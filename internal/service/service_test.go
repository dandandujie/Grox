package service

import (
	"strings"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func newTestService(t *testing.T) (*Service, string, chan model.Event) {
	t.Helper()
	dir := t.TempDir()
	events := make(chan model.Event, 8192)
	svc, err := New(dir, func(ev model.Event) { events <- ev })
	if err != nil {
		t.Fatal(err)
	}
	if err := Open(svc); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { Close(svc) })
	if _, err := svc.UpdateSettings(model.Settings{
		Theme: "midnight", Language: "en", SidebarWidth: 312, Advanced: true, EngineMode: "demo",
	}); err != nil {
		t.Fatal(err)
	}
	return svc, dir, events
}

func waitFor(t *testing.T, events <-chan model.Event, timeout time.Duration, what string, pred func(model.Event) bool) model.Event {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case ev := <-events:
			if pred(ev) {
				return ev
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func botMessage(ev model.Event, botID, contains string) bool {
	if ev.Type != "message" || ev.BotID != botID || ev.Message == nil {
		return false
	}
	return ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != "" && strings.Contains(ev.Message.Text, contains)
}

func stateHasMessage(ev model.Event, botID, messageID string, pred func(model.Message) bool) bool {
	if ev.Type != "state" || ev.State == nil {
		return false
	}
	for _, bot := range ev.State.Bots {
		if bot.ID != botID {
			continue
		}
		for _, thread := range bot.Threads {
			for _, message := range thread.Messages {
				if message.ID == messageID && pred(message) {
					return true
				}
			}
		}
	}
	return false
}

func TestSendDemoTurn(t *testing.T) {
	svc, _, events := newTestService(t)
	if _, err := svc.Send("bot-brody", "thread-brody-home", "Help me plan this week"); err != nil {
		t.Fatal(err)
	}
	ev := waitFor(t, events, 12*time.Second, "the demo reply", func(ev model.Event) bool {
		return botMessage(ev, "bot-brody", "Here is a plan I would actually run")
	})
	if ev.Message.Engine != "Grox Demo" {
		t.Fatalf("engine = %q, want Grox Demo", ev.Message.Engine)
	}
}

func TestApprovalDecision(t *testing.T) {
	svc, _, events := newTestService(t)
	if err := svc.Decide("bot-emaily", "thread-emaily-home", "m-mail-3", "allow"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the approval state", func(ev model.Event) bool {
		return stateHasMessage(ev, "bot-emaily", "m-mail-3", func(m model.Message) bool {
			return m.Status == model.StatusAllowed
		})
	})
	ev := waitFor(t, events, 12*time.Second, "the approval follow-up", func(ev model.Event) bool {
		return botMessage(ev, "bot-emaily", "Archived 53 messages")
	})
	if ev.Message.Engine != "Grox Demo" {
		t.Fatalf("approval follow-up engine = %q, want Grox Demo", ev.Message.Engine)
	}
}

func TestAnswerOptions(t *testing.T) {
	svc, _, events := newTestService(t)
	if err := svc.Answer("bot-onyx", "thread-onyx-home", "m-onyx-2", "a"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the answered state", func(ev model.Event) bool {
		return stateHasMessage(ev, "bot-onyx", "m-onyx-2", func(m model.Message) bool {
			return m.Status == model.StatusAnswered
		})
	})
	waitFor(t, events, 12*time.Second, "the answer reply", func(ev model.Event) bool {
		return botMessage(ev, "bot-onyx", "shape of your work")
	})
}

func TestCreateBotAndPersist(t *testing.T) {
	svc, dir, events := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Nova", Title: "Helper", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	if bot.Name != "Nova" || len(bot.Threads) != 1 {
		t.Fatalf("unexpected bot: %+v", bot)
	}
	waitFor(t, events, 3*time.Second, "the created bot state", func(ev model.Event) bool {
		if ev.Type != "state" || ev.State == nil {
			return false
		}
		for _, item := range ev.State.Bots {
			if item.ID == bot.ID {
				return true
			}
		}
		return false
	})
	Close(svc)
	reopened, err := New(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := Open(reopened); err != nil {
		t.Fatal(err)
	}
	defer Close(reopened)
	reopened.mu.Lock()
	defer reopened.mu.Unlock()
	found := false
	for _, item := range reopened.st.State.Bots {
		if item.ID == bot.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("created bot did not survive a reopen")
	}
}

func TestRunRoutineCreatesTask(t *testing.T) {
	svc, _, events := newTestService(t)
	if _, err := svc.RunRoutine("routine-brody-brief"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 15*time.Second, "the routine to finish", func(ev model.Event) bool {
		if ev.Type != "state" || ev.State == nil {
			return false
		}
		for _, run := range ev.State.Runs {
			if run.RoutineID == "routine-brody-brief" && run.Status == "completed" {
				for _, bot := range ev.State.Bots {
					if bot.ID != "bot-brody" {
						continue
					}
					for _, thread := range bot.Threads {
						if thread.ID == run.ThreadID && thread.Kind == "task" {
							return true
						}
					}
				}
			}
		}
		return false
	})
}

func TestStopTurn(t *testing.T) {
	svc, _, events := newTestService(t)
	if _, err := svc.Send("bot-brody", "thread-brody-home", "hello"); err != nil {
		t.Fatal(err)
	}
	// Wait for the turn to start, then stop it.
	waitFor(t, events, 3*time.Second, "the turn to start", func(ev model.Event) bool {
		return ev.Type == "turn" && ev.Turn != nil && ev.Turn.Busy
	})
	if err := svc.Stop("bot-brody", "thread-brody-home"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the stop to settle", func(ev model.Event) bool {
		return ev.Type == "turn" && ev.Turn != nil && !ev.Turn.Busy
	})
}

func TestMarkUnread(t *testing.T) {
	svc, _, events := newTestService(t)
	if err := svc.MarkUnread("bot-brody", "thread-brody-home"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 3*time.Second, "the unread state", func(ev model.Event) bool {
		if ev.Type != "state" || ev.State == nil {
			return false
		}
		for _, bot := range ev.State.Bots {
			if bot.ID != "bot-brody" {
				continue
			}
			for _, thread := range bot.Threads {
				if thread.ID == "thread-brody-home" && thread.Unread > 0 {
					return true
				}
			}
		}
		return false
	})
}

func TestDeletingLastThreadCreatesOne(t *testing.T) {
	svc, _, events := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Solo", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	threadID := bot.Threads[0].ID
	if err := svc.DeleteThread(bot.ID, threadID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 3*time.Second, "the replacement thread", func(ev model.Event) bool {
		if ev.Type != "state" || ev.State == nil {
			return false
		}
		for _, item := range ev.State.Bots {
			if item.ID == bot.ID {
				return len(item.Threads) == 1 && item.Threads[0].ID != threadID
			}
		}
		return false
	})
}
