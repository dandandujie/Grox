# Managed browser

[简体中文](BROWSER.md)

A bot set to **This computer** can use an isolated Chrome or Chromium session during a turn. Grox starts the browser on demand with a temporary profile and disposes it at the end of the turn. Install Chrome or Chromium where the desktop process can find it. The same tools are available through CLI MCP and tool-capable OpenAI-compatible API engines.

| Tool | What it does |
| --- | --- |
| `browser_open` | Opens a public HTTP or HTTPS URL and returns visible text and control references. |
| `browser_read` | Reads the current page and refreshes references to visible links, buttons and text fields. |
| `browser_click` | Clicks a control from the last inspection. |
| `browser_type` | Replaces the value of a visible ordinary text field. |
| `browser_back` | Restores the previous page. |
| `browser_screenshot` | Captures the viewport as a conversation attachment. Vision-capable models can receive that image in the tool loop. |

Ask mode prompts for each operation. Auto mode reads the current page and asks for navigation, interaction and screenshots. Full mode authorizes browser operations. The bot's tool policy applies in each mode. Control references expire after an inspection or action. Grox also checks the document, target node, label and destination before clicking or typing.

The browser connects to the public web through a turn-scoped proxy. The proxy checks the resolved destination and blocks local, private and link-local addresses. The managed browser uses one top-level page and ordinary HTML text inputs. Personal Chrome sessions, SSH browsers, password and file inputs, downloads and popup targeting are outside this interface. Sites that require a physical gesture or a browser login may need direct user interaction.

The real browser integration test uses its own local website and temporary browser profile.

```sh
GROX_TEST_BROWSER=1 node scripts/with-go.mjs go test ./internal/browser -run '^TestManagedBrowserWorkflow$' -count=1
```
