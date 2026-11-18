package service

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/schedule"
)

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
	defer s.mu.Unlock()
	now := time.Now()
	r := model.Routine{
		ID: newID("routine"), BotID: input.BotID, GroupID: input.GroupID, Name: name, Prompt: prompt,
		Cadence: normalCadence(input.Cadence), TimeOfDay: schedule.Clock(input.TimeOfDay),
		Weekday: input.Weekday, CronExpression: strings.TrimSpace(input.CronExpression), TimeZone: strings.TrimSpace(input.TimeZone),
		Continuity: input.Continuity, Checks: normalizeRoutineChecks(input.Checks), Overlap: normalizeRoutineOverlap(input.Overlap), Enabled: input.Enabled,
		CreatedAt: now, UpdatedAt: now,
	}
	if _, _, err := s.routineTargetLocked(r); err != nil {
		return model.Routine{}, err
	}
	if err := setRoutineSchedule(&r, now); err != nil {
		return model.Routine{}, err
	}
	before := s.snapshotLocked()
	s.st.State.Routines = append(s.st.State.Routines, r)
	if err := s.commitRoutineChangeLocked(before); err != nil {
		return model.Routine{}, err
	}
	return cloneRoutine(r), nil
}

// UpdateRoutine edits a routine and recomputes its next run when necessary.
func (s *Service) UpdateRoutine(id string, patch model.RoutinePatch) (model.Routine, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.findRoutineLocked(id)
	if current == nil {
		return model.Routine{}, fmt.Errorf("routine not found")
	}
	r := *current
	if patch.BotID != nil {
		r.BotID = *patch.BotID
	}
	if patch.GroupID != nil {
		r.GroupID = *patch.GroupID
	}
	if patch.Name != nil {
		r.Name = strings.TrimSpace(*patch.Name)
		if r.Name == "" {
			return model.Routine{}, fmt.Errorf("the name cannot be empty")
		}
	}
	if patch.Prompt != nil {
		r.Prompt = strings.TrimSpace(*patch.Prompt)
		if r.Prompt == "" {
			return model.Routine{}, fmt.Errorf("the prompt cannot be empty")
		}
	}
	if patch.Cadence != nil {
		r.Cadence = normalCadence(*patch.Cadence)
	}
	if patch.TimeOfDay != nil {
		r.TimeOfDay = schedule.Clock(*patch.TimeOfDay)
	}
	if patch.Weekday != nil {
		r.Weekday = *patch.Weekday
	}
	if patch.CronExpression != nil {
		r.CronExpression = strings.TrimSpace(*patch.CronExpression)
	}
	if patch.TimeZone != nil {
		r.TimeZone = strings.TrimSpace(*patch.TimeZone)
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
	}
	targetChanged := r.BotID != current.BotID || r.GroupID != current.GroupID
	if targetChanged || (r.Enabled && !current.Enabled) {
		if _, _, err := s.routineTargetLocked(r); err != nil {
			return model.Routine{}, err
		}
	}
	if targetChanged {
		r.LastThreadID = ""
		r.Queued = false
	}
	now := time.Now()
	if r.Cadence != current.Cadence || r.TimeOfDay != current.TimeOfDay || r.Weekday != current.Weekday ||
		r.CronExpression != current.CronExpression || r.TimeZone != current.TimeZone || r.Enabled != current.Enabled {
		if err := setRoutineSchedule(&r, now); err != nil {
			return model.Routine{}, err
		}
		r.Queued = false
	}
	r.UpdatedAt = now
	before := s.snapshotLocked()
	*current = r
	if err := s.commitRoutineChangeLocked(before); err != nil {
		return model.Routine{}, err
	}
	return cloneRoutine(r), nil
}

func setRoutineSchedule(r *model.Routine, now time.Time) error {
	if r.Cadence != "cron" {
		r.CronExpression, r.TimeZone = "", ""
	}
	if err := schedule.Validate(*r, now); err != nil {
		return err
	}
	r.NextRun = schedule.Next(*r, now)
	return nil
}

