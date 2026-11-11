package service

import (
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/schedule"
)

// CreateRoutine adds a scheduled task.
func normalizeRoutineOverlap(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "queue":
		return "queue"
	default:
		return "skip"
	}
}

func normalizeRoutineChecks(values []string) []string {
	out := []string{}
	for _, value := range values {
		if strings.ToLower(strings.TrimSpace(value)) == "runs" {
			out = append(out, "runs")
		}
	}
	return out
}

func (s *Service) CreateRoutine(input model.RoutineInput) (model.Routine, error) {
	name := strings.TrimSpace(input.Name)
	prompt := strings.TrimSpace(input.Prompt)
	if name == "" {
		return model.Routine{}, fmt.Errorf("give the routine a name")
	}
	if prompt == "" {
		return model.Routine{}, fmt.Errorf("tell the routine what to do")
	}
	s.mu.Lock()
	bot := s.findBotLocked(input.BotID)
	if bot == nil {
		s.mu.Unlock()
		return model.Routine{}, fmt.Errorf("bot not found")
	}
	now := time.Now()
	r := model.Routine{
		ID: newID("routine"), BotID: input.BotID, Name: name, Prompt: prompt,
		Cadence: normalCadence(input.Cadence), TimeOfDay: schedule.Clock(input.TimeOfDay),
		Weekday: input.Weekday, Continuity: input.Continuity, Checks: normalizeRoutineChecks(input.Checks), Overlap: normalizeRoutineOverlap(input.Overlap), Enabled: input.Enabled,
		CreatedAt: now, UpdatedAt: now,
	}
	r.NextRun = schedule.Next(r, now)
	s.st.State.Routines = append(s.st.State.Routines, r)
	s.touchLocked()
	s.saveLocked()
	out := cloneRoutine(r)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// UpdateRoutine edits a routine and recomputes its next run.
func (s *Service) UpdateRoutine(id string, patch model.RoutinePatch) (model.Routine, error) {
	s.mu.Lock()
	var r *model.Routine
	for i := range s.st.State.Routines {
		if s.st.State.Routines[i].ID == id {
			r = &s.st.State.Routines[i]
			break
		}
	}
	if r == nil {
		s.mu.Unlock()
		return model.Routine{}, fmt.Errorf("routine not found")
	}
	changedSchedule := false
	if patch.Name != nil {
		if strings.TrimSpace(*patch.Name) == "" {
			s.mu.Unlock()
			return model.Routine{}, fmt.Errorf("the name cannot be empty")
		}
		r.Name = strings.TrimSpace(*patch.Name)
	}
	if patch.Prompt != nil {
		if strings.TrimSpace(*patch.Prompt) == "" {
			s.mu.Unlock()
			return model.Routine{}, fmt.Errorf("the prompt cannot be empty")
		}
		r.Prompt = strings.TrimSpace(*patch.Prompt)
	}
	if patch.Cadence != nil {
		r.Cadence = normalCadence(*patch.Cadence)
		changedSchedule = true
	}
	if patch.TimeOfDay != nil {
		r.TimeOfDay = schedule.Clock(*patch.TimeOfDay)
		changedSchedule = true
	}
	if patch.Weekday != nil {
		r.Weekday = *patch.Weekday
		changedSchedule = true
	}
	if patch.Continuity != nil {
		r.Continuity = *patch.Continuity
	}
	if patch.Checks != nil {
		r.Checks = normalizeRoutineChecks(*patch.Checks)
	}
	if patch.Overlap != nil {
		r.Overlap = normalizeRoutineOverlap(*patch.Overlap)
	}
	if patch.Enabled != nil {
		r.Enabled = *patch.Enabled
		changedSchedule = true
	}
	r.UpdatedAt = time.Now()
	if changedSchedule {
		r.NextRun = schedule.Next(*r, time.Now())
	}
	s.touchLocked()
	s.saveLocked()
	out := cloneRoutine(*r)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// DeleteRoutine removes a schedule. Runs that already happened stay in the
// activity log.
func (s *Service) DeleteRoutine(id string) error {
	s.mu.Lock()
	idx := -1
	for i := range s.st.State.Routines {
		if s.st.State.Routines[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.mu.Unlock()
		return fmt.Errorf("routine not found")
	}
	s.st.State.Routines = append(s.st.State.Routines[:idx], s.st.State.Routines[idx+1:]...)
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

// RunRoutine starts a routine now, as a fresh task thread.
func (s *Service) RunRoutine(id string) (model.SendResult, error) {
	return s.runRoutine(id, false)
}

func (s *Service) runRoutine(id string, scheduled bool) (model.SendResult, error) {
	s.mu.Lock()
	var r *model.Routine
	for i := range s.st.State.Routines {
		if s.st.State.Routines[i].ID == id {
			r = &s.st.State.Routines[i]
			break
		}
	}
	if r == nil {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("routine not found")
	}
	bot := s.findBotLocked(r.BotID)
	if bot == nil {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("the routine's bot is gone")
	}
	now := time.Now()
	prompt := r.Prompt
	if scheduled && containsString(r.Checks, "runs") {
		if !r.LastCheckAt.IsZero() {
			var changes []string
			for _, run := range s.st.State.Runs {
				if run.RoutineID == r.ID || run.FinishedAt.IsZero() || !run.FinishedAt.After(r.LastCheckAt) {
					continue
				}
				line := "- " + run.Title + " (" + run.Status + ")"
				if run.Summary != "" {
					line += ": " + run.Summary
				}
				changes = append(changes, line)
			}
			if len(changes) == 0 {
				r.LastCheckAt = now
				r.UpdatedAt = now
				r.NextRun = schedule.Next(*r, now)
				s.touchLocked()
				s.saveLocked()
				s.emitStateLocked()
				s.mu.Unlock()
				return model.SendResult{}, nil
			}
			prompt += "\n\nNew routine results:\n" + strings.Join(changes, "\n")
		}
		r.LastCheckAt = now
	}
	thread := model.Thread{}
	reused := false
	if r.Continuity && r.LastThreadID != "" {
		for index := range bot.Threads {
			if bot.Threads[index].ID == r.LastThreadID {
				if bot.Threads[index].Busy {
					s.mu.Unlock()
					return model.SendResult{}, fmt.Errorf("the continuous routine thread is still busy")
				}
				thread = bot.Threads[index]
				thread.UpdatedAt = now
				reused = true
				break
			}
		}
	}
	if !reused {
		thread = model.Thread{
			ID: newID("thread"), BotID: bot.ID, Title: r.Name + " · " + now.Format("Jan 2"), Kind: "task",
			CreatedAt: now, UpdatedAt: now,
		}
		bot.Threads = append([]model.Thread{thread}, bot.Threads...)
	}
	bot.UpdatedAt = now
	r.LastThreadID = thread.ID
	run := model.Run{
		ID: newID("run"), RoutineID: r.ID, BotID: bot.ID, ThreadID: thread.ID,
		Title: r.Name, Status: "running", StartedAt: now,
	}
	s.st.State.Runs = append(s.st.State.Runs, run)
	if len(s.st.State.Runs) > 60 {
		s.st.State.Runs = s.st.State.Runs[len(s.st.State.Runs)-60:]
	}
	r.LastRun = now
	r.LastStatus = "running"
	r.NextRun = schedule.Next(*r, now)
	if scheduled {
		r.NextRun = schedule.Next(*r, now)
	}
	r.UpdatedAt = now
	s.st.State.ActiveBotID = bot.ID
	s.st.State.ActiveThreadID = thread.ID
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	botID := bot.ID
	threadID := thread.ID
	runID := run.ID
	s.mu.Unlock()

	result, err := s.sendInternal(botID, threadID, prompt, nil, runID, true)
	if err != nil {
		s.mu.Lock()
		for i := range s.st.State.Runs {
			if s.st.State.Runs[i].ID == runID {
				s.st.State.Runs[i].Status = "failed"
				s.st.State.Runs[i].FinishedAt = time.Now()
				s.st.State.Runs[i].Summary = err.Error()
			}
		}
		for i := range s.st.State.Routines {
			if s.st.State.Routines[i].ID == id {
				s.st.State.Routines[i].LastStatus = "failed"
				s.st.State.Routines[i].ConsecutiveFailures++
				delay := 15 * time.Minute
				for n := 1; n < s.st.State.Routines[i].ConsecutiveFailures && n < 5; n++ {
					delay *= 2
				}
				if delay > 4*time.Hour {
					delay = 4 * time.Hour
				}
				s.st.State.Routines[i].NextRun = time.Now().Add(delay)
			}
		}
		s.touchLocked()
		s.saveLocked()
		s.emitStateLocked()
		s.mu.Unlock()
		return model.SendResult{}, err
	}
	return result, nil
}

func (s *Service) runDueRoutines() {
	now := time.Now()
	s.mu.Lock()
	type due struct {
		id   string
		late bool
	}
	var dueRuns []due
	changed := false
	for i := range s.st.State.Routines {
		r := &s.st.State.Routines[i]
		if !r.Enabled || r.NextRun.IsZero() || r.NextRun.After(now) {
			continue
		}
		// A laptop that slept through a run should not replay a week of
		// work at once. Note the miss and move the schedule forward.
		if now.Sub(r.NextRun) > 45*time.Minute {
			r.LastStatus = "missed"
			r.NextRun = schedule.Next(*r, now)
			r.UpdatedAt = now
			changed = true
			continue
		}
		bot := s.findBotLocked(r.BotID)
		if bot == nil {
			r.Enabled = false
			r.NextRun = schedule.Next(*r, now)
			r.UpdatedAt = now
			changed = true
			continue
		}
		busy := false
		for _, t := range bot.Threads {
			if t.Busy {
				busy = true
				break
			}
		}
		if busy {
			if normalizeRoutineOverlap(r.Overlap) == "queue" {
				r.NextRun = now.Add(2 * time.Minute)
			} else {
				r.NextRun = schedule.Next(*r, now)
			}
			r.UpdatedAt = now
			changed = true
			continue
		}
		dueRuns = append(dueRuns, due{id: r.ID})
	}
	if changed {
		s.touchLocked()
		s.saveLocked()
		s.emitStateLocked()
	}
	s.mu.Unlock()
	for _, d := range dueRuns {
		_, _ = s.runRoutine(d.id, true)
	}
}

func normalCadence(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "hourly", "weekdays", "weekly", "daily":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "daily"
	}
}
