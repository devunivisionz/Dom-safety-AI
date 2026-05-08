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

const DEFAULTS = {
  project_site: 'Bauxite III (BWI100)',
  reporter_name: 'Dominique Palmer',
  reporter_email: 'Palmerdom84@gmail.com',
  company_name: 'Turner Construction',
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

const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/g;

function normalizeObservation(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('unsafe condition')) return 'Unsafe Condition';
  if (text.includes('unsafe act')) return 'Unsafe Act';
  return 'Positive/Safe Observation';
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
    test_mode: body.test_mode !== false,
    date_of_event: dateTime.date,
    time: dateTime.time,
    project_site: clean(body.project_site) || DEFAULTS.project_site,
    reporter_name: clean(body.reporter_name) || DEFAULTS.reporter_name,
    reporter_email: clean(body.reporter_email) || DEFAULTS.reporter_email,
    company_name: clean(body.company_name) || DEFAULTS.company_name,
    contractor_observed: clean(body.contractor_observed) || 'None',
    type_of_observation: observation,
    type_of_hazard: clean(body.type_of_hazard),
    severity,
    positive_safe_observation: clean(body.positive_safe_observation),
    stop_work_authority_used: stopWork,
    description_of_event: clean(body.description_of_event),
    corrective_action: clean(body.corrective_action),
    followup_status: followUp,
    photo_base64: clean(body.photo_base64),
    photo_url: clean(body.photo_url),
    photo_filename: clean(body.photo_filename) || 'safety-observation.jpg',
    photo_content_type: clean(body.photo_content_type) || 'image/jpeg',
    selected_values: {
      type_of_observation: TYPE_OF_OBSERVATION_LABELS[observation],
      severity: SEVERITY_LABELS[severity],
      stop_work_authority_used: STOP_WORK_LABELS[stopWork],
      followup_status: FOLLOW_UP_LABELS[followUp],
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

function dateForAirtable(date) {
  const [year, month, day] = date.split('-');
  return day + '/' + month + '/' + year;
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
  await byLabel(page, label).fill(String(value));
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
    await option.click({ timeout });
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

async function chooseCombo(page, label, value) {
  if (!value) return '';
  const combo = comboByLabel(page, label);
  await combo.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  await combo.click({ timeout: ACTION_TIMEOUT_MS });
  if (await clickVisibleOption(page, value)) return value;
  const search = page
    .getByRole('combobox', { name: 'Find an option' })
    .or(page.getByRole('combobox', { name: /find/i }))
    .or(page.getByRole('combobox', { name: /search/i }))
    .or(page.locator('input[placeholder*="Find" i]'))
    .or(page.locator('input[placeholder*="Search" i]'))
    .or(page.locator('input[type="text"]'))
    .first();
  await search.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await search.fill(String(value));
  if (await clickVisibleOption(page, value, ACTION_TIMEOUT_MS)) return value;
  const visibleOptions = await visibleOptionNames(page);
  const suffix = visibleOptions.length ? '. Visible options: ' + visibleOptions.join(', ') : '';
  throw new Error('No visible option found for "' + label + '" value "' + value + '"' + suffix);
}

async function chooseLinkedRecord(page, value, addNames, label) {
  if (!value) return '';
  let addButton;
  for (const addName of addNames) {
    const addRegex = new RegExp('^\\s*\\+?\\s*Add\\s+' + escapeRegExp(addName) + '\\s*$', 'i');
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
    throw new Error('No Add button found for linked field "' + label + '"');
  }
  await addButton.scrollIntoViewIfNeeded();
  await addButton.click({ timeout: ACTION_TIMEOUT_MS });
  if (await clickVisibleOption(page, value)) return value;
  const search = page
    .getByRole('combobox', { name: 'Search', exact: true })
    .or(page.getByRole('combobox', { name: /search/i }))
    .or(page.getByRole('combobox', { name: /find/i }))
    .or(page.locator('input[placeholder*="Search" i]'))
    .or(page.locator('input[placeholder*="Find" i]'))
    .or(page.locator('input[type="text"]'))
    .first();
  await search.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await search.fill(String(value));
  if (await clickVisibleOption(page, value, ACTION_TIMEOUT_MS)) return value;
  const visibleOptions = await visibleOptionNames(page);
  const suffix = visibleOptions.length ? '. Visible options: ' + visibleOptions.join(', ') : '';
  throw new Error('No visible linked option found for "' + label + '" value "' + value + '"' + suffix);
}

async function chooseLinkedProject(page, value) {
  return chooseLinkedRecord(page, value, ['project'], 'Project Site');
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

function stageTimeout(name) {
  if (name === 'launch browser') return 60000;
  if (name === 'navigate Airtable form') return NAVIGATION_TIMEOUT_MS + 5000;
  if (name === 'wait Airtable network idle') return 25000;
  if (name === 'wait Airtable form ready') return FORM_READY_TIMEOUT_MS + 5000;
  if (name.includes('screenshot')) return SCREENSHOT_TIMEOUT_MS + 2000;
  return ACTION_TIMEOUT_MS + 5000;
}

async function fillForm(payload, req, tracker = { stage: 'initializing' }) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'safety-observation-'));
  const selected = { ...payload.selected_values };
  let browser;
  let context;
  let page;
  let photoPath = '';
  let submitted = false;
  let stageName = 'initializing';

  const stage = async (name, fn) => {
    stageName = name;
    tracker.stage = name;
    console.log('form-service stage: ' + name);
    return withTimeout(Promise.resolve().then(fn), stageTimeout(name), 'Timed out during stage "' + name + '"');
  };

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

    await stage('fill date', () => fillText(page, 'Date of Event', dateForAirtable(payload.date_of_event)));
    await stage('fill time', () => fillText(page, 'Time', payload.time));
    selected.project_site = await stage('choose project site', () => chooseLinkedProject(page, payload.project_site));
    await stage('fill reporter name', () => fillText(page, 'Your Name (First and Last)', payload.reporter_name));
    await stage('fill reporter email', () => fillText(page, 'Your Email Address', payload.reporter_email));
    selected.company_name = await stage('choose company', () => chooseLinkedRecord(page, payload.company_name, ['company'], 'Name of Company'));
    selected.contractor_observed = isUnsetOption(payload.contractor_observed)
      ? ''
      : await stage('choose contractor observed', () => chooseLinkedRecord(page, payload.contractor_observed, ['contractor observed', 'contractor'], 'Name of Contractor Observed'));
    selected.type_of_observation = await stage('choose type of observation', () => chooseRadio(page, 'Type of Observation', TYPE_OF_OBSERVATION_LABELS[payload.type_of_observation]));
    selected.type_of_hazard = await stage('choose type of hazard', () => chooseCombo(page, 'Type of Hazard', payload.type_of_hazard));
    selected.severity = await stage('choose severity', () => chooseComboOrRadio(page, 'Severity', SEVERITY_LABELS[payload.severity]));
    selected.confirmation_checked = await stage('check confirmation', () => checkCheckboxIfPresent(page, 'Please check this box'));
    selected.stop_work_authority_used = await stage('choose stop work authority', () => chooseRadio(page, 'Stop Work Authority Used?', STOP_WORK_LABELS[payload.stop_work_authority_used]));
    await stage('fill description', () => fillText(page, 'Description of Event (original)', payload.description_of_event || payload.positive_safe_observation));
    await stage('fill corrective action', () => fillText(page, 'Corrective Action', payload.corrective_action));
    selected.followup_status = await stage('choose follow-up status', () => chooseRadio(page, 'Was the issue corrected onsite or is follow up needed?', FOLLOW_UP_LABELS[payload.followup_status]));

    if (payload.photo_base64 || payload.photo_url) {
      await stage('attach photo', async () => {
        photoPath = join(tmpDir, payload.photo_filename);
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
    const beforeSubmitScreenshot = await stage('capture before-submit screenshot', () => safeScreenshot(page, beforeSubmitPath));

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
    const finalScreenshot = await stage('capture final screenshot', () => safeScreenshot(page, afterPath));

    await withTimeout(context.close(), 5000, 'Timed out closing browser context').catch(() => undefined);
    await withTimeout(browser.close(), 5000, 'Timed out closing browser').catch(() => undefined);

    return {
      success: true,
      submitted,
      test_mode: payload.test_mode,
      selected_values: selected,
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
  res.json({ ok: true, submit_mode: SUBMIT_MODE, version: 'linked-company-fields' });
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
