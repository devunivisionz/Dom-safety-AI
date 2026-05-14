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

const DEFAULTS = {
  project_site: FIELD_DEFAULTS.project_site,
  reporter_name: FIELD_DEFAULTS.reporter_name,
  reporter_email: FIELD_DEFAULTS.reporter_email,
  company_name: FIELD_DEFAULTS.company_name,
};

const TYPE_OF_OBSERVATION_LABELS = {
  'Unsafe Act': 'Unsafe Act (Acto Inseguro)',
  'Unsafe Condition': 'Unsafe Condition (Condición insegura)',
  'Positive/Safe Observation': 'Positive/Safe Observation (Observación positiva/segura)',
};

const STOP_WORK_LABELS = {
  Yes: 'Yes (Si)',
  'Not Required': 'Not Required (No Requerido)',
};

const FOLLOW_UP_LABELS = {
  'Corrected Onsite': 'Corrected Onsite (Corrigdo En El Sitio)',
  'Follow Up Needed': 'Follow Up Needed (Se Requiere Seguimiento)',
  NA: 'NA',
};

const SEVERITY_LABELS = {
  Low: 'Low',
  Medium: 'Medium',
  High: 'High',
};

const KNOWN_PROJECT_OPTIONS = [
  'Bauxite (BW150)',
  'Bauxite II (BWI110)',
  'Bauxite III (BWI100)',
  'Cinco',
  'Temple',
  'Temple Stampede',
];

const KNOWN_HAZARD_OPTIONS = [
  'Aerial Lifts/MEWP (Plataformas elevadoras (MEWP))',
  'Arc Flash (Arco eléctrico)',
  'Barricades (barricadas)',
  'Batteries (Baterías)',
  'Concrete/Masonry (Hormigón/Mampostería)',
];

const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/g;

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function escapeRegExp(value) {
  return String(value).replace(REGEX_SPECIALS, '\\$&');
}

function labelRegex(label) {
  const escaped = escapeRegExp(label).replace(/\\ /g, '\\s+');
  return new RegExp('^\\s*' + escaped + '\\s*\\*?\\s*:?\\s*$', 'i');
}

function isUnsetOption(value) {
  const text = clean(value).toLowerCase();
  return !text || text === 'none' || text === 'n/a' || text === 'na' || text === 'unknown';
}

function getBody(reqBody) {
  if (Array.isArray(reqBody)) {
    return reqBody[0] || {};
  }

  return reqBody || {};
}

function normalizeObservation(value) {
  const text = String(value || '').trim().toLowerCase();

  if (text.includes('unsafe condition')) return 'Unsafe Condition';
  if (text.includes('unsafe act')) return 'Unsafe Act';
  if (text.includes('positive') || text.includes('safe observation')) {
    return 'Positive/Safe Observation';
  }

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

function normalizePayload(rawBody) {
  const body = getBody(rawBody);

  const dateTime = splitDateTime(body.date_of_event, body.time);
  let observation = normalizeObservation(body.type_of_observation);

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
    test_mode: false,

    record_id: clean(body.record_id),

    date_of_event: dateTime.date,
    time: dateTime.time,

    project_site: clean(body.project_site) || FIELD_DEFAULTS.project_site,
    reporter_name: clean(body.reporter_name) || FIELD_DEFAULTS.reporter_name,
    reporter_email: clean(body.reporter_email) || FIELD_DEFAULTS.reporter_email,
    company_name: clean(body.company_name) || FIELD_DEFAULTS.company_name,

    contractor_observed: clean(body.contractor_observed) || 'None',
    type_of_observation: observation,

    type_of_hazard: clean(body.type_of_hazard) || FIELD_DEFAULTS.type_of_hazard,

    severity,
    positive_safe_observation: clean(body.positive_safe_observation),
    stop_work_authority_used: stopWork,

    description_of_event: clean(body.description_of_event),
    corrective_action: clean(body.corrective_action),
    followup_status: followUp,

    photo_base64: clean(body.photo_base64),
    photo_url: clean(body.photo_url),
    photo_filename:
      clean(body.photo_filename) ||
      (clean(body.record_id)
        ? `safety-observation-${clean(body.record_id)}.jpg`
        : 'safety-observation.jpg'),
    photo_content_type: clean(body.photo_content_type) || 'image/jpeg',

    selected_values: {
      type_of_observation: TYPE_OF_OBSERVATION_LABELS[observation],
      severity: SEVERITY_LABELS[severity],
      stop_work_authority_used: STOP_WORK_LABELS[stopWork],
      followup_status: FOLLOW_UP_LABELS[followUp],
    },
  };
}