func (s *Service) findRoutineLocked(id string) *model.Routine {
	for i := range s.st.State.Routines {
		if s.st.State.Routines[i].ID == id {
			return &s.st.State.Routines[i]
		}
	}
	return nil
}

func (s *Service) routineTargetLocked(r model.Routine) (*model.Bot, *model.Group, error) {
	bot := s.findBotLocked(r.BotID)
	if bot == nil {
		return nil, nil, fmt.Errorf("the routine's bot is gone")
	}
	if r.GroupID == "" {
		return bot, nil, nil
	}
	group := s.findGroupLocked(r.GroupID)
	if group == nil {
		return nil, nil, fmt.Errorf("the routine's channel is gone")
	}
	if !slices.Contains(group.MemberIDs, bot.ID) {
		return nil, nil, fmt.Errorf("%s is no longer a member of %s", bot.Name, group.Name)
	}
	return bot, group, nil
}

func (s *Service) commitRoutineChangeLocked(before model.AppState) error {
	s.touchLocked()
	if err := s.st.SaveState(); err != nil {
		s.st.State = before
		return fmt.Errorf("save routine: %w", err)
	}
	s.emitStateLocked()
	return nil
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
	before := s.snapshotLocked()
	s.st.State.Routines = append(s.st.State.Routines[:idx], s.st.State.Routines[idx+1:]...)
	defer s.mu.Unlock()
	return s.commitRoutineChangeLocked(before)
}

// RunRoutine starts a routine now in its direct chat or channel.
func (s *Service) RunRoutine(id string) (model.SendResult, error) {
	return s.runRoutine(id, false)
}

func (s *Service) runRoutine(id string, scheduled bool) (model.SendResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.findRoutineLocked(id)
	if r == nil {
		return model.SendResult{}, fmt.Errorf("routine not found")
	}
	now := time.Now()
	if scheduled && !routineIsDue(*r, now) {
		return model.SendResult{}, nil
	}
	before := s.snapshotLocked()
	bot, group, err := s.routineTargetLocked(*r)
	if err != nil {
		if !scheduled {
			return model.SendResult{}, err
		}
		r.Enabled, r.Queued = false, false
		r.LastStatus = "unavailable"
		r.UpdatedAt = now
		return model.SendResult{}, s.commitRoutineChangeLocked(before)
	}
	if scheduled && !r.Queued && now.Sub(r.NextRun) > 45*time.Minute {
		r.LastStatus = "missed"
		r.NextRun = schedule.Next(*r, now)
		r.UpdatedAt = now
		return model.SendResult{}, s.commitRoutineChangeLocked(before)
	}

	var thread *model.Thread
	if r.Continuity && r.LastThreadID != "" {
		if group == nil {
			thread = s.findThreadLocked(bot, r.LastThreadID)
		} else {
			thread = s.findGroupThreadLocked(group, r.LastThreadID)
		}
	}
	threadBusy := thread != nil && thread.Busy
	if scheduled && (threadBusy || s.routineBotBusyLocked(bot)) {
		if r.Overlap == "queue" {
			if r.Queued {
				return model.SendResult{}, nil
			}
			r.Queued = true
		} else {
			r.Queued = false
			r.NextRun = schedule.Next(*r, now)
		}
		r.UpdatedAt = now
		return model.SendResult{}, s.commitRoutineChangeLocked(before)
	}
	if threadBusy {
		return model.SendResult{}, fmt.Errorf("the continuous routine thread is still busy")
	}

	prompt := r.Prompt
	if scheduled && containsString(r.Checks, "runs") {
		if !r.LastCheckAt.IsZero() {
			changes := s.routineRunChangesLocked(*r)
			if len(changes) == 0 {
				r.LastCheckAt = now
				r.UpdatedAt = now
				r.Queued = false
				r.NextRun = schedule.Next(*r, now)
				return model.SendResult{}, s.commitRoutineChangeLocked(before)
			}
			prompt += "\n\nNew routine results:\n" + strings.Join(changes, "\n")
		}
		r.LastCheckAt = now
	}
	if thread == nil {
		task := model.Thread{
			ID: newID("thread"), Title: r.Name + " · " + now.Format("Jan 2"), Kind: "task",
			CreatedAt: now, UpdatedAt: now,
		}
		if group == nil {
			task.BotID = bot.ID
			bot.Threads = append([]model.Thread{task}, bot.Threads...)
			thread = &bot.Threads[0]
		} else {
			group.Threads = append([]model.Thread{task}, group.Threads...)
			thread = &group.Threads[0]
		}
	}
	r.LastThreadID = thread.ID
	run := model.Run{
		ID: newID("run"), RoutineID: r.ID, BotID: bot.ID, GroupID: r.GroupID, ThreadID: thread.ID,
		Title: r.Name, Status: "running", StartedAt: now,
	}
	s.st.State.Runs = append(s.st.State.Runs, run)
	if len(s.st.State.Runs) > 60 {
		s.st.State.Runs = s.st.State.Runs[len(s.st.State.Runs)-60:]
	}
	r.LastRun = now
	r.LastStatus = "running"
	r.Queued = false
	r.NextRun = schedule.Next(*r, now)
	r.UpdatedAt = now
	message := model.Message{
		ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: prompt,
		CreatedAt: now, UpdatedAt: now,
	}
	thread.Messages = append(thread.Messages, message)
	if !scheduled {
		s.st.State.ActiveBotID = bot.ID
		if group != nil {
			s.st.State.ActiveBotID = ""
			group.Unread = 0
		}
		s.st.State.ActiveGroupID = r.GroupID
		s.st.State.ActiveThreadID = thread.ID
		thread.Unread = 0
	}
	if err := s.admitTurnLocked(before, bot, group, thread, prompt, nil, run.ID, false); err != nil {
		return model.SendResult{}, err
	}
	return model.SendResult{BotID: bot.ID, GroupID: r.GroupID, ThreadID: thread.ID, MessageID: message.ID}, nil
}

