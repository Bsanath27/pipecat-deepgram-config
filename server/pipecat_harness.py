"""Pipecat WebSocket pipeline server.

Browser sends raw 16-bit PCM mono at 16 kHz over a WebSocket binary stream.
A per-connection Pipecat pipeline routes audio through Deepgram streaming STT,
accumulates finalized utterances, and translates via OpenRouter once a
configurable silence gap or sentence count is reached.

Wire format (server → browser):
  {"type": "transcript", "text": "...", "is_final": true|false}
  {"type": "translation", "source_text": "...", "translated_text": "..."}
  {"type": "error",       "message": "..."}
  {"type": "ready"}
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys

import httpx
import websockets
from dotenv import load_dotenv
from pipecat.frames.frames import (
    AudioRawFrame,
    EndFrame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.deepgram.stt import DeepgramSTTService, DeepgramSTTSettings

load_dotenv()

SAMPLE_RATE = int(os.getenv("PIPECAT_SAMPLE_RATE", "16000"))
CHANNELS = int(os.getenv("PIPECAT_CHANNELS", "1"))
DEBOUNCE_SECS = float(os.getenv("PIPECAT_DEBOUNCE_SECS", "1.5"))
MIN_SENTENCES = int(os.getenv("PIPECAT_MIN_SENTENCES", "2"))

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "qwen/qwen3-next-80b-a3b-instruct:free")
OPENROUTER_FALLBACK = [
    m.strip()
    for m in os.getenv("OPENROUTER_FALLBACK_MODELS", "openrouter/auto").split(",")
    if m.strip()
]
OPENROUTER_TEMPERATURE = float(os.getenv("OPENROUTER_TEMPERATURE", "0.2"))
OPENROUTER_SITE_URL = os.getenv("OPENROUTER_SITE_URL", "http://localhost:3000")
OPENROUTER_APP_NAME = os.getenv("OPENROUTER_APP_NAME", "Rizerve Voice Console")

_SENTENCE_END = re.compile(r"[.!?।]\s*$")


def _sentence_count(text: str) -> int:
    return len(re.findall(r"[.!?।]+", text))


class TranslationProcessor(FrameProcessor):
    """Accumulate finalized STT segments and translate when ready.

    Translation fires when BOTH conditions hold:
      - accumulated text ends a sentence (or MIN_SENTENCES reached)
      - DEBOUNCE_SECS have passed since the last finalized segment
    """

    def __init__(self, websocket, source_lang: str, target_lang: str) -> None:
        super().__init__()
        self._ws = websocket
        self._source_lang = source_lang
        self._target_lang = target_lang
        self._segments: list[str] = []
        self._debounce_task: asyncio.Task | None = None

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, InterimTranscriptionFrame):
            await self._send({"type": "transcript", "text": frame.text, "is_final": False})

        elif isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if text:
                await self._send({"type": "transcript", "text": text, "is_final": True})
                self._segments.append(text)
                self._reset_debounce()

        else:
            await self.push_frame(frame, direction)

    def _reset_debounce(self) -> None:
        if self._debounce_task and not self._debounce_task.done():
            self._debounce_task.cancel()
        self._debounce_task = asyncio.create_task(self._debounce_translate())

    async def _debounce_translate(self) -> None:
        await asyncio.sleep(DEBOUNCE_SECS)
        accumulated = " ".join(self._segments).strip()
        if not accumulated:
            return
        sentences = _sentence_count(accumulated)
        if sentences >= MIN_SENTENCES or _SENTENCE_END.search(accumulated):
            self._segments.clear()
            await self._translate(accumulated)
        # If neither condition met, wait for more speech

    async def _translate(self, text: str) -> None:
        models = [OPENROUTER_MODEL, *OPENROUTER_FALLBACK]
        last_err: str = ""
        async with httpx.AsyncClient(timeout=15.0) as client:
            for model in models:
                try:
                    r = await client.post(
                        f"{OPENROUTER_BASE_URL}/chat/completions",
                        headers={
                            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                            "HTTP-Referer": OPENROUTER_SITE_URL,
                            "X-Title": OPENROUTER_APP_NAME,
                        },
                        json={
                            "model": model,
                            "temperature": OPENROUTER_TEMPERATURE,
                            "messages": [
                                {
                                    "role": "system",
                                    "content": (
                                        "You are a strict translation engine. "
                                        "Return only the translated text without markdown, "
                                        "notes, or extra explanation."
                                    ),
                                },
                                {
                                    "role": "user",
                                    "content": (
                                        f"Translate from {self._source_lang} "
                                        f"to {self._target_lang}:\n\n{text}"
                                    ),
                                },
                            ],
                        },
                    )
                    if r.status_code in (429, 503):
                        last_err = f"model {model} returned {r.status_code}"
                        continue
                    r.raise_for_status()
                    data = r.json()
                    translated = (
                        data.get("choices", [{}])[0]
                        .get("message", {})
                        .get("content", "")
                        .strip()
                    )
                    await self._send(
                        {
                            "type": "translation",
                            "source_text": text,
                            "translated_text": translated,
                        }
                    )
                    return
                except httpx.HTTPError as exc:
                    last_err = str(exc)
        await self._send({"type": "error", "message": f"Translation failed: {last_err}"})

    async def _send(self, payload: dict) -> None:
        try:
            await self._ws.send(json.dumps(payload))
        except Exception:
            pass


async def handle_connection(websocket) -> None:
    """Manage a single browser WebSocket connection end-to-end."""
    # Expect a JSON config message first; fall back to defaults on timeout/error
    source_lang, target_lang = "en", "hi"
    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=5.0)
        cfg = json.loads(raw)
        source_lang = cfg.get("sourceLanguage", source_lang)
        target_lang = cfg.get("targetLanguage", target_lang)
    except (asyncio.TimeoutError, json.JSONDecodeError, Exception):
        pass

    stt = DeepgramSTTService(
        api_key=os.getenv("DEEPGRAM_API_KEY", ""),
        encoding="linear16",
        sample_rate=SAMPLE_RATE,
        channels=CHANNELS,
        settings=DeepgramSTTSettings(
            model=os.getenv("DEEPGRAM_MODEL", "nova-2"),
            language=source_lang,
            smart_format=True,
            punctuate=True,
            interim_results=True,
            endpointing=300,
        ),
    )

    translator = TranslationProcessor(websocket, source_lang, target_lang)
    pipeline = Pipeline([stt, translator])
    task = PipelineTask(pipeline, PipelineParams(allow_interruptions=False))
    runner = PipelineRunner(handle_sigint=False)

    await websocket.send(json.dumps({"type": "ready"}))

    async def _receive_audio() -> None:
        try:
            async for message in websocket:
                if isinstance(message, bytes) and message:
                    await task.queue_frame(
                        AudioRawFrame(
                            audio=message,
                            sample_rate=SAMPLE_RATE,
                            num_channels=CHANNELS,
                        )
                    )
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await task.queue_frame(EndFrame())

    await asyncio.gather(runner.run(task), _receive_audio())


def _validate_env() -> list[str]:
    required = ["DEEPGRAM_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL"]
    return [k for k in required if not os.getenv(k)]


async def main() -> None:
    missing = _validate_env()
    if missing:
        print("Missing required env vars:", ", ".join(missing))
        sys.exit(1)

    host = os.getenv("PIPECAT_HOST", "0.0.0.0")
    port = int(os.getenv("PIPECAT_PORT", "8788"))

    print(f"Pipecat pipeline server → ws://{host}:{port}")
    print(f"  Deepgram model : {os.getenv('DEEPGRAM_MODEL', 'nova-2')}")
    print(f"  OpenRouter model: {OPENROUTER_MODEL}")
    print(f"  Debounce       : {DEBOUNCE_SECS}s, min sentences: {MIN_SENTENCES}")

    async with websockets.serve(handle_connection, host, port):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
