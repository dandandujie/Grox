# Changelog

## 0.35.0

- Added a local first-run welcome with Create a bot, Start with demo and Connect an engine actions; closing
  it or choosing an action persists Settings.Onboarded.
- Added Settings -> About -> Show welcome again and an onboarding persistence test.
- Still not ported: legacy Grok Bot migration wizard, account signup and hosted onboarding.

## 0.34.0

- Added standalone department records and Settings -> Departments CRUD: add an empty shelf, rename it with
  bots following, or delete it with bots moved to General. General is protected.
- The sidebar renders empty department shelves and bot counts; bot creation/editing keeps records in sync.
- Added department CRUD and migration coverage.
- Still not ported: department access control, sharing, organization libraries and hosted shelves.

## 0.33.0

- Signed exported team packages with a local ed25519 key (signature, publicKey, signedAt) and verify the
  signature on import, failing closed on tampering or incomplete signatures.
- Older unsigned packages remain importable. The signing seed stays in secrets.json.
- Added signed-export, tampered-package and valid-import coverage.
- Still not ported: organization trust registry, signed release discovery, revocation and hosted libraries.

## 0.32.0

- Added optional local token pricing (USD per 1M input/output) and a per-message six-decimal cost label.
- Cost uses only the configured prices and the provider-reported usage; no provider price table is invented.
- Added pricing settings, bounds validation, a cost calculation test, and updated usage docs.
- Still not ported: automatic provider pricing, budgets and billing.

## 0.31.0

- Added an opt-in per-bot Daily conversation log. Finished turns append a bounded You/Bot entry to
  memory/<botId>/logs/YYYY-MM-DD.md; logs are never loaded into prompts or recall.
- Added read-only daily log listing/viewer actions in the Memory tab and a turn-end log test.
- Still not ported: automatic fact capture and model-ranked recall.

## 0.30.0

- Added memory expiry markers: entries ending in until YYYY-MM-DD are skipped once past, counted in the
  Memory tab, and archived by Tidy even when the file is otherwise under budget.
- Added load-filter, count and Tidy-expiry tests.
- Still not ported: automatic fact capture, model-ranked recall and daily logs.

## 0.29.0

- Parsed Claude Code and Grok Build result-event usage (input_tokens/output_tokens) into the same message
  usage label as the API engine.
- Added a CLI result usage test. Codex and Gemini remain unlabelled because their formats do not expose a
  stable usage shape.

## 0.28.0

- Added token usage reporting for the OpenAI-compatible API engine. Usage is accumulated across tool rounds
  and attached to the final message; the footer shows total tokens with an input/output tooltip.
- Added the agent TokenUsage/UsageSink capability, SSE usage parsing and a service-level API turn test.
- CLI engines remain unlabelled because their output formats do not share a stable usage shape; no cost is
  fabricated.

## 0.27.0

- Extended the loopback automation API with groups and routines inventories, group message/approval/answer
  endpoints and routine run-now.
- Added an end-to-end group API test and reused the existing approval/question service paths.
- Still not ported: CORS, a full orchestration API, hosted APIs.

## 0.26.0

- Added GET /v1/events: an authenticated SSE stream of the same service events the desktop and phone
  surfaces receive, with a ready event and 15-second keepalive comments.
- Added SSE subscriber cleanup, a buffered per-client queue and an end-to-end stream test.
- Still not ported: CORS, group/routine API endpoints and public orchestration.

## 0.25.0

- Added an optional loopback automation API (off by default) with a generated bearer token, rotation,
  AppState/bots reads, message sends, approvals and question answers.
- Added the Settings -> Automation panel, one-time token reveal, and a real HTTP test covering
  unauthenticated rejection, state reads, message dispatch and shutdown.
- Still not ported: CORS/SSE, groups/routines endpoints, public orchestration and hosted APIs.

## 0.24.0

