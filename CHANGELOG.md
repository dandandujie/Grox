# Changelog

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
