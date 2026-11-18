package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/store"
)

func TestTurnAdmissionKeepsConcurrentSendOutOfHistory(t *testing.T) {
	for _, surface := range []string{"direct", "channel"} {
		t.Run(surface, func(t *testing.T) {
			started := make(chan struct{}, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				started <- struct{}{}
				select {
				case <-r.Context().Done():
				case <-time.After(10 * time.Second):
				}
			}))
			defer upstream.Close()

			svc, dir, events := newTestService(t)
			settings := svc.st.State.Settings
			settings.EngineMode = "api"
			settings.APIBaseURL = upstream.URL
			settings.APIModel = "grox-qa"
			if _, err := svc.UpdateSettings(settings); err != nil {
				t.Fatal(err)
			}
			bot, err := svc.CreateBot(model.CreateBotInput{Name: "Concurrent test"})
			if err != nil {
				t.Fatal(err)
			}
			threadID := bot.Threads[0].ID
			send := func(text string) (model.SendResult, error) { return svc.Send(bot.ID, threadID, text) }
			stop := func() error { return svc.Stop(bot.ID, threadID) }
			groupID := ""
			if surface == "channel" {
				group, err := svc.CreateGroup(model.CreateGroupInput{Name: "Test room", MemberIDs: []string{bot.ID}, LeadID: bot.ID})
				if err != nil {
					t.Fatal(err)
				}
				groupID, threadID = group.ID, group.Threads[0].ID
				send = func(text string) (model.SendResult, error) { return svc.SendGroup(groupID, threadID, text) }
				stop = func() error { return svc.StopGroup(groupID, threadID) }
			}
			defer func() { _ = stop() }()

			sent, err := send("accepted prompt")
			if err != nil || sent.MessageID == "" {
				t.Fatalf("send = %+v, %v", sent, err)
			}
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("real API adapter did not start")
			}

			// Refreshing the catalog used to normalize away the live Busy flag.
			if _, err := svc.RefreshCatalog(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := send("rejected prompt"); err == nil {
				t.Fatal("second send was admitted into a busy conversation")
			}
			if err := stop(); err != nil {
				t.Fatal(err)
			}
			waitFor(t, events, 4*time.Second, "stopped turn", func(event model.Event) bool {
				return event.Turn != nil && event.ThreadID == threadID && !event.Turn.Busy
			})
			reopened, err := store.Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			var messages []model.Message
			if surface == "channel" {
				for _, group := range reopened.State.Groups {
					if group.ID == groupID {
						messages = group.Threads[0].Messages
					}
				}
			} else {
				for _, item := range reopened.State.Bots {
					if item.ID == bot.ID {
						messages = item.Threads[0].Messages
					}
				}
			}
			var accepted, rejected int
			for _, message := range messages {
				if message.Text == "accepted prompt" {
					accepted++
				}
				if message.Text == "rejected prompt" {
					rejected++
				}
			}
			if accepted != 1 || rejected != 0 {
				t.Fatalf("accepted %d, rejected %d in saved transcript", accepted, rejected)
			}
		})
	}
}

func TestSendReturnsSaveErrorBeforeLaunching(t *testing.T) {
	svc, dir, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Persistence test", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	threadID := bot.Threads[0].ID
	stateFile := filepath.Join(dir, "state.json")
	if err := os.Rename(stateFile, stateFile+".backup"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(stateFile, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Send(bot.ID, threadID, "must never run"); err == nil || !strings.Contains(err.Error(), "save outgoing turn") {
		t.Fatalf("send error = %v", err)
	}
	svc.mu.Lock()
	thread := svc.findThreadLocked(svc.findBotLocked(bot.ID), threadID)
	busy, messages, activeTurns := thread.Busy, len(thread.Messages), len(svc.turns)
	svc.mu.Unlock()
	if busy || messages != len(bot.Threads[0].Messages) || activeTurns != 0 {
		t.Fatalf("failed save left busy=%v, messages=%d, turns=%d", busy, messages, activeTurns)
	}
}

func TestRoutineEngineFailurePersistsRetry(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, "QA credentials expired")
	}))
	defer upstream.Close()
	svc, dir, events := newTestService(t)
	settings := svc.st.State.Settings
	settings.EngineMode = "api"
	settings.APIBaseURL = upstream.URL
	settings.APIModel = "grox-qa"
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Failure test"})
	if err != nil {
		t.Fatal(err)
	}
	routine, err := svc.CreateRoutine(model.RoutineInput{BotID: bot.ID, Name: "Retry test", Prompt: "Run now", Cadence: "daily", TimeOfDay: "09:00", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RunRoutine(routine.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 4*time.Second, "failed API run", func(event model.Event) bool {
		if event.State == nil {
			return false
		}
		for _, run := range event.State.Runs {
			if run.RoutineID == routine.ID && run.Status == "failed" && strings.Contains(run.Summary, "QA credentials expired") {
				return true
			}
		}
		return false
	})
	reopened, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range reopened.State.Routines {
		if candidate.ID != routine.ID {
			continue
		}
		delay := time.Until(candidate.NextRun)
		if candidate.LastStatus != "failed" || candidate.ConsecutiveFailures != 1 || delay < 14*time.Minute || delay > 15*time.Minute {
			t.Fatalf("persisted failure state: %s, %d failures, retry in %v", candidate.LastStatus, candidate.ConsecutiveFailures, delay)
		}
		return
	}
	t.Fatal("routine missing after reload")
}
