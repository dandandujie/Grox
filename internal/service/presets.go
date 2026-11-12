package service

import (
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func (s *Service) uniquePresetNameLocked(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Preset"
	}
	taken := map[string]bool{}
	for _, preset := range s.st.State.Presets {
		taken[strings.ToLower(preset.Name)] = true
	}
	candidate := name
	for suffix := 2; taken[strings.ToLower(candidate)]; suffix++ {
		candidate = fmt.Sprintf("%s %d", name, suffix)
	}
	return candidate
}

// ListPresets returns the New bot starting points.
func (s *Service) ListPresets() []model.Preset {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]model.Preset, len(s.st.State.Presets))
	copy(out, s.st.State.Presets)
	if out == nil {
		return []model.Preset{}
	}
	return out
}

// CreatePreset saves a persona-only starting point. It deliberately ignores
// model, approval, folders and credentials.
func (s *Service) CreatePreset(input model.PresetInput) (model.Preset, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return model.Preset{}, fmt.Errorf("give the preset a name")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	color := input.Color
	if !allowedColors[color] {
		color = "green"
	}
	preset := model.Preset{
		ID: newID("preset"), Name: s.uniquePresetNameLocked(name), Title: strings.TrimSpace(input.Title),
		Description: strings.TrimSpace(input.Description), Soul: strings.TrimSpace(input.Soul), Color: color,
		CreatedAt: now, UpdatedAt: now,
	}
	s.st.State.Presets = append(s.st.State.Presets, preset)
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return preset, nil
}

func (s *Service) UpdatePreset(id string, patch model.PresetPatch) (model.Preset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var preset *model.Preset
	for index := range s.st.State.Presets {
		if s.st.State.Presets[index].ID == id {
			preset = &s.st.State.Presets[index]
			break
		}
	}
	if preset == nil {
		return model.Preset{}, fmt.Errorf("preset not found")
	}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if name == "" {
			return model.Preset{}, fmt.Errorf("the name cannot be empty")
		}
		preset.Name = name
	}
	if patch.Title != nil {
		preset.Title = strings.TrimSpace(*patch.Title)
	}
	if patch.Description != nil {
		preset.Description = strings.TrimSpace(*patch.Description)
	}
	if patch.Soul != nil {
		preset.Soul = strings.TrimSpace(*patch.Soul)
	}
	if patch.Color != nil && allowedColors[*patch.Color] {
		preset.Color = *patch.Color
	}
	preset.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return *preset, nil
}

func (s *Service) DeletePreset(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index := range s.st.State.Presets {
		if s.st.State.Presets[index].ID != id {
			continue
		}
		s.st.State.Presets = append(s.st.State.Presets[:index], s.st.State.Presets[index+1:]...)
		s.touchLocked()
		s.saveLocked()
		s.emitStateLocked()
		return nil
	}
	return fmt.Errorf("preset not found")
}