- Added per-bot automatic memory archive. When enabled, the scheduler checks at most once an hour and moves
  the oldest dated entries to topics/archive.md if MEMORY.md is over the 200-line / 24 KB budget.
- Added the Memory tab switch and a scheduler test covering the opt-in path.
- Still not ported: automatic fact capture, model-ranked recall, expiry and daily logs.

## 0.23.0

- Added up to 16 custom HTTP headers per remote MCP server, stored write-only in secrets.json.
- Claude, Grok and Gemini temporary configs include the headers; Codex keeps bearer-token env support only.
- Added header name/secret redaction in AppState, header editor UI and runtime config tests.
- Still not ported: MCP OAuth and arbitrary header support for Codex.

## 0.22.0

- Added a webhook delivery journal: the last 50 accepted deliveries keep time, status, bot, thread and a
  bounded payload; the Webhooks tab shows the latest 20.
- Added local Replay: a person can start a fresh task from a retained payload without the original
  signature. Event count and lastEventAt advance; a second delivery record is written.
- Added a journal/replay test covering the retained payload, new thread and bot reply.
- Still not ported: automatic retries, a public relay, app-event triggers and HMAC-signed replay.

## 0.21.0

- Added a per-bot tool policy: allow/deny wildcard patterns with deny taking precedence.
- The per-turn MCP gateway filters tools/list and rejects blocked tools/call; API Auto/Full filters
  registration and execution.
- Added a Tool policy editor in the bot profile, defaulting to allow-all.
- Added pattern, API-filter and MCP list/call policy tests.
- Remote MCP servers and CLI built-in tools remain governed by the CLI, not this gateway policy.

## 0.20.0

- Added bot departments. New bot and the profile editor set a department; the sidebar groups the roster
  with department headers when more than one is present.
- Existing bots migrate to General; team packages carry the department value.
- Added TestBotDepartmentCreateAndPatch and department migration defaults.
- Still not ported: a standalone department shelf, rename/delete without bots, access control and hosted
  organization libraries.

## 0.19.0

- Added memory_forget and a Memory tab Forget field. Matching top-level MEMORY.md entries are removed and
  copied to topics/archive.md with a forgotten marker.
- Requires at least three characters; no match is a no-op; the archive write happens before the memory
  rewrite.
- Added memory_forget MCP/API tools and TestForgetMemoryArchivesMatches.
- Still not ported: automatic capture, model-ranked recall and scheduled upkeep.

## 0.18.0

- Added editable memory topics: click a topic in the Memory tab to open its full markdown, save it with a
  revision check, or delete it.
- Topic revisions prevent overwriting a file changed while the editor was open; path traversal is refused.
- Topics remain excluded from wholesale prompt loading and are still available to lexical recall.
- Added topic read/save/delete and traversal tests.
- Still not ported: memory_delete agent tool, automatic capture, model-ranked recall and scheduled upkeep.

## 0.17.0

- Added TidyMemory: the oldest dated MEMORY.md entries move to topics/archive.md until the 200-line /
  24 KB budget is met. The archive is written before the memory file, and manual header lines stay.
- Added a Memory tab Tidy action and memory_tidy tools for the MCP gateway and the API Auto/Full loop.
- Added TidyMemory tests for archiving, the line budget, manual header preservation and the archive topic.
- Still not ported: memory_delete, automatic capture, model-ranked recall and scheduled upkeep.

## 0.16.0

- Added a memory_update tool to the per-turn MCP gateway and the API Auto/Full tool loop.
- Writes a dated bullet to MEMORY.md or to a named topic file, with a 2,000-character entry cap and the
  existing 512 KB file cap.
- CLI Ask hooks still gate the write through the normal approval card; Auto/Full CLIs and API bots write
  directly.
- Added a Memory tab Reload action so a tool-written note can be inspected without leaving the panel.
- Tests: TestMemoryUpdateToolWritesTopic and the expanded tool-registration test.
- Still not ported: memory_delete/tidy-up tools, automatic capture and model upkeep.

