import express from 'express';
import serverlessChromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const app = express();

app.use(express.json({ limit: process.env.JSON_LIMIT || '50mb' }));

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
const CAPTURE_SCREENSHOTS = process.env.FORM_CAPTURE_SCREENSHOTS === 'true';
const SERVICE_VERSION = 'v34-skip-screenshots';

const FIELD_DEFAULTS = {
  project_site: 'Bauxite II (BWI110)',
  reporter_name: 'Dominique Palmer',
  reporter_email: 'Palmerdom84@gmail.com',
  company_name: 'Turner Construction',
  contractor_observed: 'Other',
  contractor_observed_other: 'None',
  type_of_observation: 'Unsafe Condition',
  type_of_hazard: 'Arc Flash (Arco eléctrico)',
  stop_work_authority_used: 'Not Required',
  followup_status: 'Follow Up Needed',
  days_to_complete: 2,
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
const KNOWN_PROJECT_OPTIONS = [
  'Bauxite (BW150)', 'Bauxite II (BWI110)', 'Bauxite III (BWI100)',
  'Cinco', 'Temple', 'Temple Stampede',
];
const KNOWN_HAZARD_OPTIONS = [
  'Aerial Lifts/MEWP (Plataformas elevadoras (MEWP))',
  'Arc Flash (Arco eléctrico)',
  'Barricades (barricadas)',
  'Batteries (Baterías)',
  'Concrete/Masonry (Hormigón/Mampostería)',
  'Confined Space (Espacio confinado)',
  'Electrical (Eléctrico)',
  'Fall Protection (Protección contra caídas)',
  'Fire (Fuego)',
  'Forklift/Heavy Equipment (Montacargas/Equipo pesado)',
  'Hand/Power Tools (Herramientas manuales/eléctricas)',
  'Housekeeping (Limpieza)',
  'Hot Work (Trabajo en caliente)',
  'Ladders (Escaleras)',
  'Lifting/Rigging (Elevación/Aparejo)',
  'Lockout/Tagout (Bloqueo/Etiquetado)',
  'PPE (EPP)',
  'Slip/Trip/Fall (Resbalón/Tropiezo/Caída)',
  'Struck By (Golpeado por)',
  'Trenching/Excavation (Zanjeo/Excavación)',
  'Other (Otro)',
];

const REGEX_SPECIALS = /[\^$.*+?()[\]{}|]/g;

function clean(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function escapeRegExp(v) { return String(v).replace(REGEX_SPECIALS, '\\$&'); }
function labelRegex(label) {
  const escaped = escapeRegExp(label).replace(/\\ /g, '\\s+');
  return new RegExp('^\\s*' + escaped + '\\s*\\??\\s*:?\\s*$', 'i');
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
  const sw = normalizeStopWork(body.stop_work_authority_used);
  const fu = normalizeFollowUp(body.followup_status);
  const contractorValue = clean(body.contractor_observed);
  const useOtherContractor = isUnsetOption(contractorValue);
  const daysToComplete = Number(body.days_to_complete || body.number_of_days_to_complete || FIELD_DEFAULTS.days_to_complete);
  return {
    test_mode: false,
    record_id: clean(body.record_id),
    date_of_event: dt.date,
    time: dt.time,
    project_site: clean(body.project_site) || FIELD_DEFAULTS.project_site,
    reporter_name: clean(body.reporter_name) || FIELD_DEFAULTS.reporter_name,
    reporter_email: clean(body.reporter_email) || FIELD_DEFAULTS.reporter_email,
    company_name: clean(body.company_name) || FIELD_DEFAULTS.company_name,
    contractor_observed: useOtherContractor ? FIELD_DEFAULTS.contractor_observed : contractorValue,
    contractor_observed_other: useOtherContractor
      ? clean(body.contractor_observed_other) || FIELD_DEFAULTS.contractor_observed_other
      : clean(body.contractor_observed_other),
    type_of_observation: obs,
    type_of_hazard: clean(body.type_of_hazard) || FIELD_DEFAULTS.type_of_hazard,
    positive_safe_observation: clean(body.positive_safe_observation),
    stop_work_authority_used: sw,
    description_of_event: clean(body.description_of_event),
    corrective_action: clean(body.corrective_action),
    followup_status: fu,
    days_to_complete: Number.isFinite(daysToComplete)
      ? Math.max(1, Math.min(3, daysToComplete))
      : FIELD_DEFAULTS.days_to_complete,
    photo_base64: clean(body.photo_base64),
    photo_url: clean(body.photo_url),
    photo_filename: clean(body.photo_filename) || (clean(body.record_id)
      ? `safety-observation-${clean(body.record_id)}.jpg`
      : 'safety-observation.jpg'),
    photo_content_type: clean(body.photo_content_type) || 'image/jpeg',
    selected_values: {
      type_of_observation: TYPE_OF_OBSERVATION_LABELS[obs],
      type_of_hazard: TYPE_OF_OBSERVATION_LABELS[obs] ? body.type_of_hazard : null,
      stop_work_authority_used: STOP_WORK_LABELS[sw],
      followup_status: FOLLOW_UP_LABELS[fu],
    },
  };
}

function withTimeout(promise, ms, msg) {
  let tid;
  const t = new Promise((_, rej) => { tid = setTimeout(() => rej(new Error(msg)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(tid));
}

function airtableDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return m + '/' + d + '/' + y;
}
function airtableTimeLabel(h, m) {
  const mer = h >= 12 ? 'pm' : 'am';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + String(m).padStart(2, '0') + mer;
}

async function safeScreenshot(page, p) {
  if (!page) return '';
  try {
    await withTimeout(
      page.screenshot({ path: p, fullPage: true, timeout: SCREENSHOT_TIMEOUT_MS }),
      SCREENSHOT_TIMEOUT_MS + 1000,
      'Timed out capturing screenshot',
    );
    return p;
  } catch { return ''; }
}

async function isFieldVisible(page, label, timeout = 2000) {
  return page.getByText(label, { exact: true })
    .or(page.getByText(labelRegex(label)))
    .first()
    .isVisible({ timeout })
    .catch(() => false);
}

function stageTimeout(name) {
  if (name === 'launch browser') return 60000;
  if (name === 'navigate Airtable form') return NAVIGATION_TIMEOUT_MS + 15000;
  if (name === 'wait Airtable network idle') return 25000;
  if (name === 'wait Airtable form ready') return FORM_READY_TIMEOUT_MS + 5000;
  if (name === 'wait for form inputs') return FORM_READY_TIMEOUT_MS + 5000;
  if (name === 'fill date') return 20000;
  if (name === 'fill time') return 10000;
  if (name === 'choose project site') return 60000;
  if (name === 'fill reporter name') return 10000;
  if (name === 'fill reporter email') return 10000;
  if (name === 'fill company') return 10000;
  if (name === 'choose contractor observed') return 30000;
  if (name === 'fill contractor observed other') return 15000;
  if (name === 'choose type of observation') return 15000;
  if (name === 'choose type of hazard') return 30000;
  if (name === 'choose positive safe observation') return 30000;
  if (name === 'choose stop work authority') return 15000;
  if (name === 'fill description') return 15000;
  if (name === 'choose follow-up status') return 15000;
  if (name === 'fill corrective action') return 15000;
  if (name === 'fill days to complete') return 10000;
  if (name === 'check confirmation') return 10000;
  if (name === 'submit form') return 20000;
  if (name.includes('screenshot')) return SCREENSHOT_TIMEOUT_MS + 2000;
  return ACTION_TIMEOUT_MS + 5000;
}

async function dismissOpenPopover(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
}

async function fillInputByPlaceholderFragment(page, fragment, value) {
  if (!value) return '';
  const input = page.locator(`input[placeholder*="${fragment}"]`).first();
  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.warn(`[fillInput] placeholder "${fragment}" not visible, skipping`);
    return '';
  }
  await input.evaluate((el, nv) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, nv); else el.value = nv;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, String(value));
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
  return value;
}

async function fillDateTimeNearLabel(page, labelSubstring, dateValue, timeValue) {
  console.log(`[fillDateTime] "${labelSubstring}" => "${dateValue}" "${timeValue || ''}"`);

  const result = await withTimeout(
    page.evaluate(({ nextDateValue, nextTimeValue }) => {
      const isVisible = (node) => {
        if (!node) return false;
        const style = window.getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && box.width > 0
          && box.height > 0;
      };
      const inputEntries = Array.from(document.querySelectorAll('input:not([type="hidden"])'))
        .filter(isVisible)
        .map((el, index) => {
          const box = el.getBoundingClientRect();
          return {
            el,
            index,
            aria: el.getAttribute('aria-label') || '',
            className: String(el.className || ''),
            placeholder: el.getAttribute('placeholder') || '',
            role: el.getAttribute('role') || '',
            type: el.getAttribute('type') || '',
            top: Math.round(box.top),
            left: Math.round(box.left),
            width: Math.round(box.width),
          };
        });
      const metadata = (entry) => entry && {
        index: entry.index,
        aria: entry.aria,
        className: entry.className,
        placeholder: entry.placeholder,
        role: entry.role,
        type: entry.type,
        top: entry.top,
        left: entry.left,
        width: entry.width,
      };
      const dateEntry = inputEntries.find((entry) =>
        entry.placeholder.toLowerCase() === 'mm/dd/yyyy' || /\bdate\b/i.test(entry.className))
        || inputEntries.find((entry) =>
          entry.placeholder.toLowerCase().includes('mm/dd')
          || entry.aria.toLowerCase().includes('date'));
      const timeEntry = inputEntries.find((entry) =>
        entry.aria.toLowerCase() === 'time' || /\btimeinput\b/i.test(entry.className))
        || inputEntries.find((entry) =>
          entry.placeholder.toLowerCase().includes('hh:mm')
          || entry.aria.toLowerCase().includes('time'));

      const setValue = (entry, value) => {
        if (!entry) return false;
        const el = entry.el;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      };

      return {
        dateFilled: setValue(dateEntry, String(nextDateValue || '')),
        timeFilled: nextTimeValue ? setValue(timeEntry, String(nextTimeValue)) : true,
        dateTarget: metadata(dateEntry),
        timeTarget: metadata(timeEntry),
        visibleInputs: inputEntries.map(metadata),
      };
    }, {
      nextDateValue: String(dateValue),
      nextTimeValue: timeValue ? String(timeValue) : '',
    }),
    12000,
    `[fillDateTime] timed out setting "${labelSubstring}" inputs`,
  );

  console.log('[fillDateTime] result:', JSON.stringify(result));
  if (!result.dateFilled) {
    throw new Error(`Unable to fill "${labelSubstring}" date input: ${JSON.stringify(result)}`);
  }
  if (timeValue && !result.timeFilled) {
    throw new Error(`Unable to fill "${labelSubstring}" time input: ${JSON.stringify(result)}`);
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
  return true;
}

async function fillTextNearLabel(page, labelSubstring, value) {
  if (!value) return '';
  console.log(`[fillText] "${labelSubstring}" => "${value}"`);

  const result = await withTimeout(page.evaluate(({ labelText, nextValue }) => {
    const normalize = (t) => String(t || '').trim().replace(/\s+/g, ' ');
    const isVisible = (node) => {
      if (!node) return false;
      const s = window.getComputedStyle(node);
      const b = node.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none'
        && b.width > 0 && b.height > 0;
    };
    const target = labelText.toLowerCase();
    const labels = Array.from(document.querySelectorAll('label, div, span, p'))
      .filter((node) => {
        if (!isVisible(node)) return false;
        const text = normalize(node.textContent).toLowerCase();
        return text === target || text.includes(target);
      })
      .sort((a, b) => {
        const at = normalize(a.textContent).toLowerCase();
        const bt = normalize(b.textContent).toLowerCase();
        const exactA = at === target ? 0 : 1;
        const exactB = bt === target ? 0 : 1;
        if (exactA !== exactB) return exactA - exactB;
        if (at.length !== bt.length) return at.length - bt.length;
        const ab = a.getBoundingClientRect();
        const bb = b.getBoundingClientRect();
        return (ab.width * ab.height) - (bb.width * bb.height);
      });
    const inputs = Array.from(document.querySelectorAll(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea',
    )).filter(isVisible);
    const describe = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        aria: el.getAttribute('aria-label') || '',
        className: String(el.className || ''),
        placeholder: el.getAttribute('placeholder') || '',
        top: Math.round(box.top),
        left: Math.round(box.left),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    };
    let input = null;
    let labelNode = null;

    for (const candidateLabel of labels) {
      const lb = candidateLabel.getBoundingClientRect();
      const scored = inputs
        .map((candidate) => {
          const box = candidate.getBoundingClientRect();
          const belowDistance = box.top - lb.bottom;
          const horizontalDistance = Math.abs((box.left + box.width / 2) - (lb.left + lb.width / 2));
          const usable = belowDistance >= -12 && belowDistance <= 180;
          return {
            candidate,
            usable,
            score: (usable ? 0 : 10000)
              + Math.abs(belowDistance)
              + horizontalDistance / 20
              + (candidate.tagName.toLowerCase() === 'textarea' ? -5 : 0),
          };
        })
        .filter((entry) => entry.usable)
        .sort((a, b) => a.score - b.score);
      if (scored[0]) {
        input = scored[0].candidate;
        labelNode = candidateLabel;
        break;
      }
    }

    if (!input) {
      return {
        filled: false,
        labelCount: labels.length,
        target: labelText,
        visibleInputs: inputs.map(describe),
      };
    }

    input.focus();
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, nextValue); else input.value = nextValue;
    const inputEvent = typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue })
      : new Event('input', { bubbles: true });
    input.dispatchEvent(inputEvent);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return {
      filled: true,
      label: labelNode ? normalize(labelNode.textContent) : '',
      target: describe(input),
    };
  }, { labelText: labelSubstring, nextValue: String(value) }), 8000,
  `[fillText] timed out setting "${labelSubstring}"`);

  console.log('[fillText] result:', JSON.stringify(result));
  const filled = result.filled;

  if (!filled) console.warn(`[fillText] unable to fill "${labelSubstring}", continuing`);
  return filled ? value : '';
}

