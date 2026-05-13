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
const FORM_URL = process.env.AIRTABLE_FORM_URL || 'https://airtable.com/appUOdowBcsT6bVlS/pagzDVVSW2w9Nx1Mz/form';
const TOKEN = process.env.FORM_SERVICE_TOKEN || '';
const SUBMIT_MODE = process.env.FORM_SUBMIT_MODE || 'test';
const ACTION_TIMEOUT_MS = Number(process.env.FORM_ACTION_TIMEOUT_MS || 10000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.FORM_NAVIGATION_TIMEOUT_MS || 45000);
const FORM_READY_TIMEOUT_MS = Number(process.env.FORM_READY_TIMEOUT_MS || 30000);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.FORM_SCREENSHOT_TIMEOUT_MS || 8000);
const REQUEST_TIMEOUT_MS = Number(process.env.FORM_REQUEST_TIMEOUT_MS || 155000);

// ---------------------------------------------------------------------------
// Field-level defaults used as fallbacks when a value cannot be matched in
// the live form UI. These are applied INSIDE the browser automation so that
// even if n8n sends an unrecognised value the form still submits cleanly.
// ---------------------------------------------------------------------------
const FIELD_DEFAULTS = {
  project_site:             'Bauxite III (BWI100)',
  reporter_name:            'Dominique Palmer',
  reporter_email:           'Palmerdom84@gmail.com',
  company_name:             'Turner Construction',
  contractor_observed:      null,                    // null = skip the field entirely
  type_of_observation:      'Unsafe Condition',      // safest non-positive branch
  type_of_hazard:           null,                    // null = skip if unrecognised
  severity:                 'Medium',
  positive_safe_observation: null,                   // null = skip if unrecognised
  stop_work_authority_used: 'Not Required',
  followup_status:          'Follow Up Needed',
};

const DEFAULTS = {
  project_site:   FIELD_DEFAULTS.project_site,
  reporter_name:  FIELD_DEFAULTS.reporter_name,
  reporter_email: FIELD_DEFAULTS.reporter_email,
  company_name:   FIELD_DEFAULTS.company_name,
};

const TYPE_OF_OBSERVATION_LABELS = {
  'Unsafe Act':               'Unsafe Act (Acto Inseguro)',
  'Unsafe Condition':         'Unsafe Condition (Condición insegura)',
  'Positive/Safe Observation':'Positive/Safe Observation (Observación positiva/segura)',
};

const STOP_WORK_LABELS = {
  Yes:            'Yes (Si)',
  'Not Required': 'Not Required (No Requerido)',
};

const FOLLOW_UP_LABELS = {
  'Corrected Onsite': 'Corrected Onsite (Corrigdo En El Sitio)',
  'Follow Up Needed': 'Follow Up Needed (Se Requiere Seguimiento)',
  NA:                 'NA',
};

const SEVERITY_LABELS = {
  Low:    'Low',
  Medium: 'Medium',
  High:   'High',
};

const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/g;

function normalizeObservation(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('unsafe condition')) return 'Unsafe Condition';
  if (text.includes('unsafe act')) return 'Unsafe Act';
  if (text.includes('positive') || text.includes('safe observation')) return 'Positive/Safe Observation';
  return FIELD_DEFAULTS.type_of_observation;
}

function normalizeStopWork(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['yes', 'true', 'checked', '1'].includes(text) ? 'Yes' : 'Not Required';
}

function normalizeFollowUp(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('corrected')) return 'Corrected Onsite';
  if (text === 'na' || text === 'n/a' || text.includes('not applicable')) return 'NA';
  return 'Follow Up Needed';
}

function normalizeSeverity(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'low') return 'Low';
  if (text === 'high') return 'High';
  return 'Medium';
}

function isUnsetOption(value) {
  const text = clean(value).toLowerCase();
  return !text || text === 'none' || text === 'n/a' || text === 'na' || text === 'unknown';
}

