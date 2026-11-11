package service

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func readSkillBody(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if strings.HasPrefix(text, "---\n") {
		if end := strings.Index(text[4:], "\n---"); end >= 0 {
			return strings.TrimLeft(text[4+end+4:], "\n")
		}
	}
	return text
}

// ExportOpenMausPackage writes one channel as an openmaus.package v2 JSON
// document. It carries no tokens, connection values or chat history.
func (s *Service) ExportOpenMausPackage(groupID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	group := s.findGroupLocked(groupID)
	if group == nil {
		return "", fmt.Errorf("channel not found")
	}
	bots := make([]map[string]any, 0, len(group.MemberIDs))
	skillsByName := map[string]map[string]any{}
	playbooksByKey := map[string]map[string]any{}
	connectionsByKey := map[string]map[string]any{}
	routines := make([]map[string]any, 0)
	botKeys := map[string]string{}
	for _, botID := range group.MemberIDs {
		bot := s.findBotLocked(botID)
		if bot == nil {
			continue
		}
		key := skillSlug(bot.Name)
		if key == "" {
			key = "bot"
		}
		botKeys[bot.ID] = key
		agent := map[string]any{
			"key": key, "name": bot.Name, "title": bot.Title, "description": bot.Description, "soul": bot.Soul,
			"approval": bot.Approval, "appearance": map[string]any{"color": bot.Color},
		}
		skillKeys := []string{}
		if skills := s.scanSkillsLocked(bot); len(skills) > 0 {
			for _, skill := range skills {
				if !skill.Enabled {
					continue
				}
				body := readSkillBody(skill.Path)
				if strings.TrimSpace(body) == "" {
					continue
				}
				skillKeys = append(skillKeys, skill.ID)
				skillsByName[skill.ID] = map[string]any{"name": skill.ID, "description": skill.Description, "instructions": body}
			}
		}
		if len(skillKeys) > 0 {
			agent["skills"] = skillKeys
		}
		playbookKeys := []string{}
		if playbooks, err := s.listPlaybooksLocked(bot.ID); err == nil {
			for _, playbook := range playbooks {
				playbookKeys = append(playbookKeys, playbook.ID)
				playbooksByKey[playbook.ID] = map[string]any{
					"key": playbook.ID, "name": playbook.Name, "triggers": playbook.Triggers, "instructions": playbook.Instructions,
				}
			}
		}
		if len(playbookKeys) > 0 {
			agent["playbooks"] = playbookKeys
		}
		connectionKeys := []string{}
		for _, server := range s.st.State.MCPServers {
			if !server.Enabled || server.URL == "" {
				continue
			}
			if len(server.BotIDs) > 0 && !containsString(server.BotIDs, bot.ID) {
				continue
			}
			key := skillSlug(server.Name)
			if key == "" {
				key = server.ID
			}
			connectionKeys = append(connectionKeys, key)
			connectionsByKey[key] = map[string]any{
				"key": key, "label": server.Name, "reason": "Used by " + bot.Name,
				"mcp": map[string]any{"transport": "http", "url": server.URL, "valueNames": server.HeaderNames},
			}
		}
		if len(connectionKeys) > 0 {
			agent["connections"] = connectionKeys
		}
		if memory, err := s.memoryStateLocked(bot); err == nil && strings.TrimSpace(memory.Content) != "" {
			seed := map[string]any{"MEMORY.md": memory.Content}
			for _, topic := range memory.Topics {
				path, err := s.memoryTopicPathLocked(bot.ID, topic.Name)
				if err != nil {
					continue
				}
				content, err := s.readMemoryTopicLocked(bot, topic.Name, path)
				if err == nil && strings.TrimSpace(content.Content) != "" {
					seed["memory/"+topic.Name+".md"] = content.Content
				}
			}
			agent["seed"] = map[string]any{"memory": seed}
		}
		bots = append(bots, agent)
	}
	for index := range s.st.State.Routines {
		routine := &s.st.State.Routines[index]
		key, ok := botKeys[routine.BotID]
		if !ok {
			continue
		}
		routines = append(routines, map[string]any{
			"key": skillSlug(routine.Name), "name": routine.Name, "agent": key, "prompt": routine.Prompt,
			"runOn":               "maus",
			"schedule":            map[string]any{"type": routine.Cadence, "time": routine.TimeOfDay, "weekdays": []int{1, 2, 3, 4, 5}},
			"enabledAfterInstall": false,
		})
	}
	playbooks := make([]map[string]any, 0, len(playbooksByKey))
	for _, playbook := range playbooksByKey {
		playbooks = append(playbooks, playbook)
	}
	skills := make([]map[string]any, 0, len(skillsByName))
	for _, skill := range skillsByName {
		skills = append(skills, skill)
	}
	connections := make([]map[string]any, 0, len(connectionsByKey))
	for _, connection := range connectionsByKey {
		connections = append(connections, connection)
	}
	members := []string{}
	for _, botID := range group.MemberIDs {
		if key, ok := botKeys[botID]; ok {
			members = append(members, key)
		}
	}
	lead := ""
	if key, ok := botKeys[group.LeadID]; ok {
		lead = key
	}
	rooms := []map[string]any{{
		"key": skillSlug(group.Name), "name": group.Name, "members": members, "bulletin": group.Description,
		"defaultResponder": map[string]any{"kind": "agent", "agent": lead},
	}}
	presetEntries := []map[string]any{}
	for _, preset := range s.st.State.Presets {
		presetKey := skillSlug(preset.Name)
		if presetKey == "" {
			presetKey = preset.ID
		}
		playbookKeys := []string{}
		for _, playbook := range preset.Playbooks {
			key := skillSlug(playbook.Name)
			if key == "" {
				continue
			}
			playbookKeys = append(playbookKeys, key)
			playbooksByKey[key] = map[string]any{"key": key, "name": playbook.Name, "triggers": playbook.Triggers, "instructions": playbook.Instructions}
		}
		skillKeys := []string{}
		for _, skill := range preset.Skills {
			key := skillSlug(skill.Name)
			if key == "" {
				continue
			}
			skillKeys = append(skillKeys, key)
			skillsByName[key] = map[string]any{"name": key, "description": skill.Description, "instructions": skill.Instructions}
		}
		entry := map[string]any{
			"key": presetKey, "name": preset.Name, "description": preset.Description,
			"bot": map[string]any{"name": preset.Name, "title": preset.Title, "description": preset.Description, "soul": preset.Soul, "appearance": map[string]any{"color": preset.Color}},
		}
		if len(playbookKeys) > 0 {
			entry["playbooks"] = playbookKeys
		}
		if len(skillKeys) > 0 {
			entry["skills"] = skillKeys
		}
		if strings.TrimSpace(preset.Memory) != "" {
			entry["seed"] = map[string]any{"memory": map[string]any{"MEMORY.md": preset.Memory}}
		}
		presetEntries = append(presetEntries, entry)
	}
	document := map[string]any{
		"format": "openmaus.package", "version": 2,
		"package": map[string]any{
			"id": skillSlug(group.Name), "release": "1.0.0", "name": group.Name,
			"tagline": group.Name + " exported from Grox", "summary": group.Description,
			"category": "Imported", "author": map[string]any{"name": "Grox"},
			"license": "See source", "outcomes": []string{"Run " + group.Name + " with your own agents."},
			"setupMinutes": 5, "requirements": map[string]any{"apps": []string{}, "capabilities": []string{}},
			"team":   map[string]any{"name": group.Name, "leader": lead},
			"agents": bots, "rooms": rooms, "routines": routines,
			"playbooks": playbooks, "skills": map[string]any{"version": 1, "entries": skills},
			"connections": connections, "presets": presetEntries,
		},
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