async function clickByText(page, target, { exact = true, partial = false, maxLen = 200 } = {}) {
  return page.evaluate(({ target, exact, partial, maxLen }) => {
    const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');
    const t = norm(target);
    const lt = t.toLowerCase();
    const all = Array.from(document.querySelectorAll(
      '[role="option"],[role="radio"],[role="checkbox"],button,label,span,div,li',
    ));
    const visible = all.filter((n) => {
      const s = window.getComputedStyle(n);
      const b = n.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
    });
    let match = null;
    if (exact) match = visible.find((n) => norm(n.textContent) === t && norm(n.textContent).length <= maxLen);
    if (!match && partial) match = visible.find((n) => {
      const nt = norm(n.textContent).toLowerCase();
      return nt.length <= maxLen && (nt.includes(lt) || lt.includes(nt));
    });
    if (!match) return false;
    match.scrollIntoView({ block: 'nearest' });
    match.click();
    return true;
  }, { target, exact, partial, maxLen });
}

async function fillFocusedOrVisibleInput(page, value) {
  const filled = await page.evaluate((nextValue) => {
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    };
    const candidates = [];
    if (document.activeElement instanceof HTMLInputElement && isVisible(document.activeElement)) {
      candidates.push(document.activeElement);
    }
    candidates.push(...Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(isVisible));
    const input = candidates.find((candidate) => {
      const text = [
        candidate.getAttribute('placeholder'),
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('name'),
        candidate.getAttribute('role'),
      ].join(' ').toLowerCase();
      return text.includes('search') || text.includes('find') || text.includes('option');
    }) || candidates[0];
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, nextValue); else input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, String(value));
  if (!filled) {
    await page.keyboard.type(String(value), { delay: 20 }).catch(() => undefined);
  }
  await page.waitForTimeout(1000);
  return filled;
}

