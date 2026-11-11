package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func normalizeTopicName(name string) (string, error) {
	name = strings.TrimSpace(name)
	name = strings.TrimSuffix(name, ".md")
	if name == "" || filepath.Base(name) != name || strings.ContainsAny(name, "/\\") || strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("invalid memory topic")
	}
	return name, nil
}

func (s *Service) memoryTopicPathLocked(botID, name string) (string, error) {
	dir, err := s.memoryDirLocked(botID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "topics", name+".md"), nil
}

// ReadMemoryTopic returns the full topic body plus its revision for editing.
func (s *Service) ReadMemoryTopic(botID, name string) (model.MemoryTopic, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return model.MemoryTopic{}, fmt.Errorf("bot not found")
	}
	name, err := normalizeTopicName(name)
	if err != nil {
		return model.MemoryTopic{}, err
	}
	path, err := s.memoryTopicPathLocked(botID, name)
	if err != nil {
		return model.MemoryTopic{}, err
	}
	topic, ok := parseMemoryTopic(path)
	if !ok {
		return model.MemoryTopic{}, fmt.Errorf("topic not found")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return model.MemoryTopic{}, err
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	topic.Content = text
	topic.Bytes = len(text)
	topic.Revision = hashText(text)
	return topic, nil
}

// SaveMemoryTopic writes a topic only when the revision matches. A new topic
// may pass an empty revision.
func (s *Service) SaveMemoryTopic(botID, name, content, revision string) (model.MemoryTopic, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return model.MemoryTopic{}, fmt.Errorf("bot not found")
	}
	name, err := normalizeTopicName(name)
	if err != nil {
		return model.MemoryTopic{}, err
	}
	path, err := s.memoryTopicPathLocked(botID, name)
	if err != nil {
		return model.MemoryTopic{}, err
	}
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if len(content) > memoryMaxBytes {
		return model.MemoryTopic{}, fmt.Errorf("memory topic is too large (512 KB max)")
	}
	current, currentRevision, exists, err := readMemoryFile(path)
	if err != nil {
		return model.MemoryTopic{}, err
	}
	if exists && revision != currentRevision {
		return model.MemoryTopic{}, fmt.Errorf("topic changed on disk while you were editing; reload and try again")
	}
	if !exists && revision != "" {
		return model.MemoryTopic{}, fmt.Errorf("topic disappeared; reload and try again")
	}
	if content == current && exists {
		return s.readMemoryTopicLocked(bot, name, path)
	}
	if err := writeMemoryAtomic(path, []byte(content)); err != nil {
		return model.MemoryTopic{}, fmt.Errorf("write memory topic: %w", err)
	}
	bot.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	return s.readMemoryTopicLocked(bot, name, path)
}

func (s *Service) readMemoryTopicLocked(_ *model.Bot, _ string, path string) (model.MemoryTopic, error) {
	topic, ok := parseMemoryTopic(path)
	if !ok {
		return model.MemoryTopic{}, fmt.Errorf("topic not found")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return model.MemoryTopic{}, err
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	topic.Content = text
	topic.Bytes = len(text)
	topic.Revision = hashText(text)
	return topic, nil
}

func (s *Service) DeleteMemoryTopic(botID, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return fmt.Errorf("bot not found")
	}
	name, err := normalizeTopicName(name)
	if err != nil {
		return err
	}
	path, err := s.memoryTopicPathLocked(botID, name)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("topic not found")
		}
		return err
	}
	bot.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return nil
}