## 0.15.0

- Added optional HMAC-SHA256 signing to inbound webhooks. The URL token is the signing key.
- Requires X-Grox-Timestamp within five minutes and X-Grox-Signature over timestamp.body; invalid
  signatures return 401.
- Added X-Grox-Delivery replay protection within a ten-minute window; duplicate deliveries return 409.
- Added a Require HMAC signature switch, signed/token-only card labels and signature tests.
- Still not ported: retries, event journal, app-event triggers and public relay.

## 0.14.0

- Added local stdio MCP servers alongside remote HTTP servers in Settings -> MCP servers.
- A stdio entry carries a command and up to 32 arguments; it is launched by the selected CLI, never by Grox.
- Claude/Grok/Codex/Gemini temporary configs now emit stdio entries; HTTP token handling is unchanged.
- Added transport switching, command/argument validation, and runtime config tests for all four CLIs.
- Local commands run with the CLI's permissions and are not sandboxed by Grox; the UI warns explicitly.
- Still not ported: MCP OAuth/dynamic registration, per-tool policy and the full vault.

## 0.13.0

- Replaced the New bot dialog's hardcoded preset chips with workspace presets.
- Seeded Research, Inbox chief, Code review and Operations presets, with migration defaults for older state.
- Added Save as preset on a bot profile, Settings -> General preset management and delete, and preset-driven
  New bot fields.
- Presets are persona-only; model, folder, approval, skills, memory and credentials never travel.
- Added preset CRUD tests and refreshed the browser fixture.
- Still not ported: presets that carry skills/notes, team package presets and organization presets.

## 0.12.0

- Added user-managed remote streamable-HTTP MCP servers in Settings -> MCP servers.
- Tokens are write-only: stored in 0600 secrets.json, never in AppState or RPC responses.
- Claude, Grok, Codex and Gemini each receive enabled servers in a temporary per-turn config; Codex gets
  its token through a temporary subprocess environment variable.
- Added add/edit/enable/delete, URL validation, blank-token preservation and automatic token removal on
  delete.
- Fixed Grok/Codex turn wiring to use the temporary home configs, restoring the intended hook and MCP
  configuration path.
- Still not ported: local stdio MCP commands, OAuth/dynamic registration, per-server tool policy and the
  full vault.

## 0.11.0

- Added bounded lexical memory recall: matching topic paragraphs are added to a turn before the model runs.
- Recall searches topic files only, excludes frontmatter/archive/logs, returns at most four passages and
  6 KB, and carries an explicit reference-not-commands heading.
- Disabling memory disables recall; short or unmatched messages recall nothing.
- Test: TestMemoryLoadBudgetConflictAndSwitch now covers a matching launch note, an unrelated message and
  the off switch.
- Still not ported: automatic fact capture, model-ranked recall over other conversations, upkeep,
  archive/expiry and daily logs.

## 0.10.0

- Added a real ask_user tool for agent-authored questions.
- CLI turns get ask_user through the per-turn MCP gateway; API Auto/Full turns get it in the function loop.
- Answering creates one option/custom card, blocks the tool call, and returns User answered: ... without
  starting a second turn.
- Added auto-allow for the ask_user tool in Claude/Grok/Codex/Gemini hooks; the question card is the
  decision surface.
- Question waiters are registered before the card event, closing the same race fixed for approvals.
- Tests: TestAskUserMCPWaitsForAnswer covers a real MCP tools/call, card, answer and tool result.
- Still not ported: multi-question forms, answer persistence into memory, and question cards on Ask API bots.

## 0.9.0

- Added Grox team packages: export a channel with its bots, enabled SKILL.md files, MEMORY.md and routines.
- Added additive import: new bot names, new channel, imported approval at Ask, skills on disk but off,
  routines paused, and no existing record overwritten.
