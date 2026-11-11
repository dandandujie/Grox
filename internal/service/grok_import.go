package service

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/dandandujie/grox/internal/model"
)

func containsCredentialKey(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			lower := strings.ToLower(key)
			for _, token := range []string{"api_key", "apikey", "token", "secret", "password", "authorization", "bearer", "cookie", "private_key"} {
				if strings.Contains(lower, token) {
					return true
				}
			}
			if containsCredentialKey(child) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if containsCredentialKey(child) {
				return true
			}
		}
	}
	return false
}

func extractJSONObject(text string) string {
	start := strings.Index(text, "{")
	if start < 0 {
		return ""
	}
	depth := 0
	quoted := false
	escaped := false
	for index := start; index < len(text); index++ {
		ch := text[index]
		if quoted {
			if escaped {
				escaped = false
			} else if ch == '\\' {
				escaped = true
			} else if ch == '"' {
				quoted = false
			}
			continue
		}
		switch ch {
		case '"':
			quoted = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[start : index+1]
			}
		}
	}
	return ""
}

func stringField(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return strings.TrimSpace(value)
}

func listItems(record map[string]any, key string) []any {
	value, _ := record[key].([]any)
	return value
}

func stringList(record map[string]any, key string) []string {
	out := []string{}
	for _, item := range listItems(record, key) {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			out = append(out, strings.TrimSpace(value))
		}
	}
	return out
}

func simpleCronSchedule(expression string) (cadence, clock string, ok bool) {
	fields := strings.Fields(strings.TrimSpace(expression))
	if len(fields) != 5 || fields[0] == "*" || fields[1] == "*" || fields[4] == "*" {
		return "", "", false
	}
	minute, err := strconv.Atoi(fields[0])
	if err != nil || minute < 0 || minute > 59 {
		return "", "", false
	}
	hour, err := strconv.Atoi(fields[1])
	if err != nil || hour < 0 || hour > 23 {
		return "", "", false
	}
	cadence = "daily"
	if fields[4] == "1-5" {
		cadence = "weekdays"
	}
	return cadence, fmt.Sprintf("%02d:%02d", hour, minute), true
}

// ImportGrokBot imports a pasted Grok Bot export. It creates new bots and never
// overwrites an existing one; skills are skipped because Grox skills are global.
func (s *Service) ImportGrokBot(raw string) (model.GrokImportResult, error) {
	text := strings.TrimSpace(raw)
	if len(text) > 4*1024*1024 {
		return model.GrokImportResult{}, fmt.Errorf("Grok export is too large")
	}
	object := extractJSONObject(text)
	if object == "" {
		return model.GrokImportResult{}, fmt.Errorf("no Grok Bot export JSON found")
	}
	var generic map[string]any
	if err := json.Unmarshal([]byte(object), &generic); err != nil {
		return model.GrokImportResult{}, fmt.Errorf("invalid Grok export JSON")
	}
	if containsCredentialKey(generic) {
		return model.GrokImportResult{}, fmt.Errorf("refusing an export that contains credential-looking keys")
	}
	bots := listItems(generic, "bots")
	if len(bots) == 0 && stringField(generic, "name") != "" {
		bots = []any{generic}
	}
	if len(bots) == 0 {
		return model.GrokImportResult{}, fmt.Errorf("the export contains no bots")
	}
	result := model.GrokImportResult{}
	seen := map[string]bool{}
	for _, rawBot := range bots {
		item, ok := rawBot.(map[string]any)
		if !ok {
			continue
		}
		name := stringField(item, "name")
		if name == "" || seen[strings.ToLower(name)] {
			continue
		}
		seen[strings.ToLower(name)] = true
		bot, err := s.CreateBot(model.CreateBotInput{
			Name: name, Title: stringField(item, "title"), Description: stringField(item, "description"),
			Soul: stringField(item, "instructions"), Department: "Imported", ModelID: "grox-demo",
		})
		if err != nil {
			return result, err
		}
		result.Bots++
		result.Names = append(result.Names, bot.Name)
		result.SkillsSkipped += len(listItems(item, "skills"))
		memories := stringList(item, "memories")
		userFacts := stringList(item, "user_facts")
		if len(memories) > 0 || len(userFacts) > 0 {
			var memory strings.Builder
			memory.WriteString("# Notes from Grok Bot\n\n")
			if len(memories) > 0 {
				memory.WriteString("## What I remember\n\n")
				for _, fact := range memories {
					memory.WriteString("- " + fact + "\n")
				}
				memory.WriteString("\n")
			}
			if len(userFacts) > 0 {
				memory.WriteString("## About the person\n\n")
				for _, fact := range userFacts {
					memory.WriteString("- " + fact + "\n")
				}
			}
			state, err := s.GetMemory(bot.ID)
			if err == nil {
				if _, err := s.SaveMemory(bot.ID, memory.String(), state.Revision); err == nil {
					result.Memories += len(memories) + len(userFacts)
				}
			}
		}
		for _, rawRoutine := range listItems(item, "routines") {
			routine, ok := rawRoutine.(map[string]any)
			if !ok {
				continue
			}
			cadence, clock, ok := simpleCronSchedule(stringField(routine, "schedule_cron"))
			if !ok {
				continue
			}
			instruction := stringField(routine, "instruction")
			if instruction == "" {
				continue
			}
			_, err := s.CreateRoutine(model.RoutineInput{
				BotID: bot.ID, Name: name + ": " + stringField(routine, "name"), Prompt: instruction,
				Cadence: cadence, TimeOfDay: clock, Enabled: false,
			})
			if err == nil {
				result.Routines++
			}
		}
		for _, rawApp := range listItems(item, "apps") {
			app, ok := rawApp.(map[string]any)
			if !ok {
				continue
			}
			url := stringField(app, "mcp_url")
			if !strings.HasPrefix(url, "https://") {
				continue
			}
			_, err := s.CreateMCPServer(model.MCPServerInput{Name: stringField(app, "name"), URL: url, Enabled: false})
			if err == nil {
				result.Apps++
			}
		}
	}
	if result.Bots == 0 {
		return result, fmt.Errorf("no usable bots in the export")
	}
	return result, nil
}
