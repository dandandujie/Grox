package service

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/schedule"
)

// OpenMaus wire types stay at the portable package boundary.
type openMausTeamDocument struct {
	Version   int             `json:"version"`
	Package   openMausTeam    `json:"package"`
	Signature json.RawMessage `json:"signature"`
}

type openMausTeam struct {
	Name         string `json:"name"`
	ChiefOfStaff string `json:"chiefOfStaff"`
	Team         struct {
		Name   string `json:"name"`
		Brief  string `json:"brief,omitempty"`
		Leader string `json:"leader,omitempty"`
	} `json:"team"`
	Agents   []openMausAgent   `json:"agents"`
	Rooms    []openMausRoom    `json:"rooms"`
	Routines []openMausRoutine `json:"routines"`
	Skills   struct {
		Version int             `json:"version"`
		Entries []openMausSkill `json:"entries"`
	} `json:"skills"`
	Playbooks    []openMausPlaybook   `json:"playbooks"`
	Connections  []openMausConnection `json:"connections"`
	Presets      []json.RawMessage    `json:"presets"`
	Requirements struct {
		Apps         []json.RawMessage `json:"apps"`
		Capabilities []string          `json:"capabilities"`
		Platforms    []string          `json:"platforms"`
	} `json:"requirements"`
}

type openMausAgent struct {
	grokImportKey string
	Key           string   `json:"key"`
	Name          string   `json:"name"`
	Title         string   `json:"title"`
	Description   string   `json:"description"`
	Soul          string   `json:"soul"`
	Skills        []string `json:"skills,omitempty"`
	Playbooks     []string `json:"playbooks,omitempty"`
	Connections   []string `json:"connections,omitempty"`
	Appearance    struct {
		Color  string          `json:"color"`
		Avatar json.RawMessage `json:"avatar,omitempty"`
	} `json:"appearance"`
	Seed struct {
		Memory map[string]string `json:"memory"`
	} `json:"seed,omitzero"`
}

type openMausRoom struct {
	Key              string   `json:"key"`
	Name             string   `json:"name"`
	Members          []string `json:"members"`
	Bulletin         string   `json:"bulletin,omitempty"`
	DefaultResponder struct {
		Kind  string `json:"kind"`
		Agent string `json:"agent,omitempty"`
	} `json:"defaultResponder"`
}

type openMausRoutine struct {
	Key                 string `json:"key"`
	Name                string `json:"name"`
	Agent               string `json:"agent"`
	Room                string `json:"room,omitempty"`
	Prompt              string `json:"prompt"`
	RunOn               string `json:"runOn"`
	Overlap             string `json:"overlap,omitempty"`
	Continuity          bool   `json:"continuity,omitempty"`
	TimeoutMinutes      int    `json:"timeoutMinutes,omitempty"`
	RunOnStartup        bool   `json:"runOnStartup,omitempty"`
	DurationMinutes     int    `json:"durationMinutes"`
	EnabledAfterInstall bool   `json:"enabledAfterInstall"`
	Schedule            struct {
		Type       string `json:"type"`
		Time       string `json:"time,omitempty"`
		Weekdays   []int  `json:"weekdays,omitempty"`
		Expression string `json:"expression,omitempty"`
		TimeZone   string `json:"timeZone,omitempty"`
	} `json:"schedule"`
}

type openMausSkill struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions"`
}

type openMausPlaybook struct {
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Summary      string   `json:"summary"`
	Triggers     []string `json:"triggers"`
	Instructions string   `json:"instructions"`
}

type openMausConnection struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Reason string `json:"reason"`
	MCP    struct {
		Transport  string   `json:"transport"`
		URL        string   `json:"url"`
		ValueNames []string `json:"valueNames"`
	} `json:"mcp"`
}

