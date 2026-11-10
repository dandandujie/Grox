package schedule

import (
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func TestNextDaily(t *testing.T) {
	now := time.Date(2026, 11, 10, 9, 30, 0, 0, time.UTC) // Tuesday
	next := Next(model.Routine{Cadence: "daily", TimeOfDay: "09:00"}, now)
	want := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("daily next = %v, want %v", next, want)
	}
}

func TestNextWeekdaysSkipsWeekend(t *testing.T) {
	now := time.Date(2026, 11, 13, 18, 0, 0, 0, time.UTC) // Friday
	next := Next(model.Routine{Cadence: "weekdays", TimeOfDay: "08:00"}, now)
	want := time.Date(2026, 11, 16, 8, 0, 0, 0, time.UTC) // Monday
	if !next.Equal(want) {
		t.Fatalf("weekday next = %v, want %v", next, want)
	}
}

func TestNextWeekly(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC) // Tuesday
	next := Next(model.Routine{Cadence: "weekly", TimeOfDay: "10:00", Weekday: 1}, now)
	want := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC) // Monday
	if !next.Equal(want) {
		t.Fatalf("weekly next = %v, want %v", next, want)
	}
}

func TestNextHourly(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 20, 0, 0, time.UTC)
	next := Next(model.Routine{Cadence: "hourly"}, now)
	want := time.Date(2026, 11, 10, 13, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("hourly next = %v, want %v", next, want)
	}
}

func TestClockAndLabel(t *testing.T) {
	if got := Clock("7:5"); got != "07:05" {
		t.Fatalf("Clock = %q", got)
	}
	if got := Label(model.Routine{Cadence: "weekly", Weekday: 1, TimeOfDay: "09:30"}); got != "Mondays at 09:30" {
		t.Fatalf("Label = %q", got)
	}
}
