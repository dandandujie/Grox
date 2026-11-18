# Remote MCP servers

[简体中文](MCP.md)

Grox can add user-managed remote HTTP or local stdio MCP servers to every CLI turn. This is the local CRUD
slice of OpenMausBot's MCP settings: a remote URL with an optional bearer token, or a local command with
arguments, plus enable/disable and delete. OAuth login, per-tool policy and the full value vault are not
ported.

## What happens

Enabled servers are added to the temporary CLI configuration for the next turn:

- Claude: a temporary --mcp-config JSON entry; HTTP includes the Authorization header, stdio includes
  command and args.
- Grok: a temporary GROK_HOME config.toml entry; HTTP includes headers, stdio includes command and args.
- Codex: a temporary CODEX_HOME config.toml entry; HTTP uses bearer_token_env_var (the token is passed only
  through that subprocess environment), stdio includes command and args.
- Gemini: a temporary GEMINI_CLI_HOME settings.json entry; HTTP includes headers, stdio includes command
  and args.

The per-turn Grox MCP gateway (Composio tools plus ask_user) is always present separately.

## Token storage

The bearer token is written to the 0600 secrets.json under mcp:<id>. AppState and every RPC response
contain only authConfigured: true/false. Tokens are written into temporary 0600 config files (or the
Codex subprocess environment), and those files are deleted after the turn.

Editing a server with a blank token keeps the existing token. Deleting the server removes it.

## Limits

- HTTP and HTTPS URLs only for HTTP transport; file:// is rejected.
- Local stdio commands are launched by the selected CLI, not by Grox. Only add a command you trust; the
  command runs with the CLI's permissions and is not sandboxed by Grox.
- Arguments are one per line and limited to 32 entries.
- No OAuth flow, dynamic registration or per-server scopes.
- Server tools are still subject to the CLI's own tool approval behavior and Grox's per-turn hooks.
- The CLI may cache or surface a remote server's tools according to its own semantics; Grox does not
  proxy or execute the remote server itself.

## UI

Settings -> MCP servers. Add a name, choose HTTP or Local command, then fill URL or command/arguments and
the enabled state. The list shows the URL or command line and never a token value.

## Files

- internal/service/mcp_servers.go - CRUD, URL validation, secret storage and runtime configs
- internal/agent/cli_homes.go - per-CLI temporary configuration
- internal/agent/cli.go - Codex token environment and CLI wiring
- src/components/SettingsModal.tsx - MCP servers settings

## Per-bot scope

An MCP server can be limited to selected bots. Empty selection means every bot. The scope filters the
per-turn CLI config; it is not an access-control boundary because the CLI owns the server process.

## Custom headers

HTTP servers can carry up to 16 additional headers, for example:

    X-API-Key: value
    X-Organization: launch

Values are stored as JSON in the 0600 secrets file under mcp:<id>:headers. AppState exposes only
headerNames. Claude, Grok and Gemini receive the headers in their temporary configs; Codex receives only
the bearer-token environment path and cannot carry arbitrary custom headers through this slice.

Editing with the header box empty keeps existing headers. Enter one or more lines to replace all of them.


## OAuth authorization code + PKCE

An HTTP MCP server can use OAuth 2.0 client credentials instead of a static bearer token. Grox stores the
token URL, client ID, optional client secret and scopes in secrets.json under mcp:<id>:oauth, requests an
access token with grant_type=client_credentials, and caches the token in memory until shortly before expiry.

A stored refresh token switches the grant to refresh_token; a refresh_token returned by the token endpoint is
saved for the next exchange. Access tokens are cached until shortly before expiry.

Claude, Grok and Gemini receive the resulting bearer token in their temporary configs. Codex receives the
same bearer-token environment path. Authorization-code/PKCE, dynamic client registration and token revocation
are not implemented yet; those require an interactive OAuth flow.


### Authorization code + PKCE

If an OAuth client has an authorization URL, the server editor shows Authorize in browser. Grox starts a
one-shot loopback callback on 127.0.0.1, generates a PKCE S256 verifier/challenge and state, opens the
authorization URL, exchanges the returned code, and stores access/refresh tokens in the secrets file. The
callback closes after use or five minutes.

Dynamic client registration and token revocation are not implemented. The OAuth client must already allow a
loopback redirect URI.
