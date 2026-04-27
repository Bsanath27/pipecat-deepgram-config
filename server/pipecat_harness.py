"""Pipecat test harness for local validation.

This script is intentionally minimal and safe to copy into another project.
It validates environment variables and demonstrates where Pipecat pipeline
initialization should occur for realtime workflows.
"""

from __future__ import annotations

import os
import sys

REQUIRED = [
    "DEEPGRAM_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
]


def validate_env() -> list[str]:
    missing: list[str] = []
    for key in REQUIRED:
        if not os.getenv(key):
            missing.append(key)
    return missing


def main() -> int:
    missing = validate_env()
    if missing:
        print("Missing required env vars:")
        for item in missing:
            print(f"- {item}")
        return 1

    print("Pipecat harness env check passed.")
    print("Next step: wire a realtime Pipecat pipeline in this file.")
    print("Suggested: transport -> Deepgram STT -> OpenRouter LLM translate -> TTS sink")
    return 0


if __name__ == "__main__":
    sys.exit(main())
