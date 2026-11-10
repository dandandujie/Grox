# Grox architecture

This document describes the implementation in this repository. It is intentionally narrower than a
product spec: it explains what the code does, where the boundaries are, and which parts are deliberately
absent.

## 1. Shape

Grox is one Go process with one webview window.

    MyGo window (WKWebView / WebView2 / WebKitGTK)
      React 19 + Vite
        components/            presentation
        state/store.tsx        state + event reducer + actions
        lib/bridge.ts          real MyGo client or browser preview
        mygo.ts                generated typed client
              │
              │  one JSON event stream, typed calls
              ▼
    Go process
      internal/service         the bound Grox service
      internal/agent           engine selection and harnesses
      internal/store           atomic workspace + secrets
      internal/catalog         models, providers, apps, CLI detection
      internal/schedule        next-run arithmetic
      internal/model           wire + persisted types

There is no localhost HTTP API, no separate harness process, and no relay. The MyGo binding is the only
transport. The frontend asks Go for a snapshot, then folds events into it.

## 2. Lifecycle

1. **main** creates the Service with the platform config directory and an emit callback.
2. **mygo.BindAs("Grox", svc)** publishes the service methods; mygo generate writes src/mygo.ts.
3. **App.WhenReady** opens the workspace, starts the routine scheduler, creates the window with
   TitleBarHiddenInset, and stores the window pointer in an atomic.Pointer for event emission.
4. The page loads, calls **Grox.bootstrap()**, and renders.
5. On quit, **service.Close** cancels turns and flushes state.

The workspace is opened after the app is ready, not during mygo generate, so code generation never touches
the person's data.

## 3. Request lifecycle

A message send is the clearest path through the system.

    page: Grox.send(botID, threadID, text)
      service.Send
        validate bot, thread, not busy
        append a user message
        update title/unread/active selection
        save state, emit state
        startTurn
          copy bot + thread for the engine
          choose engine (see §5)
          mark thread busy, emit turn
          goroutine: agent.Run
            sink.Text(delta)  → emit message (first time) + delta events
            sink.Activity     → append an activity and emit message
            sink.Approval     → append an approval card and emit message
            sink.Options      → append an options card and emit message
          finishTurn
            mark the turn message final/error/stopped
            busy = false, unread++, save state
            emit message (final), turn (not busy), state

A bot message is created lazily on the first text or activity. That keeps a turn with only an approval card
from leaving an empty bubble, and it preserves the visual order "tool chips → card → answer".

### Events

One event type is published as the MyGo event "app":

| type | payload | meaning |
| --- | --- | --- |
| state | full AppState | structural change or first-paint refresh |
| message | Message | create/replace one message (base, activity, card, final) |
| delta | messageId + text | append streaming text to a message |
| turn | Turn | busy/status/engine for one thread |
| toast | Toast | transient notice, e.g. engine fallback |

The page applies message/delta/turn incrementally and replaces the document on state. State snapshots are
deep-copied through JSON before emission, so the page never shares mutable Go memory.

The full document is only emitted at boundaries, not per token. Long replies therefore cost one message
base event, N deltas, and a final message + state event.

## 4. Data model

The workspace is a single JSON document:

    AppState
      version, revision, createdAt, updatedAt
      bots: []Bot
        id, name, title, description, soul, color, mascotShape, expression, avatarUrl
        modelId, approval, workingDir, notifications, speakReplies
        pinned, hidden, archived
        threads: []Thread
          id, title, kind, unread, busy, status
          messages: []Message
            role, kind, text, status, pending, error
            engine, model
            options, approval, activities
      routines: []Routine
      runs: []Run
      connections: map[appId]Connection
      settings: Settings
      activeBotId, activeThreadId

Kinds and roles are strings by design: the frontend and the wire type stay easy to extend. The constants
live in internal/model.

### Timestamps and formatting

Go writes time.Time as RFC 3339 strings. The frontend formats them with the "en" locale because the UI copy
is English; the date helpers are isolated in src/lib/format.ts.

