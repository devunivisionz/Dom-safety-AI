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
  if (text.includes('positive') || text.includes('safe observation')) {
    return 'Positive/Safe Observation';
  }

  return 'Unsafe Condition';
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
  function toBoolean(value, defaultValue = true) {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();

  if (['false', '0', 'no', 'off', 'live'].includes(text)) return false;
  if (['true', '1', 'yes', 'on', 'test'].includes(text)) return true;

  return defaultValue;
}
  const dateTime = splitDateTime(body.date_of_event, body.time);
  let observation = normalizeObservation(body.type_of_observation);

// If Positive/Safe Observation is selected but the required
// Positive/Safe Observation dropdown value is empty, do not go into
// that branch because Airtable will require another value.
if (
  observation === 'Positive/Safe Observation' &&
  !clean(body.positive_safe_observation)
) {
  observation = 'Unsafe Condition';
}
  const severity = normalizeSeverity(body.severity);
  const stopWork = normalizeStopWork(body.stop_work_authority_used);
  const followUp = normalizeFollowUp(body.followup_status);

  return {
   test_mode: toBoolean(body.test_mode, true),
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
  if (!value || isUnsetOption(value)) return '';

  const fieldLabel = page
    .getByText(label, { exact: true })
    .or(page.getByText(labelRegex(label)))
    .first();

  await fieldLabel.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);

  let addButton = null;

  for (const addName of addNames) {
    const addRegex = new RegExp('\\+?\\s*Add\\s+.*' + escapeRegExp(addName), 'i');

    const candidate = page
      .getByRole('button', { name: addRegex })
      .or(page.getByText(addRegex))
      .first();

    if (await candidate.isVisible({ timeout: 3000 }).catch(() => false)) {
      addButton = candidate;
      break;
    }
  }

  if (!addButton) {
    throw new Error('No "+ Add" button found for linked field "' + label + '"');
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);

  await addButton.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  await addButton.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });

  const searchInput = page
    .locator('input[placeholder="Search"], input[placeholder="Find an option"], input[placeholder="Select an option"]')
    .first();

  if (!(await searchInput.isVisible({ timeout: 8000 }).catch(() => false))) {
    const visible = await listVisibleOptions(page);
    throw new Error(
      'Project picker opened but search input was not visible. Visible options: ' +
      (visible.length ? visible.join(' | ') : 'none')
    );
  }

  await searchInput.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
  await page.keyboard.press('Control+A').catch(() => undefined);
  await page.keyboard.press('Delete').catch(() => undefined);
  await page.keyboard.type(String(value), { delay: 40 });

  await page.waitForTimeout(1000);

  const exactOption = page
    .getByText(String(value), { exact: true })
    .or(page.getByRole('option', { name: String(value), exact: true }))
    .first();

  if (await exactOption.isVisible({ timeout: 5000 }).catch(() => false)) {
    await exactOption.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return value;
  }

  const partialOption = page
    .getByText(new RegExp(escapeRegExp(value), 'i'))
    .or(page.getByRole('option', { name: new RegExp(escapeRegExp(value), 'i') }))
    .first();

  if (await partialOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await partialOption.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => undefined);
    return value;
  }

  const visible = await listVisibleOptions(page);
  throw new Error(
    'No matching project option found for "' + value + '". Visible options: ' +
    (visible.length ? visible.join(' | ') : 'none')
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
  // Airtable interface forms render radio groups as styled pill buttons,
  // NOT as native <input type="radio"> elements. The pills are clickable
  // divs/spans inside a container near the group label. We use a multi-
  // strategy approach so this works regardless of the exact DOM structure.

  const optionRegex = new RegExp(escapeRegExp(optionLabel), 'i');

  // Strategy 1: standard radiogroup + radio role (works if Airtable uses ARIA)
  try {
    const group = page
      .getByRole('radiogroup', { name: groupLabel, exact: true })
      .or(page.getByRole('radiogroup', { name: labelRegex(groupLabel) }))
      .first();
    const radio = group
      .getByRole('radio', { name: optionLabel, exact: true })
      .or(group.getByRole('radio', { name: optionRegex }))
      .first();
    if (await radio.isVisible({ timeout: 2000 }).catch(() => false)) {
      await radio.check({ timeout: ACTION_TIMEOUT_MS });
      return optionLabel;
    }
  } catch { /* fall through */ }

  // Strategy 2: find the group label, scope to its field container,
  // then click the pill whose text matches optionLabel.
  // The field container is identified by walking up from the label until
  // we find a node that also contains the option text.
  try {
    const labelLoc = page
      .getByText(groupLabel, { exact: true })
      .or(page.getByText(labelRegex(groupLabel)))
      .first();

    if (await labelLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Walk up at most 6 ancestors to find a container that holds the option
      for (let depth = 1; depth <= 6; depth++) {
        const xpath = 'xpath=ancestor::*[' + depth + ']';
        const container = labelLoc.locator(xpath);
        const pill = container
          .getByText(optionLabel, { exact: true })
          .or(container.getByText(optionRegex))
          .first();
        if (await pill.isVisible({ timeout: 800 }).catch(() => false)) {
          await pill.click({ timeout: ACTION_TIMEOUT_MS });
          return optionLabel;
        }
      }
    }
  } catch { /* fall through */ }

  // Strategy 3: find the pill anywhere on the page by its exact text and click it.
  // Safe because each option label is unique on this form.
  try {
    const pill = page
      .getByText(optionLabel, { exact: true })
      .or(page.getByText(optionRegex))
      .first();
    if (await pill.isVisible({ timeout: 2000 }).catch(() => false)) {
      await pill.click({ timeout: ACTION_TIMEOUT_MS });
      return optionLabel;
    }
  } catch { /* fall through */ }

  throw new Error(
    'chooseRadio: could not find or click option "' + optionLabel + '" in group "' + groupLabel + '"'
  );
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
// pickDate / pickTime
//
// From the live form screenshot, the date and time fields are Airtable's
// custom picker cells -- NOT plain <input> elements when the page loads.
// The cell shows the current value (e.g. "5/10/2026", "10:47am") as text
// inside a styled div with a chevron. Clicking the cell opens a popover
// that contains a real <input> which we can then type into.
//
// Strategy:
//   1. Find the date/time CELL by its label row (contains "Fecha del evento"
//      or "Date of Event" text), then click the value area below it.
//   2. After click, wait up to 3s for any new <input> to become visible.
//   3. Type the value and press Escape to close the popover.
//   4. If anything fails at any step, skip silently -- date/time are
//      non-blocking fields.
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

async function clickDateTimeCell(page, labelTexts) {
  // Find the field label, then get its parent container, then click the
  // interactive value cell inside it (the div that shows the current value).
  for (const labelText of labelTexts) {
    try {
      const label = page.getByText(labelText, { exact: false }).first();
      if (!(await label.isVisible({ timeout: 2000 }).catch(() => false))) continue;

      // The clickable picker cell is a sibling/child of the label row.
      // We climb to the field container and click the first div/button
      // that looks like a value cell (has a chevron or shows a date-like value).
      const fieldContainer = label.locator('xpath=ancestor::*[self::div or self::section][position()<=4]').last();

      // Try clicking a combobox role first (most reliable)
      const combo = fieldContainer.getByRole('combobox').first();
      if (await combo.isVisible({ timeout: 1000 }).catch(() => false)) {
        await combo.click({ timeout: 3000, noWaitAfter: true });
        return true;
      }

      // Fallback: click the container itself to reveal the input
      await fieldContainer.click({ timeout: 3000, noWaitAfter: true });
      return true;
    } catch { /* try next label */ }
  }
  return false;
}

async function waitForNewInput(page, alreadyVisible, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inputs = await page.locator('input:visible').all().catch(() => []);
    const newInputs = inputs.filter(async (inp) => {
      try { return !(await inp.getAttribute('type') === 'hidden'); } catch { return false; }
    });
    if (inputs.length > alreadyVisible) {
      // Return the last appeared input (pickers append at end)
      return inputs[inputs.length - 1];
    }
    await page.waitForTimeout(150);
  }
  return null;
}

