# Security

## Scope

Grox runs local agent CLIs with the current user's permissions and stores the workspace as local files.
The main security boundaries are:

- the webview page cannot read arbitrary files or call providers directly;
- API keys are stored in a 0600 file and never sent back to the page;
- Markdown is rendered without raw HTML;
- approval modes are passed to each CLI, and the demo engine asks in-app;
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

## Prompt injection and untrusted content

Agent replies, web content, files, and tool output are untrusted data. Grox renders them as Markdown and
does not execute HTML. A real CLI may act on prompt-injected content when its permission mode allows it;
that is exactly why the default is Ask and why Full is explicit.

## Known limitations

- Real CLI tool permission prompts are not brokered by Grox in this version.
- The demo engine is local and does no network or file work, but its approval cards are scripted.
- The browser preview uses an in-memory mock; do not put real secrets into it.