func (s *Service) routineRunChangesLocked(r model.Routine) []string {
	var changes []string
	for _, run := range s.st.State.Runs {
		if run.RoutineID == r.ID || run.GroupID != r.GroupID || run.FinishedAt.IsZero() || !run.FinishedAt.After(r.LastCheckAt) {
			continue
		}
		line := "- " + run.Title + " (" + run.Status + ")"
		if run.Summary != "" {
			line += ": " + run.Summary
		}
		changes = append(changes, line)
	}
	return changes
}

func (s *Service) routineBotBusyLocked(bot *model.Bot) bool {
	for _, t := range bot.Threads {
		if t.Busy {
			return true
		}
	}
	for _, turn := range s.turns {
		if turn.botID == bot.ID {
			return true
		}
	}
	return false
}

func (s *Service) finishRoutineRunLocked(runID, status, summary string, now time.Time) {
	for i := range s.st.State.Runs {
		run := &s.st.State.Runs[i]
		if run.ID != runID {
			continue
		}
		run.Status = status
		run.FinishedAt = now
		run.Summary = summary
		for j := range s.st.State.Routines {
			routine := &s.st.State.Routines[j]
			if routine.ID != run.RoutineID || !routine.LastRun.Equal(run.StartedAt) {
				continue
			}
			routine.LastStatus = status
			switch status {
			case "completed":
				routine.ConsecutiveFailures = 0
			case "failed":
				routine.ConsecutiveFailures = max(routine.ConsecutiveFailures, 0) + 1
				delay := 15 * time.Minute << min(routine.ConsecutiveFailures-1, 4)
				if routine.Enabled {
					routine.NextRun = now.Add(delay)
				}
			}
			break
		}
		return
	}
}

func routineIsDue(routine model.Routine, now time.Time) bool {
	return routine.Enabled && (routine.Queued || (!routine.NextRun.IsZero() && !routine.NextRun.After(now)))
}

func (s *Service) runDueRoutines() {
	now := time.Now()
	s.mu.Lock()
	var due []string
	for _, routine := range s.st.State.Routines {
		if routineIsDue(routine, now) {
			due = append(due, routine.ID)
		}
	}
	s.mu.Unlock()
	for _, id := range due {
		_, _ = s.runRoutine(id, true)
	}
}

func normalCadence(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "hourly", "weekdays", "weekly", "daily", "cron":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "daily"
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
