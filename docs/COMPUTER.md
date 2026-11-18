# Agent computer tools

Grox keeps one computer selection per bot. Choose **This computer** or configure an SSH host in the bot's **Computer** panel. On SSH hosts, verify the server's host key and add it to `~/.ssh/known_hosts` before connecting.

The Grox MCP gateway exposes these tools to CLI agents. Tool-capable OpenAI-compatible models receive the same functions.

| Tool | What it does |
| --- | --- |
| `computer_info` | Reports the selected machine and working folder. |
| `computer_list` | Lists a folder inside that working folder. |
| `computer_read` | Returns bounded text or an image. |
| `computer_run` | Runs a shell command on the selected machine and returns output and exit status. |
| `computer_screenshot` | Captures a PNG and attaches it to the current conversation. |
| `attach_file` | Copies a file from the working folder into the conversation. |

**Ask** shows an approval card before file, terminal or screen access. **Auto** can list and read from a configured working folder. Shell commands, screen captures and file sharing still ask. **Full** authorizes these operations for the bot. Per-bot tool deny rules apply in all modes. **Always allow** remembers the exact operation for the rest of the current turn.

The card displays the selected machine, operation and working folder. Grox checks that the target and active turn still match before acting. The working folder bounds file tools. Shell commands run with the selected account's permissions, starting in that folder. A CLI's own built-in tools use its execution environment. To operate the selected SSH host, the agent uses the Grox tools listed above.

Screen capture depends on desktop permissions on macOS and the installed capture utility on Linux or SSH. SSH desktop capture requires an active, accessible display. Computer panels and tool calls share the same local and SSH adapters.

Open **Conversation files** in a chat header to search files shared across the bot or channel's conversations. The file stays in the original conversation and links back to its thread.