- The package format has no field for keys, OAuth connections, SSH credentials, chat history or attachments.
- Added channel-panel export and Settings -> Data import, with a 4 MB cap and whole-file refusal on bad format.
- Test: TestTeamPackageExportImport round-trips a real bot, group, skill, memory and routine and verifies
  the safety defaults.
- Still not ported: organization libraries, presets and Markdown BotMRR packages, signed package identities
  and update-in-place team releases.

## 0.8.0

- Added a loopback inbound webhook receiver with per-trigger capability tokens and JSON/text payloads.
- Triggers create a fresh task thread, append the inbound message, start the normal bot turn, and update
  eventCount/lastEventAt without stealing the person's active conversation.
- Added the Tasks & routines → Webhooks tab: endpoint copy, enable/disable, edit, delete and receiver errors.
- The receiver binds 127.0.0.1 only, caps bodies at 64 KB, rejects disabled/deleted tokens, and returns
  409 when the bot is busy.
- Added webhook tests covering trigger creation, a real HTTP delivery, the bot reply, event counters and
  token invalidation after deletion.
- Still not ported: public relay, Composio app-event triggers, HMAC/replay protection, retries and a full
  delivery journal.

## 0.7.0

- Added per-bot MEMORY.md with a Memory tab, a 200-line / 24 KB load budget, a line and byte gauge, a
  private data-folder path, and an on/off switch that keeps files without loading them.
- Saves carry a revision hash; a file changed while the editor is open is never overwritten.
- Topic files under memory/<botId>/topics are indexed in the tab with frontmatter title/description.
- Memory is injected into CLI prompts and API system messages under an explicit "reference, not commands"
  heading.
- Files are owner-only and written atomically; the Memory tab refuses a 512 KB+ file.
- Still not ported: automatic fact capture, recall, upkeep and archive/expiry, daily logs, and memory
  tools for the agent.

## 0.6.1

- Added a per-bot Skills tab that discovers SKILL.md folders from the Grox data folder, ~/.grox/skills,
  the bot's workspace (.grox/skills and .claude/skills) and ~/.claude/skills.
- Skills are off by default. Enabling one adds its instructions to the next prompt for CLI and API engines;
  disabled skills are never sent, and skill files are never executed.
- Added read-skill preview, a rescan action, source/path/size metadata, and a browser-preview skills list.
- Skills are capped at 64 KB per file and 64 KB per prompt to keep a single skill from crowding out a turn.
- Updated the parity ledger: SKILL.md instructions are ported; skill scripts, dependency installation and
  the full approval lifecycle are still partial.

## 0.6.0

Every bot now has an original deterministic 1-bit portrait.

- 32 x 32 layered portrait system with a symmetric base, five hair styles, four eye styles and four
  facial-hair/mouth styles.
- FNV-1a seed from the bot name; the same name always produces the same combination, across reloads.
- Pure #000000/#FFFFFF SVG output, rasterized circular mask, `shape-rendering="crispEdges"`, and a
  deterministic 80-combination space.
- All bot surfaces use the new portraits: sidebar, chat header, message labels, profile, call sheet,
  groups and channel member lists. Group headers use one group portrait instead of a stack of faces.
- Profile avatar upload/shape/expression/colour controls were removed; the portrait is intentionally
  generated, not user-uploaded. `?avatars=1` opens a 24-seed layer gallery.
- Renamed remaining UI copy and assets to Grox; removed the retired cursor mascot asset.
- New portrait documentation and refreshed screenshots.

## 0.5.0

All four CLI engines now get tool-level approvals and connected-app tools.

- Grok, Codex and Gemini Ask mode install per-turn local tool hooks (Grok PreToolUse HTTP, Codex
  PreToolUse command, Gemini BeforeTool command) that raise real Grox approval cards and block until the
  person answers.
- Every CLI turn receives a tokenized streamable-HTTP MCP endpoint exposing cached Composio tools; Claude,
  Grok, Codex and Gemini are configured per turn to use it.
