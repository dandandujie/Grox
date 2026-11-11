package service

import (
	"strings"

	"github.com/dandandujie/grox/internal/model"
)

func normalizeToolPatterns(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func toolPatternMatch(pattern, name string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	name = strings.ToLower(strings.TrimSpace(name))
	if pattern == "" {
		return false
	}
	if pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == name
	}
	parts := strings.Split(pattern, "*")
	if parts[0] != "" && !strings.HasPrefix(name, parts[0]) {
		return false
	}
	position := len(parts[0])
	for index := 1; index < len(parts)-1; index++ {
		part := parts[index]
		if part == "" {
			continue
		}
		found := strings.Index(name[position:], part)
		if found < 0 {
			return false
		}
		position += found + len(part)
	}
	last := parts[len(parts)-1]
	if last != "" && !strings.HasSuffix(name, last) {
		return false
	}
	return true
}

// toolAllowed applies a bot's tool policy. Empty allow means every tool is
// permitted; deny always wins.
func toolAllowed(policy model.ToolPolicy, name string) bool {
	for _, pattern := range policy.Deny {
		if toolPatternMatch(pattern, name) {
			return false
		}
	}
	if len(policy.Allow) == 0 {
		return true
	}
	for _, pattern := range policy.Allow {
		if toolPatternMatch(pattern, name) {
			return true
		}
	}
	return false
}

func (s *Service) botToolAllowedLocked(botID, name string) bool {
	bot := s.findBotLocked(botID)
	if bot == nil {
		return false
	}
	return toolAllowed(bot.ToolPolicy, name)
}
