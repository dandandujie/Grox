package service

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func TestImportedOpenMausCronRunsInItsChannel(t *testing.T) {
	svc, _, events := newTestService(t)
	data, err := os.ReadFile("testdata/openmaus-full-team.v2.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ImportTeam(string(data)); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	var routine model.Routine
	for _, candidate := range svc.st.State.Routines {
		if candidate.Name == "Weekly pipeline review" {
			routine = candidate
			break
		}
	}
	svc.mu.Unlock()
	if routine.GroupID == "" || routine.Enabled || routine.TimeZone != "UTC" || routine.CronExpression != "0 10 * * 1" {
		t.Fatalf("invalid imported room routine: %+v", routine)
	}
	result, err := svc.RunRoutine(routine.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.GroupID != routine.GroupID || result.BotID != routine.BotID || result.ThreadID == "" {
		t.Fatalf("Run now opened the wrong conversation: %+v", result)
	}
	event := waitFor(t, events, 6*time.Second, "completed channel routine", func(ev model.Event) bool {
		if ev.State == nil {
			return false
		}
		for _, run := range ev.State.Runs {
			if run.RoutineID == routine.ID && run.GroupID == routine.GroupID && run.BotID == routine.BotID &&
				run.ThreadID == result.ThreadID && run.Status == "completed" {
				return true
			}
		}
		return false
	})
	for _, group := range event.State.Groups {
		if group.ID != result.GroupID {
			continue
		}
		for _, thread := range group.Threads {
			if thread.ID == result.ThreadID && !thread.Busy && len(thread.Messages) >= 2 &&
				thread.Messages[0].Text == routine.Prompt && thread.Messages[len(thread.Messages)-1].SenderID == routine.BotID {
				return
			}
		}
	}
	t.Fatal("the selected channel has no reply from its assigned bot")
}

func TestScheduledChannelRoutineUsesFixedBotAndNeverStealsSelection(t *testing.T) {
	svc, _, events := newTestService(t)
	lead, err := svc.CreateBot(model.CreateBotInput{Name: "Routine Lead", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := svc.CreateBot(model.CreateBotInput{Name: "Routine Worker", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	group, err := svc.CreateGroup(model.CreateGroupInput{
		Name: "Routine Channel", LeadID: lead.ID, MemberIDs: []string{lead.ID, worker.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	routine, err := svc.CreateRoutine(model.RoutineInput{
		Name: "Fixed worker", GroupID: group.ID, BotID: worker.ID, Prompt: "@Routine Lead, please look at the pipeline.",
		Cadence: "cron", CronExpression: "0 10 * * 1", TimeZone: "UTC", Enabled: true, Continuity: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Select(lead.ID, lead.Threads[0].ID); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	svc.findRoutineLocked(routine.ID).NextRun = time.Now().Add(-time.Minute)
	svc.mu.Unlock()
	svc.runDueRoutines()
	ended := waitFor(t, events, 6*time.Second, "the fixed member finishing in the channel", func(ev model.Event) bool {
		return ev.GroupID == group.ID && ev.BotID == worker.ID && ev.Turn != nil && !ev.Turn.Busy
	})
	svc.mu.Lock()
	activeBot, activeGroup := svc.st.State.ActiveBotID, svc.st.State.ActiveGroupID
	svc.mu.Unlock()
	if activeBot != lead.ID || activeGroup != "" {
		t.Fatalf("background run stole navigation: bot %q, group %q", activeBot, activeGroup)
	}
	repeated, err := svc.RunRoutine(routine.ID)
	if err != nil || repeated.GroupID != group.ID || repeated.ThreadID != ended.ThreadID {
		t.Fatalf("continuity picked a different room thread: %+v (%v)", repeated, err)
	}
	waitFor(t, events, 6*time.Second, "the repeated room turn", func(ev model.Event) bool {
		return ev.GroupID == group.ID && ev.ThreadID == repeated.ThreadID && ev.Turn != nil && !ev.Turn.Busy
	})
	members := []string{lead.ID}
	if _, err := svc.UpdateGroup(group.ID, model.GroupPatch{MemberIDs: &members}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RunRoutine(routine.ID); err == nil || !strings.Contains(err.Error(), "no longer a member") {
		t.Fatalf("removed bot could still run in the channel: %v", err)
	}
	svc.mu.Lock()
	svc.findRoutineLocked(routine.ID).NextRun = time.Now().Add(-time.Minute)
	svc.mu.Unlock()
	svc.runDueRoutines()
	svc.mu.Lock()
	defer svc.mu.Unlock()
	current := svc.findRoutineLocked(routine.ID)
	if current.Enabled || current.LastStatus != "unavailable" {
		t.Fatalf("invalid channel target was not paused: %+v", current)
	}
}