function normalizePayload(body) {
  const dateTime = splitDateTime(body.date_of_event, body.time);
  const observation = normalizeObservation(body.type_of_observation);
  const severity = normalizeSeverity(body.severity);
  const stopWork = normalizeStopWork(body.stop_work_authority_used);
  const followUp = normalizeFollowUp(body.followup_status);

  return {
    test_mode:                body.test_mode !== false,
    date_of_event:            dateTime.date,
    time:                     dateTime.time,
    project_site:             clean(body.project_site) || DEFAULTS.project_site,
    reporter_name:            clean(body.reporter_name) || DEFAULTS.reporter_name,
    reporter_email:           clean(body.reporter_email) || DEFAULTS.reporter_email,
    company_name:             clean(body.company_name) || DEFAULTS.company_name,
    contractor_observed:      clean(body.contractor_observed) || 'None',
    type_of_observation:      observation,
    type_of_hazard:           clean(body.type_of_hazard),
    severity,
    positive_safe_observation:clean(body.positive_safe_observation),
    stop_work_authority_used: stopWork,
    description_of_event:     clean(body.description_of_event),
    corrective_action:        clean(body.corrective_action),
    followup_status:          followUp,
    photo_base64:             clean(body.photo_base64),
    photo_url:                clean(body.photo_url),
    photo_filename:           clean(body.photo_filename) || 'safety-observation.jpg',
    photo_content_type:       clean(body.photo_content_type) || 'image/jpeg',
    selected_values: {
      type_of_observation:      TYPE_OF_OBSERVATION_LABELS[observation],
      severity:                 SEVERITY_LABELS[severity],
      stop_work_authority_used: STOP_WORK_LABELS[stopWork],
      followup_status:          FOLLOW_UP_LABELS[followUp],
    },
  };
}

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function splitDateTime(dateValue, timeValue) {
  const fallback = new Date();
  const rawDate = clean(dateValue);
  const rawTime = clean(timeValue);
  const isoDate = rawDate.match(/\d{4}-\d{2}-\d{2}/)?.[0] || fallback.toISOString().slice(0, 10);
  const time = normalizeTime(rawTime) || fallback.toTimeString().slice(0, 5);
  return { date: isoDate, time };
}

function normalizeTime(value) {
  const text = clean(value).replace(/^=/, '');
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const hours = Math.max(0, Math.min(23, Number(match[1])));
  const minutes = Math.max(0, Math.min(59, Number(match[2])));
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

function escapeRegExp(value) {
  return String(value).replace(REGEX_SPECIALS, '\\$&');
}

function labelRegex(label) {
  const escaped = escapeRegExp(label).replace(/\\ /g, '\\s+');
  return new RegExp('^\\s*' + escaped + '\\s*\\*?\\s*:?\\s*$', 'i');
}

function byLabel(page, label) {
  return page
    .getByLabel(label, { exact: true })
    .or(page.getByLabel(labelRegex(label)))
    .first();
}

function comboByLabel(page, label) {
  return byLabel(page, label)
    .or(page.getByRole('combobox', { name: label, exact: true }))
    .or(page.getByRole('combobox', { name: labelRegex(label) }))
    .first();
}

async function fillText(page, label, value) {
  if (!value) return;
  const field = byLabel(page, label);
  await field.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  try {
    await field.fill(String(value), { timeout: ACTION_TIMEOUT_MS });
    return;
  } catch {
    await field.evaluate((element, nextValue) => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) {
        setter.call(element, nextValue);
      } else {
        element.value = nextValue;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value));
  }
}

async function clickVisibleOption(page, value, timeout = 3000) {
  const option = page
    .getByRole('option', { name: String(value), exact: true })
    .or(page.getByRole('option', { name: new RegExp(escapeRegExp(value), 'i') }))
    .or(page.getByText(String(value), { exact: true }))
    .or(page.getByText(new RegExp(escapeRegExp(value), 'i')))
    .first();
  if (!(await option.isVisible({ timeout }).catch(() => false))) return false;
  try {
    await option.click({ timeout, noWaitAfter: true });
    return true;
  } catch {
    return false;
  }
}

async function visibleOptionNames(page) {
  const options = await page.getByRole('option').evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    })
    .map((node) => node.textContent.trim())
    .filter(Boolean)
  ).catch(() => []);
  return [...new Set(options)].slice(0, 12);
}

const POPOVER_SEARCH_PLACEHOLDERS = ['Search', 'Find an option', 'Select an option'];

async function waitForPopoverSearch(page, timeout = ACTION_TIMEOUT_MS) {
  const start = Date.now();
  let combined;
  for (const placeholder of POPOVER_SEARCH_PLACEHOLDERS) {
    const candidate = page.locator(
      'input[placeholder="' + placeholder + '"], textarea[placeholder="' + placeholder + '"]'
    );
    combined = combined ? combined.or(candidate) : candidate;
  }
  combined = combined
    .or(page.locator('[role="dialog"] input[role="combobox"]'))
    .or(page.locator('[role="listbox"] input'));

  const search = combined.first();
  while (Date.now() - start < timeout) {
    if (await search.isVisible({ timeout: 500 }).catch(() => false)) {
      return search;
    }
    await page.waitForTimeout(150);
  }
  throw new Error('Popover search input did not appear within ' + timeout + 'ms');
}

async function popoverContainerFor(searchInput) {
  const handle = await searchInput.elementHandle();
  if (!handle) return null;
  const containerHandle = await handle.evaluateHandle((el) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const role = node.getAttribute('role');
      if (role === 'dialog' || role === 'listbox') return node;
      const style = window.getComputedStyle(node);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node;
      if (style.position === 'absolute' || style.position === 'fixed') return node;
      node = node.parentElement;
    }
    return null;
  });
  return containerHandle && containerHandle.asElement
    ? containerHandle.asElement()
    : null;
}