async function chooseLinkedProject(page, value) {
  const target = value || FIELD_DEFAULTS.project_site;
  console.log('[project_site] selecting:', target);

  await dismissOpenPopover(page);

  const addBtn = page.getByRole('button', { name: /add\s+project/i })
    .or(page.getByText(/\+\s*Add\s+project/i))
    .first();

  if (!(await addBtn.isVisible({ timeout: 8000 }).catch(() => false))) {
    const direct = await clickByText(page, target, { exact: false, partial: true, maxLen: 100 });
    if (direct) { await page.waitForTimeout(500); return target; }
    throw new Error('Project Site: no "+ Add project" button found');
  }

  await addBtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  await addBtn.click({ force: true, noWaitAfter: true });
  await page.waitForTimeout(1500);

  await fillFocusedOrVisibleInput(page, target);

  const clicked = await clickByText(page, target, { exact: true, partial: false, maxLen: 120 })
    || await clickByText(page, target, { exact: false, partial: true, maxLen: 120 });

  if (clicked) {
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return target;
  }

  const firstOpt = page.locator('[role="option"]').first();
  if (await firstOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
    const txt = await firstOpt.textContent();
    await firstOpt.click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return (txt || '').trim();
  }

  throw new Error('Project Site: could not select "' + target + '"');
}

