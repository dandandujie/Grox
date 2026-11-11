# BotMRR Markdown import

Settings -> Data & privacy -> BotMRR team Markdown accepts the structured YAML frontmatter used by BotMRR
blueprints (version 1).

## Imported

- Agents: name, title, description, soul, colour (mapped to a Grox colour).
- Skills: written under the imported bot's own workspace `.grox/skills/<name>/SKILL.md`, so they do not leak
  into every bot, then switched on.
- Playbooks: attached to the agents that reference them, with triggers.
- Rooms: members and lead from defaultResponder.agent; auto responder maps to Auto.
- Routines: daily/weekday schedules with a clock, created paused. Cloud routines are skipped.

Everything is additive. Nothing existing is overwritten.

## Not imported

- Package metadata, outcomes, category, author/license, requirements, examples.
- Connections/app requirements.
- Presets, memory/starter notes, avatars and package v2 fields.
- Event or unreadable schedules.

## Safety

Credential-looking YAML keys refuse the whole document. Skill bodies are written as untrusted instruction files;
they grant no tools or permissions.

## Files

- internal/service/botmrr_import.go
- internal/service/testdata/botmrr.md
- src/components/SettingsModal.tsx - Data & privacy card
