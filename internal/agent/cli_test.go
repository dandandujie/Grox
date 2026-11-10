package agent

import (
	"strings"
	"testing"

	"github.com/dandandujie/grox/internal/model"
)

func TestAnthropicStreamParsing(t *testing.T) {
	var text strings.Builder
	var sink fakeSink
	sawDelta := false
	errText := ""
	handleAnthropicEvent(map[string]any{
		"type": "stream_event",
		"event": map[string]any{
			"type":  "content_block_delta",
			"delta": map[string]any{"type": "text_delta", "text": "Hello"},
		},
	}, &text, &sawDelta, &errText, &sink)
	handleAnthropicEvent(map[string]any{
		"type":    "assistant",
		"message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "Hello"}}},
	}, &text, &sawDelta, &errText, &sink)
	handleAnthropicEvent(map[string]any{"type": "result", "result": "Hello"}, &text, &sawDelta, &errText, &sink)
	if got := sink.text.String(); got != "Hello" {
		t.Fatalf("text = %q, want Hello", got)
	}
}

func TestAnthropicFullMessageWithoutDeltas(t *testing.T) {
	var text strings.Builder
	var sink fakeSink
	sawDelta := false
	errText := ""
	handleAnthropicEvent(map[string]any{
		"type":    "assistant",
		"message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "Fallback"}}},
	}, &text, &sawDelta, &errText, &sink)
	handleAnthropicEvent(map[string]any{"type": "result", "result": "Fallback"}, &text, &sawDelta, &errText, &sink)
	if got := sink.text.String(); got != "Fallback" {
		t.Fatalf("text = %q, want Fallback", got)
	}
}

func TestCodexEventParsing(t *testing.T) {
	var text strings.Builder
	var sink fakeSink
	errText := ""
	handleCodexEvent(map[string]any{
		"type": "item.completed",
		"item": map[string]any{"type": "agent_message", "text": "From Codex"},
	}, &text, &errText, &sink)
	if sink.text.String() != "From Codex" {
		t.Fatalf("text = %q", sink.text.String())
	}
}

func TestGeminiEventParsing(t *testing.T) {
	var text strings.Builder
	var sink fakeSink
	sawDelta := false
	errText := ""
	handleGeminiEvent(map[string]any{
		"type": "message", "role": "assistant", "content": "Gem", "delta": true,
	}, &text, &sawDelta, &errText, &sink)
	if sink.text.String() != "Gem" {
		t.Fatalf("text = %q", sink.text.String())
	}
}

func TestApprovalModeMapping(t *testing.T) {
	if approvalMode(model.ApprovalAsk) != "ask" || approvalMode(model.ApprovalAuto) != "auto" || approvalMode(model.ApprovalFull) != "full" {
		t.Fatal("approval mode mapping is wrong")
	}
}