async function chooseContractorObserved(page, value) {
  const target = value || 'None';
  console.log('[contractor_observed] selecting:', target);

  await dismissOpenPopover(page);

  // Find the dropdown by label
  const labelLoc = page.getByText(/Name of Contractor Observed/i).first();
  await labelLoc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);

  // Click to open dropdown
  const dropdown = page.locator('select, [role="combobox"], [role="listbox"]')
    .filter({ hasText: /Contractor/i })
    .first();

  if (await dropdown.isVisible({ timeout: 5000 }).catch(() => false)) {
    await dropdown.click({ force: true });
    await page.waitForTimeout(800);
  } else {
    // Try clicking near the label
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label, div, span'));
      const lbl = labels.find((l) => l.textContent.toLowerCase().includes('contractor'));
      if (lbl) {
        const container = lbl.closest('div[role="listbox"], div[class*="select"], div[class*="dropdown"]') || lbl.parentElement;
        if (container) { container.scrollIntoView(); container.click(); }
      }
    });
    await page.waitForTimeout(800);
  }

  // Try to select "None" or first option
  let clicked = await clickByText(page, 'None', { exact: true, partial: false, maxLen: 50 });
  if (!clicked) clicked = await clickByText(page, target, { exact: false, partial: true, maxLen: 100 });
  
  if (!clicked) {
    const firstOpt = page.locator('[role="option"]').first();
    if (await firstOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstOpt.click();
      clicked = true;
    }
  }

  if (clicked) {
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return target;
  }

  console.warn('[contractor_observed] could not select, using default');
  return target;
}

