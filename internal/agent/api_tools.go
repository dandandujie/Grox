package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

type apiToolCall struct {
	ID        string
	Name      string
	Arguments strings.Builder
}

type apiRound struct {
	Text  string
	Calls []*apiToolCall
}

const (
	maxToolRounds = 4
	maxToolCalls  = 8
	maxToolList   = 32
)

func apiEndpoint(req Request) (string, string) {
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
		return "", ""
	}
	endpoint := strings.TrimSuffix(base, "/")
	if !strings.HasSuffix(endpoint, "/chat/completions") {
		endpoint += "/chat/completions"
	}
	modelID := strings.TrimSpace(req.APIModel)
	if modelID == "" {
		modelID = req.Model.ID
	}
	return endpoint, modelID
}

func toolSchema(tool Tool) map[string]any {
	parameters := tool.Parameters
	if parameters == nil {
		parameters = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	description := tool.Description
	if len(description) > 1000 {
		description = description[:1000] + "…"
	}
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name": tool.Name, "description": description, "parameters": parameters,
		},
	}
}

func runAPITools(ctx context.Context, req Request, sink Sink) (string, error) {
	endpoint, modelID := apiEndpoint(req)
	if endpoint == "" {
		return "", fmt.Errorf("no API base URL is configured")
	}
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
	system += "\n\nYou can call connected-app tools. Use a tool only when it is necessary; explain the result to the person in plain language."
	messages := []map[string]any{{"role": "system", "content": system}}
	if extra := strings.TrimSpace(req.ExtraContext); extra != "" {
		messages = append(messages, map[string]any{"role": "system", "content": extra})
	}
	for _, message := range recent(req.History, 16) {
		text := strings.TrimSpace(message.Text)
		if text == "" || message.Pending {
			continue
		}
		switch message.Role {
		case model.RoleUser:
			messages = append(messages, map[string]any{"role": "user", "content": text})
		case model.RoleBot:
			content := text
			if message.SenderName != "" && message.SenderName != req.Bot.Name {
				content = message.SenderName + ": " + text
			}
			messages = append(messages, map[string]any{"role": "assistant", "content": content})
		}
	}
	userText := strings.TrimSpace(req.UserText)
	if userText != "" {
		if len(messages) == 0 || messages[len(messages)-1]["role"] != "user" || messages[len(messages)-1]["content"] != userText {
			messages = append(messages, map[string]any{"role": "user", "content": userText})
		}
	}
	tools := req.Tools
	if len(tools) > maxToolList {
		tools = tools[:maxToolList]
	}
	definitions := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		definitions = append(definitions, toolSchema(tool))
	}
	var text strings.Builder
	for round := 0; round < maxToolRounds; round += 1 {
		result, err := streamAPIRound(ctx, endpoint, modelID, req.APIKey, messages, definitions, sink)
		if err != nil {
			return "", err
		}
		if result.Text != "" {
			text.WriteString(result.Text)
		}
		if len(result.Calls) == 0 {
			break
		}
		calls := result.Calls
		if len(calls) > maxToolCalls {
			calls = calls[:maxToolCalls]
		}
		assistantCalls := make([]any, 0, len(calls))
		for _, call := range calls {
			assistantCalls = append(assistantCalls, map[string]any{
				"id": call.ID, "type": "function",
				"function": map[string]any{"name": call.Name, "arguments": call.Arguments.String()},
			})
		}
		messages = append(messages, map[string]any{
			"role": "assistant", "content": result.Text, "tool_calls": assistantCalls,
		})
		for _, call := range calls {
			arguments := map[string]any{}
			raw := strings.TrimSpace(call.Arguments.String())
			if raw == "" {
				raw = "{}"
			}
			if err := json.Unmarshal([]byte(raw), &arguments); err != nil {
				arguments = map[string]any{}
				messages = append(messages, map[string]any{
					"role": "tool", "tool_call_id": call.ID,
					"content": "Grox could not parse the tool arguments: " + err.Error(),
				})
				continue
			}
			detail := raw
			if len(detail) > 260 {
				detail = detail[:260] + "…"
			}
			activity := model.Activity{Label: "Called " + call.Name, Detail: detail, StartedAt: time.Now()}
			content, execErr := req.ExecuteTool(ctx, call.Name, arguments)
			if execErr != nil {
				sink.Activity(model.Activity{Label: "Called " + call.Name, Detail: execErr.Error(), Status: model.StatusError, StartedAt: activity.StartedAt})
				content = "The tool failed: " + execErr.Error()
			} else {
				sink.Activity(model.Activity{Label: "Called " + call.Name, Detail: "completed", Status: model.StatusOK, StartedAt: activity.StartedAt})
			}
			if len(content) > 20000 {
				content = content[:20000] + "…"
			}
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": call.ID, "content": content})
		}
	}
	if strings.TrimSpace(text.String()) == "" {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("the API used a tool but returned no final reply")
	}
	return text.String(), nil
}

func streamAPIRound(ctx context.Context, endpoint, modelID, apiKey string, messages []map[string]any, tools []map[string]any, sink Sink) (apiRound, error) {
	payload := map[string]any{"model": modelID, "messages": messages, "stream": true, "stream_options": map[string]any{"include_usage": true}}
	if len(tools) > 0 {
		payload["tools"] = tools
		payload["tool_choice"] = "auto"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return apiRound{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return apiRound{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}
	sink.Status("Thinking")
	resp, err := (&http.Client{}).Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return apiRound{}, ctx.Err()
		}
		return apiRound{}, fmt.Errorf("could not reach the API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		message := strings.TrimSpace(string(data))
		if len(message) > 300 {
			message = message[:300] + "…"
		}
		return apiRound{}, fmt.Errorf("the API returned %s: %s", resp.Status, message)
	}
	result := apiRound{}
	byIndex := map[int]*apiToolCall{}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	firstToken := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
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
			return apiRound{}, fmt.Errorf("%s", str(errObj["message"]))
		}
		if usage, ok := usageFromEvent(event); ok {
			reportUsage(sink, usage)
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
				result.Text += content
			}
			collectToolCalls(delta["tool_calls"], byIndex)
		}
		if message, _ := choice["message"].(map[string]any); message != nil {
			if content := contentText(message["content"]); content != "" && result.Text == "" {
				sink.Text(content)
				result.Text += content
			}
			collectToolCalls(message["tool_calls"], byIndex)
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return apiRound{}, fmt.Errorf("the API stream ended early: %w", err)
	}
	indexes := make([]int, 0, len(byIndex))
	for index := range byIndex {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	for _, index := range indexes {
		call := byIndex[index]
		if call.Name == "" {
			continue
		}
		result.Calls = append(result.Calls, call)
	}
	return result, nil
}

func collectToolCalls(value any, byIndex map[int]*apiToolCall) {
	calls, _ := value.([]any)
	for _, item := range calls {
		call, _ := item.(map[string]any)
		if call == nil {
			continue
		}
		index := 0
		if number, ok := call["index"].(float64); ok {
			index = int(number)
		}
		entry := byIndex[index]
		if entry == nil {
			entry = &apiToolCall{}
			byIndex[index] = entry
		}
		if id := str(call["id"]); id != "" {
			entry.ID = id
		}
		if function, ok := call["function"].(map[string]any); ok {
			if name := str(function["name"]); name != "" {
				entry.Name = name
			}
			if args, ok := function["arguments"].(string); ok {
				entry.Arguments.WriteString(args)
			}
		}
	}
}
