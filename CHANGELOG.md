# Changelog

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
