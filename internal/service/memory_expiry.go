package service

import (
	"regexp"
	"strings"
	"time"
)

var memoryUntilPattern = regexp.MustCompile("(?i)until[ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})")

func memoryEntryExpired(block string, now time.Time) bool {
	for _, match := range memoryUntilPattern.FindAllStringSubmatch(block, -1) {
		date, err := time.ParseInLocation("2006-01-02", match[1], now.Location())
		if err != nil {
			continue
		}
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		if date.Before(today) {
			return true
		}
	}
	return false
}

// filterExpiredMemory removes whole top-level entries that carry an
// "until YYYY-MM-DD" marker in the past. It never mutates the file.
func filterExpiredMemory(text string, now time.Time) (string, int) {
	if text == "" {
		return "", 0
	}
	var out strings.Builder
	var block []string
	expired := 0
	flush := func() {
		if len(block) == 0 {
			return
		}
		if memoryEntryExpired(strings.Join(block, ""), now) {
			expired++
		} else {
			for _, line := range block {
				out.WriteString(line)
			}
		}
		block = nil
	}
	for _, line := range strings.SplitAfter(text, "\n") {
		if strings.HasPrefix(line, "- ") {
			flush()
			block = []string{line}
			continue
		}
		if len(block) > 0 {
			block = append(block, line)
		} else {
			out.WriteString(line)
		}
	}
	flush()
	return out.String(), expired
}