## 5. Engine selection

internal/agent owns selection, not the UI. A turn carries:

- the bot persona and instructions,
- the recent transcript,
- the selected model and its provider,
- the approval mode,
- the working directory,
- the engine preference from Settings,
- API base URL/key,
- which CLIs were detected.

Selection rules, in order:

1. Settings **Demo**, a Local model, or the demo model → demo engine.
2. Settings **API** with a base URL → OpenAI-compatible API.
3. Settings **Grok / Claude / Codex / Gemini** → that CLI if installed; otherwise demo with a note.
4. **Auto**:
   - provider CLI installed → that CLI,
   - Grok/OpenAI with an API base and key → API,
   - otherwise demo with a note.

The note becomes a toast ("Grok CLI is not connected…"). If a CLI is installed but the run fails because
the CLI is signed out or the binary disappeared, the service retries the same turn on the demo engine and
emits a toast. The final message carries the actual engine name (e.g. "Grox Demo") in its metadata.

### CLI adapters

All CLI runs are headless and non-interactive:

| Provider | Program | Main arguments |
| --- | --- | --- |
| Grok | grok | --permission-mode MODE -m MODEL --output-format streaming-messages-json --include-partial-messages --no-alt-screen --cwd DIR -p PROMPT |
| Claude | claude | -p --model MODEL --output-format stream-json --verbose --include-partial-messages --permission-mode MODE --permission-prompts none (prompt on stdin) |
| Codex | codex | exec --json --skip-git-repo-check --color never -C DIR -m MODEL -s SANDBOX - (prompt on stdin) |
| Gemini | gemini | -p PROMPT -m MODEL -o stream-json --skip-trust --approval-mode MODE |

Output is parsed line by line as NDJSON. The parsers understand:

- Anthropic Messages wire events (Grok's streaming-messages-json and Claude's stream-json):
  content_block_delta text, tool_use activities, assistant fallbacks, result;
- Codex item.completed events: agent_message, command_execution, reasoning, web_search, mcp_tool_call;
- Gemini message/tool_use/tool_result events.

If a provider emits plain text instead, it is collected and used as the reply. stderr is drained to a
bounded tail for error messages. The process is killed by CommandContext on stop, timeout, or app quit.

### API adapter

internal/agent/api.go posts a standard chat.completions request with stream: true, parses SSE data:
frames, appends choices[0].delta.content, and supports string or block-array content. It works with xAI,
OpenAI, OpenRouter, Ollama, LM Studio, and similar gateways. It does not implement the Anthropic Messages
API or provider-specific tool protocols.

### Demo engine

internal/agent/demo.go is deterministic and local. It streams a useful reply, and it can emit:

- a tool activity chip,
- an approval card (for commands that would touch files/inbox/remote services),
- an options card (for "which / choose / prioritize" decisions),
- a follow-up after an allow/deny decision or an option answer.

It is the default when no engine is connected, and it is the source of the seeded approval/question cards.
It deliberately says that it is the demo engine in its replies. It makes no network calls.

## 6. Approvals

An approval is a message of kind "approval" with status pending/allowed/always/denied and a Decision
timestamp. Four operations exist:

- Allow once: mark allowed and continue with the command.
- Always allow: mark always and set the bot's approval mode to Auto.
- Deny: mark denied and continue with a stopped explanation.
- The card is settled in place; the follow-up is a normal bot turn.

For real CLIs the app does not broker tool-level permissions. It passes a mode to the CLI:

- Ask → read-only / dontAsk / plan (nothing destructive should be approved automatically),
- Auto → accept edits / auto,
- Full → bypass.

This is a deliberate, honest boundary. A future version can add a permission-prompt transport for each
provider, but it is not faked here.

## 7. Routines and the scheduler

A routine is a prompt + a bot + a cadence + a time. internal/schedule returns the first run strictly after
now. The service starts a goroutine with a 20-second ticker:

