# Skills

Grox reads local SKILL.md folders and lets each bot enable the ones it should use. This is a port of the
instruction-file part of OpenMausBot's skill shelf. Skill scripts, dependency installation, bundled packs
and the full approval lifecycle are not yet ported.

## Where skills are discovered

For a bot with a working folder, Grox scans these roots, in order:

- <dataDir>/skills
- ~/.grox/skills
- <working folder>/.grox/skills
- <working folder>/.claude/skills
- ~/.claude/skills

A skill is a directory containing SKILL.md, or a root with SKILL.md directly inside it. Later roots win when
two skills resolve to the same id. The id comes from the frontmatter name (lowercased, slugified), with the
directory name as a fallback.

## File format

    ---
    name: Launch report
    description: Turn a launch checklist into a short, sourced status brief.
    ---

    # Launch report

    Instructions for the model live here.

Only name and description are required by the reader. All other text is the instruction body and is sent to
the model when the skill is enabled. A file is capped at 256 KB on disk and 64 KB of instruction text in
the prompt; one skill is capped at 24 KB so a single file cannot consume the whole turn.

## Per-bot state

Skills are **off by default**. Toggling one stores only its id and enabled flag on the bot; the file remains
the source of truth. Disabling removes it from the prompt. The Skills tab shows source, path, size and a
read-only preview.

The prompt block is:

    ## Enabled skills

    ### <name>
    <description>

    <body>

CLI engines receive it through their composed prompt. OpenAI-compatible API engines receive it as part of
the system message. Disabled skills and skill files that cannot be read are skipped silently.

## Safety

SKILL.md is trusted only after a person enables it. Its text is still untrusted content: it can contain
prompt-injection attempts or secrets. Grox does not execute skill scripts, install dependencies, or run
anything beside the file. Read the file in the preview before enabling it.

## API

- ListSkills(botID) returns discovered skills and per-bot enabled state.
- ReadSkill(botID, skillID) returns the full file for the preview.
- SetSkillEnabled(botID, skillID, enabled) persists the switch.

## Files

- internal/service/skills.go — discovery, parsing, state and prompt assembly
- internal/model/types.go — BotSkill and Skill
- src/components/BotPanel.tsx — Skills tab
- internal/service/service_test.go — TestSkillsDiscoverAndInject
