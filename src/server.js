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
const FORCE_CORRECTED_ONSITE = process.env.FORM_FORCE_CORRECTED_ONSITE !== 'false';

const ACTION_TIMEOUT_MS = Number(process.env.FORM_ACTION_TIMEOUT_MS || 60000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.FORM_NAVIGATION_TIMEOUT_MS || 90000);
const FORM_READY_TIMEOUT_MS = Number(process.env.FORM_READY_TIMEOUT_MS || 60000);
const FORM_READY_SELECTOR = 'input:visible, textarea:visible, [role="combobox"]:visible';
const NAVIGATION_RETRIES = Number(process.env.FORM_NAVIGATION_RETRIES || 3);
const NAVIGATION_RETRY_DELAY_MS = Number(process.env.FORM_NAVIGATION_RETRY_DELAY_MS || 3000);
const NAVIGATION_STAGE_TIMEOUT_MS = Number(
  process.env.FORM_NAVIGATION_STAGE_TIMEOUT_MS
    || ((NAVIGATION_TIMEOUT_MS + FORM_READY_TIMEOUT_MS + NAVIGATION_RETRY_DELAY_MS)
      * NAVIGATION_RETRIES)
    + 5000,
);
const SUBMIT_STAGE_TIMEOUT_MS = Number(process.env.FORM_SUBMIT_STAGE_TIMEOUT_MS || 60000);
const REQUEST_TIMEOUT_MS = Number(
  process.env.FORM_REQUEST_TIMEOUT_MS || NAVIGATION_STAGE_TIMEOUT_MS + 90000,
);
const CHROMIUM_LAUNCH_ARGS = buildChromiumLaunchArgs(serverlessChromium.args);

