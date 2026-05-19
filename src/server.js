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
const REQUEST_TIMEOUT_MS = Number(
  process.env.FORM_REQUEST_TIMEOUT_MS || NAVIGATION_STAGE_TIMEOUT_MS + 90000,
);
const CHROMIUM_LAUNCH_ARGS = buildChromiumLaunchArgs(serverlessChromium.args);

const FIELD_DEFAULTS = {
  project_site: 'Bauxite II (BWI110)',
  reporter_name: 'Dominique Palmer',
  reporter_email: 'Palmerdom84@gmail.com',
  company_name: 'Turner Construction',
  type_of_observation: 'Unsafe Condition',
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
  return {
    test_mode: false,
    record_id: clean(body.record_id),
    date_of_event: dt.date,
    time: dt.time,
    project_site: clean(body.project_site) || FIELD_DEFAULTS.project_site,
    reporter_name: clean(body.reporter_name) || FIELD_DEFAULTS.reporter_name,
    reporter_email: clean(body.reporter_email) || FIELD_DEFAULTS.reporter_email,
    company_name: clean(body.company_name) || FIELD_DEFAULTS.company_name,
    type_of_observation: obs,
    type_of_hazard: clean(body.type_of_hazard),
    positive_safe_observation: clean(body.positive_safe_observation),
    stop_work_authority_used: sw,
    description_of_event: clean(body.description_of_event),
    corrective_action: clean(body.corrective_action),
    followup_status: fu,
    photo_base64: clean(body.photo_base64),
    photo_url: clean(body.photo_url),
    selected_values: {
      type_of_observation: TYPE_OF_OBSERVATION_LABELS[obs],
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

async function fillForm(payload, req, tracker = { stage: 'initializing' }) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'safety-observation-'));
  const selected = { ...payload.selected_values };

  let browser, context, page;
  let submitted = false;
  let stageName = 'initializing';
  let submitOutcome = 'not_attempted';

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

    // Fill all fields using direct DOM manipulation
    await stage('fill all fields', async () => {
      await page.evaluate((data) => {
        const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');
        
        // Helper to find input near label
        const findInputNearLabel = (labelText) => {
          const labels = Array.from(document.querySelectorAll('label, div, span, p'));
          const lbl = labels.find((n) => {
            const s = window.getComputedStyle(n);
            const b = n.getBoundingClientRect();
            return s.visibility !== 'hidden' && s.display !== 'none'
              && b.width > 0 && b.height > 0
              && norm(n.textContent).toLowerCase().includes(labelText.toLowerCase())
              && norm(n.textContent).length < 80;
          });
          if (!lbl) return null;
          
          const lb = lbl.getBoundingClientRect();
          const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'));
          const candidates = inputs
            .filter((i) => {
              const s = window.getComputedStyle(i);
              const b = i.getBoundingClientRect();
              return s.visibility !== 'hidden' && s.display !== 'none'
                && b.width > 0 && b.height > 0 && b.top >= lb.top - 20 && b.top <= lb.bottom + 100;
            })
            .sort((a, b) => Math.abs(a.getBoundingClientRect().top - lb.bottom) - Math.abs(b.getBoundingClientRect().top - lb.bottom));
          return candidates[0] || null;
        };

        // Fill text input
        const fillInput = (labelText, value) => {
          if (!value) return;
          const input = findInputNearLabel(labelText);
          if (input) {
            input.focus();
            const proto = input instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(input, value); else input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
          }
        };

        // Click by text
        const clickByText = (text, exact = false) => {
          const t = norm(text);
          const lt = t.toLowerCase();
          const all = Array.from(document.querySelectorAll(
            '[role="option"],[role="radio"],[role="checkbox"],button,label,span,div,li',
          ));
          const visible = all.filter((n) => {
            const s = window.getComputedStyle(n);
            const b = n.getBoundingClientRect();
            return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
          });
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
        }

        // 3. Project Site - click Add button then select
        const addProjectBtn = Array.from(document.querySelectorAll('button')).find(
          (b) => norm(b.textContent).toLowerCase().includes('add project')
        );
        if (addProjectBtn && data.project_site) {
          addProjectBtn.click();
          // Wait a bit then search and select
          setTimeout(() => {
            const searchBox = Array.from(document.querySelectorAll('input[placeholder*="Search"], input[placeholder*="search"]'))[0];
            if (searchBox) {
              searchBox.focus();
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (setter) setter.call(searchBox, data.project_site);
              else searchBox.value = data.project_site;
              searchBox.dispatchEvent(new Event('input', { bubbles: true }));
              setTimeout(() => clickByText(data.project_site, false), 500);
            }
          }, 1000);
        }

        // 4. Reporter Name
        fillInput('Your Name', data.reporter_name);

        // 5. Reporter Email
        fillInput('Your Email', data.reporter_email);

        // 6. Company Name
        fillInput('Name of Company', data.company_name);

        // 7. Type of Observation
        const obsLabel = data.type_of_observation === 'Unsafe Condition' 
          ? 'Unsafe Condition (Condición insegura)'
          : data.type_of_observation === 'Unsafe Act'
          ? 'Unsafe Act (Acto Inseguro)'
          : 'Positive/Safe Observation (Observación positiva/segura)';
        clickByText(obsLabel, true);

        // 8. Stop Work Authority
        const swLabel = data.stop_work_authority_used === 'Yes' 
          ? 'Yes (Si)' 
          : 'Not Required (No Requerido)';
        clickByText(swLabel, true);

        // 9. Description
        fillInput('Description of Event', data.description_of_event);

        // 10. Follow-up Status
        const fuLabel = data.followup_status === 'Corrected Onsite'
          ? 'Corrected Onsite (Corrigdo En El Sitio)'
          : data.followup_status === 'Follow Up Needed'
          ? 'Follow Up Needed (Se Requiere Seguimiento)'
          : 'NA';
        clickByText(fuLabel, true);

      }, {
        date_of_event: payload.date_of_event,
        time: payload.time,
        project_site: payload.project_site,
        reporter_name: payload.reporter_name,
        reporter_email: payload.reporter_email,
        company_name: payload.company_name,
        type_of_observation: payload.type_of_observation,
        stop_work_authority_used: payload.stop_work_authority_used,
        description_of_event: payload.description_of_event,
        followup_status: payload.followup_status,
      });

      // Wait for all interactions to complete
      await page.waitForTimeout(3000);
    });

    // Submit
    submitOutcome = await stage('submit form', async () => {
      const submitButton = page
        .getByRole('button', { name: /Submit Observation/i })
        .or(page.getByRole('button', { name: /^Submit$/i }))
        .first();

      await submitButton.scrollIntoViewIfNeeded({ timeout: 5000 });
      const urlBefore = page.url();

      await submitButton.click({ timeout: 5000 }).catch((err) => {
        throw new Error('Submit click failed: ' + err.message);
      });

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

        submitButton.waitFor({ state: 'hidden', timeout: CAP_MS })
          .then(() => ({ kind: 'submit_button_hidden' })).catch(() => null),

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
      if (kind === 'validation_error') return 'validation_error';
      return 'unclear';
    });

    await withTimeout(context.close(), 5000, 'close context timeout').catch(() => undefined);
    await withTimeout(browser.close(), 5000, 'close browser timeout').catch(() => undefined);

    return {
      success: true,
      submitted,
      submit_outcome: submitOutcome,
      test_mode: payload.test_mode,
      submit_mode: SUBMIT_MODE,
      selected_values: selected,
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
  version: 'v27-minimal-submit',
  endpoints: ['GET /health', 'POST /submit-observation-form', 'POST /'],
}));
app.get('/health', (req, res) => res.json({
  ok: true, submit_mode: SUBMIT_MODE, version: 'v27-minimal-submit',
}));
app.post('/', submitObservationForm);
app.post('/submit-observation-form', submitObservationForm);

app.listen(PORT, () => console.log('AI Safety Manager form service listening on ' + PORT));
