# Remote MCP servers

Grox can add user-managed streamable-HTTP MCP servers to every CLI turn. This is the first local CRUD
slice of OpenMausBot's MCP settings: remote URLs, optional bearer tokens, enable/disable and delete.
Local stdio commands, OAuth login, per-tool policy and the full value vault are not ported.

## What happens

Enabled servers are added to the temporary CLI configuration for the next turn:

- Claude: a temporary --mcp-config JSON entry, including the Authorization header.
- Grok: a temporary GROK_HOME config.toml entry, including the Authorization header.
- Codex: a temporary CODEX_HOME config.toml entry with bearer_token_env_var; the token is passed only
  through that subprocess environment.
- Gemini: a temporary GEMINI_CLI_HOME settings.json entry, including the Authorization header.

The per-turn Grox MCP gateway (Composio tools plus ask_user) is always present separately.

## Token storage

The bearer token is written to the 0600 secrets.json under mcp:<id>. AppState and every RPC response
contain only authConfigured: true/false. Tokens are written into temporary 0600 config files (or the
Codex subprocess environment), and those files are deleted after the turn.

Editing a server with a blank token keeps the existing token. Deleting the server removes it.

## Limits

- HTTP and HTTPS streamable-HTTP URLs only; a file:// URL is rejected.
- No local command/stdio MCP server execution from this UI.
- No OAuth flow, dynamic registration or per-server scopes.
- Server tools are still subject to the CLI's own tool approval behavior and Grox's per-turn hooks.
- The CLI may cache or surface a remote server's tools according to its own semantics; Grox does not
  proxy or execute the remote server itself.

## UI

Settings -> MCP servers. Add a name, URL, optional bearer token and enabled state. The list shows the URL
and whether a token is configured, never the token itself.

## Files

- internal/service/mcp_servers.go - CRUD, URL validation, secret storage and runtime configs
- internal/agent/cli_homes.go - per-CLI temporary configuration
- internal/agent/cli.go - Codex token environment and CLI wiring
- src/components/SettingsModal.tsx - MCP servers settings
