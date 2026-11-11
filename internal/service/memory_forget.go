package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// ForgetMemory removes matching top-level MEMORY.md entries and appends them
// to topics/archive.md with a forgotten marker. Topic files are edited through
// their own editor; this tool is deliberately limited to MEMORY.md.
func (s *Service) ForgetMemory(botID, query string) (model.MemoryForgetResult, error) {
	query = strings.TrimSpace(query)
	if len(query) < 3 {
		return model.MemoryForgetResult{}, fmt.Errorf("use at least three characters to forget")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return model.MemoryForgetResult{}, fmt.Errorf("bot not found")
	}
	path, err := s.memoryPathLocked(botID)
	if err != nil {
		return model.MemoryForgetResult{}, err
	}
	content, _, exists, err := readMemoryFile(path)
	if err != nil {
		return model.MemoryForgetResult{}, err
	}
	if !exists {
		return model.MemoryForgetResult{}, fmt.Errorf("memory is empty")
	}
	lines := strings.Split(content, "\n")
	starts := []int{}
	for index, line := range lines {
		if strings.HasPrefix(line, "- ") {
			starts = append(starts, index)
		}
	}
	remove := map[int]bool{}
	var removed []string
	for index, start := range starts {
		end := len(lines)
		if index+1 < len(starts) {
			end = starts[index+1]
		}
		text := strings.Join(lines[start:end], "\n")
		if !strings.Contains(strings.ToLower(text), strings.ToLower(query)) {
			continue
		}
		for line := start; line < end; line++ {
			remove[line] = true
		}
		removed = append(removed, text)
	}
	if len(removed) == 0 {
		return model.MemoryForgetResult{}, nil
	}
	kept := make([]string, 0, len(lines))
	for index, line := range lines {
		if !remove[index] {
			kept = append(kept, line)
		}
	}
	next := strings.TrimRight(strings.Join(kept, "\n"), "\n") + "\n"
	archivePath := filepath.Join(filepath.Dir(path), "topics", "archive.md")
	if err := os.MkdirAll(filepath.Dir(archivePath), 0o700); err != nil {
		return model.MemoryForgetResult{}, err
	}
	existing, _ := os.ReadFile(archivePath)
	archive := string(existing)
	if strings.TrimSpace(archive) == "" {
		archive = "---\ntitle: Archive\ndescription: Older memory entries moved out of MEMORY.md.\n---\n\n"
	}
	for _, item := range removed {
		archive = strings.TrimRight(archive, "\n") + "\n\n" + item + "\n· forgotten " + time.Now().Format("2006-01-02") + "\n"
	}
	if err := writeMemoryAtomic(archivePath, []byte(archive)); err != nil {
		return model.MemoryForgetResult{}, err
	}
	if err := writeMemoryAtomic(path, []byte(next)); err != nil {
		return model.MemoryForgetResult{}, err
	}
	bot.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return model.MemoryForgetResult{Removed: len(removed), Archived: len(removed)}, nil
}

func (s *Service) memoryForgetTool(target claudeHookTarget, arguments map[string]any) (string, error) {
	query, _ := arguments["query"].(string)
	if strings.TrimSpace(query) == "" {
		query, _ = arguments["text"].(string)
	}
	result, err := s.ForgetMemory(target.BotID, query)
	if err != nil {
		return "", err
	}
	if result.Removed == 0 {
		return "No matching MEMORY.md entries were found.", nil
	}
	return fmt.Sprintf("Forgot %d matching memory entries; they were copied to topics/archive.md.", result.Removed), nil
}
