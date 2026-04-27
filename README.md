# Rizerve Stack

Presentable local test app for:
- Deepgram speech-to-text
- OpenRouter Qwen3 translation
- Pipecat-ready harness file for later realtime integration

## What is included

- [src/App.tsx](src/App.tsx): polished English UI with microphone recording and live status
- [server/index.mjs](server/index.mjs): backend API for health, transcription, translation, and full audio pipeline
- [server/pipecat_harness.py](server/pipecat_harness.py): Pipecat environment validation starter
- [.env.example](.env.example): clean placeholders for shipping to another project

## Setup

```bash
npm install
npm run dev
```

This starts both services:
- Web UI: `http://localhost:3000` (or `APP_PORT`)
- API: `http://localhost:8787` (or `API_PORT`)

## End-to-end test flow

1. Open the UI in browser.
2. Click `Check API Health`.
3. Click `Start Recording`, speak a sentence in English, then click `Stop Recording`.
4. Verify transcript and translated output are displayed.
5. Optionally edit transcript and click `Translate Transcript`.

## Backend API routes

- `GET /api/health`
- `POST /api/transcribe` (multipart form-data field: `audio`)
- `POST /api/translate` (`text`, `sourceLanguage`, `targetLanguage`)
- `POST /api/process-audio` (multipart + languages, end-to-end flow)

## Pipecat harness

Use the starter harness once Python deps are available:

```bash
python server/pipecat_harness.py
```

It validates required environment variables and prepares the handoff point for realtime Pipecat pipeline wiring.

## Notes

- Keep `.env` private; only commit `.env.example`.
- Browser code should only read `VITE_` variables.
- API keys must be used from a backend service, not directly in frontend code.