async function searchAndPick(page, searchInput, value, popoverHandle) {
  try {
    await searchInput.focus({ timeout: ACTION_TIMEOUT_MS });
  } catch {
    await searchInput.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true }).catch(() => undefined);
  }

  await page.keyboard.press('Control+A').catch(() => undefined);
  await page.keyboard.press('Delete').catch(() => undefined);
  await page.keyboard.type(String(value), { delay: 30 });
  await page.waitForTimeout(500);

  const valueRegex = new RegExp(escapeRegExp(value), 'i');
  const candidates = [
    page.getByRole('option', { name: String(value), exact: true }),
    page.getByRole('option', { name: valueRegex }),
    page.getByText(String(value), { exact: true }),
    page.getByText(valueRegex),
  ];

  for (const candidate of candidates) {
    const first = candidate.first();
    if (await first.isVisible({ timeout: 1500 }).catch(() => false)) {
      try {
        await first.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
        return true;
      } catch {
        // try next candidate
      }
    }
  }
  return false;
}

async function listVisibleOptions(page) {
  const opts = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll(
      '[role="option"], [role="listbox"] li, [role="listbox"] button, [role="dialog"] li, [role="dialog"] button'
    ));
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (box.width === 0 || box.height === 0) continue;
      const text = (node.textContent || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= 15) break;
    }
    return out;
  }).catch(() => []);
  return opts;
}

// ---------------------------------------------------------------------------
// Close any open popover by pressing Escape. Used after a failed pick attempt
// so subsequent field interactions start from a clean state.
// ---------------------------------------------------------------------------
async function dismissOpenPopover(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
}

async function chooseLinkedRecord(page, value, addNames, label) {
  if (!value) return '';

  let addButton;
  for (const addName of addNames) {
    const addRegex = new RegExp('\\+?\\s*Add\\s+.*' + escapeRegExp(addName), 'i');
    const candidate = page
      .getByRole('button', { name: addRegex })
      .or(page.getByText(addRegex))
      .first();
    if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
      addButton = candidate;
      break;
    }
  }
  if (!addButton) {
    throw new Error('No "+ Add" button found for linked field "' + label + '"');
  }

  await addButton.scrollIntoViewIfNeeded();
  await addButton.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });

  let search;
  try {
    search = await waitForPopoverSearch(page, ACTION_TIMEOUT_MS);
  } catch (err) {
    const visible = await listVisibleOptions(page);
    const suffix = visible.length ? '. Currently visible: ' + visible.join(' | ') : '';
    throw new Error('Linked-record popover did not open for "' + label + '"' + suffix);
  }

  const popoverHandle = await popoverContainerFor(search);
  const picked = await searchAndPick(page, search, value, popoverHandle);
  if (picked) return value;

  const visible = await listVisibleOptions(page);
  const suffix = visible.length ? '. Visible options: ' + visible.join(' | ') : '';
  throw new Error(
    'No matching option for "' + label + '" value "' + value + '" after searching' + suffix
  );
}

async function chooseLinkedProject(page, value) {
  return chooseLinkedRecord(page, value, ['project'], 'Project Site');
}

async function chooseCombo(page, label, value) {
  if (!value) return '';
  const combo = comboByLabel(page, label);
  await combo.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  await combo.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });

  let search = null;
  try {
    search = await waitForPopoverSearch(page, 4000);
  } catch {
    // No search input
  }

  if (await clickVisibleOption(page, value, 1500)) return value;

  if (!search) {
    const visible = await listVisibleOptions(page);
    const suffix = visible.length ? '. Visible options: ' + visible.join(' | ') : '';
    throw new Error(
      'Combobox "' + label + '" did not open a searchable popover and "' + value + '" not visible' + suffix
    );
  }

  const popoverHandle = await popoverContainerFor(search);
  const picked = await searchAndPick(page, search, value, popoverHandle);
  if (picked) return value;

  const visible = await listVisibleOptions(page);
  const suffix = visible.length ? '. Visible options: ' + visible.join(' | ') : '';
  throw new Error('No visible option found for "' + label + '" value "' + value + '"' + suffix);
}

async function dismissCookieBanner(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.getByRole('button', { name: /close/i }).first().click({ timeout: 2000 }).catch(() => undefined);
  await page.locator('button[aria-label="Close"]').first().click({ timeout: 2000 }).catch(() => undefined);
}

async function chooseRadio(page, groupLabel, optionLabel) {
  const group = page
    .getByRole('radiogroup', { name: groupLabel, exact: true })
    .or(page.getByRole('radiogroup', { name: labelRegex(groupLabel) }))
    .first();
  await group.getByRole('radio', { name: optionLabel, exact: true }).check();
  return optionLabel;
}

