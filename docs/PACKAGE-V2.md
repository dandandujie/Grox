# OpenMaus package v2 import

Settings -> Data & privacy -> OpenMaus package v2 accepts an `openmaus.package` version 2 JSON document.

## Imported

- Agents -> bots with name, title, description, soul, appearance colour and ask/auto/full approval.
- Seed memory: `MEMORY.md` and `memory/*.md` topics.
- Skills: written under each bot's own workspace `.grox/skills` and switched on.
- Playbooks: attached to agents, with triggers and instructions.
- Rooms: members, lead and Auto responder.
- Routines: daily/weekday schedules with a clock, created paused. Cloud and cron-only routines are skipped.
- Connections: remote https MCP servers, created disabled with no values, scoped to the agents that
  referenced each connection.
- Presets: basic name/title/description/soul/colour only.

Everything is additive and credential-looking keys refuse the document.

## Not imported

- Requirement enforcement, approved-app grants and connection value names.
- Avatars, mascot expressions, approval mapping and per-agent connection assignment.
- Routine continuity, overlap, timeout, room goals and cloud execution.
- Examples, notes, publisher identity, package signatures and organization trust.

## Export

The channel panel offers Export OpenMaus package. It writes an `openmaus.package` v2 JSON with the channel's
agents, enabled skills, playbooks, memory/topics, paused routines and disabled connections. Tokens, connection
values and chat history never travel. A round-trip test imports the export into a fresh workspace.

## Files

- internal/service/package_import.go
- src/components/SettingsModal.tsx - Data & privacy card