function splitDateTime(dateValue, timeValue) {
  const fallback = new Date();
  const rawDate = clean(dateValue);
  const rawTime = clean(timeValue);

  const isoDate =
    rawDate.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
    fallback.toISOString().slice(0, 10);

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
  if (!value) return '';

  console.log(`[fillText] filling "${label}" with:`, value);

  const labelLocator = page
    .getByText(label, { exact: true })
    .or(page.getByText(labelRegex(label)))
    .first();

  await labelLocator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);

  try {
    const field = byLabel(page, label);

    if (await field.isVisible({ timeout: 3000 }).catch(() => false)) {
      await field.fill(String(value), { timeout: 5000 });
      return value;
    }
  } catch {}

  const filled = await page.evaluate(
    ({ labelText, nextValue }) => {
      const normalize = (text) => String(text || '').trim().replace(/\s+/g, ' ');

      const allNodes = Array.from(document.querySelectorAll('div, label, span, p'));
      const labelNode = allNodes.find((node) => {
        const style = window.getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const text = normalize(node.textContent);

        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 0 &&
          box.height > 0 &&
          text.includes(labelText)
        );
      });

      if (!labelNode) return false;

      const labelBox = labelNode.getBoundingClientRect();

      const inputs = Array.from(
        document.querySelectorAll('input:not([type="hidden"]), textarea')
      );

      const candidates = inputs
        .filter((input) => {
          const style = window.getComputedStyle(input);
          const box = input.getBoundingClientRect();

          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            box.width > 0 &&
            box.height > 0 &&
            box.top >= labelBox.top - 10
          );
        })
        .sort((a, b) => {
          const aBox = a.getBoundingClientRect();
          const bBox = b.getBoundingClientRect();
          return aBox.top - bBox.top;
        });

      const input = candidates[0];

      if (!input) return false;

      input.focus();

      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

      if (setter) {
        setter.call(input, nextValue);
      } else {
        input.value = nextValue;
      }

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));

      return true;
    },
    {
      labelText: label,
      nextValue: String(value),
    }
  );

  if (!filled) {
    console.warn(`[fillText] unable to fill "${label}", continuing`);
    return '';
  }

  return value;
}

async function listVisibleOptions(page) {
  const opts = await page.evaluate(() => {
    const out = [];
    const seen = new Set();

    const nodes = Array.from(
      document.querySelectorAll(
        '[role="option"], [role="listbox"] li, [role="listbox"] button, [role="dialog"] li, [role="dialog"] button, button, div, span'
      )
    );

    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();

      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (box.width === 0 || box.height === 0) continue;

      const text = (node.textContent || '').trim().replace(/\s+/g, ' ');

      if (!text || seen.has(text)) continue;

      seen.add(text);
      out.push(text);

      if (out.length >= 50) break;
    }

    return out;
  }).catch(() => []);

  return opts;
}

async function dismissOpenPopover(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
}

async function clickVisibleText(page, targetValue, options = {}) {
  const {
    maxTextLength = 160,
    allowPartial = true,
    preferExact = true,
  } = options;

  return page.evaluate(
    ({ targetValue, maxTextLength, allowPartial, preferExact }) => {
      const normalize = (text) => String(text || '').trim().replace(/\s+/g, ' ');
      const target = normalize(targetValue);
      const lowerTarget = target.toLowerCase();

      const nodes = Array.from(
        document.querySelectorAll(
          '[role="option"], [role="listbox"] li, [role="listbox"] button, [role="dialog"] li, [role="dialog"] button, button, label, span, div'
        )
      );

      const visibleNodes = nodes
        .map((node) => {
          const style = window.getComputedStyle(node);
          const box = node.getBoundingClientRect();
          const text = normalize(node.textContent);

          return {
            node,
            text,
            lowerText: text.toLowerCase(),
            style,
            box,
          };
        })
        .filter(({ style, box, text }) => {
          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            box.width > 0 &&
            box.height > 0 &&
            text &&
            text.length <= maxTextLength
          );
        });

      let match = null;

      if (preferExact) {
        match = visibleNodes.find(({ text }) => text === target);
      }

      if (!match && allowPartial) {
        match = visibleNodes.find(({ lowerText }) => {
          return lowerText.includes(lowerTarget) || lowerTarget.includes(lowerText);
        });
      }

      if (!match) return false;

      match.node.scrollIntoView({ block: 'center' });
      match.node.click();

      return true;
    },
    {
      targetValue,
      maxTextLength,
      allowPartial,
      preferExact,
    }
  );
}

