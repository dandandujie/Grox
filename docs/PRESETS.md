# New bot presets

Presets are starting points for New bot. They are stored in the workspace, not hardcoded in the dialog.
They can now carry playbooks, isolated skills and starter MEMORY.md notes in addition to the persona.

## What a preset carries

- name
- role/title
- description
- standing instructions
- accent colour
- playbooks
- skills (SKILL.md text)
- starter MEMORY.md notes

It does not carry a model, approval level, working folder, computer, connected apps or credentials. Applying
a preset writes skills into a per-bot workspace and playbooks/memory through the normal writers.

## Defaults

A first-run workspace seeds four presets: Research, Inbox chief, Code review and Operations. Existing
workspaces with no presets field get the same defaults on load; a deliberately empty list stays empty.

## Create and manage

- Open a bot profile and choose Save as preset.
- Settings -> General -> New bot presets lists them and can delete one.
- New bot shows the saved presets in Start from. Selecting one fills the role, description and instructions,
  and proposes the preset name if the name field is empty.

Preset names are unique; a duplicate gets a numeric suffix. Deleting a preset never changes an existing bot.

## API

- ListPresets
- CreatePreset(input)
- UpdatePreset(id, patch)
- DeletePreset(id)

## Files

- internal/service/presets.go
- internal/store/seed.go
- src/components/NewBotDialog.tsx
- src/components/BotPanel.tsx
- src/components/SettingsModal.tsx
