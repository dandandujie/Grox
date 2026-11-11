package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/dandandujie/grox/internal/model"
)

func yamlMap(value any) map[string]any {
	record, _ := value.(map[string]any)
	return record
}

func yamlList(value any) []any {
	list, _ := value.([]any)
	return list
}

func yamlString(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return strings.TrimSpace(value)
}

func yamlKeys(record map[string]any, key string) []string {
	out := []string{}
	for _, item := range yamlList(record[key]) {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			out = append(out, strings.TrimSpace(value))
		}
	}
	return out
}

// ImportBotMRR imports the structured BotMRR Markdown frontmatter. It creates
// new bots, rooms, paused routines, playbooks and per-bot skill folders.
func (s *Service) ImportBotMRR(raw string) (model.BotMRRImportResult, error) {
	if len(raw) > 4*1024*1024 {
		return model.BotMRRImportResult{}, fmt.Errorf("team Markdown is too large")
	}
	text := strings.ReplaceAll(raw, "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return model.BotMRRImportResult{}, fmt.Errorf("this Markdown has no BotMRR frontmatter")
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return model.BotMRRImportResult{}, fmt.Errorf("this Markdown has no closing frontmatter fence")
	}
	front := text[4 : 4+end]
	var document map[string]any
	if err := yaml.Unmarshal([]byte(front), &document); err != nil {
		return model.BotMRRImportResult{}, fmt.Errorf("invalid BotMRR frontmatter")
	}
	if asInt, _ := document["botmrr"].(int); asInt != 1 {
		return model.BotMRRImportResult{}, fmt.Errorf("unsupported BotMRR version")
	}
	if containsCredentialKey(document) {
		return model.BotMRRImportResult{}, fmt.Errorf("refusing team Markdown with credential-looking keys")
	}
	agents := yamlList(document["agents"])
	if len(agents) == 0 {
		return model.BotMRRImportResult{}, fmt.Errorf("the team has no agents")
	}
	result := model.BotMRRImportResult{}
	botsByKey := map[string]*model.Bot{}
	playbooksByKey := map[string]map[string]any{}
	for _, rawPlaybook := range yamlList(document["playbooks"]) {
		playbook := yamlMap(rawPlaybook)
		if key := yamlString(playbook, "key"); key != "" {
			playbooksByKey[key] = playbook
		}
	}
	skillsByKey := map[string]map[string]any{}
	if skills := yamlMap(document["skills"]); skills != nil {
		for _, rawSkill := range yamlList(skills["entries"]) {
			skill := yamlMap(rawSkill)
			if name := yamlString(skill, "name"); name != "" {
				skillsByKey[name] = skill
			}
		}
	}
	for index, rawAgent := range agents {
		agent := yamlMap(rawAgent)
		key := yamlString(agent, "key")
		name := yamlString(agent, "name")
		if name == "" {
			name = fmt.Sprintf("Imported agent %d", index+1)
		}
		color := "green"
		if appearance := yamlMap(agent["appearance"]); appearance != nil {
			if value := yamlString(appearance, "color"); value != "" {
				color = value
			}
		}
		bot, err := s.CreateBot(model.CreateBotInput{
			Name: name, Title: yamlString(agent, "title"), Description: yamlString(agent, "description"),
			Soul: yamlString(agent, "soul"), Color: color, Department: "Imported", ModelID: "grox-demo",
		})
		if err != nil {
			return result, err
		}
		botsByKey[key] = &bot
		result.Bots++
		result.Names = append(result.Names, bot.Name)
		// Skills are isolated in this bot's workspace so one imported team cannot
		// leak its skills into every other bot.
		assignedSkills := yamlKeys(agent, "skills")
		if len(assignedSkills) > 0 {
			workspace := filepath.Join(s.dir, "workspaces", skillSlug(key)+"-team")
			if err := os.MkdirAll(workspace, 0o700); err == nil {
				for _, skillKey := range assignedSkills {
					skill := skillsByKey[skillKey]
					if skill == nil {
						continue
					}
					slug := skillSlug(yamlString(skill, "name"))
					if slug == "" {
						continue
					}
					dir := filepath.Join(workspace, ".grox", "skills", slug)
					if err := os.MkdirAll(dir, 0o700); err != nil {
						continue
					}
					body := "---\nname: " + yamlString(skill, "name") + "\ndescription: " + yamlString(skill, "description") + "\n---\n\n" + strings.TrimSpace(func() string { value, _ := skill["instructions"].(string); return value }()) + "\n"
					if err := writeMemoryAtomic(filepath.Join(dir, "SKILL.md"), []byte(body)); err != nil {
						continue
					}
					result.Skills++
				}
				path := workspace
				if _, err := s.UpdateBot(bot.ID, model.BotPatch{WorkingDir: &path}); err == nil {
					if skills, err := s.ListSkills(bot.ID); err == nil {
						for _, skill := range skills {
							if skill.Source == "Workspace" && skill.Enabled == false {
								_, _ = s.SetSkillEnabled(bot.ID, skill.ID, true)
							}
						}
					}
				}
			}
		}
		for _, playbookKey := range yamlKeys(agent, "playbooks") {
			playbook := playbooksByKey[playbookKey]
			if playbook == nil {
				continue
			}
			if _, err := s.SavePlaybook(bot.ID, model.PlaybookInput{
				Name: yamlString(playbook, "name"), Triggers: yamlKeys(playbook, "triggers"),
				Instructions: func() string { value, _ := playbook["instructions"].(string); return value }(),
			}); err == nil {
				result.Playbooks++
			}
		}
	}
	for _, rawRoom := range yamlList(document["rooms"]) {
		room := yamlMap(rawRoom)
		memberIDs := []string{}
		for _, member := range yamlKeys(room, "members") {
			if bot := botsByKey[member]; bot != nil {
				memberIDs = append(memberIDs, bot.ID)
			}
		}
		if len(memberIDs) == 0 {
			continue
		}
		leadID := memberIDs[0]
		responder := "lead"
		if defaultResponder := yamlMap(room["defaultResponder"]); defaultResponder != nil {
			if agent := yamlString(defaultResponder, "agent"); agent != "" {
				if bot := botsByKey[agent]; bot != nil {
					leadID = bot.ID
				}
			}
			if yamlString(defaultResponder, "kind") == "auto" {
				responder = "auto"
			}
		}
		group, err := s.CreateGroup(model.CreateGroupInput{
			Name: yamlString(room, "name"), Description: yamlString(room, "bulletin"), Color: "purple",
			MemberIDs: memberIDs, LeadID: leadID,
		})
		if err != nil {
			continue
		}
		if responder == "auto" {
			_, _ = s.UpdateGroup(group.ID, model.GroupPatch{Responder: &responder})
		}
		result.Groups++
	}
	for _, rawRoutine := range yamlList(document["routines"]) {
		routine := yamlMap(rawRoutine)
		agentKey := yamlString(routine, "agent")
		bot := botsByKey[agentKey]
		if bot == nil {
			continue
		}
		schedule := yamlMap(routine["schedule"])
		if schedule == nil || yamlString(schedule, "type") == "" || strings.EqualFold(yamlString(routine, "runOn"), "cloud") {
			continue
		}
		cadence := "daily"
		if yamlString(schedule, "type") == "weekdays" {
			cadence = "weekdays"
		}
		timeOfDay := yamlString(schedule, "time")
		if timeOfDay == "" {
			continue
		}
		prompt := yamlString(routine, "prompt")
		if prompt == "" {
			continue
		}
		count := func() int { value, _ := routine["durationMinutes"].(int); return value }()
		if count <= 0 {
			count = 30
		}
		if _, err := s.CreateRoutine(model.RoutineInput{
			BotID: bot.ID, Name: bot.Name + ": " + yamlString(routine, "name"), Prompt: prompt,
			Cadence: cadence, TimeOfDay: timeOfDay, Enabled: false,
		}); err == nil {
			result.Routines++
		}
	}
	return result, nil
}