async function clickRadioOption(page, optionLabel) {
  console.log(`[radio] clicking: "${optionLabel}"`);

  let clicked = await clickByText(page, optionLabel, { exact: true, partial: false, maxLen: 220 });
  if (!clicked) clicked = await clickByText(page, optionLabel, { exact: false, partial: true, maxLen: 220 });

  if (clicked) {
    await page.waitForTimeout(600);
    return optionLabel;
  }
  console.warn(`[radio] could not click "${optionLabel}"`);
  return optionLabel;
}

async function chooseTypeOfHazard(page, value) {
  const target = value || 'Arc Flash (Arco eléctrico)';
  console.log('[type_of_hazard] selecting:', target);

  // Find label and click to open
  const labelLoc = page.getByText(/Type of Hazard/i).first();
  await labelLoc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);

  // Click the field area to open dropdown
  await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label, div, span'));
    const lbl = labels.find((l) => l.textContent.toLowerCase().includes('type of hazard') || l.textContent.toLowerCase().includes('tipo de peligro'));
    if (lbl) {
      const container = lbl.parentElement?.parentElement || lbl.closest('div[class*="field"], div[class*="cell"]');
      if (container) {
        container.scrollIntoView({ block: 'center' });
        container.click();
      } else {
        lbl.click();
      }
    }
  });

  await page.waitForTimeout(1000);

  // Try exact match first
  let clicked = await clickByText(page, target, { exact: true, partial: false, maxLen: 150 });
  if (!clicked) clicked = await clickByText(page, target, { exact: false, partial: true, maxLen: 150 });

  if (clicked) {
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return target;
  }

  // Try search box
  const searchBox = page.locator(
    'input[placeholder*="Search"], input[placeholder*="Find"], input[placeholder*="search"], input[placeholder*="Select"]',
  ).first();

  if (await searchBox.isVisible({ timeout: 3000 }).catch(() => false)) {
    await searchBox.fill(target, { timeout: 5000 });
    await page.waitForTimeout(800);
    clicked = await clickByText(page, target, { exact: false, partial: true, maxLen: 150 });
    if (clicked) {
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape').catch(() => undefined);
      return target;
    }
  }

  // Click first option as fallback
  const firstOpt = page.locator('[role="option"]').first();
  if (await firstOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
    const txt = await firstOpt.textContent();
    await firstOpt.click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return (txt || target).trim();
  }

  console.warn('[type_of_hazard] could not select "' + target + '", using default');
  return target;
}