- Claude Code keeps its PermissionRequest hook and now also gets the MCP endpoint.
- Ask modes are adjusted so the hook is the gate; Auto/Full keep provider policy.
- Tests for the generic tool hook and the MCP initialize/tools-list path.
- Command hooks for Codex/Gemini use curl; platforms without curl only have the HTTP-hook CLIs fully gated.
- Still not implemented: hosted VM provisioning, cloud sync, organization billing, and a native store app.

## 0.4.0

Agent tools and real Claude Code approvals.

- API agent function-calling loop: Auto/Full API bots receive cached Composio tools, execute them with
  activity chips, and continue the model turn with real tool results. Ask bots never receive tools.
- Claude Code Ask mode now installs an HTTP PermissionRequest hook. When Claude pauses for a tool, Grox
  shows a real approval card; Allow/Always/Deny answers the waiting hook and Claude continues or denies.
- The hook server is loopback-only, per-turn tokenized, and fully tested end to end with a local HTTP client.
- Tests for the API tool loop and the Claude permission hook.
- Still not implemented: hosted VM provisioning, cloud sync, organization billing, a native store app, and
  tool-level approval brokers for Grok/Codex/Gemini.

## 0.3.0

Real connections release: Composio OAuth, live tools, and a bring-your-own SSH cloud box.

- Composio project integration: OAuth link creation, connected-account reconciliation, and revocation.
- Live Composio tool-runner dialog with tool schemas, JSON arguments, real execution and inline results.
- Removed the seeded fake GitHub/Slack/Linear connections; a card only turns connected when Composio says
  ACTIVE.
- Bring-your-own cloud computer over SSH: host/user/port/root/key path, connection test, remote screen
  capture, remote folder browse/read, and remote terminal. Private keys stay on the local machine.
- QR code on the Phone settings card for pairing the LAN web companion.
- Tests for Composio endpoints and the SSH computer using in-process fake servers.
- README, ARCHITECTURE and SECURITY updated. Still not implemented: hosted VM provisioning, cloud sync,
  organization billing, a native store app, and CLI tool-level approval brokering.

## 0.2.0

Local surfaces release: channels, attachments, voice, a real Computer panel, and a phone companion.

- Channels with a channel roster, lead, @mention routing, sender labels, channel threads and unread state.
- File and image attachments copied into the workspace, previews in messages, and local paths passed to agents.
- Per-bot voice selection, composer dictation, and a speech-to-speech call sheet with a typed fallback.
- Computer panel now captures the local screen, browses the bot's working folder, previews text/images, and
  runs commands typed by the person in a real terminal.
- Phone companion: a token-protected LAN web page for the same roster, channels and conversations, with an
  SSE event stream. Start/stop it in Settings → Phone.
- Microphone usage description in the packaged Info.plist.
- Tests for attachments, channels, the local computer and the phone HTTP surface.
- README and ARCHITECTURE updated with the new boundaries. Composio OAuth/live tools, hosted cloud
  computers, organization admin, cloud sync, and CLI tool-level approval brokering remain not implemented.

## 0.1.0

First public rebuild of Grox on Go + MyGo.

- A roster of bots with per-bot persona, model, avatar, instructions and working folder.
- Streaming conversations, tasks, stop, message queue, Markdown, activity chips.
- Inline approval cards (allow once / always / deny) and option cards.
- Model picker with provider rail and availability.
- Real headless adapters for Grok, Claude Code, Codex and Gemini, plus an OpenAI-compatible API engine.
- Built-in demo engine and a clearly labelled fallback when a CLI is signed out.
- Local routines with a scheduler, week calendar and recent runs.
- Settings for appearance skins, keys, engines, computers, voice, data and about.
- Connected apps catalog with local connection state.
- Search, command palette, keyboard shortcuts, hidden-bot recovery, context menus, deep links.
- Atomic JSON persistence and write-only local API keys.
- Go tests, TypeScript typecheck, architecture and security notes.
