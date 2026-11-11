package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func memoryIsDated(line string) bool {
	if !strings.HasPrefix(line, "- ") || len(line) < 12 {
		return false
	}
	value := line[2:12]
	_, err := time.Parse("2006-01-02", value)
	return err == nil
}

// TidyMemory moves the oldest dated entries out of MEMORY.md into
// memory/topics/archive.md until the 200-line / 24 KB load budget is met. The
// archive is written first; a failure never removes a line without a copy.
func (s *Service) TidyMemory(botID string) (model.MemoryTidyResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return model.MemoryTidyResult{}, fmt.Errorf("bot not found")
	}
	path, err := s.memoryPathLocked(botID)
	if err != nil {
		return model.MemoryTidyResult{}, err
	}
	content, _, _, err := readMemoryFile(path)
	if err != nil {
		return model.MemoryTidyResult{}, err
	}
	lines := strings.Split(content, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	starts := []int{}
	for index, line := range lines {
		if memoryIsDated(line) {
			starts = append(starts, index)
		}
	}
	if len(starts) == 0 {
		lineCount, byteCount := countMemory(content)
		return model.MemoryTidyResult{Lines: lineCount, Bytes: byteCount, Within: lineCount <= memoryLimitLines && byteCount <= memoryLimitBytes}, nil
	}
	type block struct {
		start int
		end   int
		text  string
	}
	blocks := make([]block, 0, len(starts))
	for index, start := range starts {
		end := len(lines)
		if index+1 < len(starts) {
			end = starts[index+1]
		}
		blocks = append(blocks, block{start: start, end: end, text: strings.Join(lines[start:end], "\n")})
	}
	remove := map[int]bool{}
	archive := make([]string, 0)
	lineCount, byteCount := countMemory(strings.Join(lines, "\n"))
	for _, item := range blocks {
		if lineCount <= memoryLimitLines && byteCount <= memoryLimitBytes {
			break
		}
		for index := item.start; index < item.end; index++ {
			remove[index] = true
		}
		archive = append(archive, item.text)
		lineCount -= item.end - item.start
		byteCount -= len(item.text) + 1
		if lineCount < 0 {
			lineCount = 0
		}
		if byteCount < 0 {
			byteCount = 0
		}
	}
	if len(archive) == 0 {
		return model.MemoryTidyResult{Lines: lineCount, Bytes: byteCount, Within: true}, nil
	}
	kept := make([]string, 0, len(lines))
	for index, line := range lines {
		if remove[index] {
			continue
		}
		kept = append(kept, line)
	}
	// Drop blank runs at the seam without touching manual headers.
	for index := 0; index+2 < len(kept); index++ {
		if kept[index] == "" && kept[index+1] == "" && kept[index+2] == "" {
			kept = append(kept[:index], kept[index+1:]...)
			index--
		}
	}
	nextMemory := strings.TrimRight(strings.Join(kept, "\n"), "\n")
	nextMemory += "\n"
	archivePath := filepath.Join(filepath.Dir(path), "topics", "archive.md")
	if err := os.MkdirAll(filepath.Dir(archivePath), 0o700); err != nil {
		return model.MemoryTidyResult{}, err
	}
	existing, _ := os.ReadFile(archivePath)
	archiveText := string(existing)
	if strings.TrimSpace(archiveText) == "" {
		archiveText = "---\ntitle: Archive\ndescription: Older memory entries moved out of MEMORY.md.\n---\n\n"
	}
	for _, item := range archive {
		archiveText = strings.TrimRight(archiveText, "\n") + "\n\n" + item + "\n· moved " + time.Now().Format("2006-01-02") + "\n"
	}
	if err := writeMemoryAtomic(archivePath, []byte(archiveText)); err != nil {
		return model.MemoryTidyResult{}, fmt.Errorf("write memory archive: %w", err)
	}
	if err := writeMemoryAtomic(path, []byte(nextMemory)); err != nil {
		return model.MemoryTidyResult{}, fmt.Errorf("write memory: %w", err)
	}
	bot.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	finalLines, finalBytes := countMemory(nextMemory)
	return model.MemoryTidyResult{Archived: len(archive), Lines: finalLines, Bytes: finalBytes, Within: finalLines <= memoryLimitLines && finalBytes <= memoryLimitBytes}, nil
}

func (s *Service) memoryTidyTool(target claudeHookTarget) (string, error) {
	result, err := s.TidyMemory(target.BotID)
	if err != nil {
		return "", err
	}
	if result.Archived == 0 {
		return "Memory already fits the load budget; nothing was archived.", nil
	}
	return fmt.Sprintf("Archived %d dated memory entries; MEMORY.md is now %d lines / %d bytes.", result.Archived, result.Lines, result.Bytes), nil
}
