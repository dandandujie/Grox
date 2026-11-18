package service

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func TestFreshWorkspaceCanRecoverFromUnavailableEngine(t *testing.T) {
	events := make(chan model.Event, 64)
	svc, err := New(t.TempDir(), func(event model.Event) { events <- event })
	if err != nil {
		t.Fatal(err)
	}
	if err := Open(svc); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { Close(svc) })
	initial := svc.st.State
	botID, threadID := initial.ActiveBotID, initial.ActiveThreadID
	if _, err := svc.UpdateBot(botID, model.BotPatch{ModelID: ptr("gpt-5.2")}); err != nil {
		t.Fatal(err)
	}
	settings := initial.Settings
	settings.EngineMode = "codex"
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	const request = "My answer: summarize these notes"
	if _, err := svc.Send(botID, threadID, request); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("disconnected send = %v", err)
	}
	thread := svc.st.State.Bots[0].Threads[0]
	if len(thread.Messages) != 0 || thread.Busy || len(svc.turns) != 0 {
		t.Fatalf("disconnected send created work: %+v", thread)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Real engine reply\"}}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)
	settings.EngineMode, settings.APIBaseURL, settings.APIModel = "api", server.URL, "test-model"
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Send(botID, threadID, request); err != nil {
		t.Fatal(err)
	}
	reply := waitFor(t, events, 5*time.Second, "the configured API reply", func(event model.Event) bool {
		return botMessage(event, botID, "Real engine reply")
	})
	if reply.Message.Engine != "OpenAI-compatible API" || reply.Message.Model != "test-model" {
		t.Fatalf("reply route = %+v", reply.Message)
	}
}

func TestSelectChannelThreadPreservesUnreadElsewhere(t *testing.T) {
	svc, _, _ := newTestService(t)
	group := &svc.st.State.Groups[0]
	groupID, firstID := group.ID, group.Threads[0].ID
	newThread, err := svc.CreateGroupThread(groupID, "New task")
	if err != nil {
		t.Fatal(err)
	}
	if newThread.Kind != "task" {
		t.Fatalf("new thread kind = %q", newThread.Kind)
	}
	group.Unread = 3
	group.Threads[0].Unread = 2
	group.Threads[1].Unread = 1
	if err := svc.SelectGroup(groupID, firstID); err != nil {
		t.Fatal(err)
	}
	if group.Unread != 2 || group.Threads[0].Unread != 2 || group.Threads[1].Unread != 0 {
		t.Fatalf("opening one thread changed other unread work: %+v", group)
	}
}
