import express from 'express';
import serverlessChromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const app = express();

app.use(express.json({ limit: process.env.JSON_LIMIT || '50mb' }));
app.use('/artifacts', express.static(tmpdir(), { fallthrough: false }));

const PORT = Number(process.env.PORT || 3000);
const FORM_URL =
  process.env.AIRTABLE_FORM_URL ||
  'https://airtable.com/appUOdowBcsT6bVlS/pagzDVVSW2w9Nx1Mz/form';

const TOKEN = process.env.FORM_SERVICE_TOKEN || '';
const SUBMIT_MODE = process.env.FORM_SUBMIT_MODE || 'live';

const ACTION_TIMEOUT_MS = Number(process.env.FORM_ACTION_TIMEOUT_MS || 15000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.FORM_NAVIGATION_TIMEOUT_MS || 90000);
const FORM_READY_TIMEOUT_MS = Number(process.env.FORM_READY_TIMEOUT_MS || 45000);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.FORM_SCREENSHOT_TIMEOUT_MS || 8000);
const REQUEST_TIMEOUT_MS = Number(process.env.FORM_REQUEST_TIMEOUT_MS || 170000);

const FIELD_DEFAULTS = {
  project_site: 'Bauxite II (BWI110)',
  reporter_name: 'Dominique Palmer',
  reporter_email: 'Palmerdom84@gmail.com',
  company_name: 'Turner Construction',
  contractor_observed: null,
  type_of_observation: 'Unsafe Condition',
  type_of_hazard: 'Arc Flash (Arco eléctrico)',
  severity: 'Medium',
  positive_safe_observation: null,
  stop_work_authority_used: 'Not Required',
  followup_status: 'Follow Up Needed',
};

const TYPE_OF_OBSERVATION_LABELS = {
  'Unsafe Act': 'Unsafe Act (Acto Inseguro)',
  'Unsafe Condition': 'Unsafe Condition (Condición insegura)',
  'Positive/Safe Observation': 'Positive/Safe Observation (Observación positiva/segura)',
};
const STOP_WORK_LABELS = { Yes: 'Yes (Si)', 'Not Required': 'Not Required (No Requerido)' };
const FOLLOW_UP_LABELS = {
  'Corrected Onsite': 'Corrected Onsite (Corrigdo En El Sitio)',
  'Follow Up Needed': 'Follow Up Needed (Se Requiere Seguimiento)',
  NA: 'NA',
};
const SEVERITY_LABELS = { Low: 'Low', Medium: 'Medium', High: 'High' };
const KNOWN_PROJECT_OPTIONS = ['Bauxite (BW150)', 'Bauxite II (BWI110)', 'Bauxite III (BWI100)', 'Cinco', 'Temple', 'Temple Stampede'];
const KNOWN_HAZARD_OPTIONS = ['Aerial Lifts/MEWP (Plataformas elevadoras (MEWP))', 'Arc Flash (Arco eléctrico)', 'Barricades (barricadas)', 'Batteries (Baterías)', 'Concrete/Masonry (Hormigón/Mampostería)'];
const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/g;

