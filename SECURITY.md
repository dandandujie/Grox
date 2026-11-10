# Security

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

## Local computer

Screen capture, folder browsing, and the terminal are person-driven surfaces. The terminal runs with the
current user's permissions and is not a sandbox. The agent does not get an unattended terminal through this
panel, but code or a CLI that the person already approved can still act within its own permission mode.
Screen capture may require macOS Screen Recording permission; microphone use requires Microphone permission.
The phone page cannot open the Computer panel or approval cards.

## Prompt injection and untrusted content

Agent replies, web content, files, and tool output are untrusted data. Grox renders them as Markdown and
does not execute HTML. A real CLI may act on prompt-injected content when its permission mode allows it;
that is exactly why the default is Ask and why Full is explicit.

## Known limitations

- Real CLI tool permission prompts are not brokered by Grox in this version.
- The phone companion uses plain HTTP on the local network; it is not a hardened remote-access service.
- Composio OAuth and live third-party tool calls are not implemented.
- The demo engine is local and does no network or file work, but its approval cards are scripted.
- The browser preview uses an in-memory mock; do not put real secrets into it.
