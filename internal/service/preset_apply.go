package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dandandujie/grox/internal/model"
)

// ApplyPreset adds a preset's playbooks, isolated skills and starter memory to
// an already-created bot. Persona fields are applied by the New bot form.
func (s *Service) ApplyPreset(botID, presetID string) error {
	s.mu.Lock()
	var preset *model.Preset
	for index := range s.st.State.Presets {
		if s.st.State.Presets[index].ID == presetID {
			copy := s.st.State.Presets[index]
			preset = &copy
			break
		}
	}
	bot := s.findBotLocked(botID)
	s.mu.Unlock()
	if preset == nil {
		return fmt.Errorf("preset not found")
	}
	if bot == nil {
		return fmt.Errorf("bot not found")
	}
	if len(preset.Skills) > 0 {
		workspace := filepath.Join(s.dir, "workspaces", skillSlug(bot.Name)+"-preset")
		if err := os.MkdirAll(workspace, 0o700); err != nil {
			return err
		}
		for _, skill := range preset.Skills {
			slug := skillSlug(skill.Name)
			if slug == "" || strings.TrimSpace(skill.Instructions) == "" {
				continue
			}
			dir := filepath.Join(workspace, ".grox", "skills", slug)
			if err := os.MkdirAll(dir, 0o700); err != nil {
				continue
			}
			body := "---\nname: " + skill.Name + "\ndescription: " + skill.Description + "\n---\n\n" + strings.TrimRight(skill.Instructions, "\n") + "\n"
			if err := writeMemoryAtomic(filepath.Join(dir, "SKILL.md"), []byte(body)); err != nil {
				continue
			}
		}
		path := workspace
		if _, err := s.UpdateBot(botID, model.BotPatch{WorkingDir: &path}); err != nil {
			return err
		}
		if skills, err := s.ListSkills(botID); err == nil {
			for _, skill := range skills {
				if skill.Source == "Workspace" {
					_, _ = s.SetSkillEnabled(botID, skill.ID, true)
				}
			}
		}
	}
	for _, playbook := range preset.Playbooks {
		if _, err := s.SavePlaybook(botID, model.PlaybookInput{
			Name: playbook.Name, Triggers: playbook.Triggers, Instructions: playbook.Instructions,
		}); err != nil {
			return err
		}
	}
	if strings.TrimSpace(preset.Memory) != "" {
		state, err := s.GetMemory(botID)
		if err != nil {
			return err
		}
		if _, err := s.SaveMemory(botID, preset.Memory, state.Revision); err != nil {
			return err
		}
	}
	return nil
}
