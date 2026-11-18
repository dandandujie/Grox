package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func TestAPISendIncludesSavedAttachmentContents(t *testing.T) {
	for _, tc := range []struct {
		name      string
		channel   bool
		withTools bool
		message   string
		withText  bool
		withImage bool
	}{
		{name: "image-only direct Ask message", withImage: true},
		{name: "channel with tools and mixed content", channel: true, withTools: true, message: "Read these", withText: true, withImage: true},
		{name: "text-only stays a string", message: "Read this", withText: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, workspace, events := newTestService(t)
			var pixel bytes.Buffer
			if err := png.Encode(&pixel, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
				t.Fatal(err)
			}
			encodedPNG := base64.StdEncoding.EncodeToString(pixel.Bytes())
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				var request struct {
					Messages []struct {
						Role    string
						Content json.RawMessage
					}
					Tools []json.RawMessage
				}
				if err := json.Unmarshal(raw, &request); err != nil || len(request.Messages) < 2 {
					t.Errorf("invalid outgoing request: %s (%v)", raw, err)
					return
				}
				userCount := 0
				for _, message := range request.Messages {
					if message.Role == "user" {
						userCount++
					}
				}
				outgoing := request.Messages[len(request.Messages)-1]
				if r.URL.Path != "/v1/chat/completions" || outgoing.Role != "user" || (len(request.Tools) > 0) != tc.withTools {
					t.Errorf("unexpected API request at %s: %s", r.URL.Path, raw)
				}
				if userCount != 1 {
					t.Errorf("expected exactly one outbound user message, got %d", userCount)
				}
				if bytes.Contains(raw, []byte(workspace)) || bytes.Contains(raw, []byte("spoofed-by-client.txt")) {
					t.Error("sent a local path or client-supplied filename")
				}
				if tc.withText && (!bytes.Contains(outgoing.Content, []byte("notes.txt")) ||
					!bytes.Contains(outgoing.Content, []byte("白色布景")) || !bytes.Contains(outgoing.Content, []byte(tc.message))) {
					t.Errorf("missing original UTF-8 text or user message: %s", outgoing.Content)
				}
				if tc.withImage {
					if !bytes.Contains(outgoing.Content, []byte("image_url")) ||
						!bytes.Contains(outgoing.Content, []byte("data:image/png;base64,"+encodedPNG)) {
						t.Errorf("missing canonical image payload: %s", outgoing.Content)
					}
				} else {
					var plain string
					if err := json.Unmarshal(outgoing.Content, &plain); err != nil {
						t.Errorf("text-only input should be a string: %s", outgoing.Content)
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"attachment accepted\"}}]}\n\ndata: [DONE]\n\n")
			}))
			defer api.Close()
			if _, err := svc.UpdateSettings(model.Settings{Theme: "midnight", SidebarWidth: 312, EngineMode: "api", APIBaseURL: api.URL + "/v1", APIModel: "vision-fixture"}); err != nil {
				t.Fatal(err)
			}
			input := model.CreateBotInput{Name: "Attachment audit", ModelID: "grox-demo"}
			if !tc.withTools {
				input.ToolPolicy.Deny = []string{"*"}
			}
			bot, err := svc.CreateBot(input)
			if err != nil {
				t.Fatal(err)
			}
			if tc.withTools {
				mode := model.ApprovalAuto
				if _, err := svc.UpdateBot(bot.ID, model.BotPatch{Approval: &mode}); err != nil {
					t.Fatal(err)
				}
			}
			var attachments []model.Attachment
			if tc.withImage {
				// Browser metadata deliberately conflicts with the bytes.
				imageFile, err := svc.SaveAttachment("frame.bin", "application/octet-stream", encodedPNG)
				if err != nil {
					t.Fatal(err)
				}
				attachments = append(attachments, imageFile)
			}
			if tc.withText {
				note, err := svc.SaveAttachment("notes.txt", "text/plain", base64.StdEncoding.EncodeToString([]byte("白色布景")))
				if err != nil {
					t.Fatal(err)
				}
				note.Name = "spoofed-by-client.txt"
				attachments = append(attachments, note)
			}
			if tc.channel {
				group, err := svc.CreateGroup(model.CreateGroupInput{Name: "Vision channel", MemberIDs: []string{bot.ID}, LeadID: bot.ID})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := svc.SendGroupWithAttachments(group.ID, group.Threads[0].ID, tc.message, attachments); err != nil {
					t.Fatal(err)
				}
			} else if _, err := svc.SendWithAttachments(bot.ID, bot.Threads[0].ID, tc.message, attachments); err != nil {
				t.Fatal(err)
			}
			waitFor(t, events, 5*time.Second, "reply from the API", func(event model.Event) bool {
				return botMessage(event, bot.ID, "attachment accepted")
			})
		})
	}
}

