# Feature scope ledger

This ledger tracks the Go + MyGo port against [OpenMausBot at 0f7abc72](https://github.com/milind-soni/OpenMausBot/tree/0f7abc72bef5d6a586621092593913cecb690fbe).

## Acceptance evidence

- macOS arm64 production build. In an isolated workspace, exercised Demo chat, OpenAI-compatible streaming against a local HTTP endpoint, approval denial, option selection and a manual routine. After restarting Grox, the task transcript and Completed run were still present. A queued Brody message stayed with Brody after switching to GitScout and ran on return.
- Imported the upstream Sales desk team through the native UI. Verified three bots, one channel, one paused routine, three disabled skill copies, two notes and one playbook. The import receipt listed items that require manual setup or were skipped.
- In this pass, the native desktop accepted a tool approval, wrote a file through the selected local computer and listed it with its source thread. Local SSE tests verify approval, denial, stop and a changed destination, plus byte-identical API images and transcript ordering. The exact OpenMaus export was accepted by OpenMausBot’s parser.
- Go regression coverage includes busy-send rejection after catalog refresh, transcript persistence, a failed disk write before launch, HTTP 401 routine failure and retry, CLI subprocess exit/cancellation with partial output, and the exact OpenMaus v2 fixture. Vendor-authenticated tool calls, device permissions, phone pairing on a physical second device and other operating systems were outside this acceptance pass.

## Ported and working

- Roster, bot profiles, model picker, per-bot threads and working folders.
- Demo engine, Grok Build, Claude Code, Codex CLI, Gemini CLI, and OpenAI-compatible API engines.
- Claude PermissionRequest broker and Grok / Codex / Gemini per-turn tool hooks.
- Per-turn streamable-HTTP MCP endpoint exposing Composio tools to every CLI engine.
- Composio app connections, OAuth, live tool runner, and automatic tools for Auto/Full API bots.
- Bot groups/channels with @mention routing, leads and a shared folder.
- Local attachment storage and preview, streaming replies, approval cards, option cards and activity.
- Managed local Chromium automation with navigation, reading, clicking, text input, screenshots and per-turn approval. [Browser tools](BROWSER.md)
- Local and SSH Computer panel actions and per-turn agent tools. The gateway implements file listing, reading, terminal, capture and file sharing. See [computer tools](COMPUTER.md).
- Voice calls using the system speech service; private LAN phone companion.
- Scheduled routines and run history.
- Deterministic hand-drawn 1-bit portraits for every bot and group, original to Grox.

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
- Artifacts and attachments: the conversation files panel indexes shared files across a bot or channel. CLI prompts receive local paths. API requests carry explicitly attached PNG/JPEG/WebP and UTF-8 files, up to eight files and a combined budget of 12 MiB for images and 64 KiB for text. General PDF/document extraction and binary inputs remain open. [Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create)
- Computer tools: CLI MCP and tool-capable APIs expose actions on the bot's selected computer. Hosted provisioning, live desktop takeover and personal browser takeover remain open. [OpenMaus tool bridge](https://github.com/milind-soni/OpenMausBot/blob/0f7abc72bef5d6a586621092593913cecb690fbe/docs/agents-tool-bridge.md)
- Triggers: schedules, a loopback inbound webhook receiver, optional HMAC signatures, delivery-id replay
  protection, a delivery journal and manual local replay exist. Composio app-event triggers and automatic
  retries do not.
- Automation API: a token-gated loopback JSON API for state, bots, groups, routines, messages,
  approvals, answers, routine runs and an SSE event stream is ported. CORS and public orchestration are not.
- Usage: OpenAI-compatible API turns and Claude/Grok result events record input/output/total tokens, and
  optional local per-million pricing labels cost. Codex/Gemini usage, provider price tables and budgets are
  not shown.
- Onboarding/import: local welcome, team import, BotMRR Markdown and Grok Bot JSON migration. Hosted onboarding and source-specific automatic export discovery remain open.

- Team packages: Grox v1 channel import/export with local Ed25519 integrity checks, plus OpenMaus v2/v3 team JSON import and export. Room bulletins become channel instructions. Imported skills and compatible MCP definitions start disabled, and routines arrive paused. Organization trust, package presets and unsupported source capabilities remain open.

- Playbooks: per-bot file playbooks with trigger selection and prompt injection, including playbooks from imported OpenMaus teams. The full package review and metadata remain open.
- Routines: scheduled tasks in direct chats and channels, five-field cron with IANA time zones, continuous threads, a local runs check, busy skip/queued retry and failure backoff. Mail/calendar checks, proactive brief, FIFO queueing, cloud jobs, room goals and custom timeouts remain open.
- The full memory upkeep/recall lifecycle (manual MEMORY.md and topic index are ported).
- App-event triggers, trigger broker and automatic delivery retries.
- MCP OAuth/dynamic registration, connector requirements and full vault-secret handling.
- Saved steps, structured extraction, SSH browser automation and the separate computer-takeover interaction.
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

## Remaining port and acceptance work

The reference includes hosted computers, the My Cloud installation and relay, organization accounts and policy, several third-party transports, and an iOS app. Grox's local desktop runtime covers the actions listed above. The remaining entries require service implementations, external integrations, or native clients. Provider-authenticated tool approvals, a real SSH desktop, and platform-specific device permissions still need acceptance.

- Hosted workspace and organization entry points. [My Cloud](https://github.com/milind-soni/OpenMausBot/blob/0f7abc72bef5d6a586621092593913cecb690fbe/apps/docs/content/docs/getting-started/using-the-desktop-app-with-my-cloud.mdx) · [Organization](https://github.com/milind-soni/OpenMausBot/blob/0f7abc72bef5d6a586621092593913cecb690fbe/apps/docs/content/docs/getting-started/organisation.mdx)
- Provider-backed virtual desktops and the live viewer. [Cloud and VPS computers](https://github.com/milind-soni/OpenMausBot/blob/0f7abc72bef5d6a586621092593913cecb690fbe/apps/docs/content/docs/computers/cloud-and-vps.mdx)
- Native mobile client and remote pairing. [iOS companion](https://github.com/milind-soni/OpenMausBot/blob/0f7abc72bef5d6a586621092593913cecb690fbe/apps/docs/content/docs/mobile/ios-companion.mdx)
