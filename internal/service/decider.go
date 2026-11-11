package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

const deciderSecret = "decider"

// decideRoomResponder asks an OpenRouter-compatible chat model to choose one
// member. Any failure returns nil and the room keeps its lead fallback.
func (s *Service) decideRoomResponderLocked(g *model.Group, text string) *model.Bot {
	settings := s.st.State.Settings
	if !settings.DeciderEnabled {
		return nil
	}
	provider := strings.ToLower(strings.TrimSpace(settings.DeciderProvider))
	key := ""
	if provider != "workersai" && provider != "jev" {
		key = strings.TrimSpace(s.st.Secrets[deciderSecret])
		if key == "" {
			return nil
		}
	}
	if len(g.MemberIDs) < 2 {
		return nil
	}
	base := strings.TrimRight(strings.TrimSpace(settings.DeciderBaseURL), "/")
	if base == "" {
		base = "https://openrouter.ai/api/v1"
	}
	modelID := strings.TrimSpace(settings.DeciderModel)
	if modelID == "" {
		modelID = "typesafe/jev-1.13"
	}
	var members []string
	for _, id := range g.MemberIDs {
		bot := s.findBotLocked(id)
		if bot == nil {
			continue
		}
		members = append(members, fmt.Sprintf("- %s: %s. %s", bot.ID, bot.Name+" — "+bot.Title, bot.Description))
	}
	if len(members) < 2 {
		return nil
	}
	var recent []string
	thread := s.findGroupThreadLocked(g, s.st.State.ActiveThreadID)
	if thread == nil && len(g.Threads) > 0 {
		thread = &g.Threads[0]
	}
	if thread != nil {
		start := len(thread.Messages) - 8
		if start < 0 {
			start = 0
		}
		for _, message := range thread.Messages[start:] {
			if strings.TrimSpace(message.Text) == "" || message.Pending {
				continue
			}
			recent = append(recent, message.SenderName+": "+message.Text)
		}
	}
	if provider == "workersai" || provider == "jev" {
		return s.decideRoomClassifierLocked(g, text, provider, recent)
	}
	prompt := "Choose exactly one bot to answer the new room message.\nReply only with JSON: {\"choice\":\"<bot id>\",\"pTop\":0.0}.\n\nBots:\n" + strings.Join(members, "\n")
	if len(recent) > 0 {
		prompt += "\n\nRecent room messages:\n" + strings.Join(recent, "\n")
	}
	prompt += "\n\nNew message: " + text
	started := time.Now()
	body, _ := json.Marshal(map[string]any{
		"model": modelID, "temperature": 0,
		"messages":        []map[string]string{{"role": "system", "content": "You are a fast room-routing classifier. Never do the work."}, {"role": "user", "content": prompt}},
		"response_format": map[string]string{"type": "json_object"},
	})
	request, err := http.NewRequest(http.MethodPost, base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	response, err := client.Do(request)
	if err != nil {
		s.logDecision("openrouter", "", 0, time.Since(started), modelID, prompt, false, "unreachable")
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
		s.logDecision("openrouter", "", 0, time.Since(started), modelID, prompt, false, "http_error")
		return nil
	}
	var payload map[string]any
	if json.NewDecoder(response.Body).Decode(&payload) != nil {
		s.logDecision("openrouter", "", 0, time.Since(started), modelID, prompt, false, "malformed")
		return nil
	}
	choices, _ := payload["choices"].([]any)
	if len(choices) == 0 {
		return nil
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	contentText, _ := message["content"].(string)
	var decision map[string]any
	if json.Unmarshal([]byte(contentText), &decision) != nil {
		s.logDecision("openrouter", "", 0, time.Since(started), modelID, prompt, false, "malformed")
		return nil
	}
	choiceID, _ := decision["choice"].(string)
	probability, _ := decision["pTop"].(float64)
	if probability < 0.6 {
		s.logDecision("openrouter", "", probability, time.Since(started), modelID, prompt, false, "low_confidence")
		return nil
	}
	for _, id := range g.MemberIDs {
		if id == choiceID {
			s.logDecision("openrouter", choiceID, probability, time.Since(started), modelID, prompt, true, "")
			return s.findBotLocked(id)
		}
	}
	s.logDecision("openrouter", "", probability, time.Since(started), modelID, prompt, false, "no_choice")
	return nil
}

func (s *Service) decideRoomClassifierLocked(g *model.Group, text, provider string, recent []string) *model.Bot {
	settings := s.st.State.Settings
	keyName := "decider-jev"
	key := strings.TrimSpace(s.st.Secrets[keyName])
	base := strings.TrimRight(strings.TrimSpace(settings.DeciderBaseURL), "/")
	endpoint := ""
	modelID := "jev-latest"
	if provider == "workersai" {
		keyName = "decider-workers"
		key = strings.TrimSpace(s.st.Secrets[keyName])
		if base == "" {
			base = "https://api.cloudflare.com/client/v4"
		}
		account := strings.ToLower(strings.TrimSpace(settings.DeciderAccountID))
		if len(account) != 32 {
			return nil
		}
		endpoint = base + "/accounts/" + account + "/ai/run/@cf/cloudflare/clef-flash"
		modelID = "clef-flash"
	} else {
		if base == "" {
			base = "https://api.typesafe.ai"
		}
		endpoint = base + "/v1/systemone"
	}
	if key == "" {
		return nil
	}
	options := map[string]string{}
	for _, id := range g.MemberIDs {
		bot := s.findBotLocked(id)
		if bot == nil {
			continue
		}
		options[id] = fmt.Sprintf("%s, %s bot. %s", bot.Name, bot.Title, bot.Description)
	}
	if len(options) < 2 {
		return nil
	}
	state := map[string]any{
		"room": g.Name, "bot_ids": g.MemberIDs,
		"recent_messages": recent, "new_message": text,
	}
	body, _ := json.Marshal(map[string]any{
		"model": modelID, "state": state,
		"questions": map[string]any{
			"room": map[string]any{
				"type":         "choice",
				"instructions": "Which bot in this room should answer new_message?",
				"criteria":     options,
			},
		},
	})
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	started := time.Now()
	response, err := (&http.Client{Timeout: 1500 * time.Millisecond}).Do(request)
	if err != nil {
		s.logDecision(provider, "", 0, 0, modelID, "", false, "unreachable")
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
		s.logDecision(provider, "", 0, time.Since(started), modelID, "", false, "http_error")
		return nil
	}
	var envelope map[string]any
	if json.NewDecoder(response.Body).Decode(&envelope) != nil {
		s.logDecision(provider, "", 0, time.Since(started), modelID, "", false, "malformed")
		return nil
	}
	result := envelope
	if nested, ok := envelope["result"].(map[string]any); ok {
		result = nested
	}
	answers, _ := result["answers"].(map[string]any)
	room, _ := answers["room"].(map[string]any)
	choice, _ := room["choice"].(string)
	probabilities, _ := room["probabilities"].(map[string]any)
	probability, _ := probabilities[choice].(float64)
	if probability < 0.6 {
		s.logDecision(provider, "", probability, time.Since(started), modelID, "", false, "low_confidence")
		return nil
	}
	for _, id := range g.MemberIDs {
		if id == choice {
			s.logDecision(provider, choice, probability, time.Since(started), modelID, "", true, "")
			return s.findBotLocked(id)
		}
	}
	s.logDecision(provider, "", probability, time.Since(started), modelID, "", false, "no_choice")
	return nil
}