const FIELD_DEFAULTS = {
  project_site: 'Bauxite II (BWI110)',
  reporter_name: 'Dominique Palmer',
  reporter_email: 'Palmerdom84@gmail.com',
  company_name: 'Turner Construction',
  contractor_observed: 'Other',
  type_of_observation: 'Unsafe Condition',
  type_of_hazard: 'Fall Protection',
  stop_work_authority_used: 'Not Required',
  followup_status: 'Corrected Onsite',
  corrective_action: 'testing form',
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
const HAZARD_OPTION_IDS = {
  'Fall Protection': 'selkBl5v11ihHoGJE',
  'Fall Protection (Protección contra caídas)': 'selkBl5v11ihHoGJE',
  selmDXuIL4eJ844NA: 'selkBl5v11ihHoGJE',
  selkBl5v11ihHoGJE: 'selkBl5v11ihHoGJE',
};
const HAZARD_OPTION_LABELS = {
  selmDXuIL4eJ844NA: 'Fall Protection',
  selkBl5v11ihHoGJE: 'Fall Protection',
};
const AIRTABLE_FIELD_IDS = {
  fromFormPageElementId: 'pelKHKIhfuvHYpIcB',
  tableId: 'tblxvZNqJY3EZ8uL0',
  project: 'fldyEFhAX7NiO8GWd',
  date: 'flddgn6xC3BK2MHOQ',
  name: 'fld117rscww5CwOIK',
  email: 'fld663JWIHg0F739M',
  company: 'flddBuw7EGIRupKIN',
  contractor: 'fldYiqjzBDrnf52sv',
  observation: 'fldMdj34aMlS5a08d',
  hazard: 'fld2oMD27DOG499fC',
  stopWork: 'fld9IOlpiDv6QK5rB',
  description: 'fld4WPpV4lrFvVDZk',
  followup: 'fldfpXjx1ec9rFafk',
  correctiveAction: 'fldKr9dcPMMcNVoct',
  daysToComplete: 'fldz0dpH8vZoOT1As',
  assignedTo: 'fldPCT3Xz2BvBC8Nm',
};
const KNOWN_PROJECT_OPTIONS = [
  'Bauxite (BW150)', 'Bauxite II (BWI110)', 'Bauxite III (BWI100)',
  'Cinco', 'Temple', 'Temple Stampede',
];

function clean(v) { return v === undefined || v === null ? '' : String(v).trim(); }
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
function normalizeHazard(value) {
  const v = clean(value) || FIELD_DEFAULTS.type_of_hazard;
  return HAZARD_OPTION_IDS[v] || v;
}
function normalizeHazardLabel(value) {
  const v = clean(value) || FIELD_DEFAULTS.type_of_hazard;
  const lower = v.toLowerCase();
  if (HAZARD_OPTION_LABELS[v]) return HAZARD_OPTION_LABELS[v];
  if (lower.includes('fall protection') || lower.includes('protección contra caídas')) {
    return 'Fall Protection';
  }
  return v;
}
function normalizeDaysToComplete(value) {
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days : FIELD_DEFAULTS.days_to_complete;
}
function normalizeContractorObserved(value) {
  const v = clean(value);
  if (!v || ['none', 'n/a', 'na', 'no', 'not applicable'].includes(v.toLowerCase())) {
    return FIELD_DEFAULTS.contractor_observed;
  }
  return v;
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
  const fu = FORCE_CORRECTED_ONSITE ? 'Corrected Onsite' : normalizeFollowUp(body.followup_status);
  const hazardLabel = normalizeHazardLabel(body.type_of_hazard);
  const hazardId = normalizeHazard(hazardLabel);
  const correctiveAction = clean(body.corrective_action) || FIELD_DEFAULTS.corrective_action;
  return {
    test_mode: false,
    record_id: clean(body.record_id),
    date_of_event: dt.date,
    time: dt.time,
    project_site: clean(body.project_site) || FIELD_DEFAULTS.project_site,
    reporter_name: clean(body.reporter_name) || FIELD_DEFAULTS.reporter_name,
    reporter_email: clean(body.reporter_email) || FIELD_DEFAULTS.reporter_email,
    company_name: clean(body.company_name) || FIELD_DEFAULTS.company_name,
    contractor_observed: normalizeContractorObserved(body.contractor_observed),
    type_of_observation: obs,
    type_of_hazard: hazardLabel,
    type_of_hazard_id: hazardId,
    positive_safe_observation: clean(body.positive_safe_observation),
    stop_work_authority_used: sw,
    description_of_event: clean(body.description_of_event),
    corrective_action: correctiveAction,
    followup_status: fu,
    assigned_to: clean(body.assigned_to),
    days_to_complete: normalizeDaysToComplete(body.days_to_complete),
    photo_base64: clean(body.photo_base64),
    photo_url: clean(body.photo_url),
    selected_values: {
      type_of_observation: TYPE_OF_OBSERVATION_LABELS[obs],
      type_of_hazard: hazardId,
      stop_work_authority_used: STOP_WORK_LABELS[sw],
      followup_status: FOLLOW_UP_LABELS[fu],
    },
  };
}

function validatePayloadBeforeFill(payload) {
  if (!payload.days_to_complete) {
    payload.days_to_complete = FIELD_DEFAULTS.days_to_complete;
  }

  if (!payload.corrective_action) {
    payload.corrective_action = FIELD_DEFAULTS.corrective_action;
  }

  if (FORCE_CORRECTED_ONSITE) {
    payload.followup_status = 'Corrected Onsite';
  }

  if (payload.type_of_observation === 'Unsafe Condition' && !payload.type_of_hazard) {
    payload.type_of_hazard = FIELD_DEFAULTS.type_of_hazard;
  }

  payload.type_of_hazard = normalizeHazardLabel(payload.type_of_hazard);
  payload.type_of_hazard_id = normalizeHazard(payload.type_of_hazard);

  if (payload.followup_status === 'Follow Up Needed' && !payload.assigned_to) {
    throw new Error('Follow Up Needed requires assigned_to field.');
  }

  payload.selected_values = {
    ...payload.selected_values,
    type_of_hazard: payload.type_of_hazard_id,
    followup_status: FOLLOW_UP_LABELS[payload.followup_status],
  };

  return payload;
}

function withTimeout(promise, ms, msg) {
  let tid;
  const t = new Promise((_, rej) => { tid = setTimeout(() => rej(new Error(msg)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(tid));
}

function buildChromiumLaunchArgs(baseArgs) {
  const disableFeaturesPrefix = '--disable-features=';
  const disableFeatures = [];
  const launchArgs = [
    ...baseArgs,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--disable-extensions',
  ];

  const args = launchArgs.filter((arg) => {
    if (!arg.startsWith(disableFeaturesPrefix)) return true;

    disableFeatures.push(...arg.slice(disableFeaturesPrefix.length).split(',').filter(Boolean));
    return false;
  });

  return Array.from(new Set([
    ...args,
    disableFeaturesPrefix + Array.from(new Set(disableFeatures)).join(','),
  ]));
}

async function navigateWithRetry(page, url, retries = NAVIGATION_RETRIES) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      console.log(`[navigate] attempt ${attempt}`);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      await page.waitForSelector(FORM_READY_SELECTOR, {
        timeout: FORM_READY_TIMEOUT_MS,
      });

      console.log('[navigate] Airtable form ready');
      return true;
    } catch (err) {
      lastError = err;
      console.log(`[navigate] attempt ${attempt} failed: ${err.message}`);

      if (attempt < retries) await page.waitForTimeout(NAVIGATION_RETRY_DELAY_MS);
    }
  }

  throw new Error(`[navigate Airtable form] Failed after retries: ${lastError.message}`);
}

async function clickSubmitButton(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }).catch(() => undefined);
  await page.waitForTimeout(1000);

  const locators = [
    page.getByRole('button', { name: /submit observation|submit/i }).last(),
    page.locator('button:visible').filter({ hasText: /submit/i }).last(),
    page.locator('[role="button"]:visible').filter({ hasText: /submit/i }).last(),
    page.locator('input[type="submit"]:visible').last(),
  ];

  let lastError;
  for (const locator of locators) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
      await locator.click({ timeout: 10000 });
      return locator;
    } catch (err) {
      lastError = err;
    }
  }

  const domResult = await page.evaluate(() => {
    const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');
    const isVisible = (n) => {
      if (!n || !(n instanceof Element)) return false;
      const s = window.getComputedStyle(n);
      const b = n.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
    };
    const labelFor = (n) => norm(
      n.innerText || n.textContent || n.value || n.getAttribute('aria-label') || '',
    );
    const controls = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .filter(isVisible);
    const direct = controls.find((n) => /submit/i.test(labelFor(n)));
    const nested = Array.from(document.querySelectorAll('*'))
      .filter(isVisible)
      .find((n) => /submit/i.test(labelFor(n)) && n.closest('button, [role="button"], input[type="submit"]'));
    const target = direct || nested?.closest('button, [role="button"], input[type="submit"]');

    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.click();
      return { clicked: true, label: labelFor(target) };
    }

    return {
      clicked: false,
      visible_buttons: controls.map(labelFor).filter(Boolean).slice(-20),
    };
  });

  if (domResult.clicked) {
    console.log('[submit form] clicked submit via DOM fallback:', domResult.label);
    return null;
  }

  const screenshotPath = `/tmp/airtable-submit-button-missing-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  console.log('[submit form] submit button missing screenshot:', screenshotPath);
  console.log('[submit form] visible buttons:', JSON.stringify(domResult.visible_buttons || []));
  throw new Error('Submit button not found: ' + (lastError?.message || 'no visible submit control'));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function locatorIsVisible(locator, timeout = 1000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function fillLocator(locator, value, page = null) {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout: 10000 });
  await target.scrollIntoViewIfNeeded({ timeout: 5000 });

  const isContentEditable = await target
    .evaluate((node) => node.isContentEditable || node.getAttribute('contenteditable') !== null)
    .catch(() => false);
  if (isContentEditable) {
    await target.click({ position: { x: 20, y: 20 }, timeout: 10000 });
    if (page) {
      await page.keyboard.type(String(value), { delay: 25 });
      await page.waitForTimeout(150);
      await page.keyboard.press('Tab').catch(() => undefined);
      await page.waitForTimeout(150);
    } else {
      await target.pressSequentially(String(value), { delay: 5, timeout: 10000 });
    }
    return;
  }

  await target.fill(String(value), { timeout: 10000 });
  await target.blur().catch(() => undefined);
}

async function clickOption(page, value, { exact = true } = {}) {
  const name = exact ? value : new RegExp(escapeRegExp(value), 'i');
  const candidates = exact
    ? [
      page.getByRole('option', { name, exact: true }).last(),
      page.getByText(value, { exact: true }).last(),
    ]
    : [
      page.getByRole('option', { name }).first(),
      page.getByText(name).first(),
    ];

  let lastError;
  for (const option of candidates) {
    try {
      await option.waitFor({ state: 'visible', timeout: 4000 });
      await option.scrollIntoViewIfNeeded({ timeout: 5000 });
      await option.click({ timeout: 10000 });
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Option not found: ${value}`);
}