async function chooseComboOrRadio(page, label, value) {
  if (!value) return '';
  try {
    return await chooseCombo(page, label, value);
  } catch (comboError) {
    try {
      return await chooseRadio(page, label, value);
    } catch (radioError) {
      throw new Error(
        'Unable to choose "' + label + '" value "' + value + '". Combo failed: ' +
          comboError.message + '. Radio failed: ' + radioError.message
      );
    }
  }
}

async function checkCheckboxIfPresent(page, label) {
  try {
    const checkbox = byLabel(page, label);
    if (await checkbox.count()) {
      await checkbox.check();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// withFallback — wraps any field-fill attempt with a graceful fallback.
//
// Parameters:
//   fieldName     — human-readable key (matches FIELD_DEFAULTS keys)
//   value         — the value n8n sent (may be invalid/unrecognised)
//   defaultValue  — what to try if `value` fails (from FIELD_DEFAULTS)
//   primaryFn     — async () => result using `value`
//   fallbackFn    — async () => result using `defaultValue` (can differ from primaryFn)
//   fallbacksUsed — array that receives { field, tried, usedDefault } entries
//   warn          — optional logger, defaults to console.warn
//
// Behaviour:
//   1. Try primaryFn(value).  If it succeeds, return its result.
//   2. If it throws and defaultValue is non-null/non-empty AND different from value,
//      log a warning, push to fallbacksUsed, dismiss any open popover, try fallbackFn.
//   3. If defaultValue is null (field is optional), swallow the error and return null.
//   4. If fallbackFn also throws, propagate — the stage error path will capture it.
// ---------------------------------------------------------------------------
async function withFallback(page, { fieldName, value, defaultValue, primaryFn, fallbackFn, fallbacksUsed, warn = console.warn }) {
  try {
    return await primaryFn();
  } catch (primaryError) {
    // If there is no meaningful default, treat the field as optional and skip it.
    if (defaultValue === null || defaultValue === undefined || defaultValue === '') {
      warn(
        '[fallback] field "' + fieldName + '" value "' + value + '" failed and has no default — skipping. ' +
        'Error: ' + primaryError.message
      );
      fallbacksUsed.push({ field: fieldName, tried: value, usedDefault: null, skipped: true });
      await dismissOpenPopover(page);
      return null;
    }

    // If the value that was tried IS the default, don't retry (it would loop).
    if (String(value).trim().toLowerCase() === String(defaultValue).trim().toLowerCase()) {
      throw primaryError;
    }

    warn(
      '[fallback] field "' + fieldName + '" value "' + value + '" not found — ' +
      'retrying with default "' + defaultValue + '". Error: ' + primaryError.message
    );
    fallbacksUsed.push({ field: fieldName, tried: value, usedDefault: defaultValue });
    await dismissOpenPopover(page);

    // Use the explicit fallbackFn if provided, otherwise just re-run primaryFn
    // substituting the default value. Callers that use different UI patterns for
    // the fallback (e.g. chooseRadio vs chooseCombo) supply their own fallbackFn.
    const fn = fallbackFn || primaryFn;
    return await fn();
  }
}

// ---------------------------------------------------------------------------
// Date and time pickers
// ---------------------------------------------------------------------------

function airtableDateLabel(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return m + '/' + d + '/' + y;
}

function airtableTimeLabel(hh24, mm) {
  const meridiem = hh24 >= 12 ? 'pm' : 'am';
  let hh12 = hh24 % 12;
  if (hh12 === 0) hh12 = 12;
  const mmStr = String(mm).padStart(2, '0');
  return hh12 + ':' + mmStr + meridiem;
}

async function typeIntoComboboxInput(page, input, value) {
  await input.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  await input.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
  await page.keyboard.press('Control+A').catch(() => undefined);
  await page.keyboard.press('Delete').catch(() => undefined);
  await page.keyboard.type(String(value), { delay: 30 });
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(150);
  return input.inputValue().catch(() => '');
}

// ---------------------------------------------------------------------------
// sniffInputSelectors
// Dumps every <input> in the DOM with its placeholder, aria-label, type,
// position, and visibility. Logged when date/time selectors all miss so the
// real selector can be identified from Render logs without re-deploying.
// ---------------------------------------------------------------------------
async function sniffInputSelectors(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map((el) => {
      const box = el.getBoundingClientRect();
      return {
        placeholder: el.placeholder || '',
        ariaLabel:   el.getAttribute('aria-label') || '',
        type:        el.type || '',
        name:        el.name || '',
        id:          el.id || '',
        className:   el.className ? String(el.className).slice(0, 80) : '',
        visible:     box.width > 0 && box.height > 0,
        x: Math.round(box.x),
        y: Math.round(box.y),
      };
    })
  ).catch(() => []);
}

// ---------------------------------------------------------------------------
// pickDate / pickTime
//
// Airtable's date/time inputs vary across form versions. We try every known
// selector pattern. If none match within the budget we log all visible inputs
// (so you can identify the real selector from logs) and skip gracefully —
// date/time are NOT form-blocking; the run continues without them.
// ---------------------------------------------------------------------------
async function pickDate(page, isoDate) {
  if (!isoDate) return '';
  const label = airtableDateLabel(isoDate);

  const strategies = [
    'input[placeholder*="mm/dd"]',
    'input[placeholder*="MM/DD"]',
    'input[placeholder*="date" i]',
    'input[aria-label*="date" i]',
    '[data-fieldname*="date" i] input',
    '[data-columnname*="date" i] input',
    '[role="combobox"][aria-label*="date" i]',
  ];

  const deadline = Date.now() + 6000;
  let input = null;
  outer: while (Date.now() < deadline) {
    for (const sel of strategies) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) { input = loc; break outer; }
    }
    await page.waitForTimeout(250);
  }

  if (!input) {
    const all = await sniffInputSelectors(page);
    console.warn('[pickDate] date input not found. All inputs:', JSON.stringify(all));
    return ''; // non-fatal
  }

  const value = await typeIntoComboboxInput(page, input, label);
  return value || label;
}

