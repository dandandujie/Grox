package service

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dandandujie/grox/internal/model"
)

// ImportOpenMausPackage imports an openmaus.package v2 JSON document. It is
// additive and creates disabled connections and paused routines.
func (s *Service) ImportOpenMausPackage(raw string) (model.PackageImportResult, error) {
	if len(raw) > 4*1024*1024 {
		return model.PackageImportResult{}, fmt.Errorf("package is too large")
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &document); err != nil {
		return model.PackageImportResult{}, fmt.Errorf("invalid package JSON")
	}
	version, _ := document["version"].(float64)
	if yamlString(document, "format") != "openmaus.package" || version != 2 {
		return model.PackageImportResult{}, fmt.Errorf("unsupported package format")
	}
	pkg := yamlMap(document["package"])
	if pkg == nil {
		return model.PackageImportResult{}, fmt.Errorf("package content is missing")
	}
	if containsCredentialKey(pkg) {
		return model.PackageImportResult{}, fmt.Errorf("refusing a package with credential-looking keys")
	}
	agents := yamlList(pkg["agents"])
	if len(agents) == 0 {
		return model.PackageImportResult{}, fmt.Errorf("the package has no agents")
	}
	result := model.PackageImportResult{}
	skillsByKey := map[string]map[string]any{}
	if skills := yamlMap(pkg["skills"]); skills != nil {
		for _, rawSkill := range yamlList(skills["entries"]) {
			skill := yamlMap(rawSkill)
			if name := yamlString(skill, "name"); name != "" {
				skillsByKey[name] = skill
			}
		}
	}
	playbooksByKey := map[string]map[string]any{}
	for _, raw := range yamlList(pkg["playbooks"]) {
		playbook := yamlMap(raw)
		if key := yamlString(playbook, "key"); key != "" {
			playbooksByKey[key] = playbook
		}
	}
	botsByKey := map[string]*model.Bot{}
	connectionBots := map[string][]string{}
	for index, raw := range agents {
		agent := yamlMap(raw)
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
		botsByKey[yamlString(agent, "key")] = &bot
		for _, connectionKey := range yamlKeys(agent, "connections") {
			connectionBots[connectionKey] = append(connectionBots[connectionKey], bot.ID)
		}
		result.Bots++
		result.Names = append(result.Names, bot.Name)

		workspace := filepath.Join(s.dir, "workspaces", skillSlug(name)+"-package")
		_ = os.MkdirAll(workspace, 0o700)
		path := workspace
		_, _ = s.UpdateBot(bot.ID, model.BotPatch{WorkingDir: &path})
		for _, skillKey := range yamlKeys(agent, "skills") {
			skill := skillsByKey[skillKey]
			if skill == nil {
				continue
			}
			slug := skillSlug(yamlString(skill, "name"))
			body, _ := skill["instructions"].(string)
			if slug == "" || strings.TrimSpace(body) == "" {
				continue
			}
			dir := filepath.Join(workspace, ".grox", "skills", slug)
			if err := os.MkdirAll(dir, 0o700); err != nil {
				continue
			}
			text := "---\nname: " + yamlString(skill, "name") + "\ndescription: " + yamlString(skill, "description") + "\n---\n\n" + strings.TrimRight(body, "\n") + "\n"
			if err := writeMemoryAtomic(filepath.Join(dir, "SKILL.md"), []byte(text)); err == nil {
				result.Skills++
			}
		}
		if skills, err := s.ListSkills(bot.ID); err == nil {
			for _, skill := range skills {
				if skill.Source == "Workspace" {
					_, _ = s.SetSkillEnabled(bot.ID, skill.ID, true)
				}
			}
		}
		for _, playbookKey := range yamlKeys(agent, "playbooks") {
			playbook := playbooksByKey[playbookKey]
			if playbook == nil {
				continue
			}
			instructions, _ := playbook["instructions"].(string)
			if _, err := s.SavePlaybook(bot.ID, model.PlaybookInput{
				Name: yamlString(playbook, "name"), Triggers: yamlKeys(playbook, "triggers"), Instructions: instructions,
			}); err == nil {
				result.Playbooks++
			}
		}
		if seed := yamlMap(agent["seed"]); seed != nil {
			for path, rawContent := range yamlMap(seed["memory"]) {
				content, _ := rawContent.(string)
				if strings.TrimSpace(content) == "" {
					continue
				}
				if path == "MEMORY.md" {
					if state, err := s.GetMemory(bot.ID); err == nil {
						_, _ = s.SaveMemory(bot.ID, content, state.Revision)
					}
					continue
				}
				if strings.HasPrefix(path, "memory/") && strings.HasSuffix(path, ".md") {
					name := strings.TrimSuffix(strings.TrimPrefix(path, "memory/"), ".md")
					_, _ = s.SaveMemoryTopic(bot.ID, name, content, "")
				}
			}
		}
	}
	for _, raw := range yamlList(pkg["rooms"]) {
		room := yamlMap(raw)
		memberIDs := []string{}
		for _, member := range yamlKeys(room, "members") {
			if bot := botsByKey[member]; bot != nil {
				memberIDs = append(memberIDs, bot.ID)
			}
		}
		if len(memberIDs) == 0 {
			continue
		}
		lead := memberIDs[0]
		responder := "lead"
		if defaultResponder := yamlMap(room["defaultResponder"]); defaultResponder != nil {
			if agent := yamlString(defaultResponder, "agent"); agent != "" {
				if bot := botsByKey[agent]; bot != nil {
					lead = bot.ID
				}
			}
			if yamlString(defaultResponder, "kind") == "auto" {
				responder = "auto"
			}
		}
		group, err := s.CreateGroup(model.CreateGroupInput{
			Name: yamlString(room, "name"), Description: yamlString(room, "bulletin"), Color: "purple",
			MemberIDs: memberIDs, LeadID: lead,
		})
		if err != nil {
			continue
		}
		if responder == "auto" {
			_, _ = s.UpdateGroup(group.ID, model.GroupPatch{Responder: &responder})
		}
		result.Groups++
	}
	for _, raw := range yamlList(pkg["routines"]) {
		routine := yamlMap(raw)
		bot := botsByKey[yamlString(routine, "agent")]
		if bot == nil || strings.EqualFold(yamlString(routine, "runOn"), "cloud") {
			continue
		}
		schedule := yamlMap(routine["schedule"])
		if schedule == nil {
			continue
		}
		cadence := "daily"
		if yamlString(schedule, "type") == "weekdays" {
			cadence = "weekdays"
		}
		clock := yamlString(schedule, "time")
		if clock == "" {
			continue
		}
		prompt := yamlString(routine, "prompt")
		if prompt == "" {
			continue
		}
		continuity, _ := routine["continuity"].(bool)
		if _, err := s.CreateRoutine(model.RoutineInput{
			BotID: bot.ID, Name: bot.Name + ": " + yamlString(routine, "name"), Prompt: prompt,
			Cadence: cadence, TimeOfDay: clock, Continuity: continuity, Enabled: false,
		}); err == nil {
			result.Routines++
		}
	}
	for _, raw := range yamlList(pkg["connections"]) {
		connection := yamlMap(raw)
		mcp := yamlMap(connection["mcp"])
		if mcp == nil {
			continue
		}
		url := yamlString(mcp, "url")
		if !strings.HasPrefix(url, "https://") {
			continue
		}
		if _, err := s.CreateMCPServer(model.MCPServerInput{
			Name: yamlString(connection, "label"), URL: url, Enabled: false,
			BotIDs: connectionBots[yamlString(connection, "key")],
		}); err == nil {
			result.Connections++
		}
	}
	for _, raw := range yamlList(pkg["presets"]) {
		preset := yamlMap(raw)
		bot := yamlMap(preset["bot"])
		if bot == nil {
			continue
		}
		_, _ = s.CreatePreset(model.PresetInput{
			Name: yamlString(preset, "name"), Title: yamlString(bot, "title"),
			Description: yamlString(preset, "description"), Soul: yamlString(bot, "soul"),
			Color: yamlString(yamlMap(bot["appearance"]), "color"),
		})
	}
	return result, nil
}
