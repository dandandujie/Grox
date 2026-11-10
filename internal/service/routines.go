package service

import (
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/schedule"
)

// CreateRoutine adds a scheduled task.
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
		Weekday: input.Weekday, Enabled: input.Enabled,
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
	title := r.Name + " · " + now.Format("Jan 2")
	thread := model.Thread{
		ID: newID("thread"), BotID: bot.ID, Title: title, Kind: "task",
		CreatedAt: now, UpdatedAt: now,
	}
	bot.Threads = append([]model.Thread{thread}, bot.Threads...)
	bot.UpdatedAt = now
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
	prompt := r.Prompt
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
			r.NextRun = now.Add(2 * time.Minute)
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