var (
	openMausKey   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	openMausTopic = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,199}\.md$`)
)

func openMausIndex[T any](items []T, kind string, keyOf func(T) string) (map[string]T, error) {
	index := make(map[string]T, len(items))
	for _, item := range items {
		key := keyOf(item)
		if !openMausKey.MatchString(key) {
			return nil, fmt.Errorf("invalid %s key %q", kind, key)
		}
		if _, exists := index[key]; exists {
			return nil, fmt.Errorf("duplicate %s key %q", kind, key)
		}
		index[key] = item
	}
	return index, nil
}

func validateOpenMausRefs[T any](keys []string, index map[string]T, kind string) error {
	seen := make(map[string]bool, len(keys))
	for _, key := range keys {
		if _, exists := index[key]; !exists {
			return fmt.Errorf("unknown %s %q", kind, key)
		}
		if seen[key] {
			return fmt.Errorf("duplicate %s reference %q", kind, key)
		}
		seen[key] = true
	}
	return nil
}

func openMausLine(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func openMausMemoryPath(path string) (string, error) {
	if path == "MEMORY.md" {
		return path, nil
	}
	topic, ok := strings.CutPrefix(path, "memory/")
	if ok && openMausTopic.MatchString(topic) {
		return filepath.Join("topics", topic), nil
	}
	return "", fmt.Errorf("unsupported starter note path %q", path)
}

func openMausSkillContent(skill openMausSkill) string {
	body := strings.ReplaceAll(skill.Instructions, "\r\n", "\n")
	if strings.HasPrefix(body, "---\n") {
		if end := strings.Index(body[4:], "\n---\n"); end >= 0 {
			body = body[4+end+5:]
		}
	}
	return "---\nname: " + skill.Name + "\ndescription: " + openMausLine(skill.Description) + "\n---\n\n" + strings.TrimSpace(body) + "\n"
}

func openMausPlaybookContent(playbook openMausPlaybook) string {
	triggers := normalizePlaybookTriggers(playbook.Triggers)
	for i, trigger := range triggers {
		triggers[i] = openMausLine(trigger)
	}
	return "---\nname: " + openMausLine(playbook.Name) + "\ntriggers: " + strings.Join(triggers, ", ") + "\n---\n\n" + strings.TrimSpace(playbook.Instructions) + "\n"
}

// These files are private to fresh bot IDs. Install them before state.json
// references the bots, and remove all claimed directories if any write fails.
type openMausImportFiles struct {
	owned []string
	bytes int
}

func (files *openMausImportFiles) claim(root string) error {
	if err := os.MkdirAll(filepath.Dir(root), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(root, 0o700); err != nil {
		return err
	}
	files.owned = append(files.owned, root)
	return nil
}

func (files *openMausImportFiles) write(path, content string) error {
	files.bytes += len(content)
	if files.bytes > 32<<20 {
		return fmt.Errorf("expanded team files exceed 32 MB")
	}
	return writeMemoryAtomic(path, []byte(content))
}

func (s *Service) importOpenMausTeam(raw string) (model.TeamImportResult, error) {
	var doc openMausTeamDocument
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return model.TeamImportResult{}, fmt.Errorf("invalid OpenMaus team: %w", err)
	}
	return s.installOpenMausTeam(doc, nil)
}

func (s *Service) installOpenMausTeam(doc openMausTeamDocument, warnings []string) (model.TeamImportResult, error) {
	if doc.Version < 1 || doc.Version > 3 {
		return model.TeamImportResult{}, fmt.Errorf("this OpenMaus package version is unsupported (expected v1, v2 or v3)")
	}
	pkg := doc.Package
	if doc.Version == 1 && pkg.Team.Leader == "" {
		pkg.Team.Leader = pkg.ChiefOfStaff
	}
	name := strings.TrimSpace(pkg.Name)
	if name == "" || len(pkg.Agents) == 0 {
		return model.TeamImportResult{}, fmt.Errorf("the OpenMaus package must contain a named team with bots")
	}
	skillLimit := 60
	if doc.Version == 1 {
		skillLimit = 20
	} else if doc.Version == 3 {
		skillLimit = 120
	}
	if len(pkg.Agents) > 200 || len(pkg.Rooms) > 30 || len(pkg.Routines) > 50 || len(pkg.Skills.Entries) > skillLimit || len(pkg.Playbooks) > 80 {
		return model.TeamImportResult{}, fmt.Errorf("the OpenMaus team exceeds the supported number of items")
	}
	if len(pkg.Skills.Entries) > 0 && pkg.Skills.Version != 1 {
		return model.TeamImportResult{}, fmt.Errorf("unsupported OpenMaus skill bundle version")
	}
	skills, err := openMausIndex(pkg.Skills.Entries, "skill", func(skill openMausSkill) string { return skill.Name })
	if err != nil {
		return model.TeamImportResult{}, err
	}
	playbooks, err := openMausIndex(pkg.Playbooks, "playbook", func(playbook openMausPlaybook) string { return playbook.Key })
	if err != nil {
		return model.TeamImportResult{}, err
	}
	if err := pkg.validate(skills, playbooks); err != nil {
		return model.TeamImportResult{}, err
	}
	result := model.TeamImportResult{Name: name, Warnings: warnings}
	if len(pkg.Requirements.Apps)+len(pkg.Requirements.Capabilities)+len(pkg.Requirements.Platforms) > 0 {
		result.Warnings = append(result.Warnings, "Package requirements need manual setup.")
	}
	if len(pkg.Presets) != 0 {
		result.Warnings = append(result.Warnings, "New bot presets were skipped.")
	}
	if len(doc.Signature) > 0 {
		result.Warnings = append(result.Warnings, "The source package signature was not verified.")
	}
	for _, bot := range pkg.Agents {
		if len(bot.Appearance.Avatar) > 0 {
			result.Warnings = append(result.Warnings, "Imported bots use Grox portraits.")
			break
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	before := s.st.State
	files := openMausImportFiles{}
	committed := false
	defer func() {
		if !committed {
			s.st.State = before
			for _, dir := range files.owned {
				_ = os.RemoveAll(dir)
			}
		}
	}()

	now := time.Now()
	department := openMausLine(pkg.Team.Name)
	if department == "" {
		department = openMausLine(name)
	}
	s.ensureDepartmentLocked(department, now)
	botIDs := make(map[string]string, len(pkg.Agents))
	groupIDs := make(map[string]string, len(pkg.Rooms))
	modelID := catalogDefault(s.availabilityLocked(s.engines))
	startBot, startThread, startGroup := "", "", ""
	for _, item := range pkg.Agents {
		if item.grokImportKey != "" && slices.ContainsFunc(s.st.State.Bots, func(bot model.Bot) bool {
			return bot.GrokImportKey == item.grokImportKey
		}) {
			result.Warnings = append(result.Warnings, fmt.Sprintf("%q was already moved from Grok Bot.", item.Name))
			continue
		}
		botID := newID("bot")
		botIDs[item.Key] = botID
		thread := model.Thread{ID: newID("thread"), BotID: botID, Kind: "chat", Title: "New conversation", CreatedAt: now, UpdatedAt: now}
		bot := model.Bot{
			ID: botID, Name: s.uniqueBotNameLocked(item.Name), Department: department, Title: item.Title,
			Description: item.Description, Soul: item.Soul, Color: item.Appearance.Color, ModelID: modelID,
			MascotShape: "cursor", Expression: "idle", Approval: model.ApprovalAsk, Notifications: true,
			GrokImportKey: item.grokImportKey,
			CreatedAt:     now, UpdatedAt: now, LastActiveAt: now, Threads: []model.Thread{thread},
		}
		if !allowedColors[bot.Color] {
			bot.Color = "green"
		}
		if brief := strings.TrimSpace(pkg.Team.Brief); brief != "" {
			if strings.TrimSpace(bot.Soul) == "" {
				bot.Soul = "You are " + bot.Name + ", a helpful assistant."
			}
			bot.Soul += "\n\n## Team instructions\n\n" + brief
		}
		if err := s.installOpenMausFiles(&bot, item, skills, playbooks, &files, &result); err != nil {
			return model.TeamImportResult{}, fmt.Errorf("install files for %s: %w", bot.Name, err)
		}
		s.st.State.Bots = append(s.st.State.Bots, bot)
		result.Bots++
		if startBot == "" || item.Key == pkg.Team.Leader {
			startBot, startThread = botID, thread.ID
		}
	}
	if result.Bots == 0 {
		return result, nil
	}

	for _, room := range pkg.Rooms {
		members := make([]string, 0, len(room.Members))
		for _, key := range room.Members {
			members = append(members, botIDs[key])
		}
		lead := members[0]
		if room.DefaultResponder.Agent != "" {
			lead = botIDs[room.DefaultResponder.Agent]
		}
		if room.DefaultResponder.Kind != "agent" && room.DefaultResponder.Kind != "" {
			result.Warnings = append(result.Warnings, fmt.Sprintf("Channel %q uses its lead and @mentions in Grox.", room.Name))
		}
		group := model.Group{
			ID: newID("group"), Name: s.uniqueGroupNameLocked(room.Name), Instructions: room.Bulletin,
			Color: "purple", MemberIDs: members, LeadID: lead, CreatedAt: now, UpdatedAt: now,
			Threads: []model.Thread{{ID: newID("thread"), Kind: "group", Title: "New conversation", CreatedAt: now, UpdatedAt: now}},
		}
		s.st.State.Groups = append(s.st.State.Groups, group)
		groupIDs[room.Key] = group.ID
		result.Groups++
		if startGroup == "" {
			startBot, startThread, startGroup = "", group.Threads[0].ID, group.ID
		}
	}

	for _, item := range pkg.Routines {
		if botIDs[item.Agent] == "" {
			continue
		}
		routine, reason := item.localRoutine(botIDs[item.Agent], groupIDs[item.Room], now)
		if reason != "" {
			result.Warnings = append(result.Warnings, fmt.Sprintf("Routine %q was skipped (%s).", item.Name, reason))
			continue
		}
		if item.TimeoutMinutes != 0 || item.RunOnStartup {
			result.Warnings = append(result.Warnings, fmt.Sprintf("Routine %q uses Grox's default time limit and only its imported schedule.", item.Name))
		}
		s.st.State.Routines = append(s.st.State.Routines, routine)
		result.Routines++
	}
	s.installOpenMausConnections(pkg, botIDs, now, &result)
	s.st.State.ActiveBotID = startBot
	s.st.State.ActiveThreadID = startThread
	s.st.State.ActiveGroupID = startGroup
	s.touchLocked()
	if err := s.st.SaveState(); err != nil {
		return model.TeamImportResult{}, fmt.Errorf("save imported team: %w", err)
	}
	committed = true
	s.emitStateLocked()
	return result, nil
}

func (pkg openMausTeam) validate(skills map[string]openMausSkill, playbooks map[string]openMausPlaybook) error {
	agents, err := openMausIndex(pkg.Agents, "bot", func(agent openMausAgent) string { return agent.Key })
	if err != nil {
		return err
	}
	rooms, err := openMausIndex(pkg.Rooms, "channel", func(room openMausRoom) string { return room.Key })
	if err != nil {
		return err
	}
	if _, err := openMausIndex(pkg.Routines, "routine", func(routine openMausRoutine) string { return routine.Key }); err != nil {
		return err
	}
	connections, err := openMausIndex(pkg.Connections, "connection", func(connection openMausConnection) string { return connection.Key })
	if err != nil {
		return err
	}
	if pkg.Team.Leader != "" {
		if _, exists := agents[pkg.Team.Leader]; !exists {
			return fmt.Errorf("unknown team leader %q", pkg.Team.Leader)
		}
	}
	for _, skill := range pkg.Skills.Entries {
		if skillSlug(skill.Name) != skill.Name || strings.TrimSpace(skill.Instructions) == "" ||
			len(openMausSkillContent(skill)) > 256<<10 {
			return fmt.Errorf("skill %q has an invalid name or missing or oversized instructions", skill.Name)
		}
	}
	for _, playbook := range pkg.Playbooks {
		if openMausLine(playbook.Name) == "" || len(normalizePlaybookTriggers(playbook.Triggers)) == 0 ||
			strings.TrimSpace(playbook.Instructions) == "" || len(openMausPlaybookContent(playbook)) > playbookMaxBytes {
			return fmt.Errorf("playbook %q has missing or oversized content", playbook.Key)
		}
	}
	for _, agent := range pkg.Agents {
		if openMausLine(agent.Name) == "" || len(agent.Skills) > 30 {
			return fmt.Errorf("bot %q has a missing name or too many skills", agent.Key)
		}
		if err := validateOpenMausRefs(agent.Skills, skills, "skill"); err != nil {
			return fmt.Errorf("bot %q: %w", agent.Name, err)
		}
		if err := validateOpenMausRefs(agent.Playbooks, playbooks, "playbook"); err != nil {
			return fmt.Errorf("bot %q: %w", agent.Name, err)
		}
		if err := validateOpenMausRefs(agent.Connections, connections, "connection"); err != nil {
			return fmt.Errorf("bot %q: %w", agent.Name, err)
		}
		paths := make(map[string]bool, len(agent.Seed.Memory))
		for key, content := range agent.Seed.Memory {
			path, err := openMausMemoryPath(key)
			if err != nil {
				return fmt.Errorf("bot %q: %w", agent.Name, err)
			}
			key = strings.ToLower(path)
			if paths[key] || len(content) > memoryMaxBytes {
				return fmt.Errorf("bot %q has a duplicate or oversized starter note", agent.Name)
			}
			paths[key] = true
		}
	}
	for _, room := range pkg.Rooms {
		if openMausLine(room.Name) == "" || len(room.Members) == 0 {
			return fmt.Errorf("channel %q needs a name and at least one bot", room.Key)
		}
		if err := validateOpenMausRefs(room.Members, agents, "member"); err != nil {
			return fmt.Errorf("channel %q: %w", room.Name, err)
		}
		if (room.DefaultResponder.Kind == "agent" || room.DefaultResponder.Agent != "") &&
			!slices.Contains(room.Members, room.DefaultResponder.Agent) {
			return fmt.Errorf("channel %q names a responder outside the channel", room.Name)
		}
	}
	for _, routine := range pkg.Routines {
		if openMausLine(routine.Name) == "" || strings.TrimSpace(routine.Prompt) == "" {
			return fmt.Errorf("routine %q has a missing name or prompt", routine.Key)
		}
		if _, exists := agents[routine.Agent]; !exists {
			return fmt.Errorf("routine %q names an unknown bot", routine.Name)
		}
		if routine.Room != "" {
			room, exists := rooms[routine.Room]
			if !exists || !slices.Contains(room.Members, routine.Agent) {
				return fmt.Errorf("routine %q names an unknown channel or a bot outside it", routine.Name)
			}
		}
	}
	return nil
}

func (s *Service) installOpenMausFiles(bot *model.Bot, item openMausAgent, skills map[string]openMausSkill, playbooks map[string]openMausPlaybook, files *openMausImportFiles, result *model.TeamImportResult) error {
	if len(item.Skills) > 0 {
		bot.WorkingDir = filepath.Join(s.dir, "workspaces", bot.ID)
		if err := files.claim(bot.WorkingDir); err != nil {
			return err
		}
		for _, key := range item.Skills {
			path := filepath.Join(bot.WorkingDir, ".grox", "skills", key, "SKILL.md")
			if err := files.write(path, openMausSkillContent(skills[key])); err != nil {
				return err
			}
			result.Skills++
		}
	}
	if len(item.Playbooks) > 0 {
		dir := s.playbookDirLocked(bot.ID)
		if err := files.claim(dir); err != nil {
			return err
		}
		for _, key := range item.Playbooks {
			if err := files.write(filepath.Join(dir, key+".md"), openMausPlaybookContent(playbooks[key])); err != nil {
				return err
			}
			result.Playbooks++
		}
	}
	if len(item.Seed.Memory) > 0 {
		dir, err := s.memoryDirLocked(bot.ID)
		if err != nil {
			return err
		}
		if err := files.claim(dir); err != nil {
			return err
		}
		for key, content := range item.Seed.Memory {
			path, err := openMausMemoryPath(key)
			if err != nil {
				return err
			}
			if err := files.write(filepath.Join(dir, path), content); err != nil {
				return err
			}
			result.Memories++
		}
	}
	return nil
}

func (item openMausRoutine) localRoutine(botID, groupID string, now time.Time) (model.Routine, string) {
	if item.RunOn != "maus" {
		return model.Routine{}, "requires an OpenMaus computer"
	}
	if groupID != "" && item.Continuity {
		return model.Routine{}, "channel routines cannot use continuity"
	}
	routine := model.Routine{
		ID: newID("routine"), BotID: botID, GroupID: groupID, Name: item.Name, Prompt: item.Prompt,
		Continuity: item.Continuity, Overlap: normalizeRoutineOverlap(item.Overlap), CreatedAt: now, UpdatedAt: now,
	}
	switch item.Schedule.Type {
	case "cron":
		routine.Cadence = "cron"
		routine.CronExpression = item.Schedule.Expression
		routine.TimeZone = item.Schedule.TimeZone
	case "daily":
		clock := item.Schedule.Time
		if len(clock) != 5 || schedule.Clock(clock) != clock {
			return model.Routine{}, "invalid time"
		}
		routine.TimeOfDay = clock
		days := slices.Clone(item.Schedule.Weekdays)
		slices.Sort(days)
		switch {
		case slices.Equal(days, []int{0, 1, 2, 3, 4, 5, 6}):
			routine.Cadence = "daily"
		case slices.Equal(days, []int{1, 2, 3, 4, 5}):
			routine.Cadence = "weekdays"
		case len(days) == 1 && days[0] >= 0 && days[0] <= 6:
			routine.Cadence, routine.Weekday = "weekly", days[0]
			if routine.Weekday == 0 {
				routine.Weekday = 7
			}
		default:
			if len(days) == 0 || days[0] < 0 || days[len(days)-1] > 6 {
				return model.Routine{}, "invalid weekdays"
			}
			routine.Cadence = "cron"
			days := slices.Compact(days)
			parts := make([]string, 0, len(days))
			for _, day := range days {
				parts = append(parts, strconv.Itoa(day))
			}
			hour, minute, _ := strings.Cut(clock, ":")
			routine.CronExpression = minute + " " + hour + " * * " + strings.Join(parts, ",")
		}
	default:
		return model.Routine{}, "schedule is unavailable"
	}
	if err := schedule.Validate(routine, now); err != nil {
		return model.Routine{}, err.Error()
	}
	routine.NextRun = schedule.Next(routine, now)
	return routine, ""
}
