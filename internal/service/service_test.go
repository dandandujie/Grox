package service

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/dandandujie/grox/internal/agent"
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
	svc, _, events := newTestService(t)
	info, err := svc.SetPhoneEnabled(true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = svc.SetPhoneEnabled(false) })
	if !info.Enabled || info.Port == 0 || info.Token == "" || info.QR == "" {
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
	waitFor(t, events, 5*time.Second, "the phone turn to finish", func(ev model.Event) bool {
		return ev.Type == "turn" && ev.Turn != nil && ev.Turn.ThreadID == "thread-brody-home" && !ev.Turn.Busy
	})
}

func TestComposioOAuthAndTools(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/auth_configs":
			if r.URL.Query().Get("toolkit_slug") != "github" {
				t.Errorf("toolkit_slug = %q", r.URL.Query().Get("toolkit_slug"))
			}
			_, _ = w.Write([]byte(`{"items":[{"id":"ac-github","status":"ENABLED"}]}`))
		case r.URL.Path == "/connected_accounts/link":
			_, _ = w.Write([]byte(`{"redirect_url":"https://example.test/oauth","connected_account_id":"ca-github"}`))
		case r.URL.Path == "/connected_accounts" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"items":[{"id":"ca-github","status":"ACTIVE","alias":"octocat","toolkit":{"slug":"github"}}]}`))
		case r.URL.Path == "/connected_accounts/ca-github" && r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/tool_router/session" && r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{"session_id":"sess-1"}`))
		case r.URL.Path == "/tool_router/session/sess-1/tools":
			_, _ = w.Write([]byte(`{"items":[{"slug":"GITHUB_GET_REPO","name":"Get repo","description":"Read a repository","toolkit":{"slug":"github"},"input_parameters":{"type":"object"}}]}`))
		case r.URL.Path == "/tool_router/session/sess-1/execute":
			_, _ = w.Write([]byte(`{"data":{"full_name":"acme/grox"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	oldBase := composioBaseURL
	composioBaseURL = server.URL
	defer func() { composioBaseURL = oldBase }()
	t.Setenv("GROX_NO_BROWSER", "1")
	svc, _, _ := newTestService(t)
	if _, err := svc.SetSecret("composio", "test-key"); err != nil {
		t.Fatal(err)
	}
	link, err := svc.ConnectComposioApp("github")
	if err != nil {
		t.Fatal(err)
	}
	if link.URL != "https://example.test/oauth" || link.AccountID != "ca-github" {
		t.Fatalf("unexpected link: %+v", link)
	}
	count, err := svc.RefreshComposioConnections()
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("connected count = %d", count)
	}
	svc.mu.Lock()
	if !svc.st.State.Connections["github"].Connected || svc.st.State.Connections["github"].ExternalID != "ca-github" {
		t.Fatalf("connection = %+v", svc.st.State.Connections["github"])
	}
	svc.mu.Unlock()
	tools, err := svc.ListComposioTools()
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0].Slug != "GITHUB_GET_REPO" || tools[0].InputSchema == nil {
		t.Fatalf("tools = %+v", tools)
	}
	result, err := svc.ExecuteComposioTool("GITHUB_GET_REPO", map[string]any{"owner": "acme"})
	if err != nil {
		t.Fatal(err)
	}
	if result == nil {
		t.Fatal("expected a tool result")
	}
	if err := svc.DisconnectComposioApp("github"); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	if svc.st.State.Connections["github"].Connected {
		t.Fatal("connection still connected")
	}
	svc.mu.Unlock()
}

func TestRemoteSSHComputer(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}), 0o600); err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return nil, nil },
	}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				serverConn, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					_ = conn.Close()
					return
				}
				defer serverConn.Close()
				go ssh.DiscardRequests(requests)
				for newChannel := range channels {
					if newChannel.ChannelType() != "session" {
						_ = newChannel.Reject(ssh.UnknownChannelType, "session only")
						continue
					}
					channel, requests, err := newChannel.Accept()
					if err != nil {
						continue
					}
					for request := range requests {
						if request.Type != "exec" {
							continue
						}
						var payload struct{ Command string }
						if err := ssh.Unmarshal(request.Payload, &payload); err != nil {
							continue
						}
						_ = request.Reply(true, nil)
						output := "ok\n"
						switch {
						case strings.Contains(payload.Command, "uname"):
							output = "Linux fake 6.0 aarch64\n/home/tester\n"
						case strings.Contains(payload.Command, "find"):
							output = "README.md\tf\t13\t1700000000\nnotes\td\t0\t1700000001\n"
						case strings.Contains(payload.Command, "wc -c"):
							output = "13\n"
						case strings.Contains(payload.Command, "head -c"):
							output = "hello remote\n"
						case strings.Contains(payload.Command, "printf hello"):
							output = "hello"
						}
						_, _ = channel.Write([]byte(output))
						_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
						_ = channel.Close()
						break
					}
					_ = channel.Close()
				}
			}()
		}
	}()
	addr := listener.Addr().(*net.TCPAddr)
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Remote", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	mode, host, user, root, keyField, port := "ssh", "127.0.0.1", "tester", "/home/tester", keyPath, addr.Port
	if _, err := svc.UpdateBot(bot.ID, model.BotPatch{ComputerMode: &mode, SSHHost: &host, SSHUser: &user, SSHRoot: &root, SSHKeyPath: &keyField, SSHPort: &port}); err != nil {
		t.Fatal(err)
	}
	uname, err := svc.TestRemoteComputer(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(uname, "Linux fake") {
		t.Fatalf("uname = %q", uname)
	}
	listing, err := svc.ListComputerFiles(bot.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 2 || listing.Entries[0].Name != "notes" {
		t.Fatalf("listing = %+v", listing)
	}
	preview, err := svc.ReadComputerFile(bot.ID, "/home/tester/README.md")
	if err != nil || !strings.Contains(preview.Text, "hello remote") {
		t.Fatalf("preview = %+v, %v", preview, err)
	}
	result, err := svc.RunComputerCommand(bot.ID, "printf hello")
	if err != nil || result.Stdout != "hello" {
		t.Fatalf("result = %+v, %v", result, err)
	}
}

func TestEngineRequestAttachesComposioTools(t *testing.T) {
	svc, _, _ := newTestService(t)
	svc.composioToolsMu.Lock()
	svc.composioTools = []model.ComposioTool{{Slug: "GITHUB_GET_REPO", Name: "Get repo", Description: "Read a repo", Toolkit: "github", InputSchema: map[string]any{"type": "object"}}}
	svc.composioToolsAt = time.Now()
	svc.composioToolsMu.Unlock()
	bot := model.Bot{Name: "Auto", Approval: model.ApprovalAuto, ModelID: "gpt-5.2"}
	thread := model.Thread{ID: "t", Messages: []model.Message{{ID: "m", Role: model.RoleUser, Text: "hi"}}}
	req, _ := svc.engineRequestLocked(&bot, &thread, "hi", "")
	if len(req.Tools) != 7 || req.ExecuteTool == nil {
		t.Fatalf("auto tools = %+v", req.Tools)
	}
	names := map[string]bool{}
	for _, tool := range req.Tools {
		names[tool.Name] = true
	}
	if !names["ask_user"] || !names["decide"] || !names["extract"] || !names["memory_update"] || !names["memory_tidy"] || !names["memory_forget"] || !names["GITHUB_GET_REPO"] {
		t.Fatalf("auto tools missing built-ins = %+v", req.Tools)
	}
	bot.Approval = model.ApprovalAsk
	req, _ = svc.engineRequestLocked(&bot, &thread, "hi", "")
	if len(req.Tools) != 0 {
		t.Fatalf("ask mode received tools: %+v", req.Tools)
	}
}

func TestClaudePermissionHook(t *testing.T) {
	svc, _, events := newTestService(t)
	hookURL, err := svc.newClaudeHookURL(claudeHookTarget{BotID: "bot-brody", ThreadID: "thread-brody-home"})
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{
		"tool_name": "Bash", "tool_input": map[string]any{"command": "ls"},
	})
	type hookResponse struct {
		Body []byte
		Err  error
	}
	response := make(chan hookResponse, 1)
	go func() {
		resp, err := http.Post(hookURL, "application/json", bytes.NewReader(payload))
		if err != nil {
			response <- hookResponse{Err: err}
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		response <- hookResponse{Body: body}
	}()
	messageID := ""
	waitFor(t, events, 3*time.Second, "the hook approval card", func(ev model.Event) bool {
		if ev.Type == "message" && ev.Message != nil && ev.Message.Kind == model.KindApproval && ev.Message.Status == model.StatusPending {
			messageID = ev.Message.ID
			return true
		}
		return false
	})
	if err := svc.Decide("bot-brody", "thread-brody-home", messageID, "allow"); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-response:
		if result.Err != nil {
			t.Fatal(result.Err)
		}
		if !strings.Contains(string(result.Body), "allow") {
			t.Fatalf("hook response = %s", result.Body)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("hook did not receive the decision")
	}
}

func TestMCPAndGenericToolHook(t *testing.T) {
	svc, _, events := newTestService(t)
	svc.composioToolsMu.Lock()
	svc.composioTools = []model.ComposioTool{{Slug: "GITHUB_GET_REPO", Name: "Get repo", Description: "Read a repo", Toolkit: "github", InputSchema: map[string]any{"type": "object"}}}
	svc.composioToolsAt = time.Now()
	svc.composioToolsMu.Unlock()
	target := claudeHookTarget{BotID: "bot-brody", ThreadID: "thread-brody-home"}
	mcpURL, hookURL, err := svc.newToolURLs(target)
	if err != nil {
		t.Fatal(err)
	}
	initialize, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18"}})
	resp, err := http.Post(mcpURL, "application/json", bytes.NewReader(initialize))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "grox") {
		t.Fatalf("initialize = %d %s", resp.StatusCode, body)
	}
	list, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	resp, err = http.Post(mcpURL, "application/json", bytes.NewReader(list))
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !strings.Contains(string(body), "GITHUB_GET_REPO") {
		t.Fatalf("tools/list = %s", body)
	}
	hookPayload, _ := json.Marshal(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "ls"}})
	type hookResult struct {
		Body []byte
		Err  error
	}
	result := make(chan hookResult, 1)
	go func() {
		response, err := http.Post(hookURL+"?style=codex", "application/json", bytes.NewReader(hookPayload))
		if err != nil {
			result <- hookResult{Err: err}
			return
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		result <- hookResult{Body: data}
	}()
	messageID := ""
	waitFor(t, events, 3*time.Second, "the generic hook approval", func(ev model.Event) bool {
		if ev.Type == "message" && ev.Message != nil && ev.Message.Kind == model.KindApproval && ev.Message.Status == model.StatusPending {
			messageID = ev.Message.ID
			return true
		}
		return false
	})
	if err := svc.Decide("bot-brody", "thread-brody-home", messageID, "allow"); err != nil {
		t.Fatal(err)
	}
	select {
	case hook := <-result:
		if hook.Err != nil {
			t.Fatal(hook.Err)
		}
		if strings.TrimSpace(string(hook.Body)) != "{}" {
			t.Fatalf("codex hook response = %s", hook.Body)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("generic hook did not reply")
	}
}

func TestSkillsDiscoverAndInject(t *testing.T) {
	svc, dataDir, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Skill Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	workdir := t.TempDir()
	if _, err := svc.UpdateBot(bot.ID, model.BotPatch{WorkingDir: &workdir}); err != nil {
		t.Fatal(err)
	}
	globalDir := filepath.Join(dataDir, "skills", "launch")
	workspaceDir := filepath.Join(workdir, ".grox", "skills", "code")
	if err := os.MkdirAll(globalDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workspaceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(globalDir, "SKILL.md"), []byte("---\nname: Launch report\ndescription: Build a launch brief.\n---\n\n# Launch\n\nCheck the checklist.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspaceDir, "SKILL.md"), []byte("---\nname: Code review\ndescription: Review a diff.\n---\n\nRead the diff before commenting.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	skills, err := svc.ListSkills(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(skills) < 2 {
		t.Fatalf("expected discovered skills, got %+v", skills)
	}
	var codeID string
	for _, skill := range skills {
		if skill.Name == "Code review" {
			codeID = skill.ID
			if skill.Enabled {
				t.Fatal("skills must start disabled")
			}
		}
	}
	if codeID == "" {
		t.Fatalf("code skill missing: %+v", skills)
	}
	if _, err := svc.SetSkillEnabled(bot.ID, codeID, true); err != nil {
		t.Fatal(err)
	}
	read, err := svc.ReadSkill(bot.ID, codeID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read.Body, "Read the diff before commenting") {
		t.Fatalf("read body = %q", read.Body)
	}
	svc.mu.Lock()
	stored := svc.findBotLocked(bot.ID)
	text := svc.enabledSkillTextLocked(stored)
	svc.mu.Unlock()
	if !strings.Contains(text, "Read the diff before commenting") || strings.Contains(text, "Check the checklist") {
		t.Fatalf("enabled prompt = %q", text)
	}
	svc.mu.Lock()
	stored = svc.findBotLocked(bot.ID)
	thread := &stored.Threads[0]
	req, _ := svc.engineRequestLocked(stored, thread, "Review this", "")
	svc.mu.Unlock()
	if !strings.Contains(req.SkillText, "Read the diff before commenting") {
		t.Fatalf("request skill text = %q", req.SkillText)
	}
	if !strings.Contains(req.Prompt, "## Enabled skills") || !strings.Contains(req.Prompt, "Read the diff before commenting") {
		t.Fatalf("request prompt missing skills = %q", req.Prompt)
	}
}

func TestMemoryLoadBudgetConflictAndSwitch(t *testing.T) {
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Memory Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	state, err := svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Enabled || state.LimitLines != 200 || state.LimitBytes != 24*1024 {
		t.Fatalf("initial memory state = %+v", state)
	}
	var notes strings.Builder
	for index := 1; index <= 260; index++ {
		notes.WriteString("- note ")
		notes.WriteString(strconv.Itoa(index))
		notes.WriteString("\n")
	}
	saved, err := svc.SaveMemory(bot.ID, notes.String(), state.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Lines != 260 || saved.LoadedLines != 200 {
		t.Fatalf("saved memory budget = %+v", saved)
	}
	if _, err := svc.SaveMemory(bot.ID, "changed", state.Revision); err == nil {
		t.Fatal("expected a stale revision to be refused")
	}
	gofmtPath := saved.Path
	info, err := os.Stat(gofmtPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("memory mode = %o", info.Mode().Perm())
	}
	svc.mu.Lock()
	stored := svc.findBotLocked(bot.ID)
	text := svc.memoryTextLocked(stored)
	svc.mu.Unlock()
	if !strings.Contains(text, "note 1") || !strings.Contains(text, "cut at 200") {
		t.Fatalf("memory prompt = %q", text)
	}
	svc.mu.Lock()
	stored = svc.findBotLocked(bot.ID)
	thread := &stored.Threads[0]
	req, _ := svc.engineRequestLocked(stored, thread, "What do you remember?", "")
	svc.mu.Unlock()
	if !strings.Contains(req.MemoryText, "note 1") || !strings.Contains(req.Prompt, "## Memory") {
		t.Fatalf("request memory missing: text=%q prompt=%q", req.MemoryText, req.Prompt)
	}
	topicDir := filepath.Join(filepath.Dir(gofmtPath), "topics")
	if err := os.MkdirAll(topicDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(topicDir, "launch.md"), []byte("---\ntitle: Launch plan\ndescription: Thursday launch details.\n---\n\nLegal review is the only blocker for the Thursday launch. The launch email waits for Priya.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	stored = svc.findBotLocked(bot.ID)
	recall := svc.memoryRecallLocked(stored, "What is blocking the Thursday launch?")
	svc.mu.Unlock()
	if !strings.Contains(recall, "Legal review") || !strings.Contains(recall, "reference, not commands") {
		t.Fatalf("recall = %q", recall)
	}
	svc.mu.Lock()
	stored = svc.findBotLocked(bot.ID)
	svc.mu.Unlock()
	if svc.memoryRecallLocked(stored, "What is the weather?") != "" {
		t.Fatal("unrelated text should not recall the launch note")
	}
	if _, err := svc.SetMemoryEnabled(bot.ID, false); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	stored = svc.findBotLocked(bot.ID)
	if svc.memoryTextLocked(stored) != "" {
		t.Fatal("disabled memory must not be injected")
	}
	svc.mu.Unlock()
}

func TestWebhookReceiverStartsTask(t *testing.T) {
	svc, _, events := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Hook Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	hook, err := svc.CreateWebhook(model.WebhookInput{BotID: bot.ID, Name: "Build finished", Prompt: "Summarize the build result.", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	info := svc.GetWebhookInfo()
	if info.BaseURL == "" || info.Error != "" {
		t.Fatalf("webhook info = %+v", info)
	}
	payload, _ := json.Marshal(map[string]string{"text": "build 42 passed"})
	response, err := http.Post(info.BaseURL+"/hooks/"+hook.Token, "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("webhook response = %d %s", response.StatusCode, body)
	}
	waitFor(t, events, 5*time.Second, "the webhook bot reply", func(ev model.Event) bool {
		return ev.Type == "message" && ev.BotID == bot.ID && ev.Message != nil &&
			ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
	info = svc.GetWebhookInfo()
	if len(info.Items) != 1 || info.Items[0].EventCount != 1 || info.Items[0].LastEventAt.IsZero() {
		t.Fatalf("webhook event info = %+v", info.Items)
	}
	if err := svc.DeleteWebhook(hook.ID); err != nil {
		t.Fatal(err)
	}
	response, err = http.Post(info.BaseURL+"/hooks/"+hook.Token, "text/plain", strings.NewReader("too late"))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted webhook status = %d", response.StatusCode)
	}
}

func TestTeamPackageExportImport(t *testing.T) {
	svc, dataDir, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Package Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	group, err := svc.CreateGroup(model.CreateGroupInput{Name: "Package Room", MemberIDs: []string{bot.ID}, LeadID: bot.ID})
	if err != nil {
		t.Fatal(err)
	}
	skillDir := filepath.Join(dataDir, "skills", "team-skill")
	if err := os.MkdirAll(skillDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: Team skill\ndescription: Carried with the package.\n---\n\nUse the team checklist.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	skills, err := svc.ListSkills(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, skill := range skills {
		if skill.Name == "Team skill" {
			if _, err := svc.SetSkillEnabled(bot.ID, skill.ID, true); err != nil {
				t.Fatal(err)
			}
		}
	}
	memory, err := svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SaveMemory(bot.ID, "- The package keeps this note.", memory.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateRoutine(model.RoutineInput{BotID: bot.ID, Name: "Package routine", Prompt: "Check the checklist", Cadence: "daily", TimeOfDay: "09:00", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	raw, err := svc.ExportTeam(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "secrets") || strings.Contains(raw, "apiKey") {
		t.Fatalf("package leaked a credential-shaped field: %s", raw)
	}
	var pkg model.TeamPackage
	if err := json.Unmarshal([]byte(raw), &pkg); err != nil {
		t.Fatal(err)
	}
	if pkg.Format != "grox.team" || len(pkg.Bots) != 1 || len(pkg.Bots[0].Skills) != 1 {
		t.Fatalf("exported package = %+v", pkg)
	}
	if pkg.Signature == "" || pkg.PublicKey == "" || pkg.SignedAt.IsZero() {
		t.Fatalf("exported package is unsigned = %+v", pkg)
	}
	if err := verifyTeamPackage(pkg); err != nil {
		t.Fatalf("signature verify = %v", err)
	}
	tampered := pkg
	tampered.Bots[0].Name += " tampered"
	if err := verifyTeamPackage(tampered); err == nil {
		t.Fatal("tampered package verified")
	}
	tamperedRaw, _ := json.Marshal(tampered)
	if _, err := svc.ImportTeam(string(tamperedRaw)); err == nil {
		t.Fatal("tampered package imported")
	}
	result, err := svc.ImportTeam(raw)
	if err != nil {
		t.Fatal(err)
	}
	if result.Bots != 1 || result.Groups != 1 || result.Routines != 1 || result.Skills != 1 || result.Memories != 1 {
		t.Fatalf("import result = %+v", result)
	}
	svc.mu.Lock()
	var imported *model.Bot
	for index := range svc.st.State.Bots {
		if svc.st.State.Bots[index].Name == "Package Bot 2" {
			imported = &svc.st.State.Bots[index]
		}
	}
	svc.mu.Unlock()
	if imported == nil {
		t.Fatal("imported bot not found")
	}
	memory, err = svc.GetMemory(imported.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(memory.Content, "package keeps this note") {
		t.Fatalf("imported memory = %q", memory.Content)
	}
	if len(imported.Skills) != 0 {
		t.Fatalf("imported skills must start disabled: %+v", imported.Skills)
	}
	svc.mu.Lock()
	routines := append([]model.Routine(nil), svc.st.State.Routines...)
	svc.mu.Unlock()
	for _, routine := range routines {
		if routine.Name == "Package routine" && routine.BotID == imported.ID {
			if routine.Enabled {
				t.Fatal("imported routine must start paused")
			}
			return
		}
	}
	t.Fatal("imported routine not found")
}

func TestAskUserMCPWaitsForAnswer(t *testing.T) {
	svc, _, events := newTestService(t)
	target := claudeHookTarget{BotID: "bot-brody", ThreadID: "thread-brody-home"}
	mcpURL, _, err := svc.newToolURLs(target)
	if err != nil {
		t.Fatal(err)
	}
	params := map[string]any{
		"name": "ask_user",
		"arguments": map[string]any{
			"question": "Ship the launch page?",
			"options": []any{
				map[string]any{"label": "Ship it", "description": "Publish today."},
				map[string]any{"label": "Hold", "description": "Wait for legal."},
			},
		},
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": params})
	type result struct {
		Body []byte
		Err  error
	}
	responseCh := make(chan result, 1)
	go func() {
		response, err := http.Post(mcpURL, "application/json", bytes.NewReader(body))
		if err != nil {
			responseCh <- result{Err: err}
			return
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		responseCh <- result{Body: data}
	}()
	var messageID string
	waitFor(t, events, 5*time.Second, "the ask_user card", func(ev model.Event) bool {
		if ev.Type == "message" && ev.Message != nil && ev.Message.Kind == model.KindOptions && ev.Message.Status == model.StatusPending {
			messageID = ev.Message.ID
			return true
		}
		return false
	})
	if err := svc.Answer("bot-brody", "thread-brody-home", messageID, "Ship it"); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-responseCh:
		if result.Err != nil {
			t.Fatal(result.Err)
		}
		if !strings.Contains(string(result.Body), "User answered: Ship it") {
			t.Fatalf("ask_user response = %s", result.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ask_user did not reply")
	}
}

func TestMCPServerRegistryKeepsTokenOutOfState(t *testing.T) {
	svc, _, _ := newTestService(t)
	server, err := svc.CreateMCPServer(model.MCPServerInput{Name: "Linear MCP", URL: "https://mcp.example.test/mcp", Token: "secret-token", Headers: map[string]string{"X-Test": "header-value"}, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if !server.AuthConfigured || len(server.HeaderNames) != 1 {
		t.Fatalf("server auth/header names = %+v", server)
	}
	if _, err := svc.CreateMCPServer(model.MCPServerInput{Name: "Bad", URL: "file:///tmp/x", Enabled: true}); err == nil {
		t.Fatal("file URL should be refused")
	}
	if _, err := svc.CreateMCPServer(model.MCPServerInput{Name: "Empty", Transport: "stdio", Enabled: true}); err == nil {
		t.Fatal("stdio without a command should be refused")
	}
	local, err := svc.CreateMCPServer(model.MCPServerInput{Name: "Local tools", Transport: "stdio", Command: "/bin/mcp-tool", Args: []string{"--stdio"}, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if local.Command != "/bin/mcp-tool" || len(local.Args) != 1 {
		t.Fatalf("stdio server = %+v", local)
	}
	state, _ := json.Marshal(svc.st.State)
	if strings.Contains(string(state), "secret-token") || strings.Contains(string(state), "header-value") {
		t.Fatal("MCP secret leaked into AppState")
	}
	svc.mu.Lock()
	configs := svc.mcpConfigsLocked("")
	svc.mu.Unlock()
	if len(configs) != 2 {
		t.Fatalf("runtime config = %+v", configs)
	}
	if configs[0].Token != "secret-token" && configs[1].Token != "secret-token" {
		t.Fatalf("HTTP token missing from runtime config = %+v", configs)
	}
	if configs[0].Headers["X-Test"] != "header-value" && configs[1].Headers["X-Test"] != "header-value" {
		t.Fatalf("HTTP header missing from runtime config = %+v", configs)
	}
	updated, err := svc.UpdateMCPServer(server.ID, model.MCPServerPatch{Enabled: new(bool)})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Enabled {
		t.Fatal("server should be disabled")
	}
	if _, err := svc.UpdateMCPServer(server.ID, model.MCPServerPatch{Token: new(string)}); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	configs = svc.mcpConfigsLocked("")
	svc.mu.Unlock()
	if len(configs) != 1 || configs[0].Name != "local-tools" || configs[0].Transport != "stdio" {
		t.Fatalf("stdio runtime config = %+v", configs)
	}
	if err := svc.DeleteMCPServer(server.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := svc.st.Secrets[mcpSecretName(server.ID)]; ok {
		t.Fatal("token should be removed with the server")
	}
}

func TestPresetsCreateFromBotAndDelete(t *testing.T) {
	svc, _, _ := newTestService(t)
	presets := svc.ListPresets()
	if len(presets) == 0 {
		t.Fatal("seed presets are missing")
	}
	created, err := svc.CreatePreset(model.PresetInput{
		Name: "Research", Title: "Research analyst", Description: "Maps and sources.",
		Soul: "Lead with the finding.", Color: "green",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != "Research 2" {
		t.Fatalf("duplicate preset name = %q", created.Name)
	}
	if len(svc.ListPresets()) != len(presets)+1 {
		t.Fatal("preset was not appended")
	}
	if err := svc.DeletePreset(created.ID); err != nil {
		t.Fatal(err)
	}
	if len(svc.ListPresets()) != len(presets) {
		t.Fatal("preset was not deleted")
	}
}

func TestWebhookHMACAndReplay(t *testing.T) {
	svc, _, events := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Signed Hook Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	hook, err := svc.CreateWebhook(model.WebhookInput{BotID: bot.ID, Name: "Signed", Prompt: "Read the build.", Enabled: true, RequireSignature: true})
	if err != nil {
		t.Fatal(err)
	}
	if !hook.RequireSignature {
		t.Fatal("signature requirement not stored")
	}
	info := svc.GetWebhookInfo()
	body := []byte(`{"text":"build 42 passed"}`)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(hook.Token))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	request, _ := http.NewRequest(http.MethodPost, info.BaseURL+"/hooks/"+hook.Token, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Grox-Timestamp", timestamp)
	request.Header.Set("X-Grox-Delivery", "delivery-1")
	request.Header.Set("X-Grox-Signature", signature)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("signed webhook status = %d", response.StatusCode)
	}
	waitFor(t, events, 5*time.Second, "the signed webhook turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.BotID == bot.ID && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
	request, _ = http.NewRequest(http.MethodPost, info.BaseURL+"/hooks/"+hook.Token, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Grox-Timestamp", timestamp)
	request.Header.Set("X-Grox-Delivery", "delivery-1")
	request.Header.Set("X-Grox-Signature", signature)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("replay status = %d", response.StatusCode)
	}
	request, _ = http.NewRequest(http.MethodPost, info.BaseURL+"/hooks/"+hook.Token, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Grox-Timestamp", timestamp)
	request.Header.Set("X-Grox-Delivery", "delivery-2")
	request.Header.Set("X-Grox-Signature", "sha256=bad")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad signature status = %d", response.StatusCode)
	}
}

func TestMemoryUpdateToolWritesTopic(t *testing.T) {
	svc, _, _ := newTestService(t)
	target := claudeHookTarget{BotID: "bot-brody", ThreadID: "thread-brody-home"}
	mcpURL, _, err := svc.newToolURLs(target)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 4, "method": "tools/call",
		"params": map[string]any{"name": "memory_update", "arguments": map[string]any{
			"text": "The launch prefers Tuesday.", "topic": "Launch notes",
		}},
	})
	response, err := http.Post(mcpURL, "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(body), "Saved to memory/topics/launch-notes.md") {
		t.Fatalf("memory tool response = %d %s", response.StatusCode, body)
	}
	state, err := svc.GetMemory("bot-brody")
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Topics) != 1 || state.Topics[0].Title != "Launch notes" {
		t.Fatalf("memory topics = %+v", state.Topics)
	}
	topicPath := filepath.Join(filepath.Dir(state.Path), "topics", "launch-notes.md")
	data, err := os.ReadFile(topicPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "prefers Tuesday") {
		t.Fatalf("memory topic = %s", data)
	}
}

func TestMemoryTidyArchivesOldDatedEntries(t *testing.T) {
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Tidy Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	state, err := svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	var memory strings.Builder
	memory.WriteString("# Manual header\n\n")
	for index := 1; index <= 260; index++ {
		memory.WriteString("- 2026-01-")
		memory.WriteString(fmt.Sprintf("%02d", (index%28)+1))
		memory.WriteString(" · entry ")
		memory.WriteString(strconv.Itoa(index))
		memory.WriteString("\n")
	}
	if _, err := svc.SaveMemory(bot.ID, memory.String(), state.Revision); err != nil {
		t.Fatal(err)
	}
	result, err := svc.TidyMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Archived == 0 || !result.Within || result.Lines > 200 {
		t.Fatalf("tidy result = %+v", result)
	}
	state, err = svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(state.Content, "Manual header") {
		t.Fatalf("manual header lost: %q", state.Content)
	}
	if state.Lines > 200 {
		t.Fatalf("memory still over budget: %d lines", state.Lines)
	}
	archive, err := os.ReadFile(filepath.Join(filepath.Dir(state.Path), "topics", "archive.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(archive), "entry 1") || !strings.Contains(string(archive), "moved") {
		t.Fatalf("archive = %s", archive)
	}
	found := false
	for _, topic := range state.Topics {
		if topic.Name == "archive" {
			found = true
		}
	}
	if !found {
		t.Fatalf("archive topic missing: %+v", state.Topics)
	}
}

func TestMemoryTopicReadSaveDelete(t *testing.T) {
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Topic Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.appendMemory(bot.ID, "The launch is Tuesday.", "Launch notes"); err != nil {
		t.Fatal(err)
	}
	topic, err := svc.ReadMemoryTopic(bot.ID, "launch-notes")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(topic.Content, "Tuesday") || topic.Revision == "" {
		t.Fatalf("topic read = %+v", topic)
	}
	next, err := svc.SaveMemoryTopic(bot.ID, "launch-notes", topic.Content+"\nThe email waits for Priya.\n", topic.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(next.Content, "Priya") {
		t.Fatalf("topic save = %+v", next)
	}
	if _, err := svc.SaveMemoryTopic(bot.ID, "launch-notes", "clobber", topic.Revision); err == nil {
		t.Fatal("expected stale topic revision to fail")
	}
	if err := svc.DeleteMemoryTopic(bot.ID, "launch-notes"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReadMemoryTopic(bot.ID, "launch-notes"); err == nil {
		t.Fatal("deleted topic still readable")
	}
	if _, err := svc.ReadMemoryTopic(bot.ID, "../secret"); err == nil {
		t.Fatal("path traversal should be refused")
	}
}

func TestForgetMemoryArchivesMatches(t *testing.T) {
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Forget Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.appendMemory(bot.ID, "The launch is Tuesday.", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.appendMemory(bot.ID, "The office is in Brooklyn.", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.appendMemory(bot.ID, "Priya owns the launch email.", ""); err != nil {
		t.Fatal(err)
	}
	result, err := svc.ForgetMemory(bot.ID, "launch")
	if err != nil {
		t.Fatal(err)
	}
	if result.Removed != 2 || result.Archived != 2 {
		t.Fatalf("forget result = %+v", result)
	}
	state, err := svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(state.Content, "launch") || !strings.Contains(state.Content, "Brooklyn") {
		t.Fatalf("memory after forget = %q", state.Content)
	}
	archive, err := os.ReadFile(filepath.Join(filepath.Dir(state.Path), "topics", "archive.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(archive), "forgotten") || !strings.Contains(string(archive), "Priya") {
		t.Fatalf("archive after forget = %s", archive)
	}
	if _, err := svc.ForgetMemory(bot.ID, "la"); err == nil {
		t.Fatal("expected too-short forget query to fail")
	}
}

func TestBotDepartmentCreateAndPatch(t *testing.T) {
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Dept Bot", Department: "Research", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	if bot.Department != "Research" {
		t.Fatalf("department = %q", bot.Department)
	}
	name := "Operations"
	updated, err := svc.UpdateBot(bot.ID, model.BotPatch{Department: &name})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Department != "Operations" {
		t.Fatalf("patched department = %q", updated.Department)
	}
	empty := ""
	updated, err = svc.UpdateBot(bot.ID, model.BotPatch{Department: &empty})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Department != "General" {
		t.Fatalf("empty department = %q", updated.Department)
	}
}

func TestToolPolicyFiltersAPITools(t *testing.T) {
	if !toolPatternMatch("GITHUB_*", "github_get_repo") || toolPatternMatch("GITHUB_*", "SLACK_SEND") || toolPatternMatch("*", "anything") == false {
		t.Fatal("tool pattern matching failed")
	}
	if toolAllowed(model.ToolPolicy{Allow: []string{"GITHUB_*"}, Deny: []string{"GITHUB_DELETE_*"}}, "GITHUB_DELETE_REPO") {
		t.Fatal("deny should win")
	}
	svc, _, _ := newTestService(t)
	svc.composioToolsMu.Lock()
	svc.composioTools = []model.ComposioTool{
		{Slug: "GITHUB_GET_REPO", Name: "Get repo", Description: "Read", InputSchema: map[string]any{"type": "object"}},
		{Slug: "SLACK_SEND", Name: "Send", Description: "Send", InputSchema: map[string]any{"type": "object"}},
	}
	svc.composioToolsAt = time.Now()
	svc.composioToolsMu.Unlock()
	bot := model.Bot{Name: "Policy Bot", Approval: model.ApprovalAuto, ModelID: "gpt-5.2", ToolPolicy: model.ToolPolicy{Allow: []string{"GITHUB_*"}}}
	thread := model.Thread{ID: "t", Messages: []model.Message{{ID: "m", Role: model.RoleUser, Text: "hi"}}}
	req, _ := svc.engineRequestLocked(&bot, &thread, "hi", "")
	if len(req.Tools) != 1 || req.Tools[0].Name != "GITHUB_GET_REPO" {
		t.Fatalf("policy tools = %+v", req.Tools)
	}
}

func TestToolPolicyFiltersMCPListAndCall(t *testing.T) {
	svc, _, _ := newTestService(t)
	name := "Policy Bot"
	bot, err := svc.CreateBot(model.CreateBotInput{Name: name, ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateBot(bot.ID, model.BotPatch{ToolPolicy: &model.ToolPolicy{Allow: []string{"memory_*"}}}); err != nil {
		t.Fatal(err)
	}
	target := claudeHookTarget{BotID: bot.ID, ThreadID: bot.Threads[0].ID}
	mcpURL, _, err := svc.newToolURLs(target)
	if err != nil {
		t.Fatal(err)
	}
	listPayload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
	response, err := http.Post(mcpURL, "application/json", bytes.NewReader(listPayload))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if !strings.Contains(string(body), "memory_update") || strings.Contains(string(body), "ask_user") {
		t.Fatalf("policy tools/list = %s", body)
	}
	callPayload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "ask_user", "arguments": map[string]any{"question": "hi"}}})
	response, err = http.Post(mcpURL, "application/json", bytes.NewReader(callPayload))
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	_ = response.Body.Close()
	if !strings.Contains(string(body), "blocked by this bot's tool policy") {
		t.Fatalf("policy tools/call = %s", body)
	}
}

func TestWebhookDeliveryJournalAndReplay(t *testing.T) {
	svc, _, events := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Replay Hook Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	hook, err := svc.CreateWebhook(model.WebhookInput{BotID: bot.ID, Name: "Replay", Prompt: "Read the event.", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	info := svc.GetWebhookInfo()
	payload, _ := json.Marshal(map[string]string{"text": "first delivery"})
	response, err := http.Post(info.BaseURL+"/hooks/"+hook.Token, "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("delivery status = %d", response.StatusCode)
	}
	waitFor(t, events, 5*time.Second, "the first delivery turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.BotID == bot.ID && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
	info = svc.GetWebhookInfo()
	if len(info.Deliveries) != 1 || !strings.Contains(info.Deliveries[0].Payload, "first delivery") {
		t.Fatalf("deliveries = %+v", info.Deliveries)
	}
	threadID, err := svc.ReplayWebhookDelivery(info.Deliveries[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if threadID == "" {
		t.Fatal("replay did not create a thread")
	}
	waitFor(t, events, 5*time.Second, "the replayed delivery turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.BotID == bot.ID && ev.ThreadID == threadID && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
	info = svc.GetWebhookInfo()
	if len(info.Deliveries) != 2 {
		t.Fatalf("replay deliveries = %+v", info.Deliveries)
	}
}

func TestMemoryAutoUpkeep(t *testing.T) {
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Upkeep Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	auto := true
	if _, err := svc.UpdateBot(bot.ID, model.BotPatch{MemoryAutoTidy: &auto}); err != nil {
		t.Fatal(err)
	}
	state, err := svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	var memory strings.Builder
	for index := 1; index <= 230; index++ {
		memory.WriteString("- 2026-02-")
		memory.WriteString(fmt.Sprintf("%02d", (index%28)+1))
		memory.WriteString(" · auto entry ")
		memory.WriteString(strconv.Itoa(index))
		memory.WriteString("\n")
	}
	if _, err := svc.SaveMemory(bot.ID, memory.String(), state.Revision); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	svc.lastMemoryUpkeep = time.Time{}
	svc.mu.Unlock()
	svc.runMemoryUpkeep()
	state, err = svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Lines > 200 {
		t.Fatalf("auto upkeep left %d lines", state.Lines)
	}
	found := false
	for _, topic := range state.Topics {
		if topic.Name == "archive" {
			found = true
		}
	}
	if !found {
		t.Fatal("auto upkeep did not archive")
	}
}

func TestAutomationAPIStateAndMessage(t *testing.T) {
	svc, _, events := newTestService(t)
	info, err := svc.SetAPIEnabled(true)
	if err != nil {
		t.Fatal(err)
	}
	if info.URL == "" || info.Token == "" {
		t.Fatalf("API info = %+v", info)
	}
	response, err := http.Get(info.URL + "/v1/state")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated state = %d", response.StatusCode)
	}
	request, _ := http.NewRequest(http.MethodGet, info.URL+"/v1/state", nil)
	request.Header.Set("Authorization", "Bearer "+info.Token)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authenticated state = %d", response.StatusCode)
	}
	_ = response.Body.Close()
	bot := svc.st.State.Bots[0]
	thread := bot.Threads[0]
	payload, _ := json.Marshal(map[string]string{"text": "hello from the API"})
	request, _ = http.NewRequest(http.MethodPost, info.URL+"/v1/bots/"+bot.ID+"/threads/"+thread.ID+"/messages", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer "+info.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("API message status = %d", response.StatusCode)
	}
	waitFor(t, events, 5*time.Second, "the API message turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.BotID == bot.ID && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
	if _, err := svc.SetAPIEnabled(false); err != nil {
		t.Fatal(err)
	}
	if info := svc.GetAPIInfo(); info.Enabled || info.URL != "" {
		t.Fatalf("API should be stopped = %+v", info)
	}
}

func TestAutomationAPIEvents(t *testing.T) {
	svc, _, events := newTestService(t)
	info, err := svc.SetAPIEnabled(true)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = svc.SetAPIEnabled(false) }()
	client := &http.Client{Timeout: 8 * time.Second}
	request, _ := http.NewRequest(http.MethodGet, info.URL+"/v1/events", nil)
	request.Header.Set("Authorization", "Bearer "+info.Token)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "event: ready" {
		t.Fatalf("SSE ready = %q %v", line, err)
	}
	bot := svc.st.State.Bots[0]
	thread := bot.Threads[0]
	payload, _ := json.Marshal(map[string]string{"text": "event me"})
	post, _ := http.NewRequest(http.MethodPost, info.URL+"/v1/bots/"+bot.ID+"/threads/"+thread.ID+"/messages", bytes.NewReader(payload))
	post.Header.Set("Authorization", "Bearer "+info.Token)
	post.Header.Set("Content-Type", "application/json")
	postResponse, err := client.Do(post)
	if err != nil {
		t.Fatal(err)
	}
	_ = postResponse.Body.Close()
	if postResponse.StatusCode != http.StatusAccepted {
		t.Fatalf("SSE post = %d", postResponse.StatusCode)
	}
	found := false
	for index := 0; index < 80; index++ {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "event: message") {
			data, _ := reader.ReadString('\n')
			if strings.Contains(data, "event me") || strings.Contains(data, "\"type\":\"message\"") {
				found = true
				break
			}
		}
	}
	if !found {
		t.Fatal("no message event reached the SSE stream")
	}
	waitFor(t, events, 5*time.Second, "the SSE test turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.BotID == bot.ID && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
}

func TestAutomationAPIGroupsAndRoutines(t *testing.T) {
	svc, _, events := newTestService(t)
	info, err := svc.SetAPIEnabled(true)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = svc.SetAPIEnabled(false) }()
	get := func(path string) *http.Response {
		request, _ := http.NewRequest(http.MethodGet, info.URL+path, nil)
		request.Header.Set("Authorization", "Bearer "+info.Token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	for _, path := range []string{"/v1/groups", "/v1/routines"} {
		response := get(path)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s = %d", path, response.StatusCode)
		}
	}
	group := svc.st.State.Groups[0]
	thread := group.Threads[0]
	payload, _ := json.Marshal(map[string]string{"text": "group event"})
	request, _ := http.NewRequest(http.MethodPost, info.URL+"/v1/groups/"+group.ID+"/threads/"+thread.ID+"/messages", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer "+info.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("group message = %d", response.StatusCode)
	}
	waitFor(t, events, 5*time.Second, "the group API turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.GroupID == group.ID && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
}

func TestAPITurnRecordsUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Usage reply\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	svc, _, events := newTestService(t)
	if _, err := svc.SetSecret("openai", "test-key"); err != nil {
		t.Fatal(err)
	}
	settings := svc.st.State.Settings
	settings.EngineMode = "api"
	settings.APIBaseURL = server.URL
	settings.APIModel = "gpt-5.2"
	settings.InputPricePerMillion = 1
	settings.OutputPricePerMillion = 2
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Usage Bot", ModelID: "gpt-5.2"})
	if err != nil {
		t.Fatal(err)
	}
	thread := bot.Threads[0]
	if _, err := svc.Send(bot.ID, thread.ID, "measure this"); err != nil {
		t.Fatal(err)
	}
	var final *model.Message
	waitFor(t, events, 5*time.Second, "the usage turn", func(ev model.Event) bool {
		if ev.Type == "message" && ev.BotID == bot.ID && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && ev.Message.Usage != nil {
			final = ev.Message
			return true
		}
		return false
	})
	if final.Usage.TotalTokens != 10 || final.Usage.InputTokens != 7 || final.Usage.OutputTokens != 3 || final.Usage.Source != "OpenAI-compatible API" {
		t.Fatalf("usage = %+v", final.Usage)
	}
	if final.Usage.CostUSD < 0.0000129 || final.Usage.CostUSD > 0.0000131 {
		t.Fatalf("cost = %v", final.Usage.CostUSD)
	}
}

func TestMemoryExpirySkipsPastEntries(t *testing.T) {
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Expiry Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	state, err := svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	today := time.Now()
	past := today.AddDate(0, 0, -1).Format("2006-01-02")
	future := today.AddDate(0, 0, 3).Format("2006-01-02")
	content := "# Notes\n\n- " + past + " · old fact · until " + past + "\n- " + today.Format("2006-01-02") + " · active fact · until " + future + "\n- undated fact\n"
	if _, err := svc.SaveMemory(bot.ID, content, state.Revision); err != nil {
		t.Fatal(err)
	}
	state, err = svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Expired != 1 {
		t.Fatalf("expired = %d", state.Expired)
	}
	if state.LoadedLines != 4 {
		t.Fatalf("loaded lines = %d", state.LoadedLines)
	}
	svc.mu.Lock()
	loaded := svc.memoryTextLocked(&bot)
	svc.mu.Unlock()
	if strings.Contains(loaded, "old fact") || !strings.Contains(loaded, "active fact") || !strings.Contains(loaded, "undated fact") {
		t.Fatalf("loaded memory = %q", loaded)
	}
	result, err := svc.TidyMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Archived != 1 {
		t.Fatalf("tidy expired = %+v", result)
	}
	state, err = svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(state.Content, "old fact") || state.Expired != 0 {
		t.Fatalf("tidy left expired content: %q", state.Content)
	}
}

func TestDailyConversationLog(t *testing.T) {
	svc, _, events := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Log Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	enabled := true
	if _, err := svc.UpdateBot(bot.ID, model.BotPatch{MemoryDailyLog: &enabled}); err != nil {
		t.Fatal(err)
	}
	thread := bot.Threads[0]
	if _, err := svc.Send(bot.ID, thread.ID, "remember this day"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the daily log turn", func(ev model.Event) bool {
		return ev.Type == "turn" && ev.BotID == bot.ID && ev.ThreadID == thread.ID && ev.Turn != nil && !ev.Turn.Busy
	})
	state, err := svc.GetMemory(bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Logs) != 1 || state.Logs[0].Date != time.Now().Format("2006-01-02") {
		t.Fatalf("logs = %+v", state.Logs)
	}
	log, err := svc.ReadMemoryLog(bot.ID, state.Logs[0].Date)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(log, "remember this day") || !strings.Contains(log, "Log Bot") {
		t.Fatalf("daily log = %q", log)
	}
}

func TestDepartmentShelfCRUD(t *testing.T) {
	svc, _, _ := newTestService(t)
	department, err := svc.CreateDepartment("Research Shelf")
	if err != nil {
		t.Fatal(err)
	}
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Shelf Bot", Department: "Research Shelf", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	items := svc.ListDepartments()
	found := false
	for _, item := range items {
		if item.ID == department.ID && item.BotCount == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("departments = %+v", items)
	}
	enamed, err := svc.RenameDepartment(department.ID, "Applied Shelf")
	if err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	updated := svc.findBotLocked(bot.ID)
	updatedDepartment := ""
	if updated != nil {
		updatedDepartment = updated.Department
	}
	svc.mu.Unlock()
	if updatedDepartment != "Applied Shelf" || enamed.Name != "Applied Shelf" {
		t.Fatalf("renamed bot department = %q", updatedDepartment)
	}
	if err := svc.DeleteDepartment(department.ID); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	updated = svc.findBotLocked(bot.ID)
	updatedDepartment = ""
	if updated != nil {
		updatedDepartment = updated.Department
	}
	svc.mu.Unlock()
	if updatedDepartment != "General" {
		t.Fatalf("deleted department bot = %q", updatedDepartment)
	}
	general := ""
	for _, item := range svc.ListDepartments() {
		if item.Name == "General" {
			general = item.ID
		}
	}
	if general == "" || svc.DeleteDepartment(general) == nil {
		t.Fatal("General must be protected")
	}
}

func TestOnboardingSettingPersists(t *testing.T) {
	svc, _, _ := newTestService(t)
	settings := svc.st.State.Settings
	settings.Onboarded = true
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	if !svc.st.State.Settings.Onboarded {
		t.Fatal("onboarding flag was not saved")
	}
}

func TestMCPServerOAuthClientCredentials(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("token method = %s", r.Method)
		}
		if err := r.ParseForm(); err != nil {
			t.Errorf("token form: %v", err)
		}
		if r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_id") != "client-1" || r.Form.Get("scope") != "mcp.read" {
			t.Errorf("token form = %v", r.Form)
		}
		username, password, _ := r.BasicAuth()
		if username != "client-1" || password != "secret-1" {
			t.Errorf("basic auth = %q/%q", username, password)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"oauth-token","token_type":"Bearer","expires_in":3600}`))
	}))
	defer tokenServer.Close()
	svc, _, _ := newTestService(t)
	server, err := svc.CreateMCPServer(model.MCPServerInput{
		Name: "OAuth MCP", URL: "https://mcp.example.test/mcp", Enabled: true,
		OAuthTokenURL: tokenServer.URL, OAuthClientID: "client-1", OAuthClientSecret: "secret-1", OAuthScopes: "mcp.read",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !server.OAuthConfigured || server.OAuthTokenURL != tokenServer.URL {
		t.Fatalf("oauth server = %+v", server)
	}
	svc.mu.Lock()
	configs := svc.mcpConfigsLocked("")
	svc.mu.Unlock()
	found := false
	for _, config := range configs {
		if config.ID == server.ID && config.Token == "oauth-token" {
			found = true
		}
	}
	if !found {
		t.Fatalf("configs = %+v", configs)
	}
}

func TestMCPServerOAuthRefreshToken(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("form: %v", err)
		}
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "refresh-1" {
			t.Errorf("refresh form = %v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"refreshed-token","expires_in":3600}`))
	}))
	defer tokenServer.Close()
	svc, _, _ := newTestService(t)
	server, err := svc.CreateMCPServer(model.MCPServerInput{
		Name: "Refresh MCP", URL: "https://mcp.example.test/mcp", Enabled: true,
		OAuthTokenURL: tokenServer.URL, OAuthClientID: "client-1", OAuthRefreshToken: "refresh-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	configs := svc.mcpConfigsLocked("")
	svc.mu.Unlock()
	found := false
	for _, config := range configs {
		if config.ID == server.ID && config.Token == "refreshed-token" {
			found = true
		}
	}
	if !found {
		t.Fatalf("configs = %+v", configs)
	}
}

func TestMCPServerOAuthAuthorizationCode(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("form: %v", err)
		}
		if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "code-1" || r.Form.Get("code_verifier") == "" {
			t.Errorf("code form = %v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"auth-token","refresh_token":"refresh-auth","expires_in":3600}`))
	}))
	defer tokenServer.Close()
	svc, _, _ := newTestService(t)
	server, err := svc.CreateMCPServer(model.MCPServerInput{
		Name: "Auth Code MCP", URL: "https://mcp.example.test/mcp", Enabled: true,
		OAuthTokenURL: tokenServer.URL, OAuthAuthorizationURL: "https://auth.example.test/authorize",
		OAuthClientID: "client-1", OAuthScopes: "mcp.read",
	})
	if err != nil {
		t.Fatal(err)
	}
	start, err := svc.BeginMCPOAuth(server.ID)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(start.URL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("code_challenge") == "" || query.Get("state") == "" || query.Get("redirect_uri") == "" {
		t.Fatalf("authorization URL = %s", start.URL)
	}
	response, err := http.Get(query.Get("redirect_uri") + "?code=code-1&state=" + url.QueryEscape(query.Get("state")))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("callback = %d", response.StatusCode)
	}
	svc.mu.Lock()
	configs := svc.mcpConfigsLocked("")
	svc.mu.Unlock()
	found := false
	for _, config := range configs {
		if config.ID == server.ID && config.Token == "auth-token" {
			found = true
		}
	}
	if !found {
		t.Fatalf("configs = %+v", configs)
	}
}

