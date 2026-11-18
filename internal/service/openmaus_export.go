package service

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/schedule"
)

// Detect common inline credential shapes as well as values already held by
// Grox. Portable packages never serialize the secrets/configuration records.
var portableCredentials = []*regexp.Regexp{
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`),
	regexp.MustCompile(`\b(?:sk-(?:ant-|proj-)?|xai-|github_pat_|gh[pousr]_|gsk_|hf_|ntn_|npm_|whsec_|pplx-|xox[baprs]-|xapp-[0-9]-|AIza)[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2}\b`),
	regexp.MustCompile(`(?i)(\b(?:Bearer|Authorization\s*[:=]\s*Basic)\s+)[A-Za-z0-9._~+/=-]{8,}`),
	regexp.MustCompile(`(?i)(\b(?:[a-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|private[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}`),
	regexp.MustCompile(`(?i)(--(?:token|password|passwd|api-key|secret|access-key)(?:=|[ \t]+)["']?)[A-Za-z0-9._~+/=-]{4,}`),
	regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://[^\s/:@'"]+:)[^\s/@'"]+(@)`),
}

type openMausText struct {
	secrets   []string
	redacted  bool
	shortened bool
}

func (s *Service) openMausTextLocked() openMausText {
	var scrub openMausText
	add := func(value string) {
		if len(value) >= 4 {
			scrub.secrets = append(scrub.secrets, value)
		}
	}
	for key, value := range s.st.Secrets {
		add(value)
		if !strings.HasPrefix(key, "mcp:") {
			continue
		}
		var fields map[string]string
		switch {
		case strings.HasSuffix(key, ":headers") && json.Unmarshal([]byte(value), &fields) == nil:
			for _, field := range fields {
				add(field)
			}
		case strings.HasSuffix(key, ":oauth") && json.Unmarshal([]byte(value), &fields) == nil:
			for _, key := range []string{"clientSecret", "accessToken", "refreshToken"} {
				add(fields[key])
			}
		}
	}
	add(s.st.State.Settings.PhoneToken)
	for _, name := range []string{"xai", "openai", "anthropic", "google", "composio", "api"} {
		add(s.st.Key(name))
	}
	slices.SortFunc(scrub.secrets, func(a, b string) int { return len(b) - len(a) })
	return scrub
}

func (scrub *openMausText) clean(value string) string {
	before := value
	value = scrubPortableCredentials(value, scrub.secrets)
	scrub.redacted = scrub.redacted || value != before
	return strings.TrimSpace(value)
}

func scrubPortableCredentials(value string, held []string) string {
	for _, secret := range held {
		value = strings.ReplaceAll(value, secret, "[redacted]")
	}
	for _, pattern := range portableCredentials {
		replacement := "[redacted]"
		if pattern.NumSubexp() > 0 {
			replacement = "${1}[redacted]"
		}
		if pattern.NumSubexp() > 1 {
			replacement += "${2}"
		}
		value = pattern.ReplaceAllString(value, replacement)
	}
	return value
}

func (scrub *openMausText) text(value string, maxUnits int) string {
	value = scrub.clean(value)
	units := 0
	for offset, char := range value {
		units++
		if char > 0xffff {
			units++
		}
		if units > maxUnits {
			scrub.shortened = true
			return strings.TrimSpace(value[:offset])
		}
	}
	return value
}

func (scrub *openMausText) oneLine(value string, maxUnits int) string {
	return scrub.text(openMausLine(value), maxUnits)
}

func (scrub *openMausText) bytes(value string, maxBytes int) string {
	value = scrub.clean(value)
	if len(value) <= maxBytes {
		return value
	}
	scrub.shortened = true
	for !utf8.RuneStart(value[maxBytes]) {
		maxBytes--
	}
	return strings.TrimSpace(value[:maxBytes])
}

func openMausExportColor(color string) string {
	switch color {
	case "green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral", "silver", "chrome":
		return color
	default:
		return "green"
	}
}

// ExportOpenMausTeam produces the same portable file envelope read by
// OpenMausBot. Starter notes travel only when the person includes them.
func (s *Service) ExportOpenMausTeam(groupID string, includeMemory bool) (model.OpenMausExport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	group := s.findGroupLocked(groupID)
	if group == nil {
		return model.OpenMausExport{}, fmt.Errorf("channel not found")
	}
	if len(group.MemberIDs) == 0 || len(group.MemberIDs) > 200 {
		return model.OpenMausExport{}, fmt.Errorf("an OpenMaus team must have 1–200 bots")
	}

	scrub := s.openMausTextLocked()
	pkg := openMausTeam{Name: scrub.oneLine(group.Name, 100)}
	if pkg.Name == "" {
		pkg.Name = "Grox team"
	}
	pkg.Team.Name = scrub.oneLine(group.Name, 60)
	if pkg.Team.Name == "" {
		pkg.Team.Name = "Grox team"
	}
	packageID := strings.TrimRight(skillSlug(pkg.Name), "-")
	if len(packageID) > 80 {
		packageID = strings.TrimRight(packageID[:80], "-")
	}
	if packageID == "" {
		packageID = "grox-team"
	}
	agentKeys := map[string]string{}
	skillNames := map[string]bool{}
	skillByContent := map[openMausSkill]string{}
	result := model.OpenMausExport{Filename: packageID + ".openmaus.json"}

	for _, botID := range group.MemberIDs {
		bot := s.findBotLocked(botID)
		if bot == nil || agentKeys[botID] != "" {
			continue
		}
		key := fmt.Sprintf("agent-%d", len(pkg.Agents)+1)
		agentKeys[botID] = key
		item := openMausAgent{
			Key: key, Name: scrub.oneLine(bot.Name, 100), Title: scrub.oneLine(bot.Title, 200),
			Description: scrub.text(bot.Description, 4_000), Soul: scrub.bytes(bot.Soul, 24_000),
		}
		if item.Name == "" {
			item.Name = "Grox bot " + key
		}
		item.Appearance.Color = openMausExportColor(bot.Color)

		for _, skill := range s.scanSkillsLocked(bot) {
			if !skill.Enabled {
				continue
			}
			body, err := readPortableFile(skill.Path, 256<<10)
			if err != nil {
				return model.OpenMausExport{}, fmt.Errorf("read skill %q: %w", skill.Name, err)
			}
			source := openMausSkill{
				Name: skillSlug(scrub.clean(skill.Name)), Description: scrub.oneLine(skill.Description, 1_024),
				Instructions: scrub.clean(portableSkillBody(body)),
			}
			if source.Description == "" {
				source.Description = "Skill from Grox"
			}
			source.Instructions = scrub.bytes(source.Instructions, (256<<10)-len(portableSkillFile(strings.Repeat("x", 64), source.Description, "")))
			name, alreadyDefined := skillByContent[source]
			if !alreadyDefined {
				name = portableSkillName(source.Name, skillNames)
				skillNames[name] = true
				skillByContent[source] = name
				pkg.Skills.Entries = append(pkg.Skills.Entries, openMausSkill{
					Name: name, Description: source.Description, Instructions: portableSkillFile(name, source.Description, source.Instructions),
				})
			}
			if !slices.Contains(item.Skills, name) {
				item.Skills = append(item.Skills, name)
			}
		}

		playbooks, err := s.listPlaybooksLocked(bot.ID)
		if err != nil {
			return model.OpenMausExport{}, fmt.Errorf("read playbooks for %q: %w", item.Name, err)
		}
		for _, playbook := range playbooks {
			entry := openMausPlaybook{
				Key: fmt.Sprintf("playbook-%d", len(pkg.Playbooks)+1), Name: scrub.oneLine(playbook.Name, 100),
				Instructions: scrub.text(playbook.Instructions, 24_000),
			}
			if entry.Name == "" || entry.Instructions == "" {
				continue
			}
			entry.Summary = scrub.oneLine(entry.Instructions, 300)
			for _, trigger := range playbook.Triggers {
				if value := scrub.oneLine(trigger, 100); value != "" && !slices.Contains(entry.Triggers, value) {
					entry.Triggers = append(entry.Triggers, value)
				}
			}
			if len(entry.Triggers) > 30 {
				entry.Triggers = entry.Triggers[:30]
				scrub.shortened = true
			}
			if len(entry.Triggers) == 0 {
				continue
			}
			item.Playbooks = append(item.Playbooks, entry.Key)
			pkg.Playbooks = append(pkg.Playbooks, entry)
		}

		if includeMemory {
			item.Seed.Memory, err = s.portableMemoryLocked(bot.ID, &scrub)
			if err != nil {
				return model.OpenMausExport{}, fmt.Errorf("read starter notes for %q: %w", item.Name, err)
			}
		}
		if len(item.Skills) > 30 || len(item.Playbooks) > 40 {
			return model.OpenMausExport{}, fmt.Errorf("bot %q exceeds OpenMaus's skills or playbooks limit", item.Name)
		}
		pkg.Agents = append(pkg.Agents, item)
	}

	if len(pkg.Agents) == 0 || len(pkg.Skills.Entries) > 120 || len(pkg.Playbooks) > 80 {
		return model.OpenMausExport{}, fmt.Errorf("the channel has no bots or exceeds OpenMaus's skill or playbook limits")
	}
	room := openMausRoom{
		Key: "room", Name: pkg.Name, Bulletin: scrub.text(group.Instructions, 12_000),
	}
	for _, bot := range pkg.Agents {
		room.Members = append(room.Members, bot.Key)
	}
	pkg.Team.Leader = agentKeys[group.LeadID]
	if pkg.Team.Leader == "" {
		pkg.Team.Leader = room.Members[0]
	}
	room.DefaultResponder.Kind = "agent"
	room.DefaultResponder.Agent = pkg.Team.Leader
	pkg.Rooms = []openMausRoom{room}

	for _, routine := range s.st.State.Routines {
		if routine.GroupID != "" && routine.GroupID != group.ID {
			continue
		}
		roomKey := ""
		if routine.GroupID == group.ID {
			roomKey = room.Key
		}
		if key := agentKeys[routine.BotID]; key != "" {
			if entry, ok := exportOpenMausRoutine(routine, key, roomKey, len(pkg.Routines)+1, &scrub); ok {
				pkg.Routines = append(pkg.Routines, entry)
			} else {
				result.Warnings = append(result.Warnings, fmt.Sprintf("Routine %q was skipped because its schedule or checks cannot be shared.", scrub.oneLine(routine.Name, 80)))
			}
		}
	}
	if len(pkg.Routines) > 50 {
		return model.OpenMausExport{}, fmt.Errorf("OpenMaus accepts at most 50 routines per team")
	}
	if err := s.exportOpenMausConnections(&pkg, agentKeys, &scrub, &result); err != nil {
		return model.OpenMausExport{}, err
	}

	// OpenMaus requires publishing metadata even for a local team file.
	summary := scrub.text(group.Description, 2_000)
	if summary == "" {
		summary = "Team exported from Grox."
	}
	definition := map[string]any{
		"id": packageID, "release": "1.0.0", "name": pkg.Name, "tagline": scrub.oneLine(summary, 160), "summary": summary,
		"category": "Personal agents", "author": map[string]string{"name": "Grox user"}, "license": "Unspecified",
		"outcomes": []string{"Recreate the team in OpenMausBot."}, "setupMinutes": len(pkg.Agents),
		"requirements": map[string]any{"apps": []string{}, "capabilities": []string{}},
		"team":         pkg.Team, "agents": pkg.Agents, "rooms": pkg.Rooms,
	}
	version := 2
	if len(pkg.Skills.Entries) > 0 {
		pkg.Skills.Version = 1
		definition["skills"] = pkg.Skills
		if len(pkg.Skills.Entries) > 60 {
			version = 3
		}
	}
	if len(pkg.Playbooks) > 0 {
		definition["playbooks"] = pkg.Playbooks
	}
	if len(pkg.Routines) > 0 {
		definition["routines"] = pkg.Routines
	}
	if len(pkg.Connections) > 0 {
		definition["connections"] = pkg.Connections
	}
	raw, err := json.Marshal(map[string]any{"format": "openmaus.package", "version": version, "package": definition})
	if err != nil {
		return model.OpenMausExport{}, err
	}
	if len(raw) > 4<<20 {
		return model.OpenMausExport{}, fmt.Errorf("the team is larger than OpenMaus's 4 MB limit")
	}
	result.Document = string(raw)
	if scrub.redacted {
		result.Warnings = append(result.Warnings, "Credential-shaped text was redacted.")
	}
	if scrub.shortened {
		result.Warnings = append(result.Warnings, "Long text was shortened to fit OpenMaus field limits.")
	}
	return result, nil
}

func portableSkillName(proposed string, taken map[string]bool) string {
	if proposed == "" {
		proposed = "grox-skill"
	}
	for suffix := 1; ; suffix++ {
		ending := ""
		if suffix > 1 {
			ending = fmt.Sprintf("-%d", suffix)
		}
		name := strings.TrimRight(proposed[:min(len(proposed), 64-len(ending))], "-") + ending
		if !taken[name] {
			return name
		}
	}
}

func portableSkillBody(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if strings.HasPrefix(text, "---\n") {
		if end := strings.Index(text[4:], "\n---\n"); end >= 0 {
			return text[4+end+5:]
		}
	}
	return text
}

func portableSkillFile(name, description, body string) string {
	escaped := strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(description)
	return "---\nname: " + name + "\ndescription: \"" + escaped + "\"\n---\n\n" + body + "\n"
}

func readPortableFile(path string, limit int64) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return "", fmt.Errorf("expected a regular file of at most %d KB", limit>>10)
	}
	data, err := os.ReadFile(path)
	return string(data), err
}

func (s *Service) portableMemoryLocked(botID string, scrub *openMausText) (map[string]string, error) {
	dir, err := s.memoryDirLocked(botID)
	if err != nil {
		return nil, err
	}
	var paths []string
	paths = append(paths, "MEMORY.md")
	topics, err := os.ReadDir(filepath.Join(dir, "topics"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, topic := range topics {
		if topic.Type().IsRegular() && openMausTopic.MatchString(topic.Name()) {
			paths = append(paths, "memory/"+topic.Name())
		}
	}
	memory := map[string]string{}
	total := 0
	for _, path := range paths {
		localPath, err := openMausMemoryPath(path)
		if err != nil {
			return nil, err
		}
		text, err := readPortableFile(filepath.Join(dir, localPath), memoryMaxBytes)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		text = scrub.bytes(text, 256<<10)
		if text == "" {
			continue
		}
		total += len(text)
		if len(memory) == 100 || total > 1<<20 {
			return nil, fmt.Errorf("OpenMaus accepts at most 100 starter notes and 1 MB per bot")
		}
		memory[path] = text
	}
	if len(memory) == 0 {
		return nil, nil
	}
	return memory, nil
}

func exportOpenMausRoutine(routine model.Routine, agentKey, roomKey string, number int, scrub *openMausText) (openMausRoutine, bool) {
	entry := openMausRoutine{
		Key: fmt.Sprintf("routine-%d", number), Name: scrub.text(routine.Name, 80),
		Agent: agentKey, Room: roomKey, Prompt: scrub.text(routine.Prompt, 20_000), RunOn: "maus",
		Continuity: routine.Continuity, Overlap: normalizeRoutineOverlap(routine.Overlap), DurationMinutes: 30,
	}
	if len(routine.Checks) != 0 || entry.Name == "" || entry.Prompt == "" {
		return openMausRoutine{}, false
	}
	if routine.Cadence == "cron" || routine.Cadence == "hourly" {
		entry.Schedule.Type = "cron"
		entry.Schedule.Expression = routine.CronExpression
		if routine.Cadence == "hourly" {
			entry.Schedule.Expression = "0 * * * *"
		}
		entry.Schedule.TimeZone = portableTimeZone(routine.TimeZone)
		if entry.Schedule.TimeZone == "" || entry.Schedule.Expression == "" {
			return openMausRoutine{}, false
		}
		return entry, true
	}
	entry.Schedule.Type = "daily"
	entry.Schedule.Time = schedule.Clock(routine.TimeOfDay)
	switch routine.Cadence {
	case "daily":
		entry.Schedule.Weekdays = []int{0, 1, 2, 3, 4, 5, 6}
	case "weekdays":
		entry.Schedule.Weekdays = []int{1, 2, 3, 4, 5}
	case "weekly":
		weekday := routine.Weekday
		if weekday < 1 || weekday > 7 {
			weekday = 1
		}
		entry.Schedule.Weekdays = []int{weekday % 7}
	default:
		return openMausRoutine{}, false
	}
	return entry, true
}

func portableTimeZone(name string) string {
	if name == "" || name == "Local" {
		if env, set := os.LookupEnv("TZ"); set {
			name = strings.TrimPrefix(env, ":")
			if name == "" {
				name = "UTC"
			}
		} else if target, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
			_, name, _ = strings.Cut(target, "/zoneinfo/")
		}
	}
	if _, zone, ok := strings.Cut(name, "/zoneinfo/"); ok {
		name = zone
	}
	if name == "" || name == "Local" {
		return ""
	}
	if _, err := time.LoadLocation(name); err != nil {
		return ""
	}
	return name
}
