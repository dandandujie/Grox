package service

import (
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
	"gopkg.in/yaml.v3"
)

func (s *Service) importBotMRR(raw string) (model.TeamImportResult, error) {
	if len(raw) > 1_000_000 {
		return model.TeamImportResult{}, fmt.Errorf("the BotMRR playbook is larger than 1 MB")
	}
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	_, rest, _ := strings.Cut(raw, "\n")
	var frontmatter strings.Builder
	for line := range strings.SplitSeq(rest, "\n") {
		if line == "---" {
			var data map[string]any
			if err := yaml.Unmarshal([]byte(frontmatter.String()), &data); err != nil {
				return model.TeamImportResult{}, fmt.Errorf("invalid BotMRR YAML frontmatter")
			}
			if data["botmrr"] != 1 {
				return model.TeamImportResult{}, fmt.Errorf("this Markdown requires BotMRR version 1 frontmatter")
			}
			encoded, err := json.Marshal(data)
			if err != nil {
				return model.TeamImportResult{}, fmt.Errorf("invalid BotMRR package fields")
			}
			var pkg openMausTeam
			if err := json.Unmarshal(encoded, &pkg); err != nil {
				return model.TeamImportResult{}, fmt.Errorf("invalid BotMRR team: %w", err)
			}
			return s.installOpenMausTeam(openMausTeamDocument{Version: 1, Package: pkg}, nil)
		}
		frontmatter.WriteString(line)
		frontmatter.WriteByte('\n')
	}
	return model.TeamImportResult{}, fmt.Errorf("BotMRR Markdown requires a closing YAML frontmatter line")
}

var grokCredentialField = regexp.MustCompile(`(?i)(password|(?:^|_)(?:api_?key|token|secret|passwd|passphrase|credentials?|auth|authorization|bearer|cookies?|private_?key|access_?key|session_?(?:id|key|token))(?:_|$)|key$)`)
var grokCamelField = regexp.MustCompile(`([a-z0-9])([A-Z])`)
var grokFormatField = regexp.MustCompile(`"format"\s*:\s*"(grok-bot-export|openmaus\.grok/1)"`)

func grokCredentialKeys(value any, inApps bool) bool {
	switch value := value.(type) {
	case []any:
		for _, child := range value {
			if grokCredentialKeys(child, inApps) {
				return true
			}
		}
	case map[string]any:
		for key, child := range value {
			key = strings.ToLower(grokCamelField.ReplaceAllString(key, "${1}_${2}"))
			key = strings.NewReplacer("-", "_", " ", "_").Replace(key)
			if inApps && (key == "headers" || key == "env" || key == "environment") {
				continue // values in connection slots are never read or imported
			}
			if grokCredentialField.MatchString(key) || grokCredentialKeys(child, key == "apps" || key == "plugins" || key == "integrations") {
				return true
			}
		}
	}
	return false
}

