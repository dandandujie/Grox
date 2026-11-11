# Tool policy

Each bot can limit the tools Grox exposes through its per-turn MCP gateway and its API function loop.

## Fields

- Allow: optional patterns. Empty means every tool is allowed.
- Deny: optional patterns. Deny always wins, even when allow matches.

Patterns are case-insensitive and support * as a wildcard. Examples:

    GITHUB_*
    SLACK_*
    ask_user
    memory_*
    GITHUB_DELETE_*

## Where it applies

- MCP tools/list and tools/call for the per-turn Grox gateway: ask_user, memory_update, memory_tidy,
  memory_forget and Composio tools.
- API Auto/Full tool registration and execution.
- CLI Ask still passes through the existing PreToolUse / PermissionRequest hooks; the policy is an
  additional filter, not a replacement for approval.

## Where it does not apply

- Remote HTTP or stdio MCP servers are configured directly in a temporary CLI config and are governed by
  that CLI. Grox cannot filter their tool calls through this policy.
- CLI built-in shell/file tools are also governed by the CLI's own permission mode and hooks.
- Imported team packages do not carry the policy; a new bot starts empty (allow all).

## Defaults

Both lists are empty on a new bot, so every gateway/API tool is allowed. An empty Allow with a populated
Deny is a deny-list. A populated Allow with an empty Deny is an allow-list.

## Files

- internal/service/tool_policy.go - pattern matching
- internal/service/chat.go - API filtering and execution guard
- internal/service/tool_gateway.go - MCP list/call filtering
- src/components/BotPanel.tsx - per-bot editor
