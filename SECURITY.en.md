# Security

[简体中文](SECURITY.md)

## Scope

Grox runs local agent CLIs with the current user's permissions and stores the workspace as local files.
The main security boundaries are:

- the webview page cannot read arbitrary files or call providers directly;
- API keys are stored in a 0600 file and never sent back to the page;
- Markdown is rendered without raw HTML;
- approval modes are passed to each CLI, and the demo engine asks in-app;
- attachments are copied into the workspace and served to the page by id, not by arbitrary path;
- the local Computer panel only resolves paths under the bot's working folder (or home) and the terminal
  is explicitly typed by the person;
- the phone companion is a LAN-only HTTP page protected by a random token in the URL;
- the SSH computer reads a key path but never copies the key into the workspace, and verifies the host
  against ~/.ssh/known_hosts when that file exists;
- Composio OAuth links and live tool calls are explicit actions; a tool runs only when the person presses
  Run tool;
- the app does not include telemetry, a remote updater, or a hosted relay.

Grox is **not** a sandbox. A CLI started in Full mode can do anything the current user can do. Treat a bot
with Full access as you would treat a shell with your account.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Email the maintainer listed in the repository's
profile, or use GitHub's private security advisory flow on the repository. Include:

- affected version and platform,
- reproduction steps,
- the impact you believe it has,
- whether a provider key, a local file, or the approval boundary is involved.

You can expect an initial acknowledgement within a few days. This is a small project; please be patient.

## Data at rest

The workspace (state.json) is plain JSON. The secrets file is 0600, but it is not encrypted by Grox. Rely
on full-disk encryption and operating-system account security. Backups and exports may contain transcripts;
export deliberately omits secrets.

Attachments live in the attachments/ directory with 0600 files. The phone token lives in state.json; anyone
who obtains the token and can reach the Mac's LAN port can read and send conversations. Turn the phone
companion off when it is not in use, and do not expose port 4870 to the public internet.

## Remote computer

An SSH computer is a powerful boundary. Commands and file reads run on the remote host with the SSH user's
permissions. The remote root is an absolute path; Grox rejects paths that escape it, quotes command
arguments, and applies a deadline. If ~/.ssh/known_hosts is absent, the SSH client uses trust-on-first-use;
add the host key to known_hosts for a stricter check. The private key is read from the path you provide and
is never uploaded or written into Grox's workspace.

## Composio

A Composio project key is stored in the 0600 secrets file. OAuth happens on Composio's hosted page; Grox
receives the redirect URL and opens the system browser. Connected-account status is only shown as connected
when Composio reports ACTIVE. The live tool runner sends the arguments the person entered to Composio; treat
that as a real third-party action, not a preview. No local fallback fakes a tool response.

## Local computer

Screen capture, folder browsing, and the terminal are person-driven surfaces. The terminal runs with the
current user's permissions and is not a sandbox. The agent does not get an unattended terminal through this
panel, but code or a CLI that the person already approved can still act within its own permission mode.
Screen capture may require macOS Screen Recording permission; microphone use requires Microphone permission.
The phone page cannot open the Computer panel or approval cards.

## CLI tool gate and MCP gateway

In Ask mode Grox starts a loopback HTTP server, mints a random per-turn token, and installs a provider hook:
Claude Code PermissionRequest, Grok PreToolUse HTTP, Codex PreToolUse command, or Gemini BeforeTool command.
The hook carries tool name/input to Grox; Grox appends an approval card and keeps the request open until
the person chooses Allow/Always/Deny. Codex and Gemini hooks run a tiny temporary curl script with the
per-turn URL; they are not given a general command execution endpoint. The server binds 127.0.0.1 only and
fails closed on timeout or app close.

The same loopback server exposes a tokenized streamable-HTTP MCP endpoint for that turn. It lists cached
Composio tools and executes tool calls through Composio. The CLI's Ask hook sees the MCP tool call and gates
it; in Auto/Full the provider's policy applies. This is a real MCP server, not a local fake tool result.

The Ask modes are intentionally adjusted so the hook is the gate: Grok runs auto, Codex runs
workspace-write, and Gemini runs yolo with the hook installed. If a CLI rejects the injected config, its
mode still applies; review the CLI's own logs before relying on the gate.

## Prompt injection and untrusted content

Agent replies, web content, files, and tool output are untrusted data. Grox renders them as Markdown and
does not execute HTML. A real CLI may act on prompt-injected content when its permission mode allows it;
that is exactly why the default is Ask and why Full is explicit.

## Known limitations

- Ask-mode CLI tool prompts are brokered through per-turn loopback hooks. If a CLI rejects its injected
  hook config, the provider mode still applies.
- The phone companion uses plain HTTP on the local network; it is not a hardened remote-access service.
- Composio OAuth, the manual live tool runner, per-turn MCP tools for CLI engines, and automatic tools
  for Auto/Full API bots are implemented. Ask API bots never receive tools.
- Hosted cloud provisioning, cloud sync, organization billing, and a native mobile app are not implemented.
- The demo engine is local and does no network or file work, but its approval cards are scripted.
- The browser preview uses an in-memory mock; do not put real secrets into it.
