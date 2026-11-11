# Agent questions

Grox now exposes a real ask_user tool to agents. It creates the existing option card in the conversation,
waits for the person, and returns the answer to the blocked tool call. This is the first port of
OpenMausBot's agent-authored question cards; rich multi-question forms and question-answer memory are
not ported.

## Tools

- CLI engines: the per-turn MCP gateway lists ask_user beside Composio tools.
- API engines in Auto/Full: the function-calling loop receives ask_user as a built-in tool.
- Ask API bots still receive no tools, matching the existing approval boundary.

The input is:

    {
      question: string,
      options?: [{ label: string, description?: string }]
    }

Up to six options are shown. The person can always type a custom answer.

## Flow

1. The agent calls ask_user.
2. Grox appends a KindOptions card to the active bot or channel thread and marks the turn Waiting for you.
3. The tool call stays blocked.
4. The person chooses an option or types an answer.
5. Grox marks the card answered, appends the visible answer as a user message, and resolves the waiter.
6. The tool returns: User answered: <answer>.
7. The CLI or API agent continues the same turn.

Unlike a static option card, answering an agent question does not start a second turn. The blocked tool
call owns the continuation.

## Safety

- Only agents in an active turn can create a question.
- The card belongs to the same bot/thread (or channel/thread) as the turn.
- The ask_user tool itself is auto-allowed by the CLI hooks; it cannot execute a shell command.
- A question times out after ten minutes, settles the card and returns an error to the agent.
- A turn stop or app close cancels the waiting HTTP request.

## Files

- internal/service/questions.go - card creation, waiter, answer resolution
- internal/service/tool_gateway.go - MCP tool and auto-allow
- internal/service/chat.go - API tool registration and tool execution
- src/components/Message.tsx - existing option card UI
