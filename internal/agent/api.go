package agent

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

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
	endpoint, modelID := apiEndpoint(req)
	if endpoint == "" {
		return "", fmt.Errorf("no API base URL is configured")
	}
	messages, err := apiMessages(ctx, req, false)
	if err != nil {
		return "", err
	}
	result, err := streamAPIRound(ctx, endpoint, modelID, req.APIKey, messages, nil, sink)
	if err != nil {
		return result.Text, err
	}
	if strings.TrimSpace(result.Text) == "" {
		return "", fmt.Errorf("the API returned an empty reply")
	}
	return result.Text, nil
}

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

func apiMessages(ctx context.Context, req Request, withTools bool) ([]map[string]any, error) {
	system := req.Bot.Soul
	if system == "" {
		system = "You are " + req.Bot.Name + ", a helpful assistant."
	}
	system += "\n\nYou are replying inside Grox, a chat app. Use GitHub-flavored Markdown when it helps."
	for _, context := range []struct{ title, content string }{
		{"Installed playbooks", req.PlaybookText},
		{"Enabled skills", req.SkillText},
		{"Memory", req.MemoryText},
		{"Recalled memory", req.RecallText},
	} {
		if text := strings.TrimSpace(context.content); text != "" {
			system += "\n\n## " + context.title + "\n\n" + text
		}
	}
	if withTools {
		system += "\n\nYou can call connected-app tools. Use a tool only when it is necessary; explain the result to the person in plain language."
	}
	messages := []map[string]any{{"role": "system", "content": system}}
	history := recent(req.History, 16)
	userText := strings.TrimSpace(req.UserText)
	for index, message := range history {
		text := strings.TrimSpace(message.Text)
		if message.Pending {
			continue
		}
		switch message.Role {
		case model.RoleUser:
			// The active send is already in the saved transcript. Add it
			// below, together with the explicitly selected file contents.
			if index == len(history)-1 && text == userText {
				continue
			}
			if text != "" {
				messages = append(messages, map[string]any{"role": "user", "content": text})
			}
		case model.RoleBot:
			if text == "" {
				continue
			}
			if message.SenderName != "" && message.SenderName != req.Bot.Name {
				text = message.SenderName + ": " + text
			}
			messages = append(messages, map[string]any{"role": "assistant", "content": text})
		}
	}
	var attachments []APIAttachment
	if req.LoadAPIAttachments != nil {
		var err error
		attachments, err = req.LoadAPIAttachments(ctx)
		if err != nil {
			return nil, err
		}
	}
	if userText != "" || len(attachments) > 0 {
		messages = append(messages, map[string]any{"role": "user", "content": apiUserContent(userText, attachments)})
	}
	return messages, nil
}

func apiUserContent(userText string, attachments []APIAttachment) any {
	var text strings.Builder
	text.WriteString(userText)
	var images []map[string]any
	for _, file := range attachments {
		if file.ImageMIME != "" {
			images = append(images, map[string]any{
				"type": "image_url",
				"image_url": map[string]string{
					"url": "data:" + file.ImageMIME + ";base64," + base64.StdEncoding.EncodeToString(file.Data),
				},
			})
			continue
		}
		if text.Len() > 0 {
			text.WriteString("\n\n")
		}
		fmt.Fprintf(&text, "Attached file %q:\n", file.Name)
		text.Write(file.Data)
	}
	if len(images) == 0 {
		return text.String()
	}
	if text.Len() == 0 {
		return images
	}
	return append([]map[string]any{{"type": "text", "text": text.String()}}, images...)
}

func usageFromEvent(event map[string]any) (TokenUsage, bool) {
	raw, ok := event["usage"].(map[string]any)
	if !ok || raw == nil {
		return TokenUsage{}, false
	}
	number := func(value any) int {
		if parsed, ok := value.(float64); ok {
			return int(parsed)
		}
		return 0
	}
	usage := TokenUsage{
		InputTokens:  number(raw["prompt_tokens"]),
		OutputTokens: number(raw["completion_tokens"]),
		TotalTokens:  number(raw["total_tokens"]),
	}
	if usage.TotalTokens == 0 {
		usage.TotalTokens = usage.InputTokens + usage.OutputTokens
	}
	return usage, usage.TotalTokens > 0
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
