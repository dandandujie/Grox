package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// appendMemory is the memory_update tool. It writes a dated bullet either to
// MEMORY.md or to a topic file. The tool is available through the per-turn MCP
// gateway and the API tool loop; CLI Ask hooks still gate the call.
func (s *Service) appendMemory(botID, text, topic string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("memory text is empty")
	}
	if len(text) > 2000 {
		return "", fmt.Errorf("memory entry is too long (2,000 characters max)")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return "", fmt.Errorf("bot not found")
	}
	dir, err := s.memoryDirLocked(botID)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "MEMORY.md")
	label := "MEMORY.md"
	if topic = strings.TrimSpace(topic); topic != "" {
		name := skillSlug(topic)
		if name == "" {
			name = "note"
		}
		topicDir := filepath.Join(dir, "topics")
		if err := os.MkdirAll(topicDir, 0o700); err != nil {
			return "", fmt.Errorf("create memory topic: %w", err)
		}
		path = filepath.Join(topicDir, name+".md")
		label = "memory/topics/" + name + ".md"
		if _, err := os.Stat(path); os.IsNotExist(err) {
			header := "---\ntitle: " + topic + "\ndescription: Notes captured by the bot.\n---\n\n"
			if err := os.WriteFile(path, []byte(header), 0o600); err != nil {
				return "", fmt.Errorf("create memory topic: %w", err)
			}
		}
	}
	current, _, _, err := readMemoryFile(path)
	if err != nil {
		return "", err
	}
	entry := "- " + time.Now().Format("2006-01-02") + " · " + text
	next := strings.TrimRight(current, "\n")
	if next != "" {
		next += "\n"
	}
	next += entry + "\n"
	if len(next) > memoryMaxBytes {
		return "", fmt.Errorf("memory is too large (512 KB max)")
	}
	if err := writeMemoryAtomic(path, []byte(next)); err != nil {
		return "", fmt.Errorf("write memory: %w", err)
	}
	bot.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return "Saved to " + label + ".", nil
}

func (s *Service) memoryUpdateTool(target claudeHookTarget, arguments map[string]any) (string, error) {
	text, _ := arguments["text"].(string)
	if strings.TrimSpace(text) == "" {
		text, _ = arguments["memory"].(string)
	}
	topic, _ := arguments["topic"].(string)
	return s.appendMemory(target.BotID, text, topic)
}
