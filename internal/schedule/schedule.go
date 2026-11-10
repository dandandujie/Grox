// Package schedule computes when a routine runs next.
package schedule

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// Next returns the first run strictly after now for the routine's cadence.
// Unknown cadences fall back to daily at the routine's time.
func Next(r model.Routine, now time.Time) time.Time {
	hour, minute := parseClock(r.TimeOfDay)
	loc := now.Location()
	var t time.Time
	switch r.Cadence {
	case "hourly":
		t = now.Truncate(time.Hour).Add(time.Hour)
	case "weekdays":
		t = time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, loc)
		if !t.After(now) {
			t = t.AddDate(0, 0, 1)
		}
		for t.Weekday() == time.Saturday || t.Weekday() == time.Sunday {
			t = t.AddDate(0, 0, 1)
		}
	case "weekly":
		weekday := r.Weekday
		if weekday < 1 || weekday > 7 {
			weekday = 1
		}
		target := time.Weekday(weekday % 7) // 7 is Sunday
		t = time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, loc)
		for {
			if t.Weekday() == target && t.After(now) {
				break
			}
			t = t.AddDate(0, 0, 1)
			t = time.Date(t.Year(), t.Month(), t.Day(), hour, minute, 0, 0, loc)
		}
	default: // daily
		t = time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, loc)
		if !t.After(now) {
			t = t.AddDate(0, 0, 1)
		}
	}
	return t
}

func parseClock(value string) (int, int) {
	parts := strings.SplitN(strings.TrimSpace(value), ":", 2)
	if len(parts) != 2 {
		return 9, 0
	}
	hour, err := strconv.Atoi(parts[0])
	if err != nil || hour < 0 || hour > 23 {
		hour = 9
	}
	minute, err := strconv.Atoi(parts[1])
	if err != nil || minute < 0 || minute > 59 {
		minute = 0
	}
	return hour, minute
}

// Clock normalises a user's time string to HH:MM.
func Clock(value string) string {
	hour, minute := parseClock(value)
	return fmt.Sprintf("%02d:%02d", hour, minute)
}

// Label is the human sentence used in the routines list.
func Label(r model.Routine) string {
	switch r.Cadence {
	case "hourly":
		return "Every hour"
	case "weekdays":
		return "Weekdays at " + Clock(r.TimeOfDay)
	case "weekly":
		names := []string{"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"}
		day := "Monday"
		if r.Weekday >= 1 && r.Weekday <= 7 {
			day = names[r.Weekday-1]
		}
		return day + "s at " + Clock(r.TimeOfDay)
	default:
		return "Every day at " + Clock(r.TimeOfDay)
	}
}
