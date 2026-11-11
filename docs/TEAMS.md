# Team packages

A Grox team package moves one channel with its member bots to another Grox workspace. This is the
local-code part of OpenMausBot's department sharing. Organization libraries, hosted sharing, presets and
the exact OpenMausBot package binary schema are not ported.

## What travels

- Channel name, description and colour.
- Member bots: name, title, description, standing instructions, colour and model id.
- Enabled SKILL.md files only; the complete file text is copied.
- MEMORY.md text.
- Routines for member bots.

## What never travels

- Chat history and thread messages.
- API keys, secrets.json, Composio connections and OAuth state.
- SSH credentials, private key paths and computer settings.
- Disabled skills (the package does not reveal what did not load).
- Local MCP servers, browser state, attachments or files.

The export is JSON with format grox.team and version 1. It has a group, a bots array and an optional
routines array. It does not have a field for credentials.

## Export

Open the channel panel and choose Export team package. Grox downloads a .grox-team.json file. The export
is built from the same data the channel uses; it does not call a server.

## Import

Settings -> Data & privacy -> Team packages -> Import team reads a package and adds new records:

- Bot names that collide get a numeric suffix.
- Bot approval starts at Ask regardless of the source.
- Enabled skills are written under dataDir/skills/imported-* and start switched off for the new bot.
- Routines arrive paused.
- The channel is added; no existing bot, channel or routine is modified.
- A package with a missing or unsupported format is refused before any record is written.

Import is additive. It is not a merge and it does not carry a host or organization identity.

## Limits and safety

- 4 MB package cap.
- Invalid JSON or a bad format is refused whole.
- The format has no field for credentials. A credential can still appear inside free text, such as a note
  someone typed into MEMORY.md. Review a package before importing it from another person.
- Imported skills are plain SKILL.md files, off until enabled; they are never executed.

## Not ported

- Organization library and admin packages.
- Presets and complete Markdown team files from BotMRR.
- Signed packages, package ids/versions and update-in-place releases.
- Photo/avatar images; Grox portraits are generated from the bot name.

## Signed packages

ExportTeam now signs the package with a local ed25519 key and includes:

- signature: base64 signature
- publicKey: base64 public key
- signedAt: UTC timestamp

The signature covers the canonical package JSON with those three fields cleared. ImportTeam verifies the
signature when present and fails closed if it is incomplete or does not match. Unsigned packages from older
Grox versions are still accepted.

The signing seed lives in secrets.json under team:signing-key and is generated on first signed export. A
signature detects accidental or deliberate edits after export; it does not prove who authored the package
or establish a trust registry. Organization-signed releases, revocation and key discovery are not ported.

