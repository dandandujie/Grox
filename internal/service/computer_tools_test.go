package service

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func TestAPIComputerCommandRespectsApprovalAndTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires a POSIX shell")
	}
	for _, scenario := range []string{"allow", "deny", "switch", "stop"} {
		t.Run(scenario, func(t *testing.T) {
			svc, _, events := newTestService(t)
			folder, other := t.TempDir(), t.TempDir()
			var turns atomic.Int32
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				if turns.Add(1) == 1 {
					if !strings.Contains(string(raw), `"name":"computer_run"`) {
						t.Error("Ask mode did not advertise the computer tool")
					}
					fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"shell","function":{"name":"computer_run","arguments":"{\"command\":\"printf checked > marker.txt\"}"}}]}}]}`+"\n\n")
				} else {
					want := "marker.txt"
					if scenario == "deny" {
						want = "denied"
					}
					if scenario == "switch" {
						want = "changed before execution"
					}
					if scenario == "stop" || !strings.Contains(string(raw), want) {
						t.Errorf("unexpected tool result for %s: %s", scenario, raw)
					}
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Computer tool round finished\"}}]}\n\n")
				}
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer api.Close()

			_, err := svc.UpdateSettings(model.Settings{
				Theme: "midnight", EngineMode: "api", APIBaseURL: api.URL, APIModel: "computer-fixture",
			})
			if err != nil {
				t.Fatal(err)
			}
			bot, err := svc.CreateBot(model.CreateBotInput{Name: "Terminal QA"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.UpdateBot(bot.ID, model.BotPatch{WorkingDir: &folder}); err != nil {
				t.Fatal(err)
			}
			threadID := bot.Threads[0].ID
			if _, err := svc.Send(bot.ID, threadID, "Run the terminal validation"); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = svc.Stop(bot.ID, threadID) }()

			var cardID string
			waitFor(t, events, 5*time.Second, "computer approval card", func(event model.Event) bool {
				if event.State == nil {
					return false
				}
				for _, stateBot := range event.State.Bots {
					if stateBot.ID != bot.ID {
						continue
					}
					for _, message := range stateBot.Threads[0].Messages {
						if message.Approval != nil && message.Status == model.StatusPending {
							cardID = message.ID
							return strings.Contains(message.Approval.Command, "marker.txt")
						}
					}
				}
				return false
			})
			marker := filepath.Join(folder, "marker.txt")
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("command ran before approval: %v", err)
			}
			if scenario == "switch" {
				if _, err := svc.UpdateBot(bot.ID, model.BotPatch{WorkingDir: &other}); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "stop" {
				err = svc.Stop(bot.ID, threadID)
			} else {
				decision := "allow"
				if scenario == "deny" {
					decision = "deny"
				}
				err = svc.Decide(bot.ID, threadID, cardID, decision)
			}
			if err != nil {
				t.Fatal(err)
			}
			waitFor(t, events, 5*time.Second, "computer turn completed", func(event model.Event) bool {
				return event.ThreadID == threadID && event.Turn != nil && !event.Turn.Busy
			})
			if scenario == "allow" {
				data, err := os.ReadFile(marker)
				if err != nil || string(data) != "checked" {
					t.Fatalf("approved command did not run in its working folder: %q, %v", data, err)
				}
			} else if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("%s unexpectedly ran the command: %v", scenario, err)
			}
			if _, err := os.Stat(filepath.Join(other, "marker.txt")); !os.IsNotExist(err) {
				t.Fatalf("command ran in the changed folder: %v", err)
			}
		})
	}
}

func TestAPIArtifactStaysBetweenApprovalAndFinalReply(t *testing.T) {
	svc, _, events := newTestService(t)
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "result.txt"), []byte("artifact content"), 0o600); err != nil {
		t.Fatal(err)
	}
	var rounds atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		switch rounds.Add(1) {
		case 1:
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Preparing the result.\"}}]}\n\n")
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"artifact","function":{"name":"attach_file","arguments":"{\"path\":\"result.txt\"}"}}]}}]}`+"\n\n")
		case 2:
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Here is the result.\"}}]}\n\n")
		default:
			t.Error("unexpected extra API round")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer api.Close()
	_, err := svc.UpdateSettings(model.Settings{Theme: "midnight", EngineMode: "api", APIBaseURL: api.URL, APIModel: "artifact-fixture"})
	if err != nil {
		t.Fatal(err)
	}
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Artifact QA"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateBot(bot.ID, model.BotPatch{WorkingDir: &folder}); err != nil {
		t.Fatal(err)
	}
	threadID := bot.Threads[0].ID
	if _, err := svc.Send(bot.ID, threadID, "Share the result"); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = svc.Stop(bot.ID, threadID) }()
	var card string
	waitFor(t, events, 5*time.Second, "attach_file approval", func(event model.Event) bool {
		if event.State == nil {
			return false
		}
		for _, item := range event.State.Bots {
			if item.ID != bot.ID {
				continue
			}
			for _, message := range item.Threads[0].Messages {
				if message.Status == model.StatusPending && message.Approval != nil {
					card = message.ID
					return true
				}
			}
		}
		return false
	})
	if err := svc.Decide(bot.ID, threadID, card, "allow"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "final reply", func(event model.Event) bool {
		return botMessage(event, bot.ID, "Here is the result.")
	})
	svc.mu.Lock()
	history := cloneThread(svc.findBotLocked(bot.ID).Threads[0]).Messages
	svc.mu.Unlock()
	if len(history) < 4 {
		t.Fatalf("expected a preamble, card, attachment and reply: %v", history)
	}
	sequence := history[len(history)-4:]
	if sequence[0].Text != "Preparing the result." || sequence[0].Pending ||
		sequence[1].ID != card || sequence[1].Status != model.StatusAllowed ||
		len(sequence[2].Attachments) != 1 || sequence[2].Pending ||
		sequence[3].Text != "Here is the result." || sequence[3].Pending {
		t.Fatalf("unexpected transcript order: %+v", sequence)
	}
}
