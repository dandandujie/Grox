# Getting started

On a fresh workspace, Grox opens one empty conversation with Brody. Setup offers models from detected
CLIs and configured API providers, an engine settings shortcut, and **Try demo** for scripted replies.
CLI detection checks installation. Sign-in and model access are checked by the first request.

- To use an installed CLI, sign in through the CLI, choose a model in setup, and select **Start chatting**.
- To use a gateway or local model server, open **Engine settings**, enter the base URL and model ID,
  and select **Use API for all bots**. Store the gateway's key under **Connections** if required.
- To explore offline, select **Try demo**. The composer and replies identify the demo engine.

The conversation header shows the current model. If a workspace-wide engine override is active,
the header shows that override and opens engine settings. **Auto** enables per-bot model selection.
Reopen setup from **Settings → About → Show welcome again**. Import existing teams from **Data & privacy**.

## Returning to work

Use **Work** to find pending approvals, questions, unread conversations, and failed or running turns.
Search from the sidebar to find a bot, channel, conversation title, or message. The result opens the
matching conversation. Drafts and queues stay with their conversation while the current window is open.

A rejected send leaves the draft editable. When a turn fails or stops, **Restore request** puts the
last request and its attachments in the composer. Review them before sending. Queued messages pause
after a failed or stopped turn and resume when you select **Resume queue**. When Grox reopens after an
interruption, the conversation records the stop and closes approval or question cards from that turn.
