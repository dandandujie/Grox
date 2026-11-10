<div align="center">

<img src="docs/screenshots/chat.png" alt="Grox — a chat app where every contact is a real AI agent" width="100%" />

# Grox

**A local-first chat app for a team of AI agents.**
The open-source Grok Bot alternative, written in Go with MyGo and React.

[Quick start](#quick-start) · [What is real](#what-is-real-and-what-is-not) · [Architecture](ARCHITECTURE.md) · [Screenshots](#screenshots)

![Go](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white)
![MyGo](https://img.shields.io/badge/UI-MyGo-009957)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

---

Grox is a local-first, bring-your-own-agent desktop app. Every row in the sidebar is a bot with its own
personality, model, conversations, working folder, and approval boundary. Talk to them like contacts; watch
them work; approve the steps that matter. Shared channels put several bots in one room, with a lead and
@mentions. Files, images, voice, a real local computer, and a private phone page are part of the same app.

It runs the agent CLIs you already use — **Grok Build, Claude Code, Codex, Gemini** — or any
OpenAI-compatible endpoint. No relay, no account, no telemetry. The workspace stays in
~/Library/Application Support/Grox (or the platform equivalent).

The interface follows the shape of [OpenMausBot](https://github.com/milind-soni/OpenMausBot), the
open-source Grok Bot alternative: a messaging app for a roster of agents, not a single chat box. The
implementation is new: Go services, typed MyGo bindings, a React/Vite frontend, and a local demo engine
that keeps the app usable before you connect anything.

## Why

One assistant in one box is the wrong shape for agents. A roster is better: one bot for research, one for
the inbox, one for code, each with a different model and a different permission boundary. Grox keeps that
shape local and inspectable:

- **Bring your own agent.** Use the CLIs already installed and signed in on your machine.
- **Pick a brain per bot.** Grok, Claude, GPT, Gemini, or a local demo/model; switch mid-conversation.
- **Ask before acting.** Approval modes per bot; the demo engine shows real approval cards, and every
  real CLI is started with its own read-only / edits / bypass policy.
- **Every bot has a memory.** Conversations, tasks, and routine runs are separate threads owned by a bot.
- **A room for the team.** Channels have members, a lead, @mentions, and their own transcript. The lead
  answers by default; mention @Omiii and the turn is routed there.
- **Files come with the message.** Attach images or files from the composer; bytes are copied into the
  workspace and the local path is given to the agent.
- **A real local computer.** The Computer panel can capture this Mac's screen, browse the bot's folder,
  preview files, and run a command you typed yourself.
- **Voice on this machine.** Dictate into the composer, or start a call that listens with the system
  speech service and speaks the reply with the system voice.
- **Your phone, on your Wi-Fi.** Turn on the phone companion to get a private link for the same roster and
  conversations. No account or cloud relay.
- **Local first.** A Go process owns the workspace. The frontend is a web page in the system webview.

## Screenshots

| Chat and approvals | Agent profile |
| --- | --- |
| ![Chat](docs/screenshots/chat.png) | ![Agent profile](docs/screenshots/profile.png) |

| Model picker | Approval card |
| --- | --- |
| ![Models](docs/screenshots/model.png) | ![Approval](docs/screenshots/approval.png) |

| A question card | Tasks & routines |
| --- | --- |
| ![Options](docs/screenshots/options.png) | ![Routines](docs/screenshots/routines.png) |

| Connected apps | Settings |
| --- | --- |
| ![Apps](docs/screenshots/apps.png) | ![Settings](docs/screenshots/settings.png) |

| Engines | Computer panel |
| --- | --- |
| ![Engines](docs/screenshots/engines.png) | ![Computer](docs/screenshots/computer.png) |

| New bot | New channel |
| --- | --- |
| ![New bot](docs/screenshots/newbot.png) | ![New channel](docs/screenshots/channel.png) |

| Voice call |
| --- |
| ![Voice call](docs/screenshots/voice.png) |

| Channels | Phone companion |
| --- | --- |
| ![Channels](docs/screenshots/channels.png) | <img src="docs/screenshots/phone.png" alt="Phone companion" width="320" /> |

## What is real (and what is not)

Grox is a complete, working core, not a claim that every cloud feature of a commercial product exists here.
The table below is intentionally blunt.

| Surface | Status |
| --- | --- |
| Bot roster, search, pin, hide, duplicate, delete, context menus | **Working** |
| Per-bot persona, instructions, model, colour, mascot shape/expression | **Working** |
| Conversations, tasks, a thread switcher, unread counts | **Working** |
| Streaming replies, Markdown + tables + code blocks, stop, message queue | **Working** |
| Attachments: images and files up to 32 MB, stored in the workspace | **Working** |
| Channels: members, lead, @mentions, channel threads, sender labels | **Working** |
| Question cards, approval cards, allow once / always / deny | **Working** (demo and seeded conversations) |
| Tool activity chips above a reply | **Working** for the demo engine and parsed CLI tool events |
| Model picker with provider rail and availability | **Working** |
| Grok CLI, Claude Code, Codex CLI, Gemini CLI execution | **Working** headless adapters; authentication is the CLI's |
| OpenAI-compatible API (xAI, OpenAI, OpenRouter, Ollama, LM Studio…) | **Working** streaming adapter |
| Built-in demo engine when nothing is connected | **Working**, and clearly labelled in the reply and settings |
| Local routines with a scheduler and a calendar | **Working**; a ticker runs due routines as tasks |
| Routine runs, recent runs, open the resulting task | **Working** |
| API keys stored locally, write-only to the page, 0600 file | **Working** |
| Skins (Midnight / Daylight / Atelier / Foundry), reduce motion | **Working** |
| Command palette, keyboard shortcuts, Cmd+1–9, deep links | **Working** |
| Connected apps catalog, local switches, Composio key field | **Catalog is real; OAuth and live tool calls are not wired.** The key is stored, but no account is faked |
| Cloud computers / hosted remote desktop | **Not included.** Local screen/files/terminal are real; there is no hosted VM service |
| Voice input and speech-to-speech calls | **Working locally** via the webview's speech recognition and the system voice; availability depends on the webview |
| Local computer: screenshot, folder browse, file preview, terminal | **Working** on this Mac; screen capture needs Screen Recording permission |
| Channels, multi-agent group chat, @mention routing | **Working** locally |
| Phone companion (LAN web page, same roster and chats) | **Working** while the desktop app is open; plain HTTP + private token on your network |
| Cloud sync, enterprise admin, organization billing | **Not included** |
| Approval brokering for real CLI tool requests | **Partial.** Approval mode is passed to the CLI; only the demo/seed cards and local computer commands are controlled in-app |

> In other words: the conversation, roster, model, profile, routines, settings, and local-agent parts are
> real. The hosted/cloud parts are deliberately absent and labelled, rather than mocked as connected.
> This repository is an independent project; it is not affiliated with xAI, Anthropic, OpenAI, Google,
> Manus, Meta, or the OpenMausBot project.

## How it works

    ┌──────────────────────────── MyGo window (WKWebView / WebView2 / WebKitGTK) ────────────────────────────┐
    │  React + Vite                                                                                         │
    │    Sidebar · ChatView · Composer · ModelPicker · BotPanel · Settings · Routines · Apps · Palette      │
    │         │  typed calls / one event stream                                                              │
    └─────────┼──────────────────────────────────────────────────────────────────────────────────────────────┘
              │  MyGo IPC (JSON, generated TypeScript client)
    ┌─────────▼──────────────────────────────────────────────────────────────────────────────────────────────┐
    │  Go · internal/service                                                                                │
    │    bots · threads · messages · approvals · routines · scheduler · settings · secrets                 │
    │         │                                                                                             │
    │    internal/agent ──► demo │ Grok CLI │ Claude Code │ Codex CLI │ Gemini CLI │ OpenAI-compatible API  │
    │         │                                                                                             │
    │    internal/store (atomic JSON) · internal/catalog (models, engines, apps) · internal/schedule        │
    └──────────────────────────────────────────────────────────────────────────────────────────────────────┘

mygo generate turns the bound Go service and its event type into src/mygo.ts, so the frontend and the
backend are checked against the same types. The page never talks to a provider directly.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the data model, engine selection, approval mapping, event
protocol, and security boundaries.

## Quick start

### Requirements

- **Go 1.27.3+**
- **Node.js 22.6+** (npm or pnpm; the project uses npm)
- The system webview: WKWebView on macOS, WebView2 on Windows, WebKitGTK 4.1 on Linux
- Optionally, one or more agent CLIs on PATH: grok, claude, codex, gemini

### Run

    git clone https://github.com/dandandujie/Grox.git
    cd Grox
    npm install
    npm run dev

npm run dev runs mygo dev: it builds the Go app, starts Vite on http://localhost:5174, opens the
development window, and reloads the page as you edit the frontend. Edit a .go file and MyGo restarts the
app.

The npm scripts route Go through scripts/with-go.mjs. It prefers ~/sdk/go1.27.3, removes a stale GOROOT,
and refuses a toolchain older than 1.27.3 before MyGo runs. If your shell already has 1.27.3 on PATH, the
script simply uses it.

Alternative without npm scripts:

    # after putting Go 1.27.3 on PATH
    go run github.com/egoist/mygo/cmd/mygo@v0.8.3 dev

### Build a native app

    npm run build
    # macOS Apple silicon
    open "build/darwin-arm64/Grox.app"

MyGo packages the current platform by default. For other targets:

    npm run build -- -platform linux/amd64,windows/amd64

The build is ad-hoc signed on macOS by default. Set macos.signingIdentity in mygo.config.ts to sign with a
Developer ID, and macos.notarize to notarize the DMG.

### First launch

The first run seeds a small team — Brody (research), GitScout (code review), Emaily (inbox), Omiii
(operations), and Onyx (personal) — so the app is useful before you configure anything. The bots are
pointed at real models only when those engines are available; otherwise a turn falls back to the
built-in demo and says so in a toast.

To put a real model behind a bot:

1. **Settings → Engines** shows which CLIs are installed.
2. **Settings → Connections** stores API keys locally (or export XAI_API_KEY, OPENAI_API_KEY,
   ANTHROPIC_API_KEY, GEMINI_API_KEY before launching).
3. Pick a model from the pill in the chat header. Switching mid-conversation is allowed.

## Data and privacy

| What | Where |
| --- | --- |
| Workspace (bots, threads, routines, settings, connections) | user config/Grox/state.json |
| API keys | user config/Grox/secrets.json, mode 0600 |
| Window size | user config/Grox/window-state.json |
| Attachments | user config/Grox/attachments/ |
| Phone pairing token | state.json (settings.phoneToken) |
| Frontend | Built into the Go binary |
| Telemetry | None |

On macOS, the user config directory is ~/Library/Application Support. Linux uses $XDG_CONFIG_HOME/Grox (or
~/.config/Grox); Windows uses %APPDATA%\Grox.

Keys are never returned to the page: the frontend only sees a configured flag and a masked tail. The
workspace export deliberately omits keys. The backend never shells out with a prompt; the agent CLIs are
started with exec.CommandContext and their own arguments.

**Channels.** Every channel has its own threads. A user message is routed to an @mentioned member or to
the lead. The responder gets the channel history with each bot's name, so the room reads correctly to the
model. A channel turn is still one agent turn; it does not fan out to every member.

**Voice.** Dictation and calls use the browser/webview's speech recognition when available. The Mac's
microphone permission is declared in Info.plist. The call sheet also has a typed fallback, and all
transcripts/speech are handled locally by the OS service; Grox does not upload audio.

**Local computer.** The Computer panel is a real window into this Mac: screencapture for the screen,
read-only folder browsing and previews rooted at the bot's working folder, and a terminal that runs only
commands you type. It is not exposed to an agent as an unattended tool, and it is not a hosted VM.

**Phone companion.** The Go process can serve a small mobile page on your LAN, protected by a random token
in the URL. It can read the roster and send messages; approval cards and the computer stay on the desktop.
Turn it off from Settings → Phone when not needed. The link uses plain HTTP on the local network.

**Approval boundaries.** Each bot's mode maps to the provider's own flags:

| Grox | Grok CLI | Claude Code | Codex CLI | Gemini CLI |
| --- | --- | --- | --- | --- |
| Ask | --permission-mode dontAsk | plan + --permission-prompts none | -s read-only | --approval-mode plan |
| Auto | --permission-mode auto | auto + prompts none | -s workspace-write | --approval-mode auto_edit |
| Full | --permission-mode bypassPermissions | bypassPermissions | --dangerously-bypass-approvals-and-sandbox | --approval-mode yolo |

The demo engine implements the inline allow/deny card. A real CLI's internal permission prompts are not
brokered by Grox in this version; the table above is the boundary it actually applies.

## Development

    npm run typecheck       # TypeScript
    npm run test:go         # Go tests, through the pinned Go wrapper
    npm run verify          # typecheck + Go tests + go vet

Useful debug deep links (also a foundation for the desktop's own links):

    GROX_DEBUG_QUERY='panel=profile' ./build/darwin-arm64/Grox.app/Contents/MacOS/Grox
    GROX_DEBUG_QUERY='bot=bot-emaily&theme=midnight' ./build/darwin-arm64/Grox.app/Contents/MacOS/Grox

Supported query keys: bot, group, thread, view=chat|routines|apps, panel=profile|computer|activity,
settings=general|connections|engines|computer|phone|voice|data|about, modelPicker=1, newBot=1,
newChannel=1, newRoutine=1, call=1, palette=1, shortcuts=1, threads=1,
theme=midnight|daylight|atelier|foundry, search, and send (pre-send a message, used by the screenshot
fixture).

The browser preview:

    npm run dev:web
    # open http://localhost:5174

When the page is not inside a MyGo window it loads a small in-memory mock backend and the fixture in
src/mock/bootstrap.json. Regenerate the fixture after changing the seed:

    node scripts/with-go.mjs go run ./cmd/fixture > src/mock/bootstrap.json

## Repository layout

    main.go                     MyGo app: window, typed bindings, one event stream
    internal/model              persisted and wire types
    internal/store              atomic JSON state + write-only secrets + first-run seed
    internal/catalog            model catalog, app catalog, CLI detection
    internal/schedule           routine next-run calculation
    internal/agent              demo, CLI, and OpenAI-compatible engines
    internal/service            bots, threads, turns, approvals, routines, settings
    src/                        React frontend
      components/              the interface
      state/store.tsx          one store for state + events
      lib/bridge.ts            real MyGo bridge / browser preview switch
      mygo.ts                  generated typed client (do not edit)
    cmd/fixture                 browser-preview bootstrap generator
    docs/screenshots            captured from the built app

## Attribution

The bot mascot silhouette is adapted from the Maus mascot body set in
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (shared/mascot-bodies.ts, Apache-2.0). The
information architecture and interaction vocabulary — roster, model pill, inline approval/question cards,
agent profile, routine calendar — are inspired by the same project. See [NOTICE](NOTICE).

This project is **not** affiliated with xAI, Anthropic, OpenAI, Google, Meta, Manus, or OpenMausBot.

## License

Apache-2.0. See [LICENSE](LICENSE).