async function pickTime(page, hhmm) {
  if (!hhmm) return '';
  const [hh24, mm] = hhmm.split(':').map(Number);
  const label = airtableTimeLabel(hh24, mm);

  const strategies = [
    'input[placeholder*="hh:mm"]',
    'input[placeholder*="HH:MM"]',
    'input[placeholder*="time" i]',
    'input[aria-label*="time" i]',
    '[data-fieldname*="time" i] input',
    '[data-columnname*="time" i] input',
    '[role="combobox"][aria-label*="time" i]',
  ];

  const deadline = Date.now() + 4000;
  let input = null;
  outer: while (Date.now() < deadline) {
    for (const sel of strategies) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) { input = loc; break outer; }
    }
    await page.waitForTimeout(250);
  }

  if (!input) {
    const all = await sniffInputSelectors(page);
    console.warn('[pickTime] time input not found. All inputs:', JSON.stringify(all));
    return ''; // non-fatal
  }

  const value = await typeIntoComboboxInput(page, input, label);
  return value || label;
}


function artifactUrl(req, path) {
  if (!path) return '';
  const origin = req.protocol + '://' + req.get('host');
  const relative = path.startsWith(tmpdir()) ? path.slice(tmpdir().length).replace(/^\/+/, '') : path;
  return origin + '/artifacts/' + relative.split('/').map(encodeURIComponent).join('/');
}

