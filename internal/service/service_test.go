package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
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

func TestAttachmentRoundTrip(t *testing.T) {
	svc, dir, events := newTestService(t)
	png := base64.StdEncoding.EncodeToString([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
	attachment, err := svc.SaveAttachment("pixel.png", "image/png", png)
	if err != nil {
		t.Fatal(err)
	}
	if attachment.Kind != "image" || attachment.Size == 0 {
		t.Fatalf("unexpected attachment: %+v", attachment)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "attachments", attachment.ID+"-*"))
	if len(matches) != 1 {
		t.Fatalf("expected one stored file, got %v", matches)
	}
	read, err := svc.ReadAttachment(attachment.ID)
	if err != nil || read != png {
		t.Fatalf("read attachment = %q, %v", read, err)
	}
	if _, err := svc.SendWithAttachments("bot-brody", "thread-brody-home", "Look at this file", []model.Attachment{attachment}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 12*time.Second, "the attachment reply", func(ev model.Event) bool {
		return ev.Type == "message" && ev.BotID == "bot-brody" && ev.Message != nil &&
			ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
	// The user message in a state snapshot must carry the metadata.
	waitFor(t, events, 3*time.Second, "the attachment state", func(ev model.Event) bool {
		if ev.Type != "state" || ev.State == nil {
			return false
		}
		for _, bot := range ev.State.Bots {
			for _, thread := range bot.Threads {
				for _, message := range thread.Messages {
					if len(message.Attachments) == 1 && message.Attachments[0].ID == attachment.ID {
						return true
					}
				}
			}
		}
		return false
	})
	if _, err := os.Stat(matches[0]); err != nil {
		t.Fatal("attachment file disappeared")
	}
}

func TestGroupRoundTrip(t *testing.T) {
	svc, _, events := newTestService(t)
	group, err := svc.CreateGroup(model.CreateGroupInput{
		Name: "Test room", MemberIDs: []string{"bot-brody", "bot-omiii"}, LeadID: "bot-brody", Color: "purple",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(group.Threads) != 1 || group.LeadID != "bot-brody" {
		t.Fatalf("unexpected group: %+v", group)
	}
	threadID := group.Threads[0].ID
	result, err := svc.SendGroup(group.ID, threadID, "@Omiii what should we do next?")
	if err != nil {
		t.Fatal(err)
	}
	if result.GroupID != group.ID || result.BotID != "bot-omiii" {
		t.Fatalf("mention did not route to Omiii: %+v", result)
	}
	waitFor(t, events, 12*time.Second, "the group reply", func(ev model.Event) bool {
		return ev.Type == "message" && ev.GroupID == group.ID && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending
	})
	waitFor(t, events, 3*time.Second, "the group state", func(ev model.Event) bool {
		if ev.Type != "state" || ev.State == nil {
			return false
		}
		for _, item := range ev.State.Groups {
			if item.ID != group.ID {
				continue
			}
			for _, thread := range item.Threads {
				if thread.ID != threadID {
					continue
				}
				for _, message := range thread.Messages {
					if message.Role == model.RoleBot && message.SenderID == "bot-omiii" && message.SenderName == "Omiii" {
						return true
					}
				}
			}
		}
		return false
	})
}

func TestLocalComputer(t *testing.T) {
	svc, _, _ := newTestService(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Local computer\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Computer", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateBot(bot.ID, model.BotPatch{WorkingDir: &dir}); err != nil {
		t.Fatal(err)
	}
	listing, err := svc.ListComputerFiles(bot.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	resolvedDir, _ := filepath.EvalSymlinks(dir)
	if listing.Path != resolvedDir || len(listing.Entries) != 1 || listing.Entries[0].Name != "README.md" {
		t.Fatalf("unexpected listing: %+v", listing)
	}
	preview, err := svc.ReadComputerFile(bot.ID, filepath.Join(dir, "README.md"))
	if err != nil || preview.Kind != "text" || !strings.Contains(preview.Text, "Local computer") {
		t.Fatalf("preview = %+v, %v", preview, err)
	}
	if _, err := svc.ReadComputerFile(bot.ID, "/etc/passwd"); err == nil {
		t.Fatal("expected a path outside the working folder to be rejected")
	}
	result, err := svc.RunComputerCommand(bot.ID, "printf hello")
	if err != nil {
		t.Fatal(err)
	}
	if result.Stdout != "hello" || result.ExitCode != 0 {
		t.Fatalf("unexpected command result: %+v", result)
	}
}

func TestPhoneCompanion(t *testing.T) {
	svc, _, _ := newTestService(t)
	info, err := svc.SetPhoneEnabled(true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = svc.SetPhoneEnabled(false) })
	if !info.Enabled || info.Port == 0 || info.Token == "" {
		t.Fatalf("unexpected phone info: %+v", info)
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", info.Port)
	page, err := http.Get(base + "/p/" + info.Token)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(page.Body)
	_ = page.Body.Close()
	if page.StatusCode != 200 || !strings.Contains(string(body), "Grox") {
		t.Fatalf("phone page = %d %q", page.StatusCode, string(body[:min(len(body), 80)]))
	}
	stateResponse, err := http.Get(base + "/api/state?token=" + info.Token)
	if err != nil {
		t.Fatal(err)
	}
	stateBody, _ := io.ReadAll(stateResponse.Body)
	_ = stateResponse.Body.Close()
	if stateResponse.StatusCode != 200 || !strings.Contains(string(stateBody), "bot-brody") {
		t.Fatalf("phone state = %d %q", stateResponse.StatusCode, string(stateBody[:min(len(stateBody), 80)]))
	}
	payload, _ := json.Marshal(map[string]string{"botId": "bot-brody", "threadId": "thread-brody-home", "text": "Hello from the phone"})
	sendResponse, err := http.Post(base+"/api/send?token="+info.Token, "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	sendBody, _ := io.ReadAll(sendResponse.Body)
	_ = sendResponse.Body.Close()
	if sendResponse.StatusCode != 200 {
		t.Fatalf("phone send = %d %s", sendResponse.StatusCode, sendBody)
	}
}