func TestAutoRoomDecisionChoosesMember(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer decision-key" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		payload, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": `{"choice":"bot-omiii","pTop":0.94}`}}}})
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	svc, dataDir, events := newTestService(t)
	if _, err := svc.SetSecret("decider", "decision-key"); err != nil {
		t.Fatal(err)
	}
	settings := svc.st.State.Settings
	settings.DeciderEnabled = true
	settings.DeciderBaseURL = server.URL
	settings.DeciderModel = "test-decider"
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	auto := "auto"
	if _, err := svc.UpdateGroup("group-launch", model.GroupPatch{Responder: &auto}); err != nil {
		t.Fatal(err)
	}
	group := svc.st.State.Groups[0]
	thread := group.Threads[0]
	if _, err := svc.SendGroup(group.ID, thread.ID, "Who should take the pricing question?"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the auto-routed group turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.GroupID == group.ID && ev.BotID == "bot-omiii" && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
	logData, err := os.ReadFile(filepath.Join(dataDir, "decider-log", time.Now().Format("2006-01")+".ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(logData), `"choice":"bot-omiii"`) || strings.Contains(string(logData), "pricing question") {
		t.Fatalf("decision log = %s", logData)
	}
}

func TestPlaybookSelectionAndPrompt(t *testing.T) {
	svc, _, _ := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Playbook Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	playbook, err := svc.SavePlaybook(bot.ID, model.PlaybookInput{
		Name: "Launch checklist", Triggers: []string{"launch", "release"},
		Instructions: "Check the launch checklist before replying.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if playbook.ID != "launch-checklist" {
		t.Fatalf("playbook = %+v", playbook)
	}
	items, err := svc.ListPlaybooks(bot.ID)
	if err != nil || len(items) != 1 {
		t.Fatalf("playbooks = %+v err=%v", items, err)
	}
	svc.mu.Lock()
	selected := svc.selectedPlaybookTextLocked(bot.ID, "Please prepare the release notes")
	unrelated := svc.selectedPlaybookTextLocked(bot.ID, "What is for lunch?")
	svc.mu.Unlock()
	if !strings.Contains(selected, "launch checklist") || unrelated != "" {
		t.Fatalf("selected=%q unrelated=%q", selected, unrelated)
	}
	prompt := agent.Compose(bot, model.Thread{}, "prepare the release", selected)
	if !strings.Contains(prompt, "launch checklist") {
		t.Fatalf("prompt missing playbook: %q", prompt)
	}
	if err := svc.DeletePlaybook(bot.ID, playbook.ID); err != nil {
		t.Fatal(err)
	}
}

func TestWorkersAiRoomDecision(t *testing.T) {
	account := strings.Repeat("a", 32)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/accounts/"+account+"/ai/run/@cf/cloudflare/clef-flash" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"result":{"answers":{"room":{"choice":"bot-omiii","probabilities":{"bot-omiii":0.91,"bot-emaily":0.09}}}}}`))
	}))
	defer server.Close()
	svc, _, events := newTestService(t)
	if _, err := svc.SetSecret("decider-workers", "cloud-key"); err != nil {
		t.Fatal(err)
	}
	settings := svc.st.State.Settings
	settings.DeciderEnabled = true
	settings.DeciderProvider = "workersai"
	settings.DeciderBaseURL = server.URL
	settings.DeciderAccountID = account
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	auto := "auto"
	if _, err := svc.UpdateGroup("group-launch", model.GroupPatch{Responder: &auto}); err != nil {
		t.Fatal(err)
	}
	group := svc.st.State.Groups[0]
	thread := group.Threads[0]
	if _, err := svc.SendGroup(group.ID, thread.ID, "Who handles this?"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the Workers AI routed turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.GroupID == group.ID && ev.BotID == "bot-omiii" && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
}

