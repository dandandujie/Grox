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
	maxToolRounds     = 4
	maxToolCalls      = 8
	maxToolList       = 32
	maxToolImageBytes = 12 << 20
)

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
	messages, err := apiMessages(ctx, req, true)
	if err != nil {
		return "", err
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
	toolImageBytes := 0
	for round := 0; round < maxToolRounds; round += 1 {
		result, err := streamAPIRound(ctx, endpoint, modelID, req.APIKey, messages, definitions, sink)
		if err != nil {
			return text.String() + result.Text, err
		}
		if result.Text != "" {
			text.WriteString(result.Text)
		}
		if len(result.Calls) == 0 {
			break
		}
		if roundSink, ok := sink.(interface{ StartToolRound() }); ok {
			roundSink.StartToolRound()
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
			if err := ctx.Err(); err != nil {
				return text.String(), err
			}
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
		if req.TakeAPIToolImages != nil {
			images := req.TakeAPIToolImages()
			if len(images) == 0 {
				continue
			}
			var labels strings.Builder
			labels.WriteString("Images returned by tools:")
			for _, image := range images {
				toolImageBytes += len(image.Data)
				fmt.Fprintf(&labels, "\n- %q", image.Name)
			}
			if toolImageBytes > maxToolImageBytes {
				return text.String(), fmt.Errorf("the tools returned more than 12 MiB of images in this turn")
			}
			// Chat Completions tool replies support text only. Keep the
			// correlated replies above, then provide actual visual input.
			messages = append(messages, map[string]any{"role": "user", "content": apiUserContent(labels.String(), images)})
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
			return result, fmt.Errorf("%s", str(errObj["message"]))
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
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if err := scanner.Err(); err != nil {
		return result, fmt.Errorf("the API stream ended early: %w", err)
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