async function choosePositiveSafeObservation(page, value) {
  const target = value || 'Other (Otro)';
  console.log('[positive_safe_observation] selecting:', target);

  const visible = await isFieldVisible(page, 'Positive/Safe Observation', 5000);
  if (!visible) {
    console.warn('[positive_safe_observation] field not visible, skipping');
    return '';
  }

  const labelLoc = page.getByText(/Positive\/Safe Observation/i).first();
  await labelLoc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label, div, span'));
    const lbl = labels.find((l) => l.textContent.toLowerCase().includes('positive/safe observation'));
    if (lbl) {
      const container = lbl.parentElement?.parentElement || lbl.closest('div[class*="field"], div[class*="cell"]');
      if (container) {
        container.scrollIntoView({ block: 'center' });
        container.click();
      } else {
        lbl.click();
      }
    }
  });

  await page.waitForTimeout(1000);

  let clicked = await clickByText(page, target, { exact: true, partial: false, maxLen: 180 });
  if (!clicked) clicked = await clickByText(page, target, { exact: false, partial: true, maxLen: 180 });

  if (clicked) {
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return target;
  }

  const firstOpt = page.locator('[role="option"]').first();
  if (await firstOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
    const txt = await firstOpt.textContent();
    await firstOpt.click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return (txt || target).trim();
  }

  console.warn('[positive_safe_observation] could not select "' + target + '"');
  return '';
}