async function safeScreenshot(page, path) {
  if (!page) return '';
  try {
    await withTimeout(
      page.screenshot({ path, fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS }),
      SCREENSHOT_TIMEOUT_MS + 1000,
      'Timed out capturing screenshot'
    );
    return path;
  } catch {
    return '';
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function isFieldVisible(page, label, timeout = 1500) {
  const locator = page
    .getByText(label, { exact: true })
    .or(page.getByText(labelRegex(label)))
    .first();
  return locator.isVisible({ timeout }).catch(() => false);
}

async function stageIfVisible(stage, name, label, page, fn) {
  const visible = await isFieldVisible(page, label);
  if (!visible) {
    console.log('form-service skipping stage (field not visible): ' + name);
    return null;
  }
  return stage(name, fn);
}

function stageTimeout(name) {
  if (name === 'launch browser') return 60000;
  if (name === 'navigate Airtable form') return NAVIGATION_TIMEOUT_MS + 5000;
  if (name === 'wait Airtable network idle') return 25000;
  if (name === 'wait Airtable form ready') return FORM_READY_TIMEOUT_MS + 5000;
  if (name === 'wait for form inputs') return FORM_READY_TIMEOUT_MS + 5000;
  if (name === 'fill date') return 9000; // 6s search + 3s buffer
  if (name === 'fill time') return 7000; // 4s search + 3s buffer
  if (name === 'choose project site' || name === 'choose company' || name === 'choose contractor observed') return 45000;
  if (name.includes('screenshot')) return SCREENSHOT_TIMEOUT_MS + 2000;
  return ACTION_TIMEOUT_MS + 5000;
}

// ---------------------------------------------------------------------------
// fillForm — main automation entry point
// ---------------------------------------------------------------------------
async function fillForm(payload, req, tracker = { stage: 'initializing' }) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'safety-observation-'));
  const selected = { ...payload.selected_values };

  // Collects every field that fell back to a default during this run.
  // Returned in the response so the caller can audit which fields were affected.
  const fallbacksUsed = [];

  let browser;
  let context;
  let page;
  let submitted = false;
  let stageName = 'initializing';

  const stage = async (name, fn) => {
    stageName = name;
    tracker.stage = name;
    console.log('form-service stage: ' + name);
    return withTimeout(Promise.resolve().then(fn), stageTimeout(name), 'Timed out during stage "' + name + '"');
  };

  // Convenience: build a withFallback call pre-bound to the shared fallbacksUsed array.
  const withFB = (opts) => withFallback(page, { ...opts, fallbacksUsed });

  try {
    browser = await stage('launch browser', async () => playwrightChromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || await serverlessChromium.executablePath(),
      args: [
        ...serverlessChromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    }));
    context = await stage('create browser context', () => browser.newContext({
      viewport: { width: 1280, height: 720 },
    }));
    page = await stage('create page', () => context.newPage());
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await stage('navigate Airtable form', () => page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }));
    await stage('wait Airtable network idle', () => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined));
    await stage('wait Airtable form ready', () => page.getByText(/Date\s+of\s+event/i).first().waitFor({ timeout: FORM_READY_TIMEOUT_MS }));
    await stage('dismiss cookie banner', () => dismissCookieBanner(page));

    // Wait until at least one visible <input> exists — this confirms React has
    // finished hydrating the form and all fields are interactive. Without this,
    // pickDate arrives before the date input is in the DOM and times out.
    await stage('wait for form inputs', async () => {
      const deadline = Date.now() + FORM_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const visible = await page.locator('input:visible').count().catch(() => 0);
        if (visible > 0) return;
        await page.waitForTimeout(400);
      }
      console.warn('[wait for form inputs] no visible inputs after ' + FORM_READY_TIMEOUT_MS + 'ms — proceeding anyway');
    });

    // -----------------------------------------------------------------------
    // Date / Time — free-typed fields, non-fatal if input not found.
    // pickDate / pickTime try multiple selectors and skip gracefully if the
    // input still can't be located (logged as a warning, not a thrown error).
    // -----------------------------------------------------------------------
    await stage('fill date', () => pickDate(page, payload.date_of_event).catch((e) => console.warn('[fill date] skipped:', e.message)));
    await stage('fill time', () => pickTime(page, payload.time).catch((e) => console.warn('[fill time] skipped:', e.message)));

    // -----------------------------------------------------------------------
    // Project Site — linked-record popover.
    // Fallback: FIELD_DEFAULTS.project_site
    // -----------------------------------------------------------------------
    selected.project_site = await stage('choose project site', () =>
      withFB({
        fieldName: 'project_site',
        value: payload.project_site,
        defaultValue: FIELD_DEFAULTS.project_site,
        primaryFn: () => chooseLinkedProject(page, payload.project_site),
        fallbackFn: () => chooseLinkedProject(page, FIELD_DEFAULTS.project_site),
      })
    );

    // -----------------------------------------------------------------------
    // Reporter Name / Email — free text, no fallback needed (always filled).
    // -----------------------------------------------------------------------
    await stage('fill reporter name', () => fillText(page, 'Your Name (First and Last)', payload.reporter_name));
    await stage('fill reporter email', () => fillText(page, 'Your Email Address', payload.reporter_email));

    // -----------------------------------------------------------------------
    // Company Name — searchable single-select dropdown.
    // Fallback: FIELD_DEFAULTS.company_name ("Turner Construction")
    // -----------------------------------------------------------------------
    selected.company_name = await stage('choose company', () =>
      withFB({
        fieldName: 'company_name',
        value: payload.company_name,
        defaultValue: FIELD_DEFAULTS.company_name,
        primaryFn: () => chooseCombo(page, 'Name of Company', payload.company_name),
        fallbackFn: () => chooseCombo(page, 'Name of Company', FIELD_DEFAULTS.company_name),
      })
    );

    // -----------------------------------------------------------------------
    // Contractor Observed — optional searchable dropdown.
    // Fallback: null (skip the field — it's not required).
    // -----------------------------------------------------------------------
    if (!isUnsetOption(payload.contractor_observed)) {
      selected.contractor_observed = await stage('choose contractor observed', () =>
        withFB({
          fieldName: 'contractor_observed',
          value: payload.contractor_observed,
          defaultValue: FIELD_DEFAULTS.contractor_observed, // null → skip on failure
          primaryFn: () => chooseCombo(page, 'Name of Contractor Observed', payload.contractor_observed),
          // fallbackFn omitted intentionally — defaultValue null means skip.
        })
      );
    } else {
      selected.contractor_observed = '';
    }

    // -----------------------------------------------------------------------
    // Type of Observation — radio group.
    // Fallback: FIELD_DEFAULTS.type_of_observation ("Unsafe Condition")
    // The label sent to the form is the long bilingual label from TYPE_OF_OBSERVATION_LABELS.
    // -----------------------------------------------------------------------
    const observationLabel = TYPE_OF_OBSERVATION_LABELS[payload.type_of_observation];
    const fallbackObservationLabel = TYPE_OF_OBSERVATION_LABELS[FIELD_DEFAULTS.type_of_observation];

    selected.type_of_observation = await stage('choose type of observation', () =>
      withFB({
        fieldName: 'type_of_observation',
        value: observationLabel,
        defaultValue: fallbackObservationLabel,
        primaryFn: () => chooseRadio(page, 'Type of Observation', observationLabel),
        fallbackFn: () => chooseRadio(page, 'Type of Observation', fallbackObservationLabel),
      })
    );

    // After choosing observation type the form re-renders.
    await page.waitForTimeout(300);

    // -----------------------------------------------------------------------
    // Positive/Safe Observation dropdown (only visible on that branch).
    // Fallback: null (skip — it's conditional and optional within that branch).
    // -----------------------------------------------------------------------
    selected.positive_safe_observation = await stageIfVisible(
      stage,
      'choose positive/safe observation',
      'Positive/Safe Observation',
      page,
      () => withFB({
        fieldName: 'positive_safe_observation',
        value: payload.positive_safe_observation,
        defaultValue: FIELD_DEFAULTS.positive_safe_observation, // null → skip on failure
        primaryFn: () => chooseCombo(page, 'Positive/Safe Observation', payload.positive_safe_observation),
      })
    );

    // -----------------------------------------------------------------------
    // Type of Hazard — searchable dropdown (Unsafe Act / Unsafe Condition branch).
    // Fallback: null (skip — hazard type is not always required).
    // -----------------------------------------------------------------------
    selected.type_of_hazard = await stageIfVisible(
      stage,
      'choose type of hazard',
      'Type of Hazard',
      page,
      () => withFB({
        fieldName: 'type_of_hazard',
        value: payload.type_of_hazard,
        defaultValue: FIELD_DEFAULTS.type_of_hazard, // null → skip on failure
        primaryFn: () => chooseCombo(page, 'Type of Hazard', payload.type_of_hazard),
      })
    );

    // -----------------------------------------------------------------------
    // Severity — combo or radio (Unsafe Act / Unsafe Condition branch).
    // Fallback: FIELD_DEFAULTS.severity ("Medium")
    // -----------------------------------------------------------------------
    selected.severity = await stageIfVisible(
      stage,
      'choose severity',
      'Severity',
      page,
      () => withFB({
        fieldName: 'severity',
        value: SEVERITY_LABELS[payload.severity],
        defaultValue: SEVERITY_LABELS[FIELD_DEFAULTS.severity],
        primaryFn: () => chooseComboOrRadio(page, 'Severity', SEVERITY_LABELS[payload.severity]),
        fallbackFn: () => chooseComboOrRadio(page, 'Severity', SEVERITY_LABELS[FIELD_DEFAULTS.severity]),
      })
    );

    // -----------------------------------------------------------------------
    // Confirmation checkbox — optional, no fallback needed.
    // -----------------------------------------------------------------------
    selected.confirmation_checked = await stage('check confirmation', () =>
      checkCheckboxIfPresent(page, 'Please check this box')
    );

    // -----------------------------------------------------------------------
    // Stop Work Authority Used — radio group.
    // Fallback: FIELD_DEFAULTS.stop_work_authority_used ("Not Required")
    // -----------------------------------------------------------------------
    const stopWorkLabel = STOP_WORK_LABELS[payload.stop_work_authority_used];
    const fallbackStopWorkLabel = STOP_WORK_LABELS[FIELD_DEFAULTS.stop_work_authority_used];

    selected.stop_work_authority_used = await stage('choose stop work authority', () =>
      withFB({
        fieldName: 'stop_work_authority_used',
        value: stopWorkLabel,
        defaultValue: fallbackStopWorkLabel,
        primaryFn: () => chooseRadio(page, 'Stop Work Authority Used?', stopWorkLabel),
        fallbackFn: () => chooseRadio(page, 'Stop Work Authority Used?', fallbackStopWorkLabel),
      })
    );

    // -----------------------------------------------------------------------
    // Description of Event — free text, no enum fallback needed.
    // -----------------------------------------------------------------------
    await stage('fill description', async () => {
      const text = payload.description_of_event || payload.positive_safe_observation;
      if (!text) return;
      const visibleA = await isFieldVisible(page, 'Description of Event (original)');
      const labelToUse = visibleA ? 'Description of Event (original)' : 'Description of Event';
      await fillText(page, labelToUse, text);
    });

    // -----------------------------------------------------------------------
    // Corrective Action — free text, no enum fallback needed.
    // -----------------------------------------------------------------------
    await stage('fill corrective action', () =>
      fillText(page, 'Corrective Action', payload.corrective_action)
    );

    // -----------------------------------------------------------------------
    // Follow-up Status — radio group.
    // Fallback: FIELD_DEFAULTS.followup_status ("Follow Up Needed")
    // -----------------------------------------------------------------------
    const followUpLabel = FOLLOW_UP_LABELS[payload.followup_status];
    const fallbackFollowUpLabel = FOLLOW_UP_LABELS[FIELD_DEFAULTS.followup_status];

    selected.followup_status = await stage('choose follow-up status', () =>
      withFB({
        fieldName: 'followup_status',
        value: followUpLabel,
        defaultValue: fallbackFollowUpLabel,
        primaryFn: () => chooseRadio(page, 'Was the issue corrected onsite or is follow up needed?', followUpLabel),
        fallbackFn: () => chooseRadio(page, 'Was the issue corrected onsite or is follow up needed?', fallbackFollowUpLabel),
      })
    );

    // -----------------------------------------------------------------------
    // Photo attachment — no fallback (optional binary field).
    // -----------------------------------------------------------------------
    if (payload.photo_base64 || payload.photo_url) {
      await stage('attach photo', async () => {
        const photoPath = join(tmpDir, payload.photo_filename);
        if (payload.photo_base64) {
          await writeFile(photoPath, Buffer.from(payload.photo_base64, 'base64'));
        } else {
          const response = await fetch(payload.photo_url);
          if (!response.ok) {
            throw new Error('Unable to download photo_url: ' + response.status + ' ' + response.statusText);
          }
          await writeFile(photoPath, Buffer.from(await response.arrayBuffer()));
        }
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles(photoPath);
      });
    }

    const beforeSubmitPath = join(tmpDir, 'before-submit.png');
    const beforeSubmitScreenshot = await stage('capture before-submit screenshot', () =>
      safeScreenshot(page, beforeSubmitPath)
    );

    const shouldSubmit = !payload.test_mode && SUBMIT_MODE === 'live';
    if (shouldSubmit) {
      await stage('submit form', async () => {
        const submitButton = page
          .getByRole('button', { name: 'Submit Observation', exact: true })
          .or(page.getByRole('button', { name: 'Submit', exact: true }))
          .first();
        await submitButton.click();
        submitted = true;
        await page.waitForLoadState('networkidle', { timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
      });
    }

    const afterPath = join(tmpDir, submitted ? 'after-submit.png' : 'test-filled.png');
    const finalScreenshot = await stage('capture final screenshot', () =>
      safeScreenshot(page, afterPath)
    );

    await withTimeout(context.close(), 5000, 'Timed out closing browser context').catch(() => undefined);
    await withTimeout(browser.close(), 5000, 'Timed out closing browser').catch(() => undefined);

    return {
      success: true,
      submitted,
      test_mode: payload.test_mode,
      selected_values: selected,
      // Populated only when one or more fields fell back to a default.
      // Empty array means every field matched exactly — no fallbacks triggered.
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
    if (context) {
      await withTimeout(context.close(), 5000, 'Timed out closing browser context').catch(() => undefined);
    }
    if (browser) {
      await withTimeout(browser.close(), 5000, 'Timed out closing browser').catch(() => undefined);
    }

    return {
      success: false,
      submitted,
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
        success: false,
        submitted: false,
        test_mode: payload.test_mode,
        selected_values: payload.selected_values,
        fallbacks_used: [],
        failed_stage: tracker.stage || 'request timeout',
        error: 'Form automation exceeded ' + REQUEST_TIMEOUT_MS + 'ms before returning a result. Last stage: ' + (tracker.stage || 'unknown'),
        artifacts: {},
      });
    }, REQUEST_TIMEOUT_MS);
  });
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'AI Safety Manager Form Service',
    submit_mode: SUBMIT_MODE,
    endpoints: ['GET /health', 'POST /submit-observation-form', 'POST /'],
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, submit_mode: SUBMIT_MODE, version: 'with-field-fallbacks-v3-nonfatal-datetime' });
});

async function submitObservationForm(req, res) {
  if (TOKEN && req.get('authorization') !== 'Bearer ' + TOKEN) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const payload = normalizePayload(req.body || {});
  const tracker = { stage: 'queued' };
  const result = await Promise.race([fillForm(payload, req, tracker), timeoutResult(payload, tracker)]);
  res.status(200).json(result);
}

app.post('/', submitObservationForm);
app.post('/submit-observation-form', submitObservationForm);

app.listen(PORT, () => {
  console.log('AI Safety Manager form service listening on ' + PORT);
});