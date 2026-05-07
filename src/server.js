import express from 'express';
import { chromium } from '@playwright/test';
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

function byLabel(page, label) {
  return page
    .getByLabel(label, { exact: true })
    .or(page.getByLabel(new RegExp('^' + escapeRegExp(label) + '\\s*\\*?$', 'i')))
    .first();
}

async function fillText(page, label, value) {
  if (!value) return;
  await byLabel(page, label).fill(String(value));
}

async function chooseCombo(page, label, value) {
  if (!value) return '';
  const combo = byLabel(page, label);
  await combo.click();
  const search = page.getByRole('combobox', { name: 'Find an option' });
  await search.fill(String(value));
  const option = page.getByRole('option', { name: String(value), exact: true });
  await option.click();
  return value;
}

async function chooseLinkedProject(page, value) {
  if (!value) return '';
  await page.getByRole('button', { name: 'Add project to Project Site field', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search', exact: true });
  await search.fill(String(value));
  const option = page.getByRole('option', { name: String(value), exact: true });
  await option.click();
  return value;
}

async function chooseRadio(page, groupLabel, optionLabel) {
  const group = page
    .getByRole('radiogroup', { name: groupLabel, exact: true })
    .or(page.getByRole('radiogroup', { name: new RegExp('^' + escapeRegExp(groupLabel) + '\\s*\\*?$', 'i') }))
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

async function fillForm(payload, req) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'safety-observation-'));
  const selected = { ...payload.selected_values };
  let browser;
  let context;
  let page;
  let photoPath = '';
  let submitted = false;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    context = await browser.newContext({
      recordVideo: { dir: tmpDir, size: { width: 1280, height: 720 } },
      viewport: { width: 1280, height: 720 },
    });
    page = await context.newPage();

    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('heading', { name: 'Good Catch/Positive Observations', exact: true }).waitFor({ timeout: 30000 });

    await fillText(page, 'Date of Event', dateForAirtable(payload.date_of_event));
    await fillText(page, 'Time', payload.time);
    selected.project_site = await chooseLinkedProject(page, payload.project_site);
    await fillText(page, 'Your Name (First and Last)', payload.reporter_name);
    await fillText(page, 'Your Email Address', payload.reporter_email);
    selected.company_name = await chooseCombo(page, 'Name of Company', payload.company_name);
    selected.contractor_observed = isUnsetOption(payload.contractor_observed)
      ? ''
      : await chooseCombo(page, 'Name of Contractor Observed', payload.contractor_observed);
    selected.type_of_observation = await chooseRadio(page, 'Type of Observation', TYPE_OF_OBSERVATION_LABELS[payload.type_of_observation]);
    selected.type_of_hazard = await chooseCombo(page, 'Type of Hazard', payload.type_of_hazard);
    selected.severity = await chooseComboOrRadio(page, 'Severity', SEVERITY_LABELS[payload.severity]);
    selected.confirmation_checked = await checkCheckboxIfPresent(page, 'Please check this box');
    selected.stop_work_authority_used = await chooseRadio(page, 'Stop Work Authority Used?', STOP_WORK_LABELS[payload.stop_work_authority_used]);
    await fillText(page, 'Description of Event (original)', payload.description_of_event || payload.positive_safe_observation);
    await fillText(page, 'Corrective Action', payload.corrective_action);
    selected.followup_status = await chooseRadio(page, 'Was the issue corrected onsite or is follow up needed?', FOLLOW_UP_LABELS[payload.followup_status]);

    if (payload.photo_base64 || payload.photo_url) {
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
    }

    const beforeSubmitPath = join(tmpDir, 'before-submit.png');
    await page.screenshot({ path: beforeSubmitPath, fullPage: true });

    const shouldSubmit = !payload.test_mode && SUBMIT_MODE === 'live';
    if (shouldSubmit) {
      const submitButton = page
        .getByRole('button', { name: 'Submit Observation', exact: true })
        .or(page.getByRole('button', { name: 'Submit', exact: true }))
        .first();
      await submitButton.click();
      submitted = true;
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
    }

    const afterPath = join(tmpDir, submitted ? 'after-submit.png' : 'test-filled.png');
    await page.screenshot({ path: afterPath, fullPage: true });

    const videoHandle = page.video();
    await context.close();
    const video = videoHandle ? await videoHandle.path().catch(() => '') : '';
    await browser.close();

    return {
      success: true,
      submitted,
      test_mode: payload.test_mode,
      selected_values: selected,
      artifacts: {
        directory: tmpDir,
        before_submit_screenshot: beforeSubmitPath,
        final_screenshot: afterPath,
        video,
        before_submit_screenshot_url: artifactUrl(req, beforeSubmitPath),
        final_screenshot_url: artifactUrl(req, afterPath),
        video_url: artifactUrl(req, video),
      },
    };
  } catch (error) {
    const errorPath = join(tmpDir, 'error.png');
    if (page) {
      await page.screenshot({ path: errorPath, fullPage: true }).catch(() => undefined);
    }
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }

    return {
      success: false,
      submitted,
      test_mode: payload.test_mode,
      selected_values: selected,
      error: error.message,
      artifacts: {
        directory: tmpDir,
        error_screenshot: page ? errorPath : '',
        error_screenshot_url: page ? artifactUrl(req, errorPath) : '',
      },
    };
  }
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
  res.json({ ok: true, submit_mode: SUBMIT_MODE });
});

async function submitObservationForm(req, res) {
  if (TOKEN && req.get('authorization') !== 'Bearer ' + TOKEN) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const payload = normalizePayload(req.body || {});
  const result = await fillForm(payload, req);
  res.status(result.success ? 200 : 422).json(result);
}

app.post('/', submitObservationForm);
app.post('/submit-observation-form', submitObservationForm);

app.listen(PORT, () => {
  console.log('AI Safety Manager form service listening on ' + PORT);
});