func grokField(item map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := item[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func grokList(item map[string]any, keys ...string) []any {
	for _, key := range keys {
		if values, ok := item[key].([]any); ok {
			return values
		}
	}
	return nil
}

func looksLikeGrokBot(value any) bool {
	item, ok := value.(map[string]any)
	if !ok || grokField(item, "name") == "" {
		return false
	}
	for _, field := range []string{"instructions", "soul", "systemPrompt", "memories", "user_facts", "skills", "routines", "apps"} {
		if _, present := item[field]; present {
			return true
		}
	}
	return false
}

func grokEnvelope(value any) (map[string]any, bool) {
	item, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	format := grokField(item, "format")
	if format == "grok-bot-export" || format == "openmaus.grok/1" || (format == "" && grokList(item, "bots") != nil) {
		return item, true
	}
	return nil, false
}

func grokJSON(raw string) (any, bool) {
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err == nil {
		return value, true
	}
	var cleaned strings.Builder
	var inString, escaped bool
	for i := 0; i < len(raw); i++ {
		char := raw[i]
		switch {
		case inString && escaped:
			escaped = false
		case inString && char == '\\':
			escaped = true
		case char == '"':
			inString = !inString
		case !inString && char == ',':
			rest := strings.TrimLeft(raw[i+1:], " \t\r\n")
			if strings.HasPrefix(rest, "}") || strings.HasPrefix(rest, "]") {
				continue
			}
		}
		cleaned.WriteByte(char)
	}
	err := json.Unmarshal([]byte(cleaned.String()), &value)
	return value, err == nil
}

func grokDocumentsIn(raw string) ([]map[string]any, bool) {
	if whole, ok := grokJSON(raw); ok {
		if doc, ok := grokEnvelope(whole); ok {
			return []map[string]any{doc}, false
		}
		if looksLikeGrokBot(whole) {
			return []map[string]any{{"bots": []any{whole}}}, false
		}
		if bots, ok := whole.([]any); ok && len(bots) > 0 && !slices.ContainsFunc(bots, func(bot any) bool { return !looksLikeGrokBot(bot) }) {
			return []map[string]any{{"bots": bots}}, false
		}
	}
	var docs []map[string]any
	unfinished := false
	misses := 0
	for len(raw) > 0 && misses < 50 {
		start := strings.IndexByte(raw, '{')
		if start < 0 {
			break
		}
		raw = raw[start:]
		size := grokObjectSize(raw)
		if size == 0 {
			unfinished = unfinished || grokFormatField.MatchString(raw[:min(len(raw), 512)])
			misses++
			raw = raw[1:]
			continue
		}
		if value, ok := grokJSON(raw[:size]); ok {
			if doc, ok := grokEnvelope(value); ok {
				docs = append(docs, doc)
			}
		} else {
			unfinished = unfinished || grokFormatField.MatchString(raw[:min(size, 512)])
		}
		raw = raw[size:]
	}
	return docs, unfinished
}

func grokObjectSize(raw string) int {
	depth := 0
	var quoted, escaped bool
	for i := 0; i < len(raw); i++ {
		char := raw[i]
		switch {
		case quoted && escaped:
			escaped = false
		case quoted && char == '\\':
			escaped = true
		case char == '"':
			quoted = !quoted
		case !quoted && char == '{':
			depth++
		case !quoted && char == '}':
			depth--
			if depth == 0 {
				return i + 1
			}
		}
	}
	return 0
}

func mergeGrokBot(into, part map[string]any) {
	for _, key := range []string{"title", "description"} {
		if value := grokField(part, key); value != "" {
			into[key] = value
		}
	}
	if value := grokField(part, "instructions", "soul", "systemPrompt"); value != "" {
		into["instructions"] = value
	}
	for _, aliases := range [][]string{
		{"memories"}, {"user_facts", "userFacts"}, {"skills"}, {"routines"}, {"apps", "plugins", "integrations"},
	} {
		seen := map[string]bool{}
		for _, entry := range grokList(into, aliases[0]) {
			raw, _ := json.Marshal(entry)
			seen[string(raw)] = true
		}
		for _, entry := range grokList(part, aliases...) {
			raw, _ := json.Marshal(entry)
			if !seen[string(raw)] {
				seen[string(raw)] = true
				into[aliases[0]] = append(grokList(into, aliases[0]), entry)
			}
		}
	}
}

func (s *Service) importGrokBots(raw string) (model.TeamImportResult, error) {
	docs, unfinished := grokDocumentsIn(raw)
	if len(docs) == 0 {
		repaired, repairedUnfinished := grokDocumentsIn(strings.NewReplacer("“", "\"", "”", "\"").Replace(raw))
		if len(repaired) > 0 || repairedUnfinished {
			docs, unfinished = repaired, repairedUnfinished
		}
	}
	if unfinished {
		return model.TeamImportResult{}, fmt.Errorf("the Grok Bot reply is missing part of an export. Include every complete JSON document")
	}
	if len(docs) == 0 {
		return model.TeamImportResult{}, fmt.Errorf("choose a Grox team, an OpenMaus package, a BotMRR blueprint or a complete Grok Bot export")
	}
	var bots []map[string]any
	index := map[string]int{}
	for _, doc := range docs {
		if version, ok := doc["version"].(float64); ok && version != 1 {
			return model.TeamImportResult{}, fmt.Errorf("unsupported Grok Bot export version")
		}
		if grokCredentialKeys(doc, false) {
			return model.TeamImportResult{}, fmt.Errorf("the Grok Bot export contains credential fields. Remove them before importing")
		}
		entries := grokList(doc, "bots")
		if entries == nil {
			entries = []any{doc}
		}
		for _, entry := range entries {
			bot, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			name := openMausLine(grokField(bot, "name"))
			if name == "" {
				continue
			}
			key := strings.ToLower(name)
			i, exists := index[key]
			if !exists {
				i = len(bots)
				index[key] = i
				bots = append(bots, map[string]any{"name": name})
			}
			mergeGrokBot(bots[i], bot)
		}
	}

	pkg := openMausTeam{Name: "Grok Bot migration"}
	pkg.Team.Name = "Grok Bot"
	var warnings []string
	skills := map[string]bool{}
	scrub := openMausText{}
	for i, bot := range bots {
		agent := openMausAgent{
			Key: fmt.Sprintf("grok-%d", i+1), Name: scrub.oneLine(grokField(bot, "name"), 100),
			grokImportKey: hashText(strings.ToLower(openMausLine(grokField(bot, "name")))),
			Title:         scrub.oneLine(grokField(bot, "title"), 200),
			Description:   scrub.text(grokField(bot, "description"), 4_000), Soul: scrub.bytes(grokField(bot, "instructions"), 24_000),
		}
		agent.Appearance.Color = "green"
		agent.Seed.Memory = make(map[string]string)
		if notes := grokFacts(bot, &scrub); notes != "" {
			agent.Seed.Memory["MEMORY.md"] = notes
		}
		for _, rawSkill := range grokList(bot, "skills") {
			skill, ok := rawSkill.(map[string]any)
			body := scrub.clean(portableSkillBody(grokField(skill, "instructions", "body", "content", "text")))
			if !ok || body == "" {
				warnings = append(warnings, fmt.Sprintf("A skill for %s was skipped because its full instructions were missing.", agent.Name))
				continue
			}
			if len(agent.Skills) == 30 || len(pkg.Skills.Entries) == 120 {
				return model.TeamImportResult{}, fmt.Errorf("the migration exceeds 30 skills per bot or 120 in total")
			}
			name := portableSkillName(skillSlug(scrub.oneLine(grokField(skill, "name", "title"), 64)), skills)
			skills[name] = true
			description := scrub.oneLine(grokField(skill, "description", "summary"), 1_024)
			if description == "" {
				description = "Skill from Grok Bot"
			}
			body = scrub.bytes(body, (256<<10)-len(portableSkillFile(name, description, "")))
			pkg.Skills.Entries = append(pkg.Skills.Entries, openMausSkill{
				Name: name, Description: description, Instructions: portableSkillFile(name, description, body),
			})
			agent.Skills = append(agent.Skills, name)
		}

		var eventNotes strings.Builder
		for _, rawRoutine := range grokList(bot, "routines") {
			routine, ok := rawRoutine.(map[string]any)
			if !ok {
				continue
			}
			entry := openMausRoutine{
				Key: fmt.Sprintf("routine-%d", len(pkg.Routines)+1), Agent: agent.Key, RunOn: "maus",
				Name:   scrub.oneLine(grokField(routine, "name", "title"), 80),
				Prompt: scrub.text(grokField(routine, "instruction", "prompt", "instructions", "task"), 20_000),
			}
			if entry.Name == "" {
				entry.Name = "Grok Bot routine"
			}
			trigger := strings.ToLower(grokField(routine, "trigger"))
			clock, days := grokDailyClock(routine)
			entry.Schedule.Type, entry.Schedule.Time, entry.Schedule.Weekdays = "daily", clock, days
			if zone := grokField(routine, "timezone", "timeZone", "tz"); zone != "" || clock == "" {
				entry.Schedule.Type = "cron"
				entry.Schedule.TimeZone = zone
				entry.Schedule.Expression = grokField(routine, "schedule_cron", "cron", "cronExpression", "schedule_text", "schedule", "when")
			}
			if _, problem := entry.localRoutine("", "", time.Now()); problem == "" && entry.Prompt != "" &&
				(trigger == "" || slices.Contains([]string{"schedule", "scheduled", "time", "cron", "interval"}, trigger)) && len(pkg.Routines) < 50 {
				pkg.Routines = append(pkg.Routines, entry)
				continue
			}
			fmt.Fprintf(&eventNotes, "## %s\n\nTrigger: %s\nSchedule: %s\nTime zone: %s\nDetails: %s\n\n%s\n\n",
				entry.Name, scrub.clean(trigger),
				scrub.clean(grokField(routine, "schedule_cron", "cron", "cronExpression", "schedule_text", "schedule", "when")),
				scrub.clean(grokField(routine, "timezone", "timeZone", "tz")),
				scrub.clean(grokField(routine, "trigger_details", "details")),
				scrub.clean(grokField(routine, "instruction", "prompt", "instructions", "task")))
		}
		if eventNotes.Len() > 0 {
			agent.Seed.Memory["memory/grok-bot-event-routines.md"] = scrub.bytes(eventNotes.String(), 256<<10)
			warnings = append(warnings, fmt.Sprintf("Event or unsupported routines for %s were saved in Memory.", agent.Name))
		}
		var apps []string
		for _, rawApp := range grokList(bot, "apps") {
			name, _ := rawApp.(string)
			app, hasRecord := rawApp.(map[string]any)
			if hasRecord {
				name = grokField(app, "name", "label", "id", "slug")
			}
			if name = scrub.oneLine(name, 100); name != "" && !slices.Contains(apps, name) {
				apps = append(apps, name)
			}
			if !hasRecord || len(pkg.Connections) >= 20 {
				continue
			}
			if kind := strings.ToLower(grokField(app, "transport", "type")); kind != "" && kind != "http" {
				continue
			}
			address, ok := portableMCPAddress(grokField(app, "mcp_url", "mcpUrl", "url"), false, &scrub)
			if !ok {
				continue
			}
			connection := openMausConnection{Key: fmt.Sprintf("connection-%d", len(pkg.Connections)+1), Label: name, Reason: "Migrated from Grok Bot"}
			connection.MCP.Transport = "http"
			connection.MCP.URL = address
			if headers, ok := app["headers"].(map[string]any); ok {
				connection.MCP.ValueNames = portableHeaderNames(slices.Sorted(maps.Keys(headers)))
			}
			pkg.Connections = append(pkg.Connections, connection)
			agent.Connections = append(agent.Connections, connection.Key)
		}
		if len(apps) > 0 {
			agent.Seed.Memory["memory/grok-bot-apps.md"] = scrub.bytes("# Reconnect these apps in Grox\n\n- "+strings.Join(apps, "\n- "), 256<<10)
			warnings = append(warnings, fmt.Sprintf("Reconnect %s’s imported app list in Connected apps.", agent.Name))
		}
		pkg.Agents = append(pkg.Agents, agent)
	}
	pkg.Skills.Version = 1
	version := 2
	if len(pkg.Skills.Entries) > 60 {
		version = 3
	}
	if scrub.redacted {
		warnings = append(warnings, "Credential-shaped text was redacted.")
	}
	if scrub.shortened {
		warnings = append(warnings, "Long fields were shortened to fit Grox limits.")
	}
	return s.installOpenMausTeam(openMausTeamDocument{Version: version, Package: pkg}, warnings)
}

func grokFacts(bot map[string]any, scrub *openMausText) string {
	var notes strings.Builder
	seen := map[string]bool{}
	for _, section := range []struct{ key, title string }{{"memories", "What I remember"}, {"user_facts", "About the person"}} {
		var lines []string
		for _, raw := range grokList(bot, section.key) {
			value, _ := raw.(string)
			if item, ok := raw.(map[string]any); ok {
				value = grokField(item, "text", "content", "name")
			}
			value = scrub.oneLine(value, 20_000)
			key := strings.ToLower(value)
			if value != "" && !seen[key] {
				seen[key] = true
				lines = append(lines, value)
			}
		}
		if len(lines) > 0 {
			fmt.Fprintf(&notes, "## %s\n\n- %s\n\n", section.title, strings.Join(lines, "\n- "))
		}
	}
	if notes.Len() == 0 {
		return ""
	}
	return scrub.bytes("# Notes from Grok Bot\n\n"+notes.String(), 256<<10)
}

// Only convert schedules that Grox can run without changing their meaning.
func grokDailyClock(routine map[string]any) (string, []int) {
	expression := grokField(routine, "schedule_cron", "cron", "cronExpression", "schedule_text", "schedule", "when")
	fields := strings.Fields(expression)
	if len(fields) != 5 || fields[2] != "*" || fields[3] != "*" {
		return "", nil
	}
	minute, minuteErr := strconv.Atoi(fields[0])
	hour, hourErr := strconv.Atoi(fields[1])
	if minuteErr != nil || hourErr != nil || minute < 0 || minute > 59 || hour < 0 || hour > 23 {
		return "", nil
	}
	days := map[int]bool{}
	switch fields[4] {
	case "*":
		for day := 0; day <= 6; day++ {
			days[day] = true
		}
	default:
		for part := range strings.SplitSeq(fields[4], ",") {
			first, last, ranged := strings.Cut(part, "-")
			low, err := strconv.Atoi(first)
			if err != nil || low < 0 || low > 7 {
				return "", nil
			}
			high := low
			if ranged {
				high, err = strconv.Atoi(last)
				if err != nil || high < low || high > 7 {
					return "", nil
				}
			}
			for day := low; day <= high; day++ {
				days[day%7] = true
			}
		}
	}
	return fmt.Sprintf("%02d:%02d", hour, minute), slices.Sorted(maps.Keys(days))
}
