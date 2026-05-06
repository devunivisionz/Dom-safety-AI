# AI Safety Manager Form Service

Small Render-ready Playwright service for filling the Airtable Interface form from the n8n Safety Observation workflow.

## Endpoints

- `GET /health`
- `POST /submit-observation-form`

The submission endpoint accepts JSON from n8n:

```json
{
  "test_mode": true,
  "date_of_event": "2026-05-04",
  "time": "14:30",
  "project_site": "Bauxite III (BWI100)",
  "reporter_name": "Dominique Palmer",
  "reporter_email": "Palmerdom84@gmail.com",
  "company_name": "Turner Construction",
  "contractor_observed": "None",
  "type_of_observation": "Unsafe Condition",
  "type_of_hazard": "Fall Protection",
  "positive_safe_observation": "",
  "stop_work_authority_used": "Not Required",
  "description_of_event": "Worker observed near an unprotected edge.",
  "followup_status": "Follow Up Needed",
  "photo_base64": "...",
  "photo_url": "",
  "photo_filename": "safety-observation.jpg",
  "photo_content_type": "image/jpeg"
}
```

## Environment

- `PORT`: Render provides this automatically.
- `FORM_SERVICE_TOKEN`: optional bearer token required by n8n when set.
- `FORM_SUBMIT_MODE`: keep as `test` until live submissions are approved. Set to `live` to allow `test_mode: false`.
- `AIRTABLE_FORM_URL`: defaults to the Module 1 form URL.
- `JSON_LIMIT`: optional Express JSON body size limit, default `50mb`.

## Local Run

```bash
npm install
npm start
```

The service never submits the Airtable form unless both conditions are true:

- request body has `"test_mode": false`
- environment has `FORM_SUBMIT_MODE=live`

In test mode it fills the form, uploads the photo, captures screenshots/video, and returns artifact URLs.

Send either `photo_base64` or `photo_url`. If both are present, `photo_base64` is used.
