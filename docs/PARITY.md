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

- Contexts/departments: channels and standalone department shelves (add, rename, delete, empty shelf,
  General protection) exist. Access control and department sharing do not.
- Memory: per-bot MEMORY.md, budget, editor, switch, editable topic files, bounded lexical topic recall,
  memory_update/tidy/forget tools, expiry markers, opt-in scheduled archiving and opt-in daily logs are
  ported. Automatic fact capture and model-ranked recall are not.
- Skills: Grox now discovers and toggles SKILL.md instructions per bot. Skill scripts, dependency
  installation, bundled skill packs and the full approval lifecycle are still not ported.
- Questions: agent-authored ask_user cards are ported for CLI MCP tools and API Auto/Full; multi-question
  forms are not.
- MCP: the per-turn Composio gateway, remote HTTP/stdio MCP CRUD, custom headers, OAuth authorization-code/
  PKCE, client-credentials and refresh-token grants, and a per-bot allow/deny gateway and API tool policy
  are ported. Dynamic client registration, revocation and the value vault are not.
- Artifacts: attachments and file previews exist; a first-class artifact browser does not.
- Triggers: schedules, a loopback inbound webhook receiver, optional HMAC signatures, delivery-id replay
  protection, a delivery journal and manual local replay exist. Composio app-event triggers and automatic
  retries do not.
- Automation API: a token-gated loopback JSON API for state, bots, groups, routines, messages,
  approvals, answers, routine runs and an SSE event stream is ported. CORS and public orchestration are not.
- Usage: OpenAI-compatible API turns and Claude/Grok result events record input/output/total tokens, and
  optional local per-million pricing labels cost. Codex/Gemini usage, provider price tables and budgets are
  not shown.
- Onboarding/import: a local first-run welcome, a Grok Bot export import with isolated per-bot skills, and
  team package import exist. Split exports and package v2 conversion are not ported.

## Not yet ported (local code in the reference repo)

- Team packages: channel-level export/import, local ed25519 signing, BotMRR Markdown v1 and
  openmaus.package v2 JSON import/export are ported. Requirements/grants, avatars, approval mapping, routine
  continuity/cloud jobs, package signatures and a trust registry are not.
- Playbooks: per-bot file playbooks with trigger selection and prompt injection are ported. Package-authored
  playbook import/review and the full package metadata are not.
- Routines: scheduled tasks, opt-in continuous threads and a local runs check are ported. Mail/calendar
  checks, the proactive brief, overlap queueing, cloud jobs, room goals and timeouts are not.
- The full memory upkeep/recall lifecycle (manual MEMORY.md and topic index are ported).
- App-event triggers, trigger broker and automatic delivery retries.
- Jev/decision routing: Auto rooms can use OpenRouter chat, Cloudflare Workers AI Clef-flash or native
  TypeSafe Jev to pick one member, with a 0.6 threshold, lead fallback and a metadata-only decision log.
  OpenRouter's decisions API, the several-members option and extraction/triage are not ported.
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