async function chooseLinkedRecord(page, value, addNames, label, fallbackValues = []) {
  if (!value || isUnsetOption(value)) return '';

  console.log(`[${label}] selecting linked record:`, value);

  await dismissOpenPopover(page);

  const fieldLabel = page
    .getByText(label, { exact: true })
    .or(page.getByText(labelRegex(label)))
    .first();

  await fieldLabel.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);

  let addButton = null;

  for (const addName of addNames) {
    const addRegex = new RegExp('\\+?\\s*Add\\s+.*' + escapeRegExp(addName), 'i');

    const candidate = page
      .getByRole('button', { name: addRegex })
      .or(page.getByText(addRegex))
      .first();

    const visible = await candidate.isVisible({ timeout: 2500 }).catch(() => false);

    if (visible) {
      addButton = candidate;
      break;
    }
  }

  if (!addButton) {
    console.warn(`[${label}] add button not found. Trying direct visible-text click.`);
    const directClicked = await clickVisibleText(page, value, {
      maxTextLength: 160,
      allowPartial: true,
      preferExact: true,
    }).catch(() => false);

    if (directClicked) {
      await page.waitForTimeout(700);
      return value;
    }

    const fallbackDirect = await chooseFirstMatchingFallback(page, fallbackValues);

    if (fallbackDirect) return fallbackDirect;

    const visible = await listVisibleOptions(page);
    throw new Error(
      'No "+ Add" button found for linked field "' +
        label +
        '". Visible options: ' +
        (visible.length ? visible.join(' | ') : 'none')
    );
  }

  await addButton.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);

  await addButton.click({
    timeout: 5000,
    noWaitAfter: true,
    force: true,
  });

  await page.waitForTimeout(1000);

  const valuesToTry = [
    value,
    ...fallbackValues.filter((item) => item && item !== value),
  ];

  for (const attemptValue of valuesToTry) {
    await setSearchInputValue(page, attemptValue);
    await page.waitForTimeout(1000);

    const clicked = await clickVisibleText(page, attemptValue, {
      maxTextLength: 160,
      allowPartial: true,
      preferExact: true,
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(700);
      await page.keyboard.press('Escape').catch(() => undefined);
      return attemptValue;
    }
  }

  const firstClicked = await clickFirstSmallOption(page);

  if (firstClicked) {
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape').catch(() => undefined);
    return firstClicked;
  }

  const visible = await listVisibleOptions(page);

  throw new Error(
    'No matching linked option found for "' +
      label +
      '" value "' +
      value +
      '". Visible options: ' +
      (visible.length ? visible.join(' | ') : 'none')
  );
}

async function setSearchInputValue(page, value) {
  return page.evaluate((nextValue) => {
    const inputs = Array.from(
      document.querySelectorAll(
        'input[placeholder="Search"], input[placeholder="Find an option"], input[placeholder="Select an option"], input[aria-label="Search"], input[role="combobox"]'
      )
    );

    const visibleInput = inputs.find((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();

      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        box.width > 0 &&
        box.height > 0
      );
    });

    if (!visibleInput) return false;

    visibleInput.focus();

    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;

    if (setter) {
      setter.call(visibleInput, '');
      setter.call(visibleInput, nextValue);
    } else {
      visibleInput.value = '';
      visibleInput.value = nextValue;
    }

    visibleInput.dispatchEvent(new Event('input', { bubbles: true }));
    visibleInput.dispatchEvent(new Event('change', { bubbles: true }));

    return true;
  }, String(value)).catch(() => false);
}