async function checkCheckboxIfPresent(page, labelSubstring) {
  try {
    const found = await page.evaluate((labelText) => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      for (const cb of checkboxes) {
        const b = cb.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (!cb.checked) {
          const container = cb.closest('label, div, fieldset') || cb.parentElement;
          if (container && container.textContent.toLowerCase().includes(labelText.toLowerCase())) {
            cb.click();
            return true;
          }
        }
      }
      // Last resort: click any visible unchecked checkbox
      const visible = checkboxes.find((cb) => {
        const b = cb.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && !cb.checked;
      });
      if (visible) { visible.click(); return true; }
      return false;
    }, labelSubstring);

    if (found) {
      await page.waitForTimeout(400);
      console.log(`[checkbox] "${labelSubstring}" checked`);
      return true;
    }
  } catch (e) {
    console.warn('[checkbox] failed:', e.message);
  }
  console.log(`[checkbox] "${labelSubstring}" not found`);
  return false;
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
    stageName = name;
    tracker.stage = name;
    console.log('form-service stage: ' + name);
    return withTimeout(
      Promise.resolve().then(fn),
      stageTimeout(name),
      'Timed out during stage "' + name + '"',
    );
  };

  try {
    browser = await stage('launch browser', async () => playwrightChromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH
        || (await serverlessChromium.executablePath()),
      args: [...serverlessChromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    }));

    context = await stage('create browser context', () =>
      browser.newContext({ viewport: { width: 1280, height: 900 } }),
    );
    page = await stage('create page', () => context.newPage());
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await stage('navigate Airtable form', async () => {
      await page.goto(FORM_URL, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS })
        .catch(() => undefined);
    });
    await stage('wait Airtable network idle', () =>
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined),
    );
    await stage('wait Airtable form ready', () =>
      page.getByText(/Date\s+of\s+event/i).first().waitFor({ timeout: FORM_READY_TIMEOUT_MS }),
    );

    await stage('dismiss overlays', async () => {
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.getByRole('button', { name: /close/i }).first()
        .click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    });

    await stage('wait for form inputs', async () => {
      const dl = Date.now() + FORM_READY_TIMEOUT_MS;
      while (Date.now() < dl) {
        const v = await page.locator('input:visible').count().catch(() => 0);
        if (v > 0) return;
        await page.waitForTimeout(400);
      }
      console.warn('[wait for form inputs] no visible inputs — proceeding');
    });

    // === REQUIRED FIELDS ===

    await stage('fill date', async () => {
      const [h, m] = payload.time.split(':').map(Number);
      await fillDateTimeNearLabel(
        page,
        'Date of Event',
        airtableDateLabel(payload.date_of_event),
        payload.time ? airtableTimeLabel(h, m) : '',
      );
    });

    selected.project_site = await stage('choose project site', () =>
      chooseLinkedProject(page, payload.project_site),
    );

    await stage('fill reporter name', () =>
      fillTextNearLabel(page, 'Your Name (First and Last)', payload.reporter_name),
    );

    await stage('fill reporter email', () =>
      fillTextNearLabel(page, 'Your Email Address', payload.reporter_email),
    );

    selected.company_name = await stage('fill company', async () => {
      const cv = payload.company_name || FIELD_DEFAULTS.company_name;
      await fillTextNearLabel(page, 'Name of Company', cv);
      return cv;
    });

    // REQUIRED: Contractor Observed
    selected.contractor_observed = await stage('choose contractor observed', () =>
      chooseContractorObserved(page, payload.contractor_observed),
    );

    await stage('fill contractor observed other', async () => {
      if (payload.contractor_observed !== 'Other') return;
      await page.waitForTimeout(800);
      await fillTextNearLabel(page, 'Name of Contractor', payload.contractor_observed_other);
    });

    const obsLabel = TYPE_OF_OBSERVATION_LABELS[payload.type_of_observation]
      || TYPE_OF_OBSERVATION_LABELS[FIELD_DEFAULTS.type_of_observation];

    selected.type_of_observation = await stage('choose type of observation', () =>
      clickRadioOption(page, obsLabel),
    );

    await page.waitForTimeout(1000);

    if (payload.type_of_observation === 'Positive/Safe Observation') {
      selected.positive_safe_observation = await stage('choose positive safe observation', () =>
        choosePositiveSafeObservation(page, payload.positive_safe_observation),
      );
    } else {
      // REQUIRED for unsafe observations.
      selected.type_of_hazard = await stage('choose type of hazard', () =>
        chooseTypeOfHazard(page, payload.type_of_hazard),
      );
    }

    const swLabel = STOP_WORK_LABELS[payload.stop_work_authority_used]
      || STOP_WORK_LABELS[FIELD_DEFAULTS.stop_work_authority_used];

    selected.stop_work_authority_used = await stage('choose stop work authority', () =>
      clickRadioOption(page, swLabel),
    );

    await stage('fill description', async () => {
      const text = payload.description_of_event;
      if (!text) return;
      const useOriginal = await isFieldVisible(page, 'Description of Event (original)', 2000);
      await fillTextNearLabel(
        page,
        useOriginal ? 'Description of Event (original)' : 'Description of Event',
        text,
      );
    });

    const fuLabel = FOLLOW_UP_LABELS[payload.followup_status]
      || FOLLOW_UP_LABELS[FIELD_DEFAULTS.followup_status];

    selected.followup_status = await stage('choose follow-up status', () =>
      clickRadioOption(page, fuLabel),
    );

    await page.waitForTimeout(1000);

    await stage('fill corrective action', async () => {
      if (!payload.corrective_action) return;
      await fillTextNearLabel(page, 'Corrective Action', payload.corrective_action);
    });

    await stage('fill days to complete', async () => {
      if (payload.followup_status !== 'Follow Up Needed') return;
      await fillTextNearLabel(page, 'Number of days to complete', payload.days_to_complete);
    });

    selected.confirmation_checked = await stage('check confirmation',
      () => checkCheckboxIfPresent(page, 'check this box'),
    );

    if (payload.photo_base64 || payload.photo_url) {
      await stage('attach photo', async () => {
        const pp = join(tmpDir, payload.photo_filename);
        if (payload.photo_base64) {
          await writeFile(pp, Buffer.from(payload.photo_base64, 'base64'));
        } else {
          const r = await fetch(payload.photo_url);
          if (!r.ok) throw new Error('photo download failed: ' + r.status);
          await writeFile(pp, Buffer.from(await r.arrayBuffer()));
        }
        await page.locator('input[type="file"]').setInputFiles(pp);
      });
    }

    if (CAPTURE_SCREENSHOTS) {
      const beforeSubmitPath = join(tmpDir, 'before-submit.png');
      await stage('capture before-submit screenshot',
        () => safeScreenshot(page, beforeSubmitPath),
      );
    }

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

      const CAP_MS = 14000;
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

        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: 'cap_reached' }), CAP_MS + 200),
        ),
      ]);

      const kind = result?.kind || 'cap_reached';
      submitDetail = JSON.stringify(result || {});
      console.log('[submit form] outcome signal:', kind, submitDetail);

      if (kind === 'success_text' || kind === 'url_changed' || kind === 'submit_button_hidden') {
        submitted = true;
        return 'success_' + kind;
      }
      if (kind === 'validation_error') return 'validation_error';
      return 'unclear';
    });

    if (CAPTURE_SCREENSHOTS) {
      const afterLabel = submitted ? 'success'
        : submitOutcome === 'validation_error' ? 'validation-error' : 'unclear';
      const afterPath = join(tmpDir, `after-submit-${afterLabel}.png`);
      await stage('capture final screenshot',
        () => safeScreenshot(page, afterPath),
      );
    }

    await withTimeout(context.close(), 5000, 'close context timeout').catch(() => undefined);
    await withTimeout(browser.close(), 5000, 'close browser timeout').catch(() => undefined);

    return {
      success: submitted,
      submitted,
      submit_outcome: submitOutcome,
      submit_detail: submitDetail,
      test_mode: payload.test_mode,
      submit_mode: SUBMIT_MODE,
      selected_values: selected,
      fallbacks_used: fallbacksUsed,
      // Artifacts removed - not needed for successful submit
    };

  } catch (error) {
    if (context) await withTimeout(context.close(), 5000, 'close context timeout').catch(() => undefined);
    if (browser) await withTimeout(browser.close(), 5000, 'close browser timeout').catch(() => undefined);
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
    };
  }
}

