package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type decideOption struct {
	ID          string
	Description string
}

// decideWithProvider asks the configured decision provider to choose one
// option for a bot-authored question. It never executes the chosen action.
func (s *Service) decideWithProvider(instructions string, options []decideOption) (string, float64, error) {
	instructions = strings.TrimSpace(instructions)
	if instructions == "" || len(options) < 2 || len(options) > 50 {
		return "", 0, fmt.Errorf("decide needs instructions and 2-50 options")
	}
	settings := s.st.State.Settings
	provider := strings.ToLower(strings.TrimSpace(settings.DeciderProvider))
	if provider == "" {
		provider = "openrouter"
	}
	criteria := map[string]string{}
	for _, option := range options {
		id := strings.TrimSpace(option.ID)
		if id == "" {
			return "", 0, fmt.Errorf("decide option id is empty")
		}
		criteria[id] = strings.TrimSpace(option.Description)
	}
	if provider == "workersai" || provider == "jev" {
		return s.decideViaClassifier(provider, instructions, criteria)
	}
	return s.decideViaOpenRouter(instructions, criteria)
}

func (s *Service) decideViaOpenRouter(instructions string, criteria map[string]string) (string, float64, error) {
	settings := s.st.State.Settings
	key := strings.TrimSpace(s.st.Secrets[deciderSecret])
	if key == "" {
		return "", 0, fmt.Errorf("no OpenRouter decision key configured")
	}
	base := strings.TrimRight(strings.TrimSpace(settings.DeciderBaseURL), "/")
	if base == "" {
		base = "https://openrouter.ai/api/v1"
	}
	modelID := strings.TrimSpace(settings.DeciderModel)
	if modelID == "" {
		modelID = "typesafe/jev-1.13"
	}
	optionsJSON, _ := json.Marshal(criteria)
	prompt := instructions + "\n\nOptions:\n" + string(optionsJSON) + "\n\nReply only with JSON: {\"choice\":\"<option id>\",\"pTop\":0.0}."
	body, _ := json.Marshal(map[string]any{
		"model": modelID, "temperature": 0,
		"messages":        []map[string]string{{"role": "system", "content": "You are a fast classifier. Never do the work."}, {"role": "user", "content": prompt}},
		"response_format": map[string]string{"type": "json_object"},
	})
	request, err := http.NewRequest(http.MethodPost, base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", 0, err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 2500 * time.Millisecond}).Do(request)
	if err != nil {
		return "", 0, fmt.Errorf("decision provider unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
		return "", 0, fmt.Errorf("decision provider returned %s", response.Status)
	}
	var payload map[string]any
	if json.NewDecoder(response.Body).Decode(&payload) != nil {
		return "", 0, fmt.Errorf("decision provider returned malformed JSON")
	}
	choices, _ := payload["choices"].([]any)
	if len(choices) == 0 {
		return "", 0, fmt.Errorf("decision provider returned no choice")
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	content, _ := message["content"].(string)
	var answer map[string]any
	if json.Unmarshal([]byte(content), &answer) != nil {
		return "", 0, fmt.Errorf("decision provider returned malformed answer")
	}
	selected, _ := answer["choice"].(string)
	probability, _ := answer["pTop"].(float64)
	if _, ok := criteria[selected]; !ok {
		return "", 0, fmt.Errorf("decision provider chose an unknown option")
	}
	return selected, probability, nil
}

func (s *Service) decideViaClassifier(provider, instructions string, criteria map[string]string) (string, float64, error) {
	settings := s.st.State.Settings
	key := strings.TrimSpace(s.st.Secrets["decider-jev"])
	base := strings.TrimRight(strings.TrimSpace(settings.DeciderBaseURL), "/")
	endpoint := ""
	modelID := "jev-latest"
	if provider == "workersai" {
		key = strings.TrimSpace(s.st.Secrets["decider-workers"])
		if base == "" {
			base = "https://api.cloudflare.com/client/v4"
		}
		account := strings.ToLower(strings.TrimSpace(settings.DeciderAccountID))
		if len(account) != 32 {
			return "", 0, fmt.Errorf("Cloudflare account ID is required")
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
		return "", 0, fmt.Errorf("no decision key configured")
	}
	body, _ := json.Marshal(map[string]any{
		"model": modelID, "state": map[string]any{},
		"questions": map[string]any{"choice": map[string]any{"type": "choice", "instructions": instructions, "criteria": criteria}},
	})
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", 0, err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 2500 * time.Millisecond}).Do(request)
	if err != nil {
		return "", 0, fmt.Errorf("decision provider unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
		return "", 0, fmt.Errorf("decision provider returned %s", response.Status)
	}
	var envelope map[string]any
	if json.NewDecoder(response.Body).Decode(&envelope) != nil {
		return "", 0, fmt.Errorf("decision provider returned malformed JSON")
	}
	result := envelope
	if nested, ok := envelope["result"].(map[string]any); ok {
		result = nested
	}
	answers, _ := result["answers"].(map[string]any)
	choice, _ := answers["choice"].(map[string]any)
	selected, _ := choice["choice"].(string)
	probabilities, _ := choice["probabilities"].(map[string]any)
	probability, _ := probabilities[selected].(float64)
	if _, ok := criteria[selected]; !ok {
		return "", 0, fmt.Errorf("decision provider chose an unknown option")
	}
	return selected, probability, nil
}

func (s *Service) decideTool(arguments map[string]any) (string, error) {
	instructions, _ := arguments["instructions"].(string)
	if strings.TrimSpace(instructions) == "" {
		instructions, _ = arguments["question"].(string)
	}
	rawOptions, _ := arguments["options"].(map[string]any)
	options := make([]decideOption, 0, len(rawOptions))
	for id, description := range rawOptions {
		text, _ := description.(string)
		options = append(options, decideOption{ID: id, Description: text})
	}
	choice, probability, err := s.decideWithProvider(instructions, options)
	if err != nil {
		return "", err
	}
	data, _ := json.Marshal(map[string]any{"choice": choice, "pTop": probability})
	return string(data), nil
}
