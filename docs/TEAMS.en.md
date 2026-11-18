# Team packages

[简体中文](TEAMS.md)

Open a channel’s details and choose **Share team**. The Grox file is for another Grox workspace. The OpenMaus file uses the portable `openmaus.package` format and can be read by OpenMausBot.

| Data | Grox file | OpenMaus file |
| --- | --- | --- |
| Bots, personas, channel and shared instructions | Included | Included |
| Enabled skills and compatible routines | Included | Included |
| Playbooks | | Included |
| Starter notes | Main memory | Main memory and topics when selected |
| Remote MCP connections | | Address and requested header names |

The OpenMaus export includes compatible routines from the channel and its member bots. Turn on **Include starter notes in OpenMaus file** before exporting to include memory and topic files. The export report lists unsupported items and redactions. Chat history, attachments, computer configuration and saved credentials are excluded. Review free text before sharing, especially any custom credential format.

## Import

Open **Settings → Data & privacy → Team packages → Import team**. Choose a Grox JSON file, an OpenMaus v1/v2/v3 team JSON file or a BotMRR v1 Markdown blueprint. Markdown import reads the YAML frontmatter. The prose below it stays in the source file.

Imported bots use Ask approval. Skills start disabled, routines start paused, and remote MCP connections start disabled with their requested header names. Set up the connection in **Settings → MCP servers** before enabling it. Channel bulletins become shared instructions. Names that already exist receive a numeric suffix. The import report shows counts and skipped items.

OpenMaus team JSON and BotMRR imports validate member and routine references before writing state. Supported channel and bot routines include recurring calendar schedules and cron with a named time zone. Hosted computer routines, presets, organization approvals and unsupported schedule types are reported by the importer. Grox generates its own portraits for imported bots.

## Move from Grok Bot

Open **Move from Grok Bot** in the same settings card. Copy the export prompt and send it to the source bot. Paste its reply or select its exported files. Split replies for the same bot are merged. A bot already moved to this workspace is skipped on subsequent imports.

Personas, skills and memory are copied locally. Supported routines retain their schedule and arrive paused. Event routines and unsupported schedules are saved in a memory topic with their instructions so you can rebuild them. Grox records app names and copies supported remote HTTPS MCP addresses into disabled connections. Text with credential fields is refused before installation. Recognizable secrets embedded in text are redacted.

Team JSON and Grok Bot exports may be up to 4 MB. BotMRR Markdown may be up to 1 MB. Imports add records to the current workspace.

## Signatures

The native Grox file uses format `grox.team` version 1 and signs its contents with a local Ed25519 key. Grox verifies signatures on import when present and still accepts older unsigned Grox packages. This detects changes to the signed content. The file’s public key alone cannot establish the sender’s identity.

OpenMaus files use the exchange format read by the upstream app. Grox reports source signatures that it has not verified. Organization libraries, update-in-place publication workflows and managed approval policies require separate services.