function timeoutResult(payload, tracker) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        success: false,
        submitted: false,
        test_mode: payload.test_mode,
        selected_values: payload.selected_values,
        fallbacks_used: [],
        failed_stage: tracker.stage || 'request timeout',
        error: `Form automation exceeded ${REQUEST_TIMEOUT_MS}ms. Last stage: ${tracker.stage || 'unknown'}`,
      });
    }, REQUEST_TIMEOUT_MS);
  });
}

function safeLogPayload(label, data) {
  const c = JSON.parse(JSON.stringify(data || {}));
  if (c.photo_base64) c.photo_base64 = `[base64 hidden, length=${String(data.photo_base64 || '').length}]`;
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
  const result = await Promise.race([
    fillForm(payload, req, tracker),
    timeoutResult(payload, tracker),
  ]);
  safeLogPayload('[FINAL RESULT]', result);
  console.log('================ FORM REQUEST END ==================');
  res.status(200).json(result);
}

app.get('/', (req, res) => res.json({
  ok: true,
  service: 'AI Safety Manager Form Service',
  submit_mode: SUBMIT_MODE,
  version: SERVICE_VERSION,
  endpoints: ['GET /health', 'POST /submit-observation-form', 'POST /'],
}));
app.get('/health', (req, res) => res.json({
  ok: true, submit_mode: SUBMIT_MODE, version: SERVICE_VERSION,
}));
app.post('/', submitObservationForm);
app.post('/submit-observation-form', submitObservationForm);

app.listen(PORT, () => console.log('AI Safety Manager form service listening on ' + PORT));
