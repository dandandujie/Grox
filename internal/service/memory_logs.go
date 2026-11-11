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

const dailyLogMaxBytes = 1024 * 1024

func trimLogText(text string, max int) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return text
}

func (s *Service) memoryLogsLocked(botID string) []model.MemoryLog {
	dir, err := s.memoryDirLocked(botID)
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(filepath.Join(dir, "logs"))
	if err != nil {
		return nil
	}
	out := make([]model.MemoryLog, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		out = append(out, model.MemoryLog{
			Date: strings.TrimSuffix(entry.Name(), ".md"), Path: filepath.Join(dir, "logs", entry.Name()), Bytes: int(info.Size()),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date > out[j].Date })
	return out
}

// appendDailyLogLocked writes an opt-in local conversation log. Logs are never
// included in MEMORY.md, the topic index, or recall.
func (s *Service) appendDailyLogLocked(bot *model.Bot, thread *model.Thread, final *model.Message, now time.Time) {
	if bot == nil || thread == nil || final == nil || !bot.MemoryDailyLog {
		return
	}
	reply := trimLogText(final.Text, 4000)
	if reply == "" {
		return
	}
	userText := ""
	for index := len(thread.Messages) - 1; index >= 0; index-- {
		message := thread.Messages[index]
		if message.Role == model.RoleUser && message.Kind == model.KindText && strings.TrimSpace(message.Text) != "" {
			userText = trimLogText(message.Text, 4000)
			break
		}
	}
	if userText == "" {
		return
	}
	dir, err := s.memoryDirLocked(bot.ID)
	if err != nil {
		return
	}
	logDir := filepath.Join(dir, "logs")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return
	}
	path := filepath.Join(logDir, now.Format("2006-01-02")+".md")
	if info, err := os.Stat(path); err == nil && info.Size() > dailyLogMaxBytes {
		return
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	entry := fmt.Sprintf("## %s · %s\n\n**You:** %s\n\n**%s:** %s\n\n", now.Format("15:04"), thread.Title, userText, bot.Name, reply)
	_, _ = file.WriteString(entry)
}

// ReadMemoryLog returns one daily log file. Logs are read-only.
func (s *Service) ReadMemoryLog(botID, date string) (string, error) {
	if _, err := time.Parse("2006-01-02", date); err != nil {
		return "", fmt.Errorf("invalid log date")
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
	path := filepath.Join(dir, "logs", date+".md")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("log not found")
		}
		return "", err
	}
	return string(data), nil
}