func TestAPIRejectsUnsupportedAttachmentBeforeUploading(t *testing.T) {
	svc, _, events := newTestService(t)
	var requests atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected upload", http.StatusBadRequest)
	}))
	defer api.Close()
	if _, err := svc.UpdateSettings(model.Settings{Theme: "midnight", SidebarWidth: 312, EngineMode: "api", APIBaseURL: api.URL, APIModel: "test"}); err != nil {
		t.Fatal(err)
	}
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Unsupported attachment audit", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	attachment, err := svc.SaveAttachment("pretend.txt", "text/plain", base64.StdEncoding.EncodeToString([]byte("%PDF-1.7\n")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SendWithAttachments(bot.ID, bot.Threads[0].ID, "Read this", []model.Attachment{attachment}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "unsupported file error", func(event model.Event) bool {
		return event.Message != nil && event.Message.Error && strings.Contains(event.Message.Text, "API messages support PNG")
	})
	if requests.Load() != 0 {
		t.Fatal("unsupported attachment reached the API")
	}
}

func TestAPIComputerReadReturnsVisionAndSavesAttachment(t *testing.T) {
	svc, _, events := newTestService(t)
	folder := t.TempDir()
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "frame.png"), imageData.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(imageData.Bytes())
	var rounds atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		switch rounds.Add(1) {
		case 1:
			if !bytes.Contains(raw, []byte(`"name":"computer_read"`)) {
				t.Error("computer_read is missing from the advertised API tools")
			}
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-frame","function":{"name":"computer_read","arguments":"{\"path\":\"frame.png\"}"}}]}}]}`+"\n\n")
		case 2:
			if !bytes.Contains(raw, []byte(`"tool_call_id":"call-frame"`)) ||
				!bytes.Contains(raw, []byte("data:image/png;base64,"+encoded)) {
				t.Errorf("second round did not receive the tool result and the original PNG: %s", raw)
			}
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"frame received\"}}]}\n\n")
		default:
			t.Error("unexpected extra API round")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer api.Close()
	if _, err := svc.UpdateSettings(model.Settings{Theme: "midnight", SidebarWidth: 312, EngineMode: "api", APIBaseURL: api.URL, APIModel: "vision-fixture"}); err != nil {
		t.Fatal(err)
	}
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Image tool audit", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	auto := model.ApprovalAuto
	if _, err := svc.UpdateBot(bot.ID, model.BotPatch{Approval: &auto, WorkingDir: &folder}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Send(bot.ID, bot.Threads[0].ID, "Inspect frame.png"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the second API reply", func(event model.Event) bool {
		return botMessage(event, bot.ID, "frame received")
	})
	svc.mu.Lock()
	thread := cloneThread(svc.findBotLocked(bot.ID).Threads[0])
	svc.mu.Unlock()
	for _, message := range thread.Messages {
		for _, attachment := range message.Attachments {
			if attachment.Name == "frame.png" {
				if got, err := svc.ReadAttachment(attachment.ID); err != nil || got != encoded {
					t.Fatalf("saved computer image differs from the original: %v", err)
				}
				return
			}
		}
	}
	t.Fatal("computer image was not attached to the conversation")
}