- disabled or future routines are skipped;
- a run more than 45 minutes late is marked "missed" and rescheduled instead of replaying the day;
- a busy bot defers the routine by two minutes;
- otherwise a new task thread is created, a Run record is appended, the routine's nextRun is advanced, and
  the prompt is sent through the normal turn path.

Runs are visible in Tasks & routines and the Activity tab. A task is just a Thread with kind = "task"; it
has no special execution path.

## 8. Persistence and atomicity

internal/store.Open:

1. creates the directory with 0700,
2. loads secrets.json if present,
3. reads state.json; if it is missing, seeds the first-run team; if it is corrupt, renames it to
   state.json.broken-<timestamp> and seeds,
4. normalizes stale busy flags, defaults, and selections.

Writes use a temporary file in the same directory, chmod 0600, write, fsync, close, rename. There is no
lock file; the app is single-instance by construction and all state mutations are behind Service.mu.

Secrets are a separate file and never included in AppState. The page sees SecretStatus:
configured booleans and masked tails only. Environment variables are accepted as a fallback for CLI users.

## 9. Security boundaries

- The frontend is a local page served by MyGo; it has no direct filesystem or network privileges.
- Provider API keys live in Go and are only used for outbound HTTPS headers.
- The CLI runs with the current user's permissions. It is not sandboxed by Grox; the approval mode is the
  boundary. Full access is explicit and per bot.
- Markdown is rendered with react-markdown and no raw HTML. Links open externally.
- The transcript is JSON in a local file; there is no encryption at rest. Disk encryption is the OS's job.
- Export omits secrets.
- No telemetry, analytics, updater, or remote configuration is included.

## 10. Frontend state

There is one AppProvider. It holds:

- the latest full state (from bootstrap and state events),
- providers, apps, engines, secrets (catalog-level data),
- UI state: active bot/thread, view, right panel, open dialogs, search, toasts, confirmations,
- actions that call the backend and translate errors into toasts.

The event reducer is intentionally small:

- state → replace,
- message → upsert in the addressed bot/thread,
- delta → append or create a placeholder message,
- turn → update busy/status.

Selection is local and mirrored to Go with Grox.select. The server's active IDs are for persistence, not
authority over the page.

## 11. Extending

**Add a model/provider:** add entries in internal/catalog/catalog.go and a CLI mapping in
internal/agent/agent.go + cli.go. The model picker and catalog page update automatically.

**Add an API provider:** the OpenAI-compatible adapter already accepts any base URL. For a different wire
protocol, add a new engine file and a branch in agent.Run; keep the Sink contract so the UI need not change.

**Add a real approval broker:** add a permission event to the provider driver, create an approval message
with a correlation ID, and have Decide call back into the driver. The existing card and event protocol can
carry it without a schema change.

**Add a cloud computer:** implement it as a separate service and expose capability flags; do not make the
Computer panel imply a live desktop when one is not connected.

## 12. Testing

    go test ./...
    npm run typecheck
    npm run verify

- internal/schedule: next-run arithmetic.
- internal/store: seeding, persistence, secret modes, corrupt-state recovery.
- internal/agent: demo paths, approval/options, CLI event parsing, API SSE.
- internal/service: real turn streaming, approval decisions, answer cards, routine runs, bot creation,
  persistence across reopen, stop.
- Frontend: typecheck plus the production Vite build.

The screenshots in docs/screenshots are captured from the built app via a macOS window capture; the
GROX_DEBUG_QUERY deep links make each state reproducible.

## 13. Known limitations

- No cloud computers, Composio OAuth sessions, live app tool calls, group chats, channels, file
  attachments, microphone calls, mobile companion, or admin surfaces.
- Real CLI tool permissions are not brokered; approval mode is passed through.
- The browser preview uses a separate in-memory mock, not the Go backend.
- The demo engine is a deterministic scripted engine, not a model. It is labelled as such.
- The activity calendar is a week planner, not a minute-by-minute scheduler UI.
- The app is single-window by design.

## 14. Attribution

The mascot silhouette and the broad interaction vocabulary come from OpenMausBot (Apache-2.0). See NOTICE
and LICENSE.