function clean(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function escapeRegExp(v) { return String(v).replace(REGEX_SPECIALS, '\\$&'); }
function labelRegex(label) {
  const escaped = escapeRegExp(label).replace(/\\ /g, '\\s+');
  return new RegExp('^\\s*' + escaped + '\\s*\\*?\\s*:?\\s*$', 'i');
}
function isUnsetOption(v) {
  const t = clean(v).toLowerCase();
  return !t || t === 'none' || t === 'n/a' || t === 'na' || t === 'unknown';
}
function getBody(rb) { return Array.isArray(rb) ? (rb[0] || {}) : (rb || {}); }

function normalizeObservation(v) {
  const t = String(v || '').trim().toLowerCase();
  if (t.includes('unsafe condition')) return 'Unsafe Condition';
  if (t.includes('unsafe act')) return 'Unsafe Act';
  if (t.includes('positive') || t.includes('safe observation')) return 'Positive/Safe Observation';
  return FIELD_DEFAULTS.type_of_observation;
}
function normalizeStopWork(v) {
  const t = String(v || '').trim().toLowerCase();
  return ['yes', 'true', 'checked', '1'].includes(t) ? 'Yes' : 'Not Required';
}
function normalizeFollowUp(v) {
  const t = String(v || '').trim().toLowerCase();
  if (t.includes('corrected')) return 'Corrected Onsite';
  if (t === 'na' || t === 'n/a' || t.includes('not applicable')) return 'NA';
  return 'Follow Up Needed';
}
function normalizeSeverity(v) {
  const t = String(v || '').trim().toLowerCase();
  if (t === 'low') return 'Low';
  if (t === 'high') return 'High';
  return 'Medium';
}

function splitDateTime(d, t) {
  const fb = new Date();
  const rd = clean(d), rt = clean(t);
  const iso = rd.match(/\d{4}-\d{2}-\d{2}/)?.[0] || fb.toISOString().slice(0, 10);
  const time = normalizeTime(rt) || fb.toTimeString().slice(0, 5);
  return { date: iso, time };
}
function normalizeTime(v) {
  const text = clean(v).replace(/^=/, '');
  const m = text.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function normalizePayload(rawBody) {
  const body = getBody(rawBody);
  const dt = splitDateTime(body.date_of_event, body.time);
  let obs = normalizeObservation(body.type_of_observation);
  if (obs === 'Positive/Safe Observation' && !clean(body.positive_safe_observation)) obs = 'Unsafe Condition';
  const sev = normalizeSeverity(body.severity);
  const sw = normalizeStopWork(body.stop_work_authority_used);
  const fu = normalizeFollowUp(body.followup_status);
  return {
    test_mode: false,
    record_id: clean(body.record_id),
    date_of_event: dt.date,
    time: dt.time,
    project_site: clean(body.project_site) || FIELD_DEFAULTS.project_site,
    reporter_name: clean(body.reporter_name) || FIELD_DEFAULTS.reporter_name,
    reporter_email: clean(body.reporter_email) || FIELD_DEFAULTS.reporter_email,
    company_name: clean(body.company_name) || FIELD_DEFAULTS.company_name,
    contractor_observed: clean(body.contractor_observed) || 'None',
    type_of_observation: obs,
    type_of_hazard: clean(body.type_of_hazard) || FIELD_DEFAULTS.type_of_hazard,
    severity: sev,
    positive_safe_observation: clean(body.positive_safe_observation),
    stop_work_authority_used: sw,
    description_of_event: clean(body.description_of_event),
    corrective_action: clean(body.corrective_action),
    followup_status: fu,
    photo_base64: clean(body.photo_base64),
    photo_url: clean(body.photo_url),
    photo_filename: clean(body.photo_filename) || (clean(body.record_id) ? `safety-observation-${clean(body.record_id)}.jpg` : 'safety-observation.jpg'),
    photo_content_type: clean(body.photo_content_type) || 'image/jpeg',
    selected_values: {
      type_of_observation: TYPE_OF_OBSERVATION_LABELS[obs],
      severity: SEVERITY_LABELS[sev],
      stop_work_authority_used: STOP_WORK_LABELS[sw],
      followup_status: FOLLOW_UP_LABELS[fu],
    },
  };
}

function byLabel(page, label) {
  return page.getByLabel(label, { exact: true }).or(page.getByLabel(labelRegex(label))).first();
}
function comboByLabel(page, label) {
  return byLabel(page, label)
    .or(page.getByRole('combobox', { name: label, exact: true }))
    .or(page.getByRole('combobox', { name: labelRegex(label) })).first();
}

async function fillText(page, label, value) {
  if (!value) return '';
  console.log(`[fillText] filling "${label}" with:`, value);
  const labelLocator = page.getByText(label, { exact: true }).or(page.getByText(labelRegex(label))).first();
  await labelLocator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
  try {
    const field = byLabel(page, label);
    if (await field.isVisible({ timeout: 3000 }).catch(() => false)) {
      await field.fill(String(value), { timeout: 5000 });
      return value;
    }
  } catch {}
  const filled = await page.evaluate(({ labelText, nextValue }) => {
    const normalize = (t) => String(t || '').trim().replace(/\s+/g, ' ');
    const allNodes = Array.from(document.querySelectorAll('div, label, span, p'));
    const labelNode = allNodes.find((node) => {
      const s = window.getComputedStyle(node);
      const b = node.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0 && normalize(node.textContent).includes(labelText);
    });
    if (!labelNode) return false;
    const lb = labelNode.getBoundingClientRect();
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea'));
    const candidates = inputs.filter((i) => {
      const s = window.getComputedStyle(i);
      const b = i.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0 && b.top >= lb.top - 10;
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const input = candidates[0];
    if (!input) return false;
    input.focus();
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, nextValue); else input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }, { labelText: label, nextValue: String(value) });
  if (!filled) { console.warn(`[fillText] unable to fill "${label}", continuing`); return ''; }
  return value;
}

async function listVisibleOptions(page) {
  return page.evaluate(() => {
    const out = []; const seen = new Set();
    const nodes = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li, [role="listbox"] button, [role="dialog"] li, [role="dialog"] button, button, div, span'));
    for (const n of nodes) {
      const s = window.getComputedStyle(n);
      const b = n.getBoundingClientRect();
      if (s.visibility === 'hidden' || s.display === 'none') continue;
      if (b.width === 0 || b.height === 0) continue;
      const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
      if (!t || seen.has(t)) continue;
      seen.add(t); out.push(t);
      if (out.length >= 50) break;
    }
    return out;
  }).catch(() => []);
}

async function dismissOpenPopover(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
}

async function clickVisibleText(page, targetValue, options = {}) {
  const { maxTextLength = 160, allowPartial = true, preferExact = true } = options;
  return page.evaluate(({ targetValue, maxTextLength, allowPartial, preferExact }) => {
    const normalize = (t) => String(t || '').trim().replace(/\s+/g, ' ');
    const target = normalize(targetValue); const lt = target.toLowerCase();
    const nodes = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li, [role="listbox"] button, [role="dialog"] li, [role="dialog"] button, button, label, span, div'));
    const vn = nodes.map((n) => {
      const s = window.getComputedStyle(n); const b = n.getBoundingClientRect();
      const t = normalize(n.textContent);
      return { node: n, text: t, lowerText: t.toLowerCase(), style: s, box: b };
    }).filter(({ style, box, text }) => (
      style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0 && text && text.length <= maxTextLength
    ));
    let match = null;
    if (preferExact) match = vn.find(({ text }) => text === target);
    if (!match && allowPartial) match = vn.find(({ lowerText }) => lowerText.includes(lt) || lt.includes(lowerText));
    if (!match) return false;
    match.node.scrollIntoView({ block: 'center' });
    match.node.click();
    return true;
  }, { targetValue, maxTextLength, allowPartial, preferExact });
}

async function setSearchInputValue(page, value) {
  return page.evaluate((nv) => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder="Search"], input[placeholder="Find an option"], input[placeholder="Select an option"], input[aria-label="Search"], input[role="combobox"]'));
    const vi = inputs.find((e) => {
      const s = window.getComputedStyle(e); const b = e.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
    });
    if (!vi) return false;
    vi.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) { setter.call(vi, ''); setter.call(vi, nv); } else { vi.value = ''; vi.value = nv; }
    vi.dispatchEvent(new Event('input', { bubbles: true }));
    vi.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, String(value)).catch(() => false);
}

async function chooseFirstMatchingFallback(page, fallbackValues = []) {
  for (const fv of fallbackValues) {
    const c = await clickVisibleText(page, fv, { maxTextLength: 160, allowPartial: true, preferExact: true }).catch(() => false);
    if (c) { await page.waitForTimeout(700); return fv; }
  }
  return '';
}

async function clickFirstSmallOption(page) {
  return page.evaluate(() => {
    const normalize = (t) => String(t || '').trim().replace(/\s+/g, ' ');
    const nodes = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li, [role="listbox"] button, [role="dialog"] li, [role="dialog"] button, button, span, div'));
    const c = nodes.map((n) => ({ node: n, style: window.getComputedStyle(n), box: n.getBoundingClientRect(), text: normalize(n.textContent) }))
      .filter(({ style, box, text }) => style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0 && text && text.length <= 120 && !/submit|clear form|report malicious|do not submit/i.test(text));
    const cand = c[0]; if (!cand) return '';
    cand.node.scrollIntoView({ block: 'center' }); cand.node.click();
    return cand.text;
  }).catch(() => '');
}

async function chooseLinkedRecord(page, value, addNames, label, fallbackValues = []) {
  if (!value || isUnsetOption(value)) return '';

  console.log(`[${label}] selecting linked record:`, value);
  await dismissOpenPopover(page);

  const fieldLabel = page.getByText(label, { exact: true }).or(page.getByText(labelRegex(label))).first();
  await fieldLabel.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);

  const addButtonRegexes = addNames.map((an) => new RegExp('\\+?\\s*Add\\s+.*' + escapeRegExp(an), 'i'));

  let addButton = null;
  for (const r of addButtonRegexes) {
    const cand = page.getByRole('button', { name: r }).or(page.getByText(r)).first();
    if (await cand.isVisible({ timeout: 2500 }).catch(() => false)) {
      addButton = cand;
      break;
    }
  }

  if (!addButton) {
    throw new Error('No "+ Add" button found for linked field "' + label + '"');
  }

  const isPickerStillOpen = async () => {
    return page.locator('input[placeholder="Search"], input[placeholder="Find an option"]')
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
  };

  const isRecordAttached = async (recordText) => {
    // Check the form area, not just the open dropdown. If Airtable still shows
    // "+ Add project", the linked record was not attached.
    const addVisible = await page.getByRole('button', { name: addButtonRegexes[0] })
      .or(page.getByText(addButtonRegexes[0]))
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);

    if (!addVisible) return true;

    const pickerOpen = await isPickerStillOpen();
    if (pickerOpen) return false;

    return page.getByText(recordText, { exact: true })
      .first()
      .isVisible({ timeout: 700 })
      .catch(() => false);
  };

  const valuesToTry = [...new Set([value, ...fallbackValues.filter((x) => x && x !== value)])];

  for (const attemptValue of valuesToTry) {
    console.log(`[${label}] attempting:`, attemptValue);

    if (!(await isPickerStillOpen())) {
      await addButton.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
      await addButton.click({ timeout: 5000, force: true }).catch(() => undefined);
      await page.waitForTimeout(800);
    }

    const searchInput = page.locator('input[placeholder="Search"]').first();
    if (await searchInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await searchInput.click({ timeout: 3000 }).catch(() => undefined);
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.press('Delete').catch(() => undefined);
      await page.keyboard.type(String(attemptValue), { delay: 25 });
      await page.waitForTimeout(700);
    }

    // Use a real browser mouse click first. This works better with Airtable
    // linked-record rows than synthetic DOM click events.
    const rowInfo = await page.evaluate((target) => {
      const normalize = (t) => String(t || '').trim().replace(/\s+/g, ' ');
      const targetNorm = normalize(target);
      const lt = targetNorm.toLowerCase();

      const visible = (el) => {
        const s = window.getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
      };

      const searchInputs = Array.from(document.querySelectorAll('input[placeholder="Search"]'));
      const activeSearch = searchInputs.find(visible);
      if (!activeSearch) return { ok: false, reason: 'no_search_input' };

      let popover = activeSearch.parentElement;
      while (popover && popover !== document.body) {
        const s = window.getComputedStyle(popover);
        if (s.position === 'absolute' || s.position === 'fixed') break;
        popover = popover.parentElement;
      }
      if (!popover || popover === document.body) {
        popover = activeSearch.parentElement?.parentElement || activeSearch.parentElement;
      }

      const rows = Array.from(popover.querySelectorAll('button, [role="option"], [role="button"], li, div, span'))
        .filter((n) => {
          if (n === activeSearch) return false;
          if (!visible(n)) return false;
          const t = normalize(n.textContent);
          return t && t.length > 0 && t.length <= 80;
        });

      let match = rows.find((n) => {
        const t = normalize(n.textContent);
        return t === targetNorm && !Array.from(n.children).some((c) => normalize(c.textContent) === targetNorm);
      });

      if (!match) {
        match = rows.find((n) => {
          const t = normalize(n.textContent).toLowerCase();
          return t.includes(lt) && !Array.from(n.children).some((c) => normalize(c.textContent).toLowerCase().includes(lt));
        });
      }

      if (!match) {
        return { ok: false, reason: 'no_match', sample: rows.slice(0, 10).map((n) => normalize(n.textContent)) };
      }

      match.scrollIntoView({ block: 'center' });
      const rect = match.getBoundingClientRect();
      return {
        ok: true,
        text: normalize(match.textContent),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }, attemptValue).catch((e) => ({ ok: false, reason: 'evaluate_threw', error: String(e) }));

    console.log(`[${label}] row result:`, JSON.stringify(rowInfo));

    if (rowInfo?.ok) {
      await page.mouse.click(rowInfo.x, rowInfo.y).catch(() => undefined);
      await page.waitForTimeout(700);

      if (await isRecordAttached(attemptValue)) {
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(300);
        console.log(`[${label}] SELECTED:`, attemptValue);
        return attemptValue;
      }

      // Some Airtable rows require Enter after the row is highlighted/focused.
      await page.keyboard.press('Enter').catch(() => undefined);
      await page.waitForTimeout(700);

      if (await isRecordAttached(attemptValue)) {
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(300);
        console.log(`[${label}] SELECTED via Enter:`, attemptValue);
        return attemptValue;
      }
    }

    console.warn(`[${label}] attempt failed for "${attemptValue}"`);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(400);
  }

  const visible = await listVisibleOptions(page);
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);

  throw new Error(
    'Failed to pick linked record for "' + label + '". Tried: ' +
    valuesToTry.join(', ') + '. Visible on page: ' +
    (visible.length ? visible.slice(0, 12).join(' | ') : 'none')
  );
}