async function pickDate(page, isoDate) {
  if (!isoDate) return '';
  const label = airtableDateLabel(isoDate);
  try {
    // Count inputs before clicking so we can detect the new one
    const before = await page.locator('input:visible').count().catch(() => 0);

    // Click the date cell
    const clicked = await clickDateTimeCell(page, [
      'Fecha del evento', 'Date of Event', 'Date of event',
    ]);

    // After clicking, wait briefly for an input to appear
    await page.waitForTimeout(400);

    // Try every visible input -- the date input is likely the first one
    // or the one that wasn't there before
    const inputs = await page.locator('input:visible').all().catch(() => []);

    let typed = false;
    for (const inp of inputs) {
      try {
        await inp.scrollIntoViewIfNeeded({ timeout: 1000 });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.type(label, { delay: 30 });
        await page.keyboard.press('Escape');
        typed = true;
        break;
      } catch { /* try next */ }
    }

    if (!typed) {
      // Last resort: just type blind -- whatever has focus after clicking
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(label, { delay: 30 });
      await page.keyboard.press('Escape');
    }

    await page.waitForTimeout(200);
    console.log('[pickDate] typed:', label);
    return label;
  } catch (e) {
    console.warn('[pickDate] skipped:', e.message);
    return '';
  }
}

async function pickTime(page, hhmm) {
  if (!hhmm) return '';
  const [hh24, mm] = hhmm.split(':').map(Number);
  const label = airtableTimeLabel(hh24, mm);
  try {
    // The time picker sits next to the date picker inside the same row.
    // After filling the date, focus may still be in the date input.
    // We Tab once to move to the time input, or click the time cell directly.

    // Try Tab first (fast path when date was just filled)
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    // Check if a time-like input is now focused
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return { tag: el.tagName, placeholder: el.placeholder || '', value: el.value || '' };
    }).catch(() => null);

    if (focused && focused.tag === 'INPUT') {
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(label, { delay: 30 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      console.log('[pickTime] typed via Tab:', label);
      return label;
    }

    // Fallback: click the time cell by finding it near the date label
    const clicked = await clickDateTimeCell(page, [
      '10:', ':', 'am', 'pm', // time value patterns already on screen
    ]);
    await page.waitForTimeout(300);

    const inputs = await page.locator('input:visible').all().catch(() => []);
    // Time input is typically the second visible input (date is first)
    const timeInput = inputs[1] || inputs[0];
    if (timeInput) {
      await timeInput.scrollIntoViewIfNeeded({ timeout: 1000 });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(label, { delay: 30 });
      await page.keyboard.press('Escape');
    }

    await page.waitForTimeout(200);
    console.log('[pickTime] typed:', label);
    return label;
  } catch (e) {
    console.warn('[pickTime] skipped:', e.message);
    return '';
  }
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
  if (name === 'choose type of observation' || name === 'choose stop work authority' || name === 'choose follow-up status') return 20000;
  if (name === 'choose severity' || name === 'choose type of hazard' || name === 'choose positive/safe observation') return 20000;
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
    // Date / Time — run OUTSIDE stage() so withTimeout can never kill them.
    // Both functions are fully try/catch guarded internally and always resolve.
    stageName = 'fill date'; tracker.stage = 'fill date';
    console.log('form-service stage: fill date');
    await pickDate(page, payload.date_of_event);

    stageName = 'fill time'; tracker.stage = 'fill time';
    console.log('form-service stage: fill time');
    await pickTime(page, payload.time);

    // -----------------------------------------------------------------------
    // Project Site — linked-record popover.
    // Fallback: FIELD_DEFAULTS.project_site
    // -----------------------------------------------------------------------
   selected.project_site = await stage('choose project site', async () => {
  try {
    return await chooseLinkedProject(page, payload.project_site);
  } catch (error) {
    console.warn('[project_site] failed, trying default:', error.message);

    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);

    if (payload.project_site !== DEFAULTS.project_site) {
      try {
        return await chooseLinkedProject(page, DEFAULTS.project_site);
      } catch (fallbackError) {
       throw new Error('Project Site default also failed: ' + fallbackError.message);
      }
    }

    throw new Error('Project Site could not be selected. Please confirm the project exists in the Airtable form options.');
  }
});

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

    const shouldSubmit = payload.test_mode === false && SUBMIT_MODE === 'live';

if (shouldSubmit) {
  await stage('submit form', async () => {
    const submitButton = page
      .getByRole('button', { name: /Submit Observation/i })
      .or(page.getByRole('button', { name: /^Submit$/i }))
      .or(page.locator('button:has-text("Submit")'))
      .first();

    await submitButton.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    await submitButton.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });

    await page.waitForTimeout(3000);

    const successVisible = await page
      .getByText(/thank you|submitted|success|your response has been submitted/i)
      .first()
      .isVisible({ timeout: 12000 })
      .catch(() => false);

    const validationVisible = await page
      .getByText(/required|must be filled|please complete|invalid/i)
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (successVisible) {
      submitted = true;
      return;
    }

    if (validationVisible) {
      throw new Error('Airtable form validation failed after submit click.');
    }

    throw new Error('Submit clicked but no success confirmation was detected.');
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
  res.json({ ok: true, submit_mode: SUBMIT_MODE, version: 'v5-pill-radio' });
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