async function chooseFirstMatchingFallback(page, fallbackValues = []) {
  for (const fallbackValue of fallbackValues) {
    const clicked = await clickVisibleText(page, fallbackValue, {
      maxTextLength: 160,
      allowPartial: true,
      preferExact: true,
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(700);
      return fallbackValue;
    }
  }

  return '';
}

async function clickFirstSmallOption(page) {
  return page.evaluate(() => {
    const normalize = (text) => String(text || '').trim().replace(/\s+/g, ' ');

    const nodes = Array.from(
      document.querySelectorAll(
        '[role="option"], [role="listbox"] li, [role="listbox"] button, [role="dialog"] li, [role="dialog"] button, button, span, div'
      )
    );

    const candidates = nodes
      .map((node) => {
        const style = window.getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const text = normalize(node.textContent);

        return { node, style, box, text };
      })
      .filter(({ style, box, text }) => {
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 0 &&
          box.height > 0 &&
          text &&
          text.length <= 120 &&
          !/submit|clear form|report malicious|do not submit/i.test(text)
        );
      });

    const candidate = candidates[0];

    if (!candidate) return '';

    candidate.node.scrollIntoView({ block: 'center' });
    candidate.node.click();

    return candidate.text;
  }).catch(() => '');
}

async function chooseLinkedProject(page, value) {
  return chooseLinkedRecord(
    page,
    value || FIELD_DEFAULTS.project_site,
    ['project'],
    'Project Site',
    [
      value,
      FIELD_DEFAULTS.project_site,
      ...KNOWN_PROJECT_OPTIONS,
    ].filter(Boolean)
  );
}

