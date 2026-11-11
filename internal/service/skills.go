package service

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

const (
	maxSkillBytes     = 64 * 1024
	maxSkillPrompt    = 64 * 1024
	maxOneSkillPrompt = 24 * 1024
)

type skillRoot struct {
	path   string
	source string
}

func skillSlug(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	dash := false
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case r == '-' || r == '_' || r == ' ' || r == '.':
			if b.Len() > 0 && !dash {
				b.WriteByte('-')
				dash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func parseSkillFile(path, source string, enabled map[string]bool) (model.Skill, bool) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return model.Skill{}, false
	}
	if info.Size() > 256*1024 {
		return model.Skill{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return model.Skill{}, false
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	meta := map[string]string{}
	body := text
	if strings.HasPrefix(text, "---\n") {
		if end := strings.Index(text[4:], "\n---"); end >= 0 {
			header := text[4 : 4+end]
			body = strings.TrimLeft(text[4+end+4:], "\n")
			for _, line := range strings.Split(header, "\n") {
				key, value, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				key = strings.ToLower(strings.TrimSpace(key))
				value = strings.TrimSpace(value)
				if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
					value = value[1 : len(value)-1]
				}
				if key != "" {
					meta[key] = value
				}
			}
		}
	}
	name := strings.TrimSpace(meta["name"])
	dir := filepath.Base(filepath.Dir(path))
	if name == "" {
		name = dir
	}
	id := skillSlug(name)
	if id == "" {
		id = skillSlug(dir)
	}
	if id == "" {
		return model.Skill{}, false
	}
	description := strings.TrimSpace(meta["description"])
	if description == "" {
		for _, line := range strings.Split(body, "\n") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "#"))
			if line == "" || strings.HasPrefix(line, "---") {
				continue
			}
			description = line
			if len(description) > 220 {
				description = description[:220] + "…"
			}
			break
		}
	}
	if len(body) > maxSkillBytes {
		body = body[:maxSkillBytes] + "\n\n[Truncated by Grox at 64 KB]"
	}
	bytes := len(body)
	return model.Skill{
		ID: id, Name: name, Description: description, Source: source, Path: path,
		Bytes: bytes, Enabled: enabled[id], Body: body, UpdatedAt: info.ModTime(),
	}, true
}

func (s *Service) skillRootsLocked(bot *model.Bot) []skillRoot {
	roots := []skillRoot{
		{path: filepath.Join(s.dir, "skills"), source: "Grox"},
	}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, skillRoot{path: filepath.Join(home, ".grox", "skills"), source: "Grox home"})
		if bot != nil && strings.TrimSpace(bot.WorkingDir) != "" {
			roots = append(roots,
				skillRoot{path: filepath.Join(bot.WorkingDir, ".grox", "skills"), source: "Workspace"},
				skillRoot{path: filepath.Join(bot.WorkingDir, ".claude", "skills"), source: "Claude workspace"},
			)
		}
		roots = append(roots, skillRoot{path: filepath.Join(home, ".claude", "skills"), source: "Claude home"})
	}
	return roots
}

func (s *Service) scanSkillsLocked(bot *model.Bot) []model.Skill {
	enabled := map[string]bool{}
	if bot != nil {
		for _, item := range bot.Skills {
			enabled[item.ID] = item.Enabled
		}
	}
	byID := map[string]model.Skill{}
	for _, root := range s.skillRootsLocked(bot) {
		entries, err := os.ReadDir(root.path)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			var path string
			if entry.IsDir() {
				path = filepath.Join(root.path, entry.Name(), "SKILL.md")
			} else if entry.Name() == "SKILL.md" {
				path = filepath.Join(root.path, entry.Name())
			} else {
				continue
			}
			if skill, ok := parseSkillFile(path, root.source, enabled); ok {
				byID[skill.ID] = skill
			}
		}
	}
	out := make([]model.Skill, 0, len(byID))
	for _, skill := range byID {
		skill.Body = ""
		out = append(out, skill)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Source != out[j].Source {
			return out[i].Source < out[j].Source
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// ListSkills discovers SKILL.md files visible to a bot and returns their
// per-bot enabled state. It never executes a skill.
func (s *Service) ListSkills(botID string) ([]model.Skill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return nil, fmt.Errorf("bot not found")
	}
	return s.scanSkillsLocked(bot), nil
}

// ReadSkill returns the SKILL.md body for the instructions viewer.
func (s *Service) ReadSkill(botID, skillID string) (model.Skill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return model.Skill{}, fmt.Errorf("bot not found")
	}
	for _, skill := range s.scanSkillsLocked(bot) {
		if skill.ID != skillID {
			continue
		}
		info, err := os.Stat(skill.Path)
		if err != nil || info.IsDir() {
			return model.Skill{}, fmt.Errorf("skill file not found")
		}
		data, err := os.ReadFile(skill.Path)
		if err != nil {
			return model.Skill{}, fmt.Errorf("read skill: %w", err)
		}
		body := strings.ReplaceAll(string(data), "\r\n", "\n")
		if len(body) > maxSkillBytes {
			body = body[:maxSkillBytes] + "\n\n[Truncated by Grox at 64 KB]"
		}
		skill.Body = body
		return skill, nil
	}
	return model.Skill{}, fmt.Errorf("skill not found")
}

// SetSkillEnabled stores the per-bot switch. The skill text stays on disk.
func (s *Service) SetSkillEnabled(botID, skillID string, enabled bool) (model.Bot, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return model.Bot{}, fmt.Errorf("bot not found")
	}
	found := false
	for _, skill := range s.scanSkillsLocked(bot) {
		if skill.ID == skillID {
			found = true
			break
		}
	}
	if !found {
		s.mu.Unlock()
		return model.Bot{}, fmt.Errorf("skill not found")
	}
	next := make([]model.BotSkill, 0, len(bot.Skills)+1)
	for _, item := range bot.Skills {
		if item.ID != skillID {
			next = append(next, item)
		}
	}
	if enabled {
		next = append(next, model.BotSkill{ID: skillID, Enabled: true})
	}
	bot.Skills = next
	bot.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	out := cloneBot(*bot)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

func (s *Service) enabledSkillTextLocked(bot *model.Bot) string {
	if bot == nil {
		return ""
	}
	var b strings.Builder
	for _, skill := range s.scanSkillsLocked(bot) {
		if !skill.Enabled {
			continue
		}
		data, err := os.ReadFile(skill.Path)
		if err != nil {
			continue
		}
		body := strings.ReplaceAll(string(data), "\r\n", "\n")
		if len(body) > maxOneSkillPrompt {
			body = body[:maxOneSkillPrompt] + "\n\n[Truncated by Grox at 24 KB]"
		}
		part := "### " + skill.Name + "\n"
		if skill.Description != "" {
			part += skill.Description + "\n"
		}
		part += "\n" + strings.TrimSpace(body) + "\n\n"
		if b.Len()+len(part) > maxSkillPrompt {
			break
		}
		b.WriteString(part)
	}
	return strings.TrimSpace(b.String())
}