async function selectFromDropdown(page, opener, value, { exact = true, search = true } = {}) {
  const target = opener.first();
  await target.waitFor({ state: 'visible', timeout: 10000 });
  await target.scrollIntoViewIfNeeded({ timeout: 5000 });

  const currentText = await target.textContent().catch(() => '');
  if (currentText && currentText.includes(value)) return true;

  await target.click({ timeout: 10000 });
  await page.waitForTimeout(500);

  if (search) {
    const searchBox = page
      .locator(
        'input[placeholder="Search"]:visible, input[placeholder="Find an option"]:visible, input[placeholder="Select an option"]:visible',
      )
      .last();
    if (await locatorIsVisible(searchBox, 1500)) {
      await searchBox.fill(value, { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(700);
    }
  }

  await clickOption(page, value, { exact });
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(500);
  return true;
}

async function clickRadio(page, label) {
  const radio = page.getByRole('radio', { name: label, exact: true }).first();
  await radio.waitFor({ state: 'visible', timeout: 10000 });
  await radio.scrollIntoViewIfNeeded({ timeout: 5000 });
  await radio.click({ timeout: 10000 });
}

async function fillVisibleAirtableControls(page, payload) {
  const report = [];
  const record = async (field, fn) => {
    try {
      const detail = await fn();
      report.push({ field, ok: true, detail });
    } catch (err) {
      report.push({ field, ok: false, detail: err.message });
    }
  };

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(500);

  await record('date_of_event', async () => {
    const input = page.locator('input[placeholder*="/yyyy"]:visible').first();
    const placeholder = await input.getAttribute('placeholder').catch(() => '');
    const label = airtableDateLabel(payload.date_of_event, placeholder);
    await fillLocator(input, label);
    return label;
  });

  await record('time', async () => {
    const [h, m] = payload.time.split(':').map(Number);
    const label = airtableTimeLabel(h, m);
    await fillLocator(page.locator('input[aria-label="Time"]:visible, input[placeholder*="hh:mm"]:visible').first(), label);
    return label;
  });

  await record('project_site', async () => {
    const selected = page.getByText(payload.project_site, { exact: true }).first();
    const dropdownSearch = page.locator('input[placeholder="Search"]:visible, input[placeholder="Find an option"]:visible').last();
    if (await locatorIsVisible(selected, 500) && !(await locatorIsVisible(dropdownSearch, 200))) {
      return payload.project_site;
    }
    await selectFromDropdown(
      page,
      page.locator('button[aria-label*="Project Site"]:visible, button:has-text("Add project"):visible').first(),
      payload.project_site,
      { exact: true, search: true },
    );
    return payload.project_site;
  });

  await record('reporter_name', async () => {
    await fillLocator(page.locator('textarea:visible').nth(0), payload.reporter_name);
    return payload.reporter_name;
  });

  await record('reporter_email', async () => {
    await fillLocator(page.locator('textarea:visible').nth(1), payload.reporter_email);
    return payload.reporter_email;
  });

  await record('company_name', async () => {
    await selectFromDropdown(page, page.locator('div[role="combobox"]:visible').nth(0), payload.company_name);
    return payload.company_name;
  });

  await record('contractor_observed', async () => {
    await selectFromDropdown(page, page.locator('div[role="combobox"]:visible').nth(1), payload.contractor_observed);
    return payload.contractor_observed;
  });

  await record('type_of_observation', async () => {
    const label = TYPE_OF_OBSERVATION_LABELS[payload.type_of_observation];
    await clickRadio(page, label);
    await page.waitForTimeout(500);
    return label;
  });

  if (payload.type_of_observation === 'Unsafe Condition') {
    await record('type_of_hazard', async () => {
      await selectFromDropdown(page, page.locator('div[role="combobox"]:visible').nth(2), payload.type_of_hazard, {
        exact: false,
        search: true,
      });
      return payload.type_of_hazard;
    });
  }

  await record('stop_work_authority_used', async () => {
    const label = STOP_WORK_LABELS[payload.stop_work_authority_used];
    await clickRadio(page, label);
    return label;
  });

  await record('followup_status', async () => {
    const label = FOLLOW_UP_LABELS[payload.followup_status];
    await clickRadio(page, label);
    await page.waitForTimeout(700);
    return label;
  });

  await record('description_of_event', async () => {
    await fillLocator(
      page.locator('[role="textbox"][contenteditable]:visible, [role="textbox"]:visible').first(),
      payload.description_of_event,
      page,
    );
    return payload.description_of_event;
  });

  await record('corrective_action', async () => {
    const textboxes = page.locator('[role="textbox"][contenteditable]:visible, [role="textbox"]:visible');
    await fillLocator(textboxes.nth(1), payload.corrective_action, page);
    return payload.corrective_action;
  });

  if (payload.followup_status === 'Follow Up Needed') {
    await record('assigned_to', async () => {
      await selectFromDropdown(
        page,
        page.locator('button[aria-label*="Corrective Action be assigned to"]:visible, button:has-text("Add person"):visible').first(),
        payload.assigned_to,
        { exact: true, search: true },
      );
      return payload.assigned_to;
    });

    await record('days_to_complete', async () => {
      const daysInput = page.locator('input:not([type="hidden"]):visible').last();
      await fillLocator(daysInput, payload.days_to_complete);
      return String(payload.days_to_complete);
    });
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(1000);
  return report;
}

async function collectValidationDiagnostics(page, payload) {
  const screenshotPath = `/tmp/airtable-validation-error-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

  const details = await page.evaluate((data) => {
    const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');
    const isVisible = (n) => {
      if (!n || !(n instanceof Element)) return false;
      const s = window.getComputedStyle(n);
      const b = n.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
    };
    const unique = (items) => Array.from(new Set(items.filter(Boolean)));
    const textFor = (n) => norm(
      n.innerText || n.textContent || n.value || n.getAttribute('aria-label') || '',
    );
    const interestingText = /required|must|please|missing|invalid|complete|hazard|corrective|days|assigned/i;
    const visibleTexts = unique(
      Array.from(document.querySelectorAll('body *'))
        .filter(isVisible)
        .map(textFor)
        .filter((text) => text.length > 0 && text.length < 220 && interestingText.test(text)),
    ).slice(0, 80);

    const fieldAliases = {
      project_site: ['Project Site', 'Project'],
      date_of_event: ['Date of event', 'Date'],
      time: ['Time'],
      reporter_name: ['Your Name', 'Reporter Name'],
      reporter_email: ['Your Email', 'Reporter Email'],
      company_name: ['Name of Company', 'Company Name'],
      type_of_observation: ['Type of Observation', 'Observation'],
      type_of_hazard: ['Type of Hazard', 'Hazard'],
      stop_work_authority_used: ['Stop Work Authority', 'Stop Work'],
      description_of_event: ['Description of Event', 'Description'],
      followup_status: ['Follow-up Status', 'Follow Up Status', 'Followup'],
      corrective_action: ['Corrective Action'],
      days_to_complete: ['Days to Complete', 'Days To Complete'],
      assigned_to: ['Who should the Corrective Action be assigned to', 'Assigned To'],
    };

    const controls = Array.from(document.querySelectorAll(
      'input:not([type="hidden"]), textarea, button, [role="button"], [role="combobox"], [role="radio"], [role="checkbox"]',
    )).filter(isVisible);
    const labels = Array.from(document.querySelectorAll('label, div, span, p')).filter(isVisible);

    const readField = (aliases) => {
      const wanted = aliases.map((alias) => alias.toLowerCase());
      const label = labels.find((n) => {
        const text = textFor(n).toLowerCase();
        return text.length < 180 && wanted.some((alias) => text.includes(alias));
      });
      if (!label) return { found_label: false, values: [] };

      const lb = label.getBoundingClientRect();
      const nearby = controls
        .filter((control) => {
          const b = control.getBoundingClientRect();
          return b.top >= lb.top - 30 && b.top <= lb.bottom + 180;
        })
        .slice(0, 8)
        .map((control) => textFor(control))
        .filter(Boolean);

      return {
        found_label: true,
        label: textFor(label).slice(0, 160),
        values: unique(nearby).slice(0, 8),
      };
    };

    const fieldChecks = Object.fromEntries(
      Object.entries(fieldAliases).map(([field, aliases]) => [field, readField(aliases)]),
    );

    return {
      url: window.location.href,
      expected: {
        type_of_hazard: data.type_of_hazard,
        contractor_observed: data.contractor_observed,
        followup_status: data.followup_status,
        corrective_action: data.corrective_action,
        days_to_complete: data.days_to_complete,
      },
      validation_texts: visibleTexts,
      field_checks: fieldChecks,
    };
  }, {
    type_of_hazard: payload.type_of_hazard,
    contractor_observed: payload.contractor_observed,
    followup_status: payload.followup_status,
    corrective_action: payload.corrective_action,
    days_to_complete: payload.days_to_complete,
  });

  return { ...details, screenshot_path: screenshotPath };
}

function airtableDateLabel(iso, formatHint = '') {
  const [y, m, d] = iso.split('-').map(Number);
  if (/dd\/mm/i.test(formatHint)) return d + '/' + m + '/' + y;
  return m + '/' + d + '/' + y;
}
function airtableTimeLabel(h, m) {
  const mer = h >= 12 ? 'pm' : 'am';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + String(m).padStart(2, '0') + mer;
}

async function fillForm(payload, req, tracker = { stage: 'initializing' }) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'safety-observation-'));
  const selected = { ...payload.selected_values };

  let browser, context, page;
  let submitted = false;
  let stageName = 'initializing';
  let submitOutcome = 'not_attempted';
  let validationDetails = null;

  const stage = async (name, fn, timeoutMs = 30000) => {
    stageName = name;
    tracker.stage = name;
    console.log('form-service stage: ' + name);
    return withTimeout(
      Promise.resolve().then(fn),
      timeoutMs,
      'Timed out during stage "' + name + '"',
    );
  };

  try {
    browser = await stage('launch browser', async () => playwrightChromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH
        || (await serverlessChromium.executablePath()),
      args: CHROMIUM_LAUNCH_ARGS,
    }));

    context = await stage('create browser context', () =>
      browser.newContext({ viewport: { width: 1280, height: 900 } }),
    );
    page = await stage('create page', () => context.newPage());
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await stage('navigate Airtable form', async () => {
      try {
        await navigateWithRetry(page, FORM_URL, NAVIGATION_RETRIES);
      } catch (err) {
        const screenshotPath = `/tmp/airtable-navigation-error-${Date.now()}.png`;

        await page.screenshot({
          path: screenshotPath,
          fullPage: true,
        }).catch(() => {});

        throw new Error(`[navigate Airtable form] ${err.message}`);
      }
    }, NAVIGATION_STAGE_TIMEOUT_MS);

    // Dismiss overlays
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);

    // Fill all fields with user-like Playwright interactions.
    await stage('fill all fields', async () => {
      const fillReport = await fillVisibleAirtableControls(page, payload);
      console.log('[fill all fields] report:', JSON.stringify(fillReport));

      if (process.env.FORM_ENABLE_LEGACY_DOM_FILL === 'true') {
        const legacyFillReport = await page.evaluate(async (data) => {
        const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');
        const asList = (v) => Array.isArray(v) ? v : [v];
        const report = [];
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const record = (field, ok, detail = '') => {
          report.push({ field, ok: Boolean(ok), detail });
          return ok;
        };
        const isVisible = (n) => {
          if (!n || !(n instanceof Element)) return false;
          const s = window.getComputedStyle(n);
          const b = n.getBoundingClientRect();
          return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
        };
        const setNativeValue = (input, value) => {
          const proto = input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(input, String(value));
          else input.value = String(value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        
        const findFieldContainer = (labelText, fieldId) => {
          if (fieldId) {
            const byFieldId = document.querySelector(
              `[data-field-id="${fieldId}"], [data-fieldid="${fieldId}"], [data-field="${fieldId}"], [id="${fieldId}"]`,
            );
            if (byFieldId) {
              return byFieldId.closest('[role="group"], fieldset, section, article, div') || byFieldId;
            }
          }

          const wanted = asList(labelText).map((t) => norm(t).toLowerCase()).filter(Boolean);
          const labels = Array.from(document.querySelectorAll('label, div, span, p'));
          const lbl = labels.find((n) => {
            const text = norm(n.textContent).toLowerCase();
            return isVisible(n)
              && wanted.some((label) => text.includes(label))
              && norm(n.textContent).length < 120;
          });
          return lbl?.closest('[role="group"], fieldset, section, article, div') || lbl || null;
        };

        // Helper to find input near label
        const findInputNearLabel = (labelText, fieldId) => {
          const container = findFieldContainer(labelText, fieldId);
          const inputSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea';
          const scoped = container
            ? Array.from(container.querySelectorAll(inputSelector)).filter(isVisible)
            : [];
          if (scoped.length > 0) return scoped[0];

          const wanted = asList(labelText).map((t) => norm(t).toLowerCase()).filter(Boolean);
          const labels = Array.from(document.querySelectorAll('label, div, span, p'));
          const lbl = labels.find((n) => {
            const text = norm(n.textContent).toLowerCase();
            return isVisible(n)
              && wanted.some((label) => text.includes(label))
              && norm(n.textContent).length < 120;
          });
          if (!lbl) return null;
          
          const lb = lbl.getBoundingClientRect();
          const inputs = Array.from(document.querySelectorAll(inputSelector));
          const candidates = inputs
            .filter((i) => {
              const b = i.getBoundingClientRect();
              return isVisible(i) && b.top >= lb.top - 20 && b.top <= lb.bottom + 120;
            })
            .sort((a, b) => Math.abs(a.getBoundingClientRect().top - lb.bottom) - Math.abs(b.getBoundingClientRect().top - lb.bottom));
          return candidates[0] || null;
        };

        // Fill text input
        const fillInput = (labelText, value, fieldId) => {
          if (value === undefined || value === null || value === '') return false;
          const input = findInputNearLabel(labelText, fieldId);
          if (input) {
            input.scrollIntoView({ block: 'center' });
            input.focus();
            setNativeValue(input, value);
            input.dispatchEvent(new Event('blur', { bubbles: true }));
            return true;
          }
          return false;
        };

        const textMatchesNeedles = (text, needles) => {
          const lower = norm(text).toLowerCase();
          return asList(needles)
            .map((needle) => norm(needle).toLowerCase())
            .filter(Boolean)
            .some((needle) => lower.includes(needle)
              || needle.split(/\s+/).every((word) => lower.includes(word)));
        };

        const findControlNearLabel = (labelText, fieldId, addText) => {
          const controls = Array.from(document.querySelectorAll(
            'button, [role="button"], [role="combobox"], input:not([type="hidden"]), textarea',
          )).filter(isVisible);
          const container = findFieldContainer(labelText, fieldId);
          const scopedControls = container ? controls.filter((control) => container.contains(control)) : [];
          const addNeedles = asList(addText || []);

          let control = scopedControls.find((n) => addNeedles.length > 0 && textMatchesNeedles(n.textContent, addNeedles));
          control ||= scopedControls.find((n) => n.getAttribute('role') === 'combobox');
          control ||= scopedControls.find((n) => n.tagName === 'BUTTON' || n.getAttribute('role') === 'button');
          control ||= scopedControls[0];
          if (control) return control;

          const wanted = asList(labelText).map((t) => norm(t).toLowerCase()).filter(Boolean);
          const labels = Array.from(document.querySelectorAll('label, div, span, p'));
          const lbl = labels.find((n) => {
            const text = norm(n.textContent).toLowerCase();
            return isVisible(n)
              && wanted.some((label) => text.includes(label))
              && norm(n.textContent).length < 140;
          });
          if (lbl) {
            const lb = lbl.getBoundingClientRect();
            const nearby = controls
              .filter((candidate) => {
                const b = candidate.getBoundingClientRect();
                return b.top >= lb.top - 20 && b.top <= lb.bottom + 180;
              })
              .sort((a, b) => Math.abs(a.getBoundingClientRect().top - lb.bottom) - Math.abs(b.getBoundingClientRect().top - lb.bottom));
            control = nearby.find((n) => addNeedles.length > 0 && textMatchesNeedles(n.textContent, addNeedles));
            control ||= nearby.find((n) => n.getAttribute('role') === 'combobox');
            control ||= nearby.find((n) => n.tagName === 'BUTTON' || n.getAttribute('role') === 'button');
            control ||= nearby[0];
          }

          if (!control && addNeedles.length > 0) {
            control = controls.find((n) => textMatchesNeedles(n.textContent, addNeedles));
          }

          return control || null;
        };

        // Click by text
        const clickByText = (text, exact = false) => {
          const t = norm(text);
          const lt = t.toLowerCase();
          const all = Array.from(document.querySelectorAll(
            '[role="option"],[role="radio"],[role="checkbox"],button,label,span,div,li',
          ));
          const visible = all.filter(isVisible);
          let match = exact 
            ? visible.find((n) => norm(n.textContent) === t)
            : visible.find((n) => norm(n.textContent).toLowerCase().includes(lt));
          if (match) {
            match.scrollIntoView({ block: 'nearest' });
            match.click();
            return true;
          }
          return false;
        };

        const clickByOption = (texts, optionId) => {
          const wanted = asList(texts).map(norm).filter(Boolean);
          const lowerWanted = wanted.map((text) => text.toLowerCase());
          const all = Array.from(document.querySelectorAll(
            '[role="option"],[role="radio"],[role="checkbox"],button,label,span,div,li',
          ));
          const visible = all.filter(isVisible);

          if (optionId) {
            const byId = visible.find((n) =>
              n.id === optionId
              || n.getAttribute('data-id') === optionId
              || n.getAttribute('data-option-id') === optionId
              || n.getAttribute('data-record-id') === optionId);
            if (byId) {
              byId.scrollIntoView({ block: 'nearest' });
              byId.click();
              return true;
            }
          }

          let match = visible.find((n) => wanted.includes(norm(n.textContent)));
          if (!match) {
            match = visible.find((n) => lowerWanted.some((text) =>
              norm(n.textContent).toLowerCase().includes(text)));
          }
          if (match) {
            match.scrollIntoView({ block: 'nearest' });
            match.click();
            return true;
          }
          return false;
        };

        const chooseFieldOption = async (labelText, value, { fieldId, optionId, addText } = {}) => {
          if (!value) return false;
          if (clickByOption(value, optionId)) return true;

          const control = findControlNearLabel(labelText, fieldId, addText);
          if (control) {
            control.scrollIntoView({ block: 'center' });
            control.click();
          }

          await sleep(700);

          const searchBox = Array.from(document.querySelectorAll(
            'input[placeholder*="Search"], input[placeholder*="search"], input[role="combobox"]',
          )).filter(isVisible).at(-1);
          if (searchBox) {
            searchBox.focus();
            setNativeValue(searchBox, value);
            await sleep(700);
          }

          const clicked = clickByOption(value, optionId);
          await sleep(500);
          document.body.click();

          return clicked;
        };

        // 1. Date
        const dateInputs = Array.from(document.querySelectorAll('input[placeholder*="mm/dd"]'));
        if (dateInputs.length > 0 && data.date_of_event) {
          const [y, m, d] = data.date_of_event.split('-');
          dateInputs[0].focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(dateInputs[0], `${m}/${d}/${y}`);
          else dateInputs[0].value = `${m}/${d}/${y}`;
          dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
          record('date_of_event', true, `${m}/${d}/${y}`);
        } else {
          record('date_of_event', false, 'date input not found');
        }

        // 2. Time
        const timeInputs = Array.from(document.querySelectorAll('input[placeholder*="hh"]'));
        if (timeInputs.length > 0 && data.time) {
          const [h, m] = data.time.split(':');
          const hour = parseInt(h);
          const mer = hour >= 12 ? 'pm' : 'am';
          const h12 = hour % 12 || 12;
          timeInputs[0].focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(timeInputs[0], `${h12}:${m}${mer}`);
          else timeInputs[0].value = `${h12}:${m}${mer}`;
          timeInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          timeInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
          record('time', true, `${h12}:${m}${mer}`);
        } else {
          record('time', false, 'time input not found');
        }

        // 3. Project Site - click Add button then select
        record('project_site', await chooseFieldOption(
          ['Project Site', 'Project'],
          data.project_site,
          {
            fieldId: data.field_ids.project,
            addText: ['add project', 'add project site', 'add'],
          },
        ), data.project_site);

        // 4. Reporter Name
        record('reporter_name', fillInput(['Your Name', 'Reporter Name'], data.reporter_name, data.field_ids.name), data.reporter_name);

        // 5. Reporter Email
        record('reporter_email', fillInput(['Your Email', 'Reporter Email'], data.reporter_email, data.field_ids.email), data.reporter_email);

        // 6. Company Name
        record('company_name', fillInput(['Name of Company', 'Company Name'], data.company_name, data.field_ids.company), data.company_name);

        // 7. Type of Observation
        const obsLabel = data.type_of_observation === 'Unsafe Condition' 
          ? 'Unsafe Condition (Condición insegura)'
          : data.type_of_observation === 'Unsafe Act'
          ? 'Unsafe Act (Acto Inseguro)'
          : 'Positive/Safe Observation (Observación positiva/segura)';
        record('type_of_observation', clickByText(obsLabel, true), obsLabel);
        await sleep(1000);

        if (data.type_of_observation === 'Unsafe Condition') {
          record('type_of_hazard', await chooseFieldOption(
            ['Type of Hazard', 'Hazard'],
            data.type_of_hazard,
            {
              fieldId: data.field_ids.hazard,
              optionId: data.type_of_hazard_id,
              addText: ['add hazard', 'add type of hazard', 'add'],
            },
          ), data.type_of_hazard);
        }

        if (data.type_of_observation === 'Positive/Safe Observation') {
          record('positive_safe_observation', fillInput(
            ['Positive/Safe Observation', 'Positive Safe Observation'],
            data.positive_safe_observation,
          ), data.positive_safe_observation);
        }

        // 8. Stop Work Authority
        const swLabel = data.stop_work_authority_used === 'Yes' 
          ? 'Yes (Si)' 
          : 'Not Required (No Requerido)';
        record('stop_work_authority_used', clickByText(swLabel, true), swLabel);
        await sleep(500);

        // 9. Description
        record('description_of_event', fillInput(['Description of Event', 'Description'], data.description_of_event, data.field_ids.description), data.description_of_event);

        // 10. Follow-up Status
        const fuLabel = data.followup_status === 'Corrected Onsite'
          ? 'Corrected Onsite (Corrigdo En El Sitio)'
          : data.followup_status === 'Follow Up Needed'
          ? 'Follow Up Needed (Se Requiere Seguimiento)'
          : 'NA';
        record('followup_status', clickByText(fuLabel, true), fuLabel);
        await sleep(1200);

        record('corrective_action', fillInput(
          ['Corrective Action', 'Corrective action'],
          data.corrective_action,
          data.field_ids.correctiveAction,
        ), data.corrective_action);
        record('days_to_complete', fillInput(
          ['Days to Complete', 'Days To Complete', 'days to complete'],
          data.days_to_complete,
          data.field_ids.daysToComplete,
        ), String(data.days_to_complete));

        if (data.followup_status === 'Follow Up Needed') {
          record('assigned_to', await chooseFieldOption(
            ['Who should the Corrective Action be assigned to', 'Corrective Action be assigned to', 'Assigned To'],
            data.assigned_to,
            { fieldId: data.field_ids.assignedTo, addText: ['add assignee', 'add assigned', 'add'] },
          ), data.assigned_to);
        }

        await sleep(500);
        return report;

      }, {
        date_of_event: payload.date_of_event,
        time: payload.time,
        project_site: payload.project_site,
        reporter_name: payload.reporter_name,
        reporter_email: payload.reporter_email,
        company_name: payload.company_name,
        contractor_observed: payload.contractor_observed,
        type_of_observation: payload.type_of_observation,
        type_of_hazard: payload.type_of_hazard,
        type_of_hazard_id: payload.type_of_hazard_id,
        positive_safe_observation: payload.positive_safe_observation,
        stop_work_authority_used: payload.stop_work_authority_used,
        description_of_event: payload.description_of_event,
        corrective_action: payload.corrective_action,
        followup_status: payload.followup_status,
        assigned_to: payload.assigned_to,
        days_to_complete: payload.days_to_complete,
        field_ids: AIRTABLE_FIELD_IDS,
      });
        console.log('[legacy fill all fields] report:', JSON.stringify(legacyFillReport));
      }

      // Wait for all interactions to complete
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(1500);
    });

    // Submit
    submitOutcome = await stage('submit form', async () => {
      const urlBefore = page.url();
      const submitButton = await clickSubmitButton(page);

      const CAP_MS = 10000;
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

        submitButton
          ? submitButton.waitFor({ state: 'hidden', timeout: CAP_MS })
            .then(() => ({ kind: 'submit_button_hidden' })).catch(() => null)
          : Promise.resolve(null),

        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: 'cap_reached' }), CAP_MS + 200),
        ),
      ]);

      const kind = result?.kind || 'cap_reached';
      console.log('[submit form] outcome signal:', kind);

      if (kind === 'success_text' || kind === 'url_changed' || kind === 'submit_button_hidden') {
        submitted = true;
        return 'success_' + kind;
      }
      if (kind === 'validation_error') {
        validationDetails = await collectValidationDiagnostics(page, payload);
        console.log('[submit form] validation details:', JSON.stringify(validationDetails));
        return 'validation_error';
      }
      return 'unclear';
    }, SUBMIT_STAGE_TIMEOUT_MS);

    await withTimeout(context.close(), 5000, 'close context timeout').catch(() => undefined);
    await withTimeout(browser.close(), 5000, 'close browser timeout').catch(() => undefined);

    return {
      success: submitted,
      submitted,
      submit_outcome: submitOutcome,
      test_mode: payload.test_mode,
      submit_mode: SUBMIT_MODE,
      selected_values: selected,
      validation_details: validationDetails,
    };

  } catch (error) {
    if (context) await withTimeout(context.close(), 5000, 'close context timeout').catch(() => undefined);
    if (browser) await withTimeout(browser.close(), 5000, 'close browser timeout').catch(() => undefined);
    return {
      success: false,
      submitted,
      submit_outcome: submitOutcome,
      test_mode: payload.test_mode,
      selected_values: selected,
      validation_details: validationDetails,
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
        failed_stage: tracker.stage || 'request timeout',
        error: `Form automation exceeded ${REQUEST_TIMEOUT_MS}ms. Last stage: ${tracker.stage || 'unknown'}`,
      });
    }, REQUEST_TIMEOUT_MS);
  });
}

function safeLogPayload(label, data) {
  const c = JSON.parse(JSON.stringify(data || {}));
  if (c.photo_base64) c.photo_base64 = `[base64 hidden]`;
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
  let payload;
  try {
    payload = validatePayloadBeforeFill(normalizePayload(req.body || {}));
  } catch (error) {
    const result = {
      success: false,
      submitted: false,
      failed_stage: 'validate payload',
      error: '[validate payload] ' + error.message,
    };
    safeLogPayload('[FINAL RESULT]', result);
    console.log('================ FORM REQUEST END ==================');
    res.status(200).json(result);
    return;
  }
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
  version: 'v31-playwright-visible-controls',
  endpoints: ['GET /health', 'POST /submit-observation-form', 'POST /'],
}));
app.get('/health', (req, res) => res.json({
  ok: true, submit_mode: SUBMIT_MODE, version: 'v31-playwright-visible-controls',
}));
app.post('/', submitObservationForm);
app.post('/submit-observation-form', submitObservationForm);

app.listen(PORT, () => console.log('AI Safety Manager form service listening on ' + PORT));