async function chooseLinkedProject(page, value) {
  const requested = clean(value);

  // These values are confirmed from the live Airtable form payload.
  // Bauxite II row id: rec8pigLKoJDxvHRk
  // Bauxite row id: recgjGxPTsgp0ZKUt
  const safeDefault = 'Bauxite II (BWI110)';
  const fallback = 'Bauxite (BW150)';

  const valuesToTry = [
    requested,
    safeDefault,
    fallback,
    FIELD_DEFAULTS.project_site,
    ...KNOWN_PROJECT_OPTIONS,
  ].filter(Boolean);

  return chooseLinkedRecord(
    page,
    requested || safeDefault,
    ['project'],
    'Project Site',
    [...new Set(valuesToTry)]
  );
}

async function chooseComboByPartialMatch(page, label, value, fallbackValues = []) {
  if (!value || isUnsetOption(value)) value = fallbackValues[0] || '';
  if (!value) return '';
  console.log(`[${label}] choosing dropdown value:`, value);
  const combo = comboByLabel(page, label);
  await combo.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  await combo.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true, force: true });
  await page.waitForTimeout(700);

  const vt = [value, ...fallbackValues.filter((x) => x && x !== value)];
  for (const av of vt) {
    await setSearchInputValue(page, av);
    await page.keyboard.type(String(av), { delay: 10 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const c = await clickVisibleText(page, av, { maxTextLength: 180, allowPartial: true, preferExact: true }).catch(() => false);
    if (c) { await page.waitForTimeout(700); await page.keyboard.press('Escape').catch(() => undefined); return av; }
  }
  const fc = await clickFirstSmallOption(page);
  if (fc) { await page.waitForTimeout(700); await page.keyboard.press('Escape').catch(() => undefined); return fc; }
  const v = await listVisibleOptions(page);
  console.warn(`No dropdown option found for "${label}" value "${value}". Continuing. Visible: ${v.length ? v.join(' | ') : 'none'}`);
  await page.keyboard.press('Escape').catch(() => undefined);
  return value;
}

async function chooseCombo(page, label, value) { return chooseComboByPartialMatch(page, label, value, [value]); }

async function chooseRadio(page, groupLabel, optionLabel) {
  console.log(`[chooseRadio] group="${groupLabel}", option="${optionLabel}"`);
  const c = await clickVisibleText(page, optionLabel, { maxTextLength: 180, allowPartial: true, preferExact: true }).catch(() => false);
  if (c) { await page.waitForTimeout(700); await page.keyboard.press('Escape').catch(() => undefined); return optionLabel; }
  const v = await listVisibleOptions(page);
  console.warn('Could not click radio "' + optionLabel + '" in "' + groupLabel + '". Visible: ' + (v.length ? v.join(' | ') : 'none'));
  return optionLabel;
}

async function chooseComboOrRadio(page, label, value) {
  if (!value) return '';
  try { return await chooseCombo(page, label, value); }
  catch (e) { console.warn(`[${label}] combo failed:`, e.message); return chooseRadio(page, label, value); }
}

async function checkCheckboxIfPresent(page, label) {
  // First try: standard aria-label match (works if the form uses proper labels).
  try {
    const cb = byLabel(page, label);
    if (await cb.count()) { await cb.check(); return true; }
  } catch {}

  // Second try: DOM scan for any visible element containing the label text,
  // then click the nearest unchecked checkbox-like element.
  const clicked = await page.evaluate((lbl) => {
    const normalize = (t) => String(t || '').trim().replace(/\s+/g, ' ');

    // Find a visible element whose text contains the label.
    const nodes = Array.from(document.querySelectorAll('label, span, div, p'));
    const labelNode = nodes.find((n) => {
      const s = window.getComputedStyle(n);
      const b = n.getBoundingClientRect();
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (b.width === 0 || b.height === 0) return false;
      return normalize(n.textContent).toLowerCase().includes(lbl.toLowerCase());
    });

    if (!labelNode) return false;

    // Look for a checkbox-like element near the label: a real checkbox input,
    // role=checkbox, or any clickable element with a check icon.
    const labelBox = labelNode.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"], [aria-checked]'
    ));

    const near = candidates
      .map((el) => {
        const b = el.getBoundingClientRect();
        const dy = Math.abs(b.top - labelBox.top);
        const dx = Math.abs(b.left - labelBox.left);
        return { el, dist: dy + dx, b };
      })
      .filter(({ el, b }) => {
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
      })
      .sort((a, b) => a.dist - b.dist);

    const target = near[0]?.el;
    if (!target) return false;

    // If already checked, do nothing.
    if (target.type === 'checkbox' && target.checked) return true;
    if (target.getAttribute('aria-checked') === 'true') return true;

    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }, label).catch(() => false);

  if (!clicked) console.log(`[checkCheckboxIfPresent] "${label}" not found or not clickable`);
  return clicked;
}

