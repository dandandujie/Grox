# Fast room decisions

Auto rooms can ask a fast decision provider which bot should answer a message that @mentions nobody. The
chosen bot still runs its own normal turn; the decision model never does the work.

## Providers

- **OpenRouter** uses chat completions with strict JSON (default).
- **Workers AI** calls Clef-flash with a Cloudflare account ID and token.
- **Jev** calls TypeSafe system-one with a Jev key.

## Enable

Settings -> Engines -> Fast decisions:

- Use fast decisions
- Provider
- Decision base URL
- Model (OpenRouter) or Cloudflare account ID (Workers AI)
- Key in Settings -> Connections: OpenRouter decision key, Cloudflare Workers AI token or TypeSafe Jev key

Then set a channel's Who answers to Auto (fast decisions).

## Behavior

- @mentions always win before a decision call.
- The request sends room name, member ids/names/titles/descriptions, up to 8 recent lines and the new message.
- The model must answer JSON: {"choice":"<bot id>","pTop":0.6}.
- pTop below 0.6, an unknown choice, a timeout (1.5s), network/HTTP failure or malformed JSON falls back to the room lead.
- Only one member can be chosen; the several-members option is not implemented.

## Decision log

Each room decision appends one JSON line to `<data>/decider-log/YYYY-MM.ndjson` (0600). The row holds time,
provider, ok, choice, pTop, latency, model and a short state hash. Message text and bot descriptions are never
written. Month files are local and not part of a workspace export.

## Not ported

- OpenRouter's decisions API; this slice uses chat completions with strict JSON.
- The several-members option.
- Extraction, inbox triage and bot decide/extract tools.

## Files

- internal/service/decider.go
- internal/service/groups.go - auto responder path
- src/components/SettingsModal.tsx - Fast decisions
- src/components/GroupPanel.tsx - Auto room setting