func TestJevRoomDecision(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/systemone" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"answers":{"room":{"choice":"bot-emaily","probabilities":{"bot-emaily":0.88,"bot-omiii":0.12}}}}`))
	}))
	defer server.Close()
	svc, _, events := newTestService(t)
	if _, err := svc.SetSecret("decider-jev", "jev-key"); err != nil {
		t.Fatal(err)
	}
	settings := svc.st.State.Settings
	settings.DeciderEnabled = true
	settings.DeciderProvider = "jev"
	settings.DeciderBaseURL = server.URL
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	auto := "auto"
	if _, err := svc.UpdateGroup("group-launch", model.GroupPatch{Responder: &auto}); err != nil {
		t.Fatal(err)
	}
	group := svc.st.State.Groups[0]
	thread := group.Threads[0]
	if _, err := svc.SendGroup(group.ID, thread.ID, "Inbox question"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the Jev routed turn", func(ev model.Event) bool {
		return ev.Type == "message" && ev.GroupID == group.ID && ev.BotID == "bot-emaily" && ev.Message != nil && ev.Message.Role == model.RoleBot && !ev.Message.Pending && strings.TrimSpace(ev.Message.Text) != ""
	})
}

func TestGrokBotImport(t *testing.T) {
	svc, _, _ := newTestService(t)
	export := map[string]any{
		"format": "grok-bot-export", "version": 1,
		"bots": []any{map[string]any{
			"name": "Moved Bot", "title": "Research bot", "instructions": "Be concise.",
			"memories": []any{"The launch is Tuesday."}, "user_facts": []any{"The person prefers tea."},
			"skills": []any{map[string]any{"name": "checklist", "instructions": "Use a checklist."}},
			"routines": []any{map[string]any{
				"name": "Morning brief", "instruction": "Write a short brief.", "trigger": "schedule", "schedule_cron": "0 8 * * 1-5",
			}},
			"apps": []any{map[string]any{"name": "crm", "mcp_url": "https://mcp.example.test/mcp"}},
		}},
	}
	raw, _ := json.Marshal(export)
	result, err := svc.ImportGrokBot(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if result.Bots != 1 || result.Routines != 1 || result.Memories != 2 || result.Apps != 1 || result.Skills != 1 {
		t.Fatalf("result = %+v", result)
	}
	var imported *model.Bot
	svc.mu.Lock()
	for index := range svc.st.State.Bots {
		if svc.st.State.Bots[index].Name == "Moved Bot" {
			imported = &svc.st.State.Bots[index]
		}
	}
	svc.mu.Unlock()
	if imported == nil || imported.WorkingDir == "" {
		t.Fatalf("imported bot missing working dir: %+v", imported)
	}
	skills, err := svc.ListSkills(imported.ID)
	foundSkill := false
	for _, skill := range skills {
		if skill.Source == "Workspace" && skill.Enabled {
			foundSkill = true
		}
	}
	if err != nil || !foundSkill {
		t.Fatalf("imported skills = %+v err=%v", skills, err)
	}
	state, err := svc.GetMemory(imported.ID)
	if err != nil || !strings.Contains(state.Content, "prefers tea") {
		t.Fatalf("memory = %+v err=%v", state, err)
	}
	svc.mu.Lock()
	routines := append([]model.Routine(nil), svc.st.State.Routines...)
	svc.mu.Unlock()
	found := false
	for _, routine := range routines {
		if routine.BotID == imported.ID && routine.Name == "Moved Bot: Morning brief" && !routine.Enabled {
			found = true
		}
	}
	if !found {
		t.Fatalf("imported routine missing")
	}
	bad := map[string]any{"bots": []any{map[string]any{"name": "Bad", "api_key": "secret"}}}
	badRaw, _ := json.Marshal(bad)
	if _, err := svc.ImportGrokBot(string(badRaw)); err == nil {
		t.Fatal("credential-looking export should be refused")
	}
}

func TestBotMRRMarkdownImport(t *testing.T) {
	raw, err := os.ReadFile("testdata/botmrr.md")
	if err != nil {
		t.Fatal(err)
	}
	svc, _, _ := newTestService(t)
	result, err := svc.ImportBotMRR(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if result.Bots != 2 || result.Groups != 1 || result.Routines != 1 || result.Playbooks != 1 || result.Skills != 1 {
		t.Fatalf("result = %+v", result)
	}
	var scout *model.Bot
	svc.mu.Lock()
	for index := range svc.st.State.Bots {
		if svc.st.State.Bots[index].Name == "Imported Scout" {
			scout = &svc.st.State.Bots[index]
		}
	}
	routines := append([]model.Routine(nil), svc.st.State.Routines...)
	svc.mu.Unlock()
	if scout == nil || scout.WorkingDir == "" {
		t.Fatalf("imported scout = %+v", scout)
	}
	foundRoutine := false
	for _, routine := range routines {
		if routine.BotID == scout.ID && !routine.Enabled && routine.Cadence == "weekdays" {
			foundRoutine = true
		}
	}
	if !foundRoutine {
		t.Fatalf("routines = %+v", routines)
	}
	playbooks, err := svc.ListPlaybooks(scout.ID)
	if err != nil || len(playbooks) != 1 {
		t.Fatalf("playbooks = %+v err=%v", playbooks, err)
	}
}

func TestOpenMausPackageV2Import(t *testing.T) {
	document := map[string]any{
		"format": "openmaus.package", "version": 2,
		"package": map[string]any{
			"name": "Imported Desk",
			"agents": []any{
				map[string]any{"key": "lead", "name": "Package Lead", "soul": "Coordinate.", "approval": "full", "appearance": map[string]any{"color": "purple"}, "skills": []any{"research"}, "playbooks": []any{"qualify"}, "seed": map[string]any{"memory": map[string]any{"MEMORY.md": "- Remember the launch.\n"}}},
				map[string]any{"key": "writer", "name": "Package Writer"},
			},
			"rooms":       []any{map[string]any{"key": "desk", "name": "Package Room", "members": []any{"lead", "writer"}, "defaultResponder": map[string]any{"kind": "agent", "agent": "lead"}}},
			"routines":    []any{map[string]any{"name": "Daily digest", "agent": "lead", "prompt": "Summarize the day.", "runOn": "maus", "schedule": map[string]any{"type": "daily", "time": "09:00"}}},
			"playbooks":   []any{map[string]any{"key": "qualify", "name": "Qualify", "triggers": []any{"lead"}, "instructions": "Ask about budget."}},
			"skills":      map[string]any{"version": float64(1), "entries": []any{map[string]any{"name": "research", "description": "Research", "instructions": "Research carefully."}}},
			"connections": []any{map[string]any{"key": "crm", "label": "CRM", "mcp": map[string]any{"url": "https://mcp.example.test/crm", "valueNames": []any{"Authorization"}}}},
		},
	}
	raw, _ := json.Marshal(document)
	svc, _, _ := newTestService(t)
	result, err := svc.ImportOpenMausPackage(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if result.Bots != 2 || result.Groups != 1 || result.Routines != 1 || result.Playbooks != 1 || result.Skills != 1 || result.Connections != 1 {
		t.Fatalf("result = %+v", result)
	}
	var lead *model.Bot
	svc.mu.Lock()
	for index := range svc.st.State.Bots {
		if svc.st.State.Bots[index].Name == "Package Lead" {
			lead = &svc.st.State.Bots[index]
		}
	}
	svc.mu.Unlock()
	if lead == nil || lead.WorkingDir == "" || lead.Approval != model.ApprovalFull {
		t.Fatalf("lead = %+v", lead)
	}
	state, err := svc.GetMemory(lead.ID)
	if err != nil || !strings.Contains(state.Content, "Remember the launch") {
		t.Fatalf("memory = %+v err=%v", state, err)
	}
	skills, _ := svc.ListSkills(lead.ID)
	found := false
	for _, skill := range skills {
		if skill.Source == "Workspace" && skill.Enabled {
			found = true
		}
	}
	if !found {
		t.Fatalf("skills = %+v", skills)
	}
	svc.mu.Lock()
	required := []string{}
	for _, server := range svc.st.State.MCPServers {
		if strings.EqualFold(server.Name, "crm") {
			required = server.RequiredValues
		}
	}
	svc.mu.Unlock()
	if len(required) != 1 || required[0] != "Authorization" {
		t.Fatalf("required values = %+v", required)
	}
}

func TestMCPServerBotScope(t *testing.T) {
	svc, _, _ := newTestService(t)
	first, err := svc.CreateBot(model.CreateBotInput{Name: "Scope One", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.CreateBot(model.CreateBotInput{Name: "Scope Two", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := svc.CreateMCPServer(model.MCPServerInput{
		Name: "Scoped", URL: "https://mcp.example.test/mcp", Enabled: true, BotIDs: []string{first.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(server.BotIDs) != 1 || server.BotIDs[0] != first.ID {
		t.Fatalf("server scope = %+v", server)
	}
	svc.mu.Lock()
	one := svc.mcpConfigsLocked(first.ID)
	two := svc.mcpConfigsLocked(second.ID)
	all := svc.mcpConfigsLocked("")
	svc.mu.Unlock()
	if len(one) != 1 || len(two) != 0 || len(all) != 1 {
		t.Fatalf("scoped configs one=%+v two=%+v all=%+v", one, two, all)
	}
}

func TestOpenMausPackageV2ExportRoundTrip(t *testing.T) {
	source, _, _ := newTestService(t)
	if _, err := source.SavePlaybook("bot-brody", model.PlaybookInput{Name: "Export checklist", Triggers: []string{"export"}, Instructions: "Check the export."}); err != nil {
		t.Fatal(err)
	}
	state, err := source.GetMemory("bot-brody")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.SaveMemory("bot-brody", "# Notes\n\n- Export this note.\n", state.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := source.CreateMCPServer(model.MCPServerInput{Name: "Export MCP", URL: "https://mcp.example.test/export", Enabled: true, BotIDs: []string{"bot-brody"}}); err != nil {
		t.Fatal(err)
	}
	raw, err := source.ExportOpenMausPackage("group-launch")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, `"format": "openmaus.package"`) || strings.Contains(raw, "secret-token") {
		t.Fatalf("unexpected export: %s", raw[:min(len(raw), 200)])
	}
	target, _, _ := newTestService(t)
	result, err := target.ImportOpenMausPackage(raw)
	if err != nil {
		t.Fatal(err)
	}
	if result.Bots < 3 || result.Groups != 1 || result.Playbooks < 1 || result.Connections < 1 {
		t.Fatalf("roundtrip = %+v", result)
	}
}

func TestRoutineContinuityReusesThread(t *testing.T) {
	svc, _, events := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Continuous Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	routine, err := svc.CreateRoutine(model.RoutineInput{
		BotID: bot.ID, Name: "Continuous routine", Prompt: "Keep a running log.", Cadence: "daily", TimeOfDay: "09:00", Continuity: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := svc.RunRoutine(routine.ID)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "the first continuous run", func(ev model.Event) bool {
		return ev.Type == "turn" && ev.BotID == bot.ID && ev.ThreadID == first.ThreadID && ev.Turn != nil && !ev.Turn.Busy
	})
	second, err := svc.RunRoutine(routine.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.ThreadID != second.ThreadID {
		t.Fatalf("continuity threads = %q and %q", first.ThreadID, second.ThreadID)
	}
}

func TestRoutineRunsCheckSkipsQuietTicks(t *testing.T) {
	svc, _, events := newTestService(t)
	bot, err := svc.CreateBot(model.CreateBotInput{Name: "Checked Bot", ModelID: "grox-demo"})
	if err != nil {
		t.Fatal(err)
	}
	routine, err := svc.CreateRoutine(model.RoutineInput{
		BotID: bot.ID, Name: "Checked routine", Prompt: "Report the new run.", Cadence: "daily", TimeOfDay: "09:00", Checks: []string{"runs"},
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	for index := range svc.st.State.Routines {
		if svc.st.State.Routines[index].ID == routine.ID {
			svc.st.State.Routines[index].LastCheckAt = time.Now().Add(-time.Hour)
		}
	}
	before := len(bot.Threads)
	svc.mu.Unlock()
	result, err := svc.runRoutine(routine.ID, true)
	if err != nil || result.ThreadID != "" {
		t.Fatalf("quiet tick result=%+v err=%v", result, err)
	}
	svc.mu.Lock()
	after := 0
	for _, thread := range svc.findBotLocked(bot.ID).Threads {
		after++
		_ = thread
	}
	svc.st.State.Runs = append(svc.st.State.Runs, model.Run{
		ID: "run-other", RoutineID: "other", BotID: bot.ID, Title: "Other run", Status: "completed",
		StartedAt: time.Now(), FinishedAt: time.Now().Add(10 * time.Second),
	})
	svc.mu.Unlock()
	if after != before {
		t.Fatalf("threads before=%d after=%d", before, after)
	}
	result, err = svc.runRoutine(routine.ID, true)
	if err != nil || result.ThreadID == "" {
		t.Fatalf("news tick result=%+v err=%v", result, err)
	}
	waitFor(t, events, 5*time.Second, "the checked routine turn", func(ev model.Event) bool {
		return ev.Type == "turn" && ev.BotID == bot.ID && ev.ThreadID == result.ThreadID && ev.Turn != nil && !ev.Turn.Busy
	})
}

func TestDecideToolUsesProvider(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"choice\":\"red\",\"pTop\":0.9}"}}]}`))
	}))
	defer server.Close()
	svc, _, _ := newTestService(t)
	if _, err := svc.SetSecret("decider", "decision-key"); err != nil {
		t.Fatal(err)
	}
	settings := svc.st.State.Settings
	settings.DeciderEnabled = true
	settings.DeciderProvider = "openrouter"
	settings.DeciderBaseURL = server.URL
	settings.DeciderModel = "test"
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	value, err := svc.decideTool(map[string]any{
		"instructions": "Pick a colour",
		"options":      map[string]any{"red": "warm", "blue": "cool"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(value, `"choice":"red"`) || !strings.Contains(value, "0.9") {
		t.Fatalf("decision = %s", value)
	}
}

func TestExtractToolReturnsJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"name\":\"Ada\",\"deadline\":\"Tuesday\"}"}}]}`))
	}))
	defer server.Close()
	svc, _, _ := newTestService(t)
	if _, err := svc.SetSecret("decider", "decision-key"); err != nil {
		t.Fatal(err)
	}
	settings := svc.st.State.Settings
	settings.DeciderBaseURL = server.URL
	settings.DeciderModel = "test"
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	value, err := svc.extractTool(map[string]any{
		"text":   "Ada needs this by Tuesday.",
		"schema": map[string]any{"name": "string", "deadline": "string"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(value, `"name":"Ada"`) || !strings.Contains(value, "Tuesday") {
		t.Fatalf("extraction = %s", value)
	}
}