async function chooseComboByPartialMatch(page, label, value, fallbackValues = []) {
  if (!value || isUnsetOption(value)) {
    value = fallbackValues[0] || '';
  }

  if (!value) return '';

  console.log(`[${label}] choosing dropdown value:`, value);

  const combo = comboByLabel(page, label);

  await combo.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  await combo.click({
    timeout: ACTION_TIMEOUT_MS,
    noWaitAfter: true,
    force: true,
  });

  await page.waitForTimeout(700);

  const valuesToTry = [
    value,
    ...fallbackValues.filter((item) => item && item !== value),
  ];

  for (const attemptValue of valuesToTry) {
    await setSearchInputValue(page, attemptValue);
    await page.keyboard.type(String(attemptValue), { delay: 10 }).catch(() => undefined);
    await page.waitForTimeout(800);

    const clicked = await clickVisibleText(page, attemptValue, {
      maxTextLength: 180,
      allowPartial: true,
      preferExact: true,
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(700);
      await page.keyboard.press('Escape').catch(() => undefined);
      return attemptValue;
    }
  }

  const firstClicked = await clickFirstSmallOption(page);

  if (firstClicked) {
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape').catch(() => undefined);
    return firstClicked;
  }

  const visible = await listVisibleOptions(page);

  console.warn(
    `No dropdown option found for "${label}" value "${value}". Continuing with payload/default. Visible options: ${
      visible.length ? visible.join(' | ') : 'none'
    }`
  );

  await page.keyboard.press('Escape').catch(() => undefined);

  return value;
}

async function chooseCombo(page, label, value) {
  return chooseComboByPartialMatch(page, label, value, [value]);
}

async function chooseRadio(page, groupLabel, optionLabel) {
  console.log(`[chooseRadio] group="${groupLabel}", option="${optionLabel}"`);

  const clicked = await clickVisibleText(page, optionLabel, {
    maxTextLength: 180,
    allowPartial: true,
    preferExact: true,
  }).catch(() => false);

  if (clicked) {
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape').catch(() => undefined);
    return optionLabel;
  }

  const visible = await listVisibleOptions(page);

  console.warn(
    'Could not click radio option "' +
      optionLabel +
      '" in group "' +
      groupLabel +
      '". Continuing with payload/default. Visible options: ' +
      (visible.length ? visible.join(' | ') : 'none')
  );

  return optionLabel;
}

async function chooseComboOrRadio(page, label, value) {
  if (!value) return '';

  try {
    return await chooseCombo(page, label, value);
  } catch (comboError) {
    console.warn(`[${label}] combo failed, trying radio:`, comboError.message);
    return chooseRadio(page, label, value);
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

async function withFallback(
  page,
  {
    fieldName,
    value,
    defaultValue,
    primaryFn,
    fallbackFn,
    fallbacksUsed,
    warn = console.warn,
  }
) {
  try {
    return await primaryFn();
  } catch (primaryError) {
    warn(
      '[fallback] field "' +
        fieldName +
        '" value "' +
        value +
        '" failed. Error: ' +
        primaryError.message
    );

    fallbacksUsed.push({
      field: fieldName,
      tried: value,
      usedDefault: defaultValue || null,
      error: primaryError.message,
    });

    await dismissOpenPopover(page);

    if (defaultValue !== null && defaultValue !== undefined && defaultValue !== '') {
      try {
        if (fallbackFn) return await fallbackFn();
      } catch (fallbackError) {
        warn(
          '[fallback] field "' +
            fieldName +
            '" default "' +
            defaultValue +
            '" also failed. Continuing. Error: ' +
            fallbackError.message
        );
      }

      return defaultValue;
    }

    return value || null;
  }
}

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

async function setInputValueByPlaceholder(page, placeholderPart, value) {
  if (!value) return '';

  const input = page.locator(`input[placeholder*="${placeholderPart}"]`).first();

  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.warn(`[${placeholderPart}] input not visible, skipping`);
    return '';
  }

  await input.evaluate((element, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;

    if (setter) {
      setter.call(element, nextValue);
    } else {
      element.value = nextValue;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }, String(value));

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);

  return value;
}

async function pickDate(page, isoDate) {
  if (!isoDate) return '';

  const label = airtableDateLabel(isoDate);
  return setInputValueByPlaceholder(page, 'mm/dd', label);
}

async function pickTime(page, hhmm) {
  if (!hhmm) return '';

  const [hh24, mm] = hhmm.split(':').map(Number);
  const label = airtableTimeLabel(hh24, mm);

  return setInputValueByPlaceholder(page, 'hh:mm', label);
}

function artifactUrl(req, path) {
  if (!path) return '';

  const origin = req.protocol + '://' + req.get('host');
  const relative = path.startsWith(tmpdir())
    ? path.slice(tmpdir().length).replace(/^\/+/, '')
    : path;

  return (
    origin +
    '/artifacts/' +
    relative
      .split('/')
      .map(encodeURIComponent)
      .join('/')
  );
}

async function safeScreenshot(page, path) {
  if (!page) return '';

  try {
    await withTimeout(
      page.screenshot({
        path,
        fullPage: false,
        timeout: SCREENSHOT_TIMEOUT_MS,
      }),
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
  if (name === 'navigate Airtable form') return NAVIGATION_TIMEOUT_MS + 15000;
  if (name === 'wait Airtable network idle') return 25000;
  if (name === 'wait Airtable form ready') return FORM_READY_TIMEOUT_MS + 5000;
  if (name === 'wait for form inputs') return FORM_READY_TIMEOUT_MS + 5000;
  if (name === 'fill date') return 9000;
  if (name === 'fill time') return 7000;

  if (
    name === 'choose project site' ||
    name === 'choose contractor observed'
  ) {
    return 60000;
  }

  if (name === 'fill company') return 20000;

  if (
    name === 'choose type of observation' ||
    name === 'choose stop work authority' ||
    name === 'choose follow-up status'
  ) {
    return 20000;
  }

  if (
    name === 'choose severity' ||
    name === 'choose type of hazard' ||
    name === 'choose positive/safe observation'
  ) {
    return 20000;
  }

  if (name.includes('screenshot')) return SCREENSHOT_TIMEOUT_MS + 2000;

  return ACTION_TIMEOUT_MS + 5000;
}

async function dismissCookieBanner(page) {
  await page.keyboard.press('Escape').catch(() => undefined);

  await page
    .getByRole('button', { name: /close/i })
    .first()
    .click({ timeout: 2000 })
    .catch(() => undefined);

  await page
    .locator('button[aria-label="Close"]')
    .first()
    .click({ timeout: 2000 })
    .catch(() => undefined);
}

async function fillForm(payload, req, tracker = { stage: 'initializing' }) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'safety-observation-'));
  const selected = { ...payload.selected_values };
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

    return withTimeout(
      Promise.resolve().then(fn),
      stageTimeout(name),
      'Timed out during stage "' + name + '"'
    );
  };

  const withFB = (opts) =>
    withFallback(page, {
      ...opts,
      fallbacksUsed,
    });

  try {
    browser = await stage('launch browser', async () =>
      playwrightChromium.launch({
        headless: true,
        executablePath:
          process.env.CHROMIUM_EXECUTABLE_PATH ||
          (await serverlessChromium.executablePath()),
        args: [
          ...serverlessChromium.args,
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      })
    );

    context = await stage('create browser context', () =>
      browser.newContext({
        viewport: {
          width: 1280,
          height: 720,
        },
      })
    );

    page = await stage('create page', () => context.newPage());

    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await stage('navigate Airtable form', async () => {
      await page.goto(FORM_URL, {
        waitUntil: 'commit',
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      await page
        .waitForLoadState('domcontentloaded', {
          timeout: NAVIGATION_TIMEOUT_MS,
        })
        .catch(() => undefined);
    });

    await stage('wait Airtable network idle', () =>
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined)
    );

    await stage('wait Airtable form ready', () =>
      page
        .getByText(/Date\s+of\s+event/i)
        .first()
        .waitFor({ timeout: FORM_READY_TIMEOUT_MS })
    );

    await stage('dismiss cookie banner', () => dismissCookieBanner(page));

    await stage('wait for form inputs', async () => {
      const deadline = Date.now() + FORM_READY_TIMEOUT_MS;

      while (Date.now() < deadline) {
        const visible = await page.locator('input:visible').count().catch(() => 0);

        if (visible > 0) return;

        await page.waitForTimeout(400);
      }

      console.warn(
        '[wait for form inputs] no visible inputs after ' +
          FORM_READY_TIMEOUT_MS +
          'ms — proceeding anyway'
      );
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

    await stage('fill reporter name', () =>
      fillText(page, 'Your Name (First and Last)', payload.reporter_name)
    );

    await stage('fill reporter email', () =>
      fillText(page, 'Your Email Address', payload.reporter_email)
    );

    selected.company_name = await stage('fill company', async () => {
      const companyValue = payload.company_name || FIELD_DEFAULTS.company_name;
      await fillText(page, 'Name of Company', companyValue);
      return companyValue;
    });

    if (!isUnsetOption(payload.contractor_observed)) {
      selected.contractor_observed = await stage('choose contractor observed', () =>
        withFB({
          fieldName: 'contractor_observed',
          value: payload.contractor_observed,
          defaultValue: FIELD_DEFAULTS.contractor_observed,
          primaryFn: () =>
            chooseCombo(page, 'Name of Contractor Observed', payload.contractor_observed),
        })
      );
    } else {
      selected.contractor_observed = '';
    }

    const observationLabel =
      TYPE_OF_OBSERVATION_LABELS[payload.type_of_observation] ||
      TYPE_OF_OBSERVATION_LABELS[FIELD_DEFAULTS.type_of_observation];

    const fallbackObservationLabel =
      TYPE_OF_OBSERVATION_LABELS[FIELD_DEFAULTS.type_of_observation];

    selected.type_of_observation = await stage('choose type of observation', () =>
      withFB({
        fieldName: 'type_of_observation',
        value: observationLabel,
        defaultValue: fallbackObservationLabel,
        primaryFn: () => chooseRadio(page, 'Type of Observation', observationLabel),
        fallbackFn: () =>
          chooseRadio(page, 'Type of Observation', fallbackObservationLabel),
      })
    );

    await page.waitForTimeout(300);

    if (
      payload.type_of_observation === 'Positive/Safe Observation' &&
      payload.positive_safe_observation &&
      !payload.positive_safe_observation.includes('.')
    ) {
      selected.positive_safe_observation = await stageIfVisible(
        stage,
        'choose positive/safe observation',
        'Positive/Safe Observation',
        page,
        () =>
          withFB({
            fieldName: 'positive_safe_observation',
            value: payload.positive_safe_observation,
            defaultValue: FIELD_DEFAULTS.positive_safe_observation,
            primaryFn: () =>
              chooseCombo(
                page,
                'Positive/Safe Observation',
                payload.positive_safe_observation
              ),
          })
      );
    } else {
      selected.positive_safe_observation = '';
    }

    if (payload.type_of_observation !== 'Positive/Safe Observation') {
      selected.type_of_hazard = await stageIfVisible(
        stage,
        'choose type of hazard',
        'Type of Hazard',
        page,
        () =>
          withFB({
            fieldName: 'type_of_hazard',
            value: payload.type_of_hazard,
            defaultValue: FIELD_DEFAULTS.type_of_hazard,
            primaryFn: () =>
              chooseComboByPartialMatch(
                page,
                'Type of Hazard',
                payload.type_of_hazard,
                [
                  FIELD_DEFAULTS.type_of_hazard,
                  ...KNOWN_HAZARD_OPTIONS,
                ]
              ),
            fallbackFn: () =>
              chooseComboByPartialMatch(
                page,
                'Type of Hazard',
                FIELD_DEFAULTS.type_of_hazard,
                KNOWN_HAZARD_OPTIONS
              ),
          })
      );
    } else {
      selected.type_of_hazard = '';
    }

    selected.severity = await stageIfVisible(
      stage,
      'choose severity',
      'Severity',
      page,
      () =>
        withFB({
          fieldName: 'severity',
          value: SEVERITY_LABELS[payload.severity],
          defaultValue: SEVERITY_LABELS[FIELD_DEFAULTS.severity],
          primaryFn: () =>
            chooseComboOrRadio(page, 'Severity', SEVERITY_LABELS[payload.severity]),
          fallbackFn: () =>
            chooseComboOrRadio(
              page,
              'Severity',
              SEVERITY_LABELS[FIELD_DEFAULTS.severity]
            ),
        })
    );

    selected.confirmation_checked = await stage('check confirmation', () =>
      checkCheckboxIfPresent(page, 'Please check this box')
    );

    const stopWorkLabel =
      STOP_WORK_LABELS[payload.stop_work_authority_used] ||
      STOP_WORK_LABELS[FIELD_DEFAULTS.stop_work_authority_used];

    const fallbackStopWorkLabel =
      STOP_WORK_LABELS[FIELD_DEFAULTS.stop_work_authority_used];

    selected.stop_work_authority_used = await stage('choose stop work authority', () =>
      withFB({
        fieldName: 'stop_work_authority_used',
        value: stopWorkLabel,
        defaultValue: fallbackStopWorkLabel,
        primaryFn: () =>
          chooseRadio(page, 'Stop Work Authority Used?', stopWorkLabel),
        fallbackFn: () =>
          chooseRadio(page, 'Stop Work Authority Used?', fallbackStopWorkLabel),
      })
    );

    await stage('fill description', async () => {
      const text = payload.description_of_event || payload.positive_safe_observation;

      if (!text) return;

      const visibleA = await isFieldVisible(page, 'Description of Event (original)');
      const labelToUse = visibleA
        ? 'Description of Event (original)'
        : 'Description of Event';

      await fillText(page, labelToUse, text);
    });

    await stageIfVisible(
      stage,
      'fill corrective action',
      'Corrective Action',
      page,
      () => fillText(page, 'Corrective Action', payload.corrective_action)
    );

    const followUpLabel =
      FOLLOW_UP_LABELS[payload.followup_status] ||
      FOLLOW_UP_LABELS[FIELD_DEFAULTS.followup_status];

    const fallbackFollowUpLabel =
      FOLLOW_UP_LABELS[FIELD_DEFAULTS.followup_status];

    selected.followup_status = await stage('choose follow-up status', () =>
      withFB({
        fieldName: 'followup_status',
        value: followUpLabel,
        defaultValue: fallbackFollowUpLabel,
        primaryFn: () =>
          chooseRadio(
            page,
            'Was the issue corrected onsite or is follow up needed?',
            followUpLabel
          ),
        fallbackFn: () =>
          chooseRadio(
            page,
            'Was the issue corrected onsite or is follow up needed?',
            fallbackFollowUpLabel
          ),
      })
    );

    if (payload.photo_base64 || payload.photo_url) {
      await stage('attach photo', async () => {
        const photoPath = join(tmpDir, payload.photo_filename);

        if (payload.photo_base64) {
          await writeFile(photoPath, Buffer.from(payload.photo_base64, 'base64'));
        } else {
          const response = await fetch(payload.photo_url);

          if (!response.ok) {
            throw new Error(
              'Unable to download photo_url: ' +
                response.status +
                ' ' +
                response.statusText
            );
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

    const shouldSubmit = true;

    if (shouldSubmit) {
      await stage('submit form', async () => {
        const submitButton = page
          .getByRole('button', { name: /Submit Observation/i })
          .or(page.getByRole('button', { name: /^Submit$/i }))
          .or(page.locator('button:has-text("Submit")'))
          .first();

        await submitButton.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });

        await submitButton.click({
          timeout: ACTION_TIMEOUT_MS,
          noWaitAfter: true,
        });

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

    await withTimeout(context.close(), 5000, 'Timed out closing browser context').catch(
      () => undefined
    );

    await withTimeout(browser.close(), 5000, 'Timed out closing browser').catch(
      () => undefined
    );

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
      await withTimeout(context.close(), 5000, 'Timed out closing browser context').catch(
        () => undefined
      );
    }

    if (browser) {
      await withTimeout(browser.close(), 5000, 'Timed out closing browser').catch(
        () => undefined
      );
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
        error:
          'Form automation exceeded ' +
          REQUEST_TIMEOUT_MS +
          'ms before returning a result. Last stage: ' +
          (tracker.stage || 'unknown'),
        artifacts: {},
      });
    }, REQUEST_TIMEOUT_MS);
  });
}

function safeLogPayload(label, data) {
  const copy = JSON.parse(JSON.stringify(data || {}));

  if (copy.photo_base64) {
    copy.photo_base64 =
      '[base64 hidden, length=' + String(data.photo_base64 || '').length + ']';
  }

  if (copy.photo_url) {
    copy.photo_url = '[photo_url present]';
  }

  console.log(label, JSON.stringify(copy, null, 2));
}

async function submitObservationForm(req, res) {
  if (TOKEN && req.get('authorization') !== 'Bearer ' + TOKEN) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
    });
    return;
  }

  console.log('================ FORM REQUEST START ================');
  console.log('request timestamp:', new Date().toISOString());
  console.log('submit_mode:', SUBMIT_MODE);

  safeLogPayload('[RAW BODY FROM N8N]', req.body || {});

  const payload = normalizePayload(req.body || {});

  safeLogPayload('[NORMALIZED PAYLOAD USED BY SCRIPT]', payload);

  console.log(
    '[PAYLOAD CHECK]',
    JSON.stringify(
      {
        raw_project_site: getBody(req.body)?.project_site,
        normalized_project_site: payload.project_site,

        raw_company_name: getBody(req.body)?.company_name,
        normalized_company_name: payload.company_name,

        raw_type_of_observation: getBody(req.body)?.type_of_observation,
        normalized_type_of_observation: payload.type_of_observation,

        raw_type_of_hazard: getBody(req.body)?.type_of_hazard,
        normalized_type_of_hazard: payload.type_of_hazard,

        raw_positive_safe_observation: getBody(req.body)?.positive_safe_observation,
        normalized_positive_safe_observation: payload.positive_safe_observation,

        raw_test_mode: getBody(req.body)?.test_mode,
        normalized_test_mode: payload.test_mode,

        submit_mode: SUBMIT_MODE,
      },
      null,
      2
    )
  );

  const tracker = {
    stage: 'queued',
  };

  const result = await Promise.race([
    fillForm(payload, req, tracker),
    timeoutResult(payload, tracker),
  ]);

  safeLogPayload('[FINAL RESULT]', result);

  console.log('================ FORM REQUEST END ==================');

  res.status(200).json(result);
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'AI Safety Manager Form Service',
    submit_mode: SUBMIT_MODE,
    version: 'v21-payload-default-browser-fallback',
    endpoints: ['GET /health', 'POST /submit-observation-form', 'POST /'],
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    submit_mode: SUBMIT_MODE,
    version: 'v21-payload-default-browser-fallback',
  });
});

app.post('/', submitObservationForm);
app.post('/submit-observation-form', submitObservationForm);

app.listen(PORT, () => {
  console.log('AI Safety Manager form service listening on ' + PORT);
});