async function withFallback(page, { fieldName, value, defaultValue, primaryFn, fallbackFn, fallbacksUsed, warn = console.warn }) {
  try { return await primaryFn(); }
  catch (e) {
    warn('[fallback] field "' + fieldName + '" value "' + value + '" failed: ' + e.message);
    fallbacksUsed.push({ field: fieldName, tried: value, usedDefault: defaultValue || null, error: e.message });
    await dismissOpenPopover(page);
    if (defaultValue) {
      try { if (fallbackFn) return await fallbackFn(); }
      catch (e2) { warn('[fallback] default "' + defaultValue + '" also failed: ' + e2.message); }
      return defaultValue;
    }
    return value || null;
  }
}

function airtableDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

function airtableTimeLabel(h, m) {
  const mer = h >= 12 ? 'pm' : 'am';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${mer}`;
}

async function setInputValueByPlaceholder(page, ph, value) {
  if (!value) return '';
  const input = page.locator(`input[placeholder*="${ph}"]`).first();
  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) { console.warn(`[${ph}] input not visible, skipping`); return ''; }
  await input.evaluate((el, nv) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, nv); else el.value = nv;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, String(value));
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
  return value;
}

async function pickDate(page, iso) { if (!iso) return ''; return setInputValueByPlaceholder(page, 'mm/dd', airtableDateLabel(iso)); }
async function pickTime(page, hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return setInputValueByPlaceholder(page, 'hh:mm', airtableTimeLabel(h, m));
}

function artifactUrl(req, p) {
  if (!p) return '';
  const origin = req.protocol + '://' + req.get('host');
  const rel = p.startsWith(tmpdir()) ? p.slice(tmpdir().length).replace(/^\/+/, '') : p;
  return origin + '/artifacts/' + rel.split('/').map(encodeURIComponent).join('/');
}

async function safeScreenshot(page, p) {
  if (!page) return '';
  try {
    await withTimeout(page.screenshot({ path: p, fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS }), SCREENSHOT_TIMEOUT_MS + 1000, 'Timed out capturing screenshot');
    return p;
  } catch { return ''; }
}

function withTimeout(promise, ms, msg) {
  let tid;
  const t = new Promise((_, rej) => { tid = setTimeout(() => rej(new Error(msg)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(tid));
}

async function isFieldVisible(page, label, timeout = 1500) {
  // First try: anchored regex match on its own line/element.
  // This catches "Severity", "Severity *", "Severity:" etc as standalone labels.
  const anchored = page
    .getByText(label, { exact: true })
    .or(page.getByText(labelRegex(label)))
    .first();
  if (await anchored.isVisible({ timeout }).catch(() => false)) return true;

  // Second try: DOM scan for any visible element whose text starts with the
  // label as a word. Airtable sometimes wraps labels with adjacent asterisks,
  // subtitle text, or other inline siblings that break exact-match.
  const found = await page.evaluate((lbl) => {
    const normalize = (t) => String(t || '').trim().replace(/\s+/g, ' ');
    const target = normalize(lbl);
    if (!target) return false;

    // Use a word-boundary anchor so "Severity" doesn't match inside
    // "no severity issues found".
    const re = new RegExp('^' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');

    const nodes = Array.from(document.querySelectorAll('label, span, div, p, h1, h2, h3, h4'));
    return nodes.some((n) => {
      const s = window.getComputedStyle(n);
      const b = n.getBoundingClientRect();
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (b.width === 0 || b.height === 0) return false;
      const text = normalize(n.textContent);
      // Cap text length so we don't match the whole form body.
      return text.length <= 80 && re.test(text);
    });
  }, label).catch(() => false);

  if (!found) console.log(`[isFieldVisible] "${label}" not found on page`);
  return found;
}

async function stageIfVisible(stage, name, label, page, fn) {
  if (!(await isFieldVisible(page, label))) { console.log('skipping (not visible): ' + name); return null; }
  return stage(name, fn);
}

function stageTimeout(name) {
  if (name === 'launch browser') return 60000;
  if (name === 'navigate Airtable form') return NAVIGATION_TIMEOUT_MS + 15000;
  if (name === 'wait Airtable network idle') return 25000;
  if (name === 'wait Airtable form ready') return FORM_READY_TIMEOUT_MS + 5000;
  if (name === 'wait for form inputs') return FORM_READY_TIMEOUT_MS + 5000;
  if (name === 'fill date') return 9000;
  if (name === 'fill time') return 7000;
  if (name === 'choose project site' || name === 'choose contractor observed') return 60000;
  if (name === 'fill company') return 20000;
  if (name === 'choose type of observation' || name === 'choose stop work authority' || name === 'choose follow-up status') return 20000;
  if (name === 'choose severity' || name === 'choose type of hazard' || name === 'choose positive/safe observation') return 20000;
  if (name === 'submit form') return 18000;
  if (name.includes('screenshot')) return SCREENSHOT_TIMEOUT_MS + 2000;
  return ACTION_TIMEOUT_MS + 5000;
}

async function dismissCookieBanner(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.getByRole('button', { name: /close/i }).first().click({ timeout: 2000 }).catch(() => undefined);
  await page.locator('button[aria-label="Close"]').first().click({ timeout: 2000 }).catch(() => undefined);
}

async function fillForm(payload, req, tracker = { stage: 'initializing' }) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'safety-observation-'));
  const selected = { ...payload.selected_values };
  const fallbacksUsed = [];

  let browser, context, page;
  let submitted = false;
  let stageName = 'initializing';
  let submitOutcome = 'not_attempted';
  let submitDetail = '';

  const stage = async (name, fn) => {
    stageName = name; tracker.stage = name;
    console.log('form-service stage: ' + name);
    return withTimeout(Promise.resolve().then(fn), stageTimeout(name), 'Timed out during stage "' + name + '"');
  };
  const withFB = (opts) => withFallback(page, { ...opts, fallbacksUsed });

  try {
    browser = await stage('launch browser', async () => playwrightChromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || (await serverlessChromium.executablePath()),
      args: [...serverlessChromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    }));
    context = await stage('create browser context', () => browser.newContext({ viewport: { width: 1280, height: 720 } }));
    page = await stage('create page', () => context.newPage());
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await stage('navigate Airtable form', async () => {
      await page.goto(FORM_URL, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
    });
    await stage('wait Airtable network idle', () => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined));
    await stage('wait Airtable form ready', () => page.getByText(/Date\s+of\s+event/i).first().waitFor({ timeout: FORM_READY_TIMEOUT_MS }));
    await stage('dismiss cookie banner', () => dismissCookieBanner(page));
    await stage('wait for form inputs', async () => {
      const dl = Date.now() + FORM_READY_TIMEOUT_MS;
      while (Date.now() < dl) {
        const v = await page.locator('input:visible').count().catch(() => 0);
        if (v > 0) return;
        await page.waitForTimeout(400);
      }
      console.warn('[wait for form inputs] no visible inputs — proceeding');
    });

    await stage('fill date', () => pickDate(page, payload.date_of_event));
    await stage('fill time', () => pickTime(page, payload.time));

    selected.project_site = await stage('choose project site', () =>
      withFB({
        fieldName: 'project_site',
        value: payload.project_site,
        defaultValue: FIELD_DEFAULTS.project_site,
        primaryFn: () => chooseLinkedProject(page, payload.project_site),
        fallbackFn: () => chooseLinkedProject(page, FIELD_DEFAULTS.project_site),
      })
    );

    await stage('fill reporter name', () => fillText(page, 'Your Name (First and Last)', payload.reporter_name));
    await stage('fill reporter email', () => fillText(page, 'Your Email Address', payload.reporter_email));

    selected.company_name = await stage('fill company', async () => {
      const cv = payload.company_name || FIELD_DEFAULTS.company_name;
      await fillText(page, 'Name of Company', cv);
      return cv;
    });

    if (!isUnsetOption(payload.contractor_observed)) {
      selected.contractor_observed = await stage('choose contractor observed', () =>
        withFB({
          fieldName: 'contractor_observed',
          value: payload.contractor_observed,
          defaultValue: FIELD_DEFAULTS.contractor_observed,
          primaryFn: () => chooseCombo(page, 'Name of Contractor Observed', payload.contractor_observed),
        })
      );
    } else {
      selected.contractor_observed = '';
    }

    const obsLabel = TYPE_OF_OBSERVATION_LABELS[payload.type_of_observation] || TYPE_OF_OBSERVATION_LABELS[FIELD_DEFAULTS.type_of_observation];
    const obsFallback = TYPE_OF_OBSERVATION_LABELS[FIELD_DEFAULTS.type_of_observation];

    selected.type_of_observation = await stage('choose type of observation', () =>
      withFB({
        fieldName: 'type_of_observation',
        value: obsLabel,
        defaultValue: obsFallback,
        primaryFn: () => chooseRadio(page, 'Type of Observation', obsLabel),
        fallbackFn: () => chooseRadio(page, 'Type of Observation', obsFallback),
      })
    );

    await page.waitForTimeout(300);

    if (payload.type_of_observation === 'Positive/Safe Observation' && payload.positive_safe_observation && !payload.positive_safe_observation.includes('.')) {
      selected.positive_safe_observation = await stageIfVisible(stage, 'choose positive/safe observation', 'Positive/Safe Observation', page,
        () => withFB({
          fieldName: 'positive_safe_observation',
          value: payload.positive_safe_observation,
          defaultValue: FIELD_DEFAULTS.positive_safe_observation,
          primaryFn: () => chooseCombo(page, 'Positive/Safe Observation', payload.positive_safe_observation),
        })
      );
    } else {
      selected.positive_safe_observation = '';
    }

    if (payload.type_of_observation !== 'Positive/Safe Observation') {
      selected.type_of_hazard = await stageIfVisible(stage, 'choose type of hazard', 'Type of Hazard', page,
        () => withFB({
          fieldName: 'type_of_hazard',
          value: payload.type_of_hazard,
          defaultValue: FIELD_DEFAULTS.type_of_hazard,
          primaryFn: () => chooseComboByPartialMatch(page, 'Type of Hazard', payload.type_of_hazard, [FIELD_DEFAULTS.type_of_hazard, ...KNOWN_HAZARD_OPTIONS]),
          fallbackFn: () => chooseComboByPartialMatch(page, 'Type of Hazard', FIELD_DEFAULTS.type_of_hazard, KNOWN_HAZARD_OPTIONS),
        })
      );
    } else {
      selected.type_of_hazard = '';
    }

    selected.severity = await stageIfVisible(stage, 'choose severity', 'Severity', page,
      () => withFB({
        fieldName: 'severity',
        value: SEVERITY_LABELS[payload.severity],
        defaultValue: SEVERITY_LABELS[FIELD_DEFAULTS.severity],
        primaryFn: () => chooseComboOrRadio(page, 'Severity', SEVERITY_LABELS[payload.severity]),
        fallbackFn: () => chooseComboOrRadio(page, 'Severity', SEVERITY_LABELS[FIELD_DEFAULTS.severity]),
      })
    );

    selected.confirmation_checked = await stage('check confirmation', () => checkCheckboxIfPresent(page, 'Please check this box'));

    const swLabel = STOP_WORK_LABELS[payload.stop_work_authority_used] || STOP_WORK_LABELS[FIELD_DEFAULTS.stop_work_authority_used];
    const swFallback = STOP_WORK_LABELS[FIELD_DEFAULTS.stop_work_authority_used];

    selected.stop_work_authority_used = await stage('choose stop work authority', () =>
      withFB({
        fieldName: 'stop_work_authority_used',
        value: swLabel, defaultValue: swFallback,
        primaryFn: () => chooseRadio(page, 'Stop Work Authority Used?', swLabel),
        fallbackFn: () => chooseRadio(page, 'Stop Work Authority Used?', swFallback),
      })
    );

    await stage('fill description', async () => {
      const text = payload.description_of_event || payload.positive_safe_observation;
      if (!text) return;
      const vA = await isFieldVisible(page, 'Description of Event (original)');
      await fillText(page, vA ? 'Description of Event (original)' : 'Description of Event', text);
    });

    await stageIfVisible(stage, 'fill corrective action', 'Corrective Action', page,
      () => fillText(page, 'Corrective Action', payload.corrective_action)
    );

    const fuLabel = FOLLOW_UP_LABELS[payload.followup_status] || FOLLOW_UP_LABELS[FIELD_DEFAULTS.followup_status];
    const fuFallback = FOLLOW_UP_LABELS[FIELD_DEFAULTS.followup_status];

    selected.followup_status = await stage('choose follow-up status', () =>
      withFB({
        fieldName: 'followup_status',
        value: fuLabel, defaultValue: fuFallback,
        primaryFn: () => chooseRadio(page, 'Was the issue corrected onsite or is follow up needed?', fuLabel),
        fallbackFn: () => chooseRadio(page, 'Was the issue corrected onsite or is follow up needed?', fuFallback),
      })
    );

    if (payload.photo_base64 || payload.photo_url) {
      await stage('attach photo', async () => {
        const pp = join(tmpDir, payload.photo_filename);
        if (payload.photo_base64) {
          await writeFile(pp, Buffer.from(payload.photo_base64, 'base64'));
        } else {
          const r = await fetch(payload.photo_url);
          if (!r.ok) throw new Error('Unable to download photo_url: ' + r.status + ' ' + r.statusText);
          await writeFile(pp, Buffer.from(await r.arrayBuffer()));
        }
        await page.locator('input[type="file"]').setInputFiles(pp);
      });
    }

    const beforeSubmitPath = join(tmpDir, 'before-submit.png');
    const beforeSubmitScreenshot = await stage('capture before-submit screenshot', () => safeScreenshot(page, beforeSubmitPath));

    // -------------------------------------------------------------------------
    // Submit stage: race four success signals in parallel with a 12s cap.
    // Always return regardless of outcome. The final screenshot lets you
    // visually confirm what actually happened.
    // -------------------------------------------------------------------------
    submitOutcome = await stage('submit form', async () => {
      const submitButton = page
        .getByRole('button', { name: /Submit Observation/i })
        .or(page.getByRole('button', { name: /^Submit$/i }))
        .or(page.locator('button:has-text("Submit")'))
        .first();

      await submitButton.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      const urlBefore = page.url();

      await submitButton.click({ timeout: ACTION_TIMEOUT_MS }).catch((err) => {
        throw new Error('Submit click failed: ' + err.message);
      });

      const CAP_MS = 12000;
      const result = await Promise.race([
        page.getByText(/thank you|response has been submitted|submission received|submitted successfully/i)
          .first().waitFor({ state: 'visible', timeout: CAP_MS })
          .then(() => ({ kind: 'success_text' })).catch(() => null),
        page.getByText(/required|must be filled|please complete|invalid|missing/i)
          .first().waitFor({ state: 'visible', timeout: CAP_MS })
          .then(() => ({ kind: 'validation_error' })).catch(() => null),
        (async () => {
          const start = Date.now();
          while (Date.now() - start < CAP_MS) {
            if (page.url() !== urlBefore) return { kind: 'url_changed', to: page.url() };
            await page.waitForTimeout(250);
          }
          return null;
        })(),
        submitButton.waitFor({ state: 'hidden', timeout: CAP_MS })
          .then(() => ({ kind: 'submit_button_hidden' })).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve({ kind: 'cap_reached' }), CAP_MS + 200)),
      ]);

      const kind = result?.kind || 'cap_reached';
      submitDetail = JSON.stringify(result || {});
      console.log('[submit form] outcome signal:', kind, submitDetail);

      // If we got a validation error, scrape which fields are flagged so the
      // caller can see exactly what Airtable rejected -- not just "something
      // failed".
      if (kind === 'validation_error') {
        const fieldErrors = await page.evaluate(() => {
          const normalize = (t) => String(t || '').trim().replace(/\s+/g, ' ');
          // Airtable typically marks invalid fields by adding a red border
          // or an error message near the field. We look for both.
          const errorTexts = Array.from(document.querySelectorAll('*'))
            .filter((n) => {
              const s = window.getComputedStyle(n);
              const b = n.getBoundingClientRect();
              if (s.visibility === 'hidden' || s.display === 'none') return false;
              if (b.width === 0 || b.height === 0) return false;
              const t = normalize(n.textContent);
              return /required|must be filled|please complete|invalid|missing|cannot be empty/i.test(t)
                && t.length <= 200;
            })
            .map((n) => normalize(n.textContent))
            .slice(0, 10);
          return [...new Set(errorTexts)];
        }).catch(() => []);
        submitDetail = JSON.stringify({ kind, field_errors: fieldErrors });
        console.log('[submit form] validation errors visible:', fieldErrors);
      }

      if (kind === 'success_text' || kind === 'url_changed' || kind === 'submit_button_hidden') {
        submitted = true;
        return 'success_' + kind;
      }
      if (kind === 'validation_error') return 'validation_error';
      return 'unclear';
    });

    const afterPath = join(tmpDir, submitted ? 'after-submit-success.png' : (submitOutcome === 'validation_error' ? 'after-submit-validation-error.png' : 'after-submit-unclear.png'));
    const finalScreenshot = await stage('capture final screenshot', () => safeScreenshot(page, afterPath));

    await withTimeout(context.close(), 5000, 'Timed out closing browser context').catch(() => undefined);
    await withTimeout(browser.close(), 5000, 'Timed out closing browser').catch(() => undefined);

    return {
      success: true,
      submitted,
      submit_outcome: submitOutcome,
      submit_detail: submitDetail,
      test_mode: payload.test_mode,
      submit_mode: SUBMIT_MODE,
      selected_values: selected,
      fallbacks_used: fallbacksUsed,
      artifacts: {
        directory: tmpDir,
        before_submit_screenshot: beforeSubmitScreenshot,
        final_screenshot: finalScreenshot,
        before_submit_screenshot_url: artifactUrl(req, beforeSubmitScreenshot),
        final_screenshot_url: artifactUrl(req, finalScreenshot),
      },
    };
  } catch (error) {
    const errorPath = join(tmpDir, 'error.png');
    const errorScreenshot = await safeScreenshot(page, errorPath);
    if (context) await withTimeout(context.close(), 5000, 'Timed out closing browser context').catch(() => undefined);
    if (browser) await withTimeout(browser.close(), 5000, 'Timed out closing browser').catch(() => undefined);
    return {
      success: false,
      submitted,
      submit_outcome: submitOutcome,
      submit_detail: submitDetail,
      test_mode: payload.test_mode,
      selected_values: selected,
      fallbacks_used: fallbacksUsed,
      failed_stage: stageName,
      error: '[' + stageName + '] ' + error.message,
      artifacts: {
        directory: tmpDir,
        error_screenshot: errorScreenshot,
        error_screenshot_url: artifactUrl(req, errorScreenshot),
      },
    };
  }
}

function timeoutResult(payload, tracker) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        success: false, submitted: false,
        test_mode: payload.test_mode, selected_values: payload.selected_values,
        fallbacks_used: [], failed_stage: tracker.stage || 'request timeout',
        error: 'Form automation exceeded ' + REQUEST_TIMEOUT_MS + 'ms before returning. Last stage: ' + (tracker.stage || 'unknown'),
        artifacts: {},
      });
    }, REQUEST_TIMEOUT_MS);
  });
}

function safeLogPayload(label, data) {
  const c = JSON.parse(JSON.stringify(data || {}));
  if (c.photo_base64) c.photo_base64 = '[base64 hidden, length=' + String(data.photo_base64 || '').length + ']';
  if (c.photo_url) c.photo_url = '[photo_url present]';
  console.log(label, JSON.stringify(c, null, 2));
}

async function submitObservationForm(req, res) {
  if (TOKEN && req.get('authorization') !== 'Bearer ' + TOKEN) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  console.log('================ FORM REQUEST START ================');
  console.log('request timestamp:', new Date().toISOString());
  console.log('submit_mode:', SUBMIT_MODE);
  safeLogPayload('[RAW BODY]', req.body || {});
  const payload = normalizePayload(req.body || {});
  safeLogPayload('[NORMALIZED PAYLOAD]', payload);
  const tracker = { stage: 'queued' };
  const result = await Promise.race([fillForm(payload, req, tracker), timeoutResult(payload, tracker)]);
  safeLogPayload('[FINAL RESULT]', result);
  console.log('================ FORM REQUEST END ==================');
  res.status(200).json(result);
}

app.get('/', (req, res) => res.json({
  ok: true, service: 'AI Safety Manager Form Service',
  submit_mode: SUBMIT_MODE, version: 'v28-accepted-values-project-date-fix',
  endpoints: ['GET /health', 'POST /submit-observation-form', 'POST /'],
}));
app.get('/health', (req, res) => res.json({ ok: true, submit_mode: SUBMIT_MODE, version: 'v28-accepted-values-project-date-fix' }));
app.post('/', submitObservationForm);
app.post('/submit-observation-form', submitObservationForm);

app.listen(PORT, () => console.log('AI Safety Manager form service listening on ' + PORT));
