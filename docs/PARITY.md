# OpenMausBot feature port ledger

This ledger tracks the port from the reference implementation at
OpenMausBot commit f9c25dd. Grox is an independent Go + MyGo project; the ledger is not a claim that the
two products are code-identical.

## Ported and working

- Roster, bot profiles, model picker, per-bot threads and working folders.
- Demo engine, Grok Build, Claude Code, Codex CLI, Gemini CLI, and OpenAI-compatible API engines.
- Claude PermissionRequest broker and Grok / Codex / Gemini per-turn tool hooks.
- Per-turn streamable-HTTP MCP endpoint exposing Composio tools to every CLI engine.
- Composio app connections, OAuth, live tool runner, and automatic tools for Auto/Full API bots.
- Bot groups/channels with @mention routing, leads, shared folder and responder rules.
- Attachments and image input, streaming replies, approval cards, option cards, activity.
- Local computer (screenshot, files, terminal) and real SSH computer.
- Voice calls using the system speech service; private LAN phone companion.
- Scheduled routines and run history.
- Deterministic layered 1-bit portraits for every bot and group, original to Grox.

## Partial

- Contexts/departments: channels and bot department labels exist. A standalone department shelf,
  rename/delete without bots, access control and department sharing do not.
- Memory: per-bot MEMORY.md, budget, editor, switch, editable topic files, bounded lexical topic recall,
  memory_update/tidy/forget tools and opt-in scheduled archiving are ported. Automatic fact capture,
  model-ranked recall, expiry and daily logs are not.
- Skills: Grox now discovers and toggles SKILL.md instructions per bot. Skill scripts, dependency
  installation, bundled skill packs and the full approval lifecycle are still not ported.
- Questions: agent-authored ask_user cards are ported for CLI MCP tools and API Auto/Full; multi-question
  forms are not.
- MCP: the per-turn Composio gateway, remote HTTP/stdio MCP CRUD, custom headers, and a per-bot allow/deny
  gateway and API tool policy are ported. MCP OAuth and the value vault are not.
- Artifacts: attachments and file previews exist; a first-class artifact browser does not.
- Triggers: schedules, a loopback inbound webhook receiver, optional HMAC signatures, delivery-id replay
  protection, a delivery journal and manual local replay exist. Composio app-event triggers and automatic
  retries do not.
- Automation API: a token-gated loopback JSON API for state, bots, messages, approvals and answers is
  ported. CORS/SSE, groups/routines endpoints and public orchestration are not.
- Usage: token/cost accounting is not shown.
- Onboarding/import: no team pack, preset, or Grok Bot migration flow.

## Not yet ported (local code in the reference repo)

- Team packages: channel-level export/import of bots, skills, memory and routines is ported. Organization
  libraries, presets, signed releases and department shelves are not.
- Playbooks and the full memory upkeep/recall lifecycle (manual MEMORY.md and topic index are ported).
- App-event triggers, trigger broker and automatic delivery retries.
- Jeev/decision-model routing with multiple decision providers.
- MCP OAuth/dynamic registration, connector requirements and full vault-secret handling.
- Saved steps, extractor, attachment extraction, browser automation and computer-ask.
- Email, phone numbers, meetings, Postiz/social publishing and related connectors.
- MCP orchestration surface beyond the local automation API.
- Organization/admin, billing, usage metering and enterprise policy.
- Native mobile companion and store distribution.

## Requires a hosted service, not only code

These features exist in the reference repo but depend on services, credentials or infrastructure that a
local-only binary cannot create:

- Hosted cloud computers, remote desktop provisioning and relay.
- Cloud sync, team cloud, shared phone/email relays, hosted webhook relay.
- Organization library, admin, billing and managed policy.
- App events from hosted Composio, Postiz publishing and hosted email/phone providers.

Grox labels these as absent rather than returning fake success.

## Port order

1. Skills, memory files and team packages (local, high leverage).
2. Webhook triggers, trigger broker and usage accounting.
3. MCP vault / local stdio / per-tool policy, artifacts.
4. Headless API/MCP surface, onboarding/import.
5. Hosted features only when a real backend is available.
