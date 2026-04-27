# Plan

## Goals
- Run a local English UI that streams audio to a Pipecat pipeline.
- Use Deepgram for speech-to-text.
- Use Qwen3 (free translation model) for translation.
- Keep the project clean and portable for later reuse.

## Steps
1. Initialize the project structure (frontend, backend, shared types).
2. Add the .env placeholders and document required keys.
3. Implement the Pipecat pipeline with Deepgram STT.
4. Add the Qwen3 translation step and validate output language.
5. Build the local UI using a component library (English labels only).
6. Add status, error handling, and basic logs.
7. Verify end-to-end flow locally and note any deploy-time configs.

## Deliverables
- Local UI with start/stop and live transcript view.
- Translation output panel and basic settings.
- Clean configuration and setup instructions.
