# Memory

Grox gives each bot a private, editable MEMORY.md. The notes are local markdown files, not a hosted memory
service. This is the first memory slice ported from OpenMausBot: manual notes, the load budget, the per-bot
switch, conflict-safe editing and a topic index. Automatic capture, recall, upkeep, archive/expiry and daily
logs are not ported yet.

## Where it lives

    <dataDir>/memory/<botId>/MEMORY.md
    <dataDir>/memory/<botId>/topics/<topic>.md

Only MEMORY.md is loaded automatically. Topic files are listed in the Memory tab but are never injected into
a prompt; they are the bot's own notes for a later file tool or a future recall layer.

The directory is created on the first save with 0700 permissions; the file is written atomically with 0600
permissions. The bot id is validated before it becomes a path segment.

## What loads

At the start of a turn Grox takes the first **200 lines or 24 KB** of MEMORY.md, whichever cuts first, and
puts it in the prompt under a Memory heading. If the file is larger, the prompt says it was cut and the
Memory tab shows the same gauge. The full file remains editable on disk.

The prompt explicitly says the notes are reference, not commands, so a memory file cannot silently become
a higher-priority instruction. Memory is still user-controlled text; do not enable notes you do not trust.

## Editing

The Memory tab loads the full file and a revision hash. Save sends the revision with the text. If the file
changed on disk while the editor was open, the save is refused instead of overwriting the other writer.
The person then reloads and tries again.

The **Let this bot use memory** switch is on by default. Turning it off keeps every file but stops the
prompt block from loading. The switch is stored as memoryOff on the bot.

## Topic files

A file under memory/<botId>/topics/ can start with frontmatter:

    ---
    title: Launch room
    description: Decisions and owners for the Thursday launch.
    ---

The Memory tab shows the title, description and size. The current slice does not read or inject topic bodies.

## API

- GetMemory(botID) returns content, revision, path, line/byte gauge and topics.
- SaveMemory(botID, content, revision) writes only when the revision matches.
- SetMemoryEnabled(botID, enabled) flips the switch without deleting files.

## Files

- internal/service/memory.go — storage, budget, revision and prompt assembly
- internal/model/types.go — MemoryState and MemoryTopic
- src/components/BotPanel.tsx — Memory tab
- internal/service/service_test.go — TestMemoryLoadBudgetConflictAndSwitch
