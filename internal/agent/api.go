package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// runAPI streams an OpenAI-compatible chat completion and, when tools are
// attached, runs a bounded function-calling loop.
func runAPI(ctx context.Context, req Request, sink Sink) (string, error) {
	if len(req.Tools) > 0 && req.ExecuteTool != nil {
		return runAPITools(ctx, req, sink)
	}
	return runAPIPlain(ctx, req, sink)
}

// runAPIPlain streams one response without function tools.
func runAPIPlain(ctx context.Context, req Request, sink Sink) (string, error) {
	base := strings.TrimSpace(req.APIBaseURL)
	if base == "" {
		switch req.Model.Provider {
		case "grok":
			base = "https://api.x.ai/v1"
		case "openai":
			base = "https://api.openai.com/v1"
		}
	}
	if base == "" {
		return "", fmt.Errorf("no API base URL is configured")
	}
	endpoint := strings.TrimSuffix(base, "/")
	if !strings.HasSuffix(endpoint, "/chat/completions") {
		endpoint += "/chat/completions"
	}
	modelID := strings.TrimSpace(req.APIModel)
	if modelID == "" {
		modelID = req.Model.ID
	}

	messages := []map[string]string{}
	system := req.Bot.Soul
	if system == "" {
		system = "You are " + req.Bot.Name + ", a helpful assistant."
	}
	system += "\n\nYou are replying inside Grox, a chat app. Use GitHub-flavored Markdown when it helps."
	if skillText := strings.TrimSpace(req.SkillText); skillText != "" {
		system += "\n\n## Enabled skills\n\n" + skillText
	}
	if memoryText := strings.TrimSpace(req.MemoryText); memoryText != "" {
		system += "\n\n## Memory\n\n" + memoryText
	}
	if recallText := strings.TrimSpace(req.RecallText); recallText != "" {
		system += "\n\n## Recalled memory\n\n" + recallText
	}
	messages = append(messages, map[string]string{"role": "system", "content": system})
	for _, m := range recent(req.History, 16) {
		text := strings.TrimSpace(m.Text)
		if text == "" || m.Pending {
			continue
		}
		switch m.Role {
		case model.RoleUser:
			messages = append(messages, map[string]string{"role": "user", "content": text})
		case model.RoleBot:
			content := text
			if m.SenderName != "" && m.SenderName != req.Bot.Name {
				content = m.SenderName + ": " + text
			}
			messages = append(messages, map[string]string{"role": "assistant", "content": content})
		}
	}
	// Ensure the newest user message is present exactly once.
	userText := strings.TrimSpace(req.UserText)
	if userText != "" {
		if len(messages) == 0 || messages[len(messages)-1]["content"] != userText || messages[len(messages)-1]["role"] != "user" {
			messages = append(messages, map[string]string{"role": "user", "content": userText})
		}
	}

	body, err := json.Marshal(map[string]any{
		"model":    modelID,
		"messages": messages,
		"stream":   true,
	})
	if err != nil {
		return "", err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if req.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+req.APIKey)
	}

	sink.Status("Thinking")
	client := &http.Client{}
	resp, err := client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("could not reach the API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg := strings.TrimSpace(string(data))
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		return "", fmt.Errorf("the API returned %s: %s", resp.Status, msg)
	}

	var text strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	firstToken := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		if errObj, ok := event["error"].(map[string]any); ok {
			return "", fmt.Errorf("%s", str(errObj["message"]))
		}
		choices, _ := event["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		choice, _ := choices[0].(map[string]any)
		if choice == nil {
			continue
		}
		delta, _ := choice["delta"].(map[string]any)
		if delta != nil {
			if content := contentText(delta["content"]); content != "" {
				if !firstToken {
					sink.Status("Writing")
					firstToken = true
				}
				sink.Text(content)
				text.WriteString(content)
			}
			if calls, ok := delta["tool_calls"].([]any); ok && len(calls) > 0 {
				sink.Activity(model.Activity{Label: "Used a tool", Status: model.StatusRunning, StartedAt: time.Now()})
			}
		}
		if msg, _ := choice["message"].(map[string]any); msg != nil && text.Len() == 0 {
			if content := contentText(msg["content"]); content != "" {
				sink.Text(content)
				text.WriteString(content)
			}
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return "", fmt.Errorf("the API stream ended early: %w", err)
	}
	if strings.TrimSpace(text.String()) == "" {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("the API returned an empty reply")
	}
	return text.String(), nil
}

func contentText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		var b strings.Builder
		for _, part := range value {
			block, _ := part.(map[string]any)
			if block == nil {
				continue
			}
			if t := str(block["text"]); t != "" {
				b.WriteString(t)
			}
		}
		return b.String()
	default:
		return ""
	}
}
