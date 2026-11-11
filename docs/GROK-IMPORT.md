# Moving from Grok Bot

Settings -> Data & privacy -> Move from Grok Bot accepts a pasted Grok Bot export. Grox creates new bots;
nothing existing is overwritten.

## What is imported

- Name, title, description and standing instructions.
- memories and user_facts into the new bot's MEMORY.md.
- Scheduled routines with a simple readable cron (`minute hour * * day`) arrive paused.
- Remote https MCP apps arrive as disabled MCP servers.

## Split exports

The pasted text can contain several JSON objects. Objects for the same bot name are merged, with list fields
(skills, routines, memories, apps) deduplicated. This supports split Grok exports.

## Event routines

Routines with an event trigger or an unreadable cron are not scheduled. Their name, trigger and instruction
are appended to the bot's MEMORY.md under Grok Bot event routines, and the result reports an event count.

## Skills

Each bot gets its own workspace at `workspaces/<name>-grok/`. Imported skills are written under
`.grox/skills/<name>/SKILL.md` there and switched on. They do not leak to other bots. `skills` in the result
counts what was created.

## What is skipped

- Event-triggered or unreadable schedules.
- Chat history, app logins, keys and model choice.
- Local apps without a remote https URL.
- Images and avatars.

## Safety

- The export text is untrusted JSON.
- Credential-looking keys (api_key, token, secret, password, authorization, bearer, cookie, private_key)
  refuse the whole document.
- Only the first JSON object in pasted chat text is read.
- The import is additive and uses the normal bot, memory, routine and MCP writers.

## Not ported

- Skill import per bot, split exports, Grok Bot UI-cache lookups and Downloads scanning.
- The full package v2 conversion used by OpenMausBot.
