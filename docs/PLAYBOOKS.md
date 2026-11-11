# Playbooks

A playbook is process guidance attached to one bot. It is selected by trigger words in the new message and
included in that turn's prompt; it does not grant tools, connected apps or permissions.

## Storage

Each playbook is a Markdown file under `playbooks/<botId>/<slug>.md` with frontmatter:

    ---
    name: Launch checklist
    triggers: launch, release, ship
    ---

    Instructions...

Files are 0600 and are not part of a team package yet.

## Selection

- Triggers are comma-separated, case-insensitive and normalized to words.
- A trigger matches when the normalized new message contains it.
- At most 3 playbooks are selected; the rendered instructions are capped at 24 KB.
- Selected playbooks appear in a `<installed_playbooks>` block for CLI Compose and API system prompts.
- The block explicitly says it grants no tools or authority.

## UI

Bot panel -> Playbooks: create, edit and delete. A playbook editor needs a name, at least one trigger and
instructions.

## Not ported

- Package-authored playbooks, BotMRR import and playbook review screens.
- The actual OpenMausBot selection algorithm uses package metadata; this port uses local files and triggers.
