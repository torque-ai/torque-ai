# Privacy

TORQUE runs entirely on your machine. No data is transmitted to TORQUE AI or any third party.

## What stays local

- All task data (submissions, outputs, results) — stored in local SQLite
- Your provider API keys — held in memory, never logged or transmitted
- Your code and project files — never uploaded
- Dashboard data — served from localhost only

## External connections TORQUE makes

- **Ollama hosts** — machines YOU registered on your local network
- **Cloud LLM providers** — APIs YOU configured with YOUR API keys (DeepInfra, Anthropic, Groq, etc.)
- **No telemetry** — TORQUE does not phone home, collect analytics, or track usage

## BYOK (Bring Your Own Keys)

Your API keys are your responsibility. TORQUE uses them to make API calls on your behalf and does not store, share, or transmit them beyond the direct provider API call.
