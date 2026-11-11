# Token usage

Grox records token accounting when the selected engine reports it. This is currently the
OpenAI-compatible API engine.

## What is recorded

Each finished bot message can carry:

    usage: { inputTokens, outputTokens, totalTokens, source }

The footer shows a small `N tok` label with an input/output tooltip. Cost is not calculated because no
pricing table ships with Grox.

## Provider behavior

Grox requests `stream_options.include_usage` and reads the final `usage` object. Providers that omit it, or
that reject the stream option, simply produce no usage label. Usage is accumulated across API tool rounds.

## CLI engines

Claude Code and Grok Build result events can carry input_tokens/output_tokens; those are read when present.
Codex CLI and Gemini CLI do not expose a stable usage shape in this port, so their messages stay unlabelled.
This is explicit rather than showing a fabricated number.

## Files

- internal/agent/agent.go - TokenUsage / UsageSink
- internal/agent/api.go and api_tools.go - stream parsing
- internal/service/turns.go - attaches usage to the final message
- src/components/Message.tsx - footer label
