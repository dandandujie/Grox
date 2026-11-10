# Changelog

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
