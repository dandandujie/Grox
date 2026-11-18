package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

func TestSelectExplicitCLIByProvider(t *testing.T) {
	for _, test := range []struct{ mode, provider, name string }{
		{"grok", "grok", "Grok CLI"}, {"claude", "claude", "Claude Code"},
		{"codex", "openai", "Codex CLI"}, {"gemini", "google", "Gemini CLI"},
	} {
		t.Run(test.mode, func(t *testing.T) {
			request := Request{
				Model:      model.Model{Provider: test.provider, ID: "test"},
				EngineMode: test.mode, CLIAvailable: map[string]bool{test.provider: true},
			}
			if selected := Select(request); selected.Kind != "cli" || selected.Engine != test.name {
				t.Fatalf("available selection = %+v", selected)
			}
			request.CLIAvailable = nil
			if selected := Select(request); selected.Kind != "unavailable" || !strings.Contains(selected.Note, test.name) {
				t.Fatalf("unavailable selection = %+v", selected)
			}
		})
	}
}

func TestSelectExplicitAPIForDemoBot(t *testing.T) {
	request := Request{
		Model: model.Model{Provider: "local", ID: "grox-demo"}, EngineMode: "api",
		APIBaseURL: "http://localhost:1234/v1", APIModel: "server-model",
	}
	if selected := Select(request); selected.Kind != "api" {
		t.Fatalf("configured explicit API selection = %+v", selected)
	}
	request.APIModel = ""
	if selected := Select(request); selected.Kind != "unavailable" || !strings.Contains(selected.Note, "model ID") {
		t.Fatalf("unconfigured explicit API selection = %+v", selected)
	}
}

type cancelOnTextSink struct {
	fakeSink
	cancel context.CancelFunc
}

func (s *cancelOnTextSink) Text(value string) {
	s.fakeSink.Text(value)
	s.cancel()
}

func writeTestCLI(t *testing.T, command, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("CLI fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, command), []byte("#!/bin/sh\n"+body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

const codexPartial = `printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}'`

func TestCLIReportsTerminalFailureAfterStreaming(t *testing.T) {
	dir := writeTestCLI(t, "codex", codexPartial+`
printf '%s\n' '{"type":"turn.failed","error":{"message":"terminal failure"}}'
`)
	sink := &fakeSink{}
	result, err := runCLI(context.Background(), Request{
		Bot: model.Bot{Approval: model.ApprovalAuto}, Model: model.Model{Provider: "openai", ID: "test"},
		WorkDir: dir, Prompt: "hello",
	}, sink)
	if err == nil || err.Error() != "terminal failure" || result != "partial" || sink.text.String() != result {
		t.Fatalf("CLI returned %q, %v with streamed text %q", result, err, sink.text.String())
	}
}

func TestCLIReportsCancellationAfterStreaming(t *testing.T) {
	dir := writeTestCLI(t, "codex", codexPartial+"\nexec /bin/sleep 30\n")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := &cancelOnTextSink{cancel: cancel}
	result, err := runCLI(ctx, Request{
		Bot: model.Bot{Approval: model.ApprovalAuto}, Model: model.Model{Provider: "openai", ID: "test"},
		WorkDir: dir, Prompt: "hello",
	}, sink)
	if !errors.Is(err, context.Canceled) || result != "partial" || sink.text.String() != result {
		t.Fatalf("CLI returned %q, %v with streamed text %q", result, err, sink.text.String())
	}
}

func TestCLIAskDoesNotLaunchWithoutApprovalConfiguration(t *testing.T) {
	for _, test := range []struct{ name, provider string }{
		{"grok", "grok"}, {"claude", "claude"}, {"codex", "openai"}, {"gemini", "google"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := writeTestCLI(t, test.name, "printf 'launched' > launched")
			request := Request{
				Bot: model.Bot{Approval: model.ApprovalAsk}, Model: model.Model{Provider: test.provider, ID: "test"},
				WorkDir: dir, Prompt: "hello",
			}
			if _, err := runCLI(context.Background(), request, &fakeSink{}); err == nil || !strings.Contains(err.Error(), "approval service") {
				t.Fatalf("missing approval config error = %v", err)
			}
			if _, err := os.Stat(filepath.Join(dir, "launched")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("CLI launched without an approval service: %v", err)
			}
		})
	}
}

func TestGeminiAskDoesNotLaunchWhenHookSetupFails(t *testing.T) {
	dir := writeTestCLI(t, "gemini", "printf 'launched' > launched")
	blockedTemp := filepath.Join(dir, "missing")
	t.Setenv("TMPDIR", blockedTemp)
	_, err := runCLI(context.Background(), Request{
		Bot: model.Bot{Approval: model.ApprovalAsk}, Model: model.Model{Provider: "google", ID: "test"},
		WorkDir: dir, Prompt: "hello", HookURL: "http://127.0.0.1:1/hook",
	}, &fakeSink{})
	if err == nil || !strings.Contains(err.Error(), "could not configure Gemini CLI") {
		t.Fatalf("approval setup failure = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "launched")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("CLI launched despite failed approval setup: %v", err)
	}
}

func TestToolHookDeniesInvalidApprovalResponse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("hook wrapper requires a POSIX shell")
	}
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl is required to exercise the hook")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if request, err := io.ReadAll(r.Body); err == nil && string(request) == "allow" {
			_, _ = io.WriteString(w, `{"decision":"allow"}`)
			return
		}
		_, _ = io.WriteString(w, "invalid approval response")
	}))
	defer server.Close()
	path, cleanup, err := makeToolHookScript(server.URL, "gemini")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	run := func(input string) string {
		t.Helper()
		cmd := exec.Command("/bin/sh", path)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	if got := run("allow"); !strings.Contains(got, `"decision":"allow"`) {
		t.Fatalf("explicit approval was lost: %q", got)
	}
	if got := run("invalid"); !strings.Contains(got, `"decision":"deny"`) {
		t.Fatalf("invalid approval did not deny the tool call: %q", got)
	}
	server.Close()
	if got := run("allow"); !strings.Contains(got, `"decision":"deny"`) {
		t.Fatalf("unavailable approval service did not deny the tool call: %q", got)
	}
}
