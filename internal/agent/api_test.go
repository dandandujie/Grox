package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dandandujie/grox/internal/model"
)

func TestRunAPIStream(t *testing.T) {
	var called bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test" {
			t.Errorf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	sink := &fakeSink{}
	req := Request{
		Bot:        model.Bot{Name: "Test", Soul: "Be brief."},
		UserText:   "Hi",
		Model:      model.Model{ID: "test-model", Provider: "openai"},
		APIBaseURL: server.URL + "/v1",
		APIKey:     "test",
	}
	result, err := runAPI(context.Background(), req, sink)
	if err != nil {
		t.Fatal(err)
	}
	if !called || result != "Hello" || sink.text.String() != "Hello" {
		t.Fatalf("called=%v result=%q sink=%q", called, result, sink.text.String())
	}
	if sink.usage.TotalTokens != 5 || sink.usage.InputTokens != 3 || sink.usage.OutputTokens != 2 {
		t.Fatalf("usage = %+v", sink.usage)
	}
}

func TestRunAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no access", http.StatusUnauthorized)
	}))
	defer server.Close()
	_, err := runAPI(context.Background(), Request{
		Bot: model.Bot{Name: "Test"}, UserText: "Hi",
		Model:      model.Model{ID: "m", Provider: "openai"},
		APIBaseURL: server.URL,
	}, &fakeSink{})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected a 401 error, got %v", err)
	}
}

func TestRunAPIToolLoop(t *testing.T) {
	round := 0
	var sawTool bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		round += 1
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("payload: %v", err)
			return
		}
		tools, _ := payload["tools"].([]any)
		if len(tools) != 1 {
			t.Errorf("tools = %+v", payload["tools"])
		} else if definition, ok := tools[0].(map[string]any); ok {
			function, _ := definition["function"].(map[string]any)
			if function["name"] != "GITHUB_GET_REPO" {
				t.Errorf("tool name = %+v", function["name"])
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		writeEvent := func(event any) {
			data, _ := json.Marshal(event)
			fmt.Fprintf(w, "data: %s\n\n", data)
		}
		if round == 1 {
			args, _ := json.Marshal(map[string]any{"owner": "acme"})
			writeEvent(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{
				"tool_calls": []any{map[string]any{"index": 0, "id": "call_1", "function": map[string]any{
					"name": "GITHUB_GET_REPO", "arguments": string(args),
				}}},
			}}}})
		} else {
			messages, _ := payload["messages"].([]any)
			if len(messages) < 2 {
				t.Errorf("missing tool and image messages: %v", messages)
			} else {
				reply, _ := messages[len(messages)-2].(map[string]any)
				sawTool = reply["role"] == "tool" && reply["tool_call_id"] == "call_1"
				visual, _ := messages[len(messages)-1].(map[string]any)
				content := fmt.Sprint(visual["content"])
				if visual["role"] != "user" || !strings.Contains(content, "Images returned by tools:") ||
					!strings.Contains(content, "repo-preview.png") || !strings.Contains(content, "data:image/png;base64,cGl4ZWxz") {
					t.Errorf("missing visual tool result in the next round: %v", visual)
				}
			}
			writeEvent(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "Repo is acme/grox"}}}})
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	executed := false
	sink := &fakeSink{}
	var images []APIAttachment
	result, err := runAPI(context.Background(), Request{
		Bot:        model.Bot{Name: "Test", Approval: model.ApprovalAuto},
		UserText:   "Which repo?",
		Model:      model.Model{ID: "test-model", Provider: "openai"},
		APIBaseURL: server.URL,
		Tools:      []Tool{{Name: "GITHUB_GET_REPO", Description: "Get a repo", Parameters: map[string]any{"type": "object", "properties": map[string]any{}}}},
		ExecuteTool: func(_ context.Context, name string, arguments map[string]any) (string, error) {
			executed = true
			if name != "GITHUB_GET_REPO" || arguments["owner"] != "acme" {
				t.Errorf("unexpected tool call: %s %+v", name, arguments)
			}
			images = append(images, APIAttachment{Name: "repo-preview.png", Data: []byte("pixels"), ImageMIME: "image/png"})
			data, _ := json.Marshal(map[string]any{"full_name": "acme/grox"})
			return string(data), nil
		},
		TakeAPIToolImages: func() []APIAttachment {
			result := images
			images = nil
			return result
		},
	}, sink)
	if err != nil {
		t.Fatal(err)
	}
	if !executed || !sawTool || result != "Repo is acme/grox" || round != 2 {
		t.Fatalf("executed=%v sawTool=%v result=%q rounds=%d", executed, sawTool, result, round)
	}
	if len(sink.activity) != 1 || sink.activity[0].Status != model.StatusOK {
		t.Fatalf("activities = %+v", sink.activity)
	}
}
