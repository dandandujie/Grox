package service

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func TestApprovalGatewayRejectsBrowserOriginAndWrongHost(t *testing.T) {
	svc, _, _ := newTestService(t)
	endpoint, _, err := svc.newToolURLs(claudeHookTarget{BotID: "bot-brody", ThreadID: "thread"})
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{"null", "https://example.test"} {
		request, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", origin)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("browser origin %s got %s", origin, response.Status)
		}
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Host = "foreign.example"
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign host accepted: %s", response.Status)
	}
}

func TestAPIBrowserOpenWaitsForApproval(t *testing.T) {
	svc, _, events := newTestService(t)
	var rounds atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		switch rounds.Add(1) {
		case 1:
			if !bytes.Contains(raw, []byte(`"name":"browser_open"`)) {
				t.Error("browser_open is missing from the request")
			}
			fmt.Fprintln(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"web","function":{"name":"browser_open","arguments":"{\"url\":\"https://example.com/?secret=private-fixture\"}"}}]}}]}`)
		case 2:
			if !bytes.Contains(raw, []byte("denied this computer operation")) {
				t.Errorf("browser denial did not return to the model: %s", raw)
			}
			fmt.Fprintln(w, `data: {"choices":[{"delta":{"content":"Browser approval was declined."}}]}`)
		default:
			t.Error("unexpected browser model round")
		}
		fmt.Fprint(w, "\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	_, err := svc.UpdateSettings(model.Settings{Theme: "midnight", EngineMode: "api", APIBaseURL: upstream.URL, APIModel: "browser-fixture"})
	if err != nil {
		t.Fatal(err)
	}
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Browser QA"})
	if err != nil {
		t.Fatal(err)
	}
	thread := bot.Threads[0].ID
	if _, err := svc.Send(bot.ID, thread, "Open the example site"); err != nil {
		t.Fatal(err)
	}
	var approvalID string
	waitFor(t, events, 5*time.Second, "browser approval", func(event model.Event) bool {
		if event.State == nil {
			return false
		}
		for _, item := range event.State.Bots {
			if item.ID != bot.ID {
				continue
			}
			for _, message := range item.Threads[0].Messages {
				if message.Approval != nil && message.Status == model.StatusPending {
					approvalID = message.ID
					if !strings.Contains(message.Approval.Command, "https://example.com/") || strings.Contains(message.Approval.Command, "private-fixture") {
						t.Errorf("approval showed the wrong URL: %s", message.Approval.Command)
					}
					return true
				}
			}
		}
		return false
	})
	if rounds.Load() != 1 {
		t.Fatal("approval did not block the model call")
	}
	if err := svc.Decide(bot.ID, thread, approvalID, "deny"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "denied browser reply", func(event model.Event) bool {
		return botMessage(event, bot.ID, "Browser approval was declined.")
	})
}
