# Fast room decisions

Auto rooms can ask a small OpenRouter-compatible chat model which bot should answer a message that
@mentions nobody. The chosen bot still runs its own normal turn; the decision model never does the work.

## Enable

Settings -> Engines -> Fast decisions:

- Use fast decisions
- Decision base URL (default https://openrouter.ai/api/v1)
- Decision model (default typesafe/jev-1.13)
- OpenRouter decision key in Settings -> Connections (write-only)

Then set a channel's Who answers to Auto (fast decisions).

## Behavior

- @mentions always win before a decision call.
- The request sends room name, member ids/names/titles/descriptions, up to 8 recent lines and the new message.
- The model must answer JSON: {"choice":"<bot id>","pTop":0.6}.
- pTop below 0.6, an unknown choice, a timeout (1.5s), network/HTTP failure or malformed JSON falls back to the room lead.
- Only one member can be chosen; the several-members option is not implemented.

## Not ported

- TypeSafe Jev's native API and Cloudflare Workers AI/Clef.
- OpenRouter's decisions API; this slice uses chat completions with strict JSON.
- Decision log, extraction, inbox triage, bot decide/extract tools.

## Files

- internal/service/decider.go
- internal/service/groups.go - auto responder path
- src/components/SettingsModal.tsx - Fast decisions
- src/components/GroupPanel.tsx - Auto room setting
