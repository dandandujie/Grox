package service

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func (s *Service) startWebhookServer() {
	s.webhookMu.Lock()
	defer s.webhookMu.Unlock()
	if s.webhookListener != nil {
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		s.webhookErr = err.Error()
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"ok\":true}\n"))
	})
	mux.HandleFunc("/hooks/", s.handleWebhook)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	s.webhookListener = listener
	s.webhookServer = server
	s.webhookErr = ""
	go func() { _ = server.Serve(listener) }()
}

func (s *Service) stopWebhookServer() {
	s.webhookMu.Lock()
	server := s.webhookServer
	listener := s.webhookListener
	s.webhookServer = nil
	s.webhookListener = nil
	s.webhookMu.Unlock()
	if server != nil {
		_ = server.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
}

func (s *Service) webhookBaseURL() string {
	s.webhookMu.Lock()
	defer s.webhookMu.Unlock()
	if s.webhookListener == nil {
		return ""
	}
	return "http://" + s.webhookListener.Addr().String()
}

// GetWebhookInfo reports the loopback receiver and the current trigger list.
func (s *Service) GetWebhookInfo() model.WebhookInfo {
	base := s.webhookBaseURL()
	s.webhookMu.Lock()
	errText := s.webhookErr
	s.webhookMu.Unlock()
	s.mu.Lock()
	items := append([]model.Webhook(nil), s.st.State.Webhooks...)
	s.mu.Unlock()
	if items == nil {
		items = []model.Webhook{}
	}
	return model.WebhookInfo{BaseURL: base, Error: errText, Items: items}
}

// CreateWebhook adds an inbound loopback trigger.
func (s *Service) CreateWebhook(input model.WebhookInput) (model.Webhook, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return model.Webhook{}, fmt.Errorf("give the webhook a name")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(input.BotID)
	if bot == nil {
		return model.Webhook{}, fmt.Errorf("bot not found")
	}
	now := time.Now()
	hook := model.Webhook{
		ID: newID("hook"), BotID: bot.ID, Name: name, Prompt: strings.TrimSpace(input.Prompt),
		Token: randomToken(), Enabled: input.Enabled, CreatedAt: now, UpdatedAt: now,
	}
	s.st.State.Webhooks = append(s.st.State.Webhooks, hook)
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return hook, nil
}

// UpdateWebhook edits a trigger without rotating its token.
func (s *Service) UpdateWebhook(id string, patch model.WebhookPatch) (model.Webhook, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var hook *model.Webhook
	for index := range s.st.State.Webhooks {
		if s.st.State.Webhooks[index].ID == id {
			hook = &s.st.State.Webhooks[index]
			break
		}
	}
	if hook == nil {
		return model.Webhook{}, fmt.Errorf("webhook not found")
	}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if name == "" {
			return model.Webhook{}, fmt.Errorf("the name cannot be empty")
		}
		hook.Name = name
	}
	if patch.Prompt != nil {
		hook.Prompt = strings.TrimSpace(*patch.Prompt)
	}
	if patch.Enabled != nil {
		hook.Enabled = *patch.Enabled
	}
	hook.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return *hook, nil
}

// DeleteWebhook removes a trigger and invalidates its URL token.
func (s *Service) DeleteWebhook(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index := range s.st.State.Webhooks {
		if s.st.State.Webhooks[index].ID != id {
			continue
		}
		s.st.State.Webhooks = append(s.st.State.Webhooks[:index], s.st.State.Webhooks[index+1:]...)
		s.touchLocked()
		s.saveLocked()
		s.emitStateLocked()
		return nil
	}
	return fmt.Errorf("webhook not found")
}

func webhookPayload(body []byte, contentType string) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	if strings.Contains(contentType, "application/json") {
		var value any
		if json.Unmarshal(body, &value) == nil {
			switch typed := value.(type) {
			case string:
				return strings.TrimSpace(typed)
			case map[string]any:
				for _, key := range []string{"prompt", "text", "message", "body"} {
					if candidate, ok := typed[key].(string); ok && strings.TrimSpace(candidate) != "" {
						return strings.TrimSpace(candidate)
					}
				}
				data, _ := json.Marshal(typed)
				return string(data)
			}
		}
	}
	return text
}

func (s *Service) handleWebhook(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_, _ = w.Write([]byte("{\"error\":\"method not allowed\"}\n"))
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/hooks/")
	if token == "" || strings.Contains(token, "/") {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("{\"error\":\"not found\"}\n"))
		return
	}
	if auth := strings.TrimSpace(r.Header.Get("Authorization")); auth != "" && auth != "Bearer "+token {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("{\"error\":\"bad authorization\"}\n"))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
	if err != nil {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = w.Write([]byte("{\"error\":\"payload is too large\"}\n"))
		return
	}
	payload := webhookPayload(body, r.Header.Get("Content-Type"))
	s.mu.Lock()
	var hook *model.Webhook
	for index := range s.st.State.Webhooks {
		if s.st.State.Webhooks[index].Token == token {
			hook = &s.st.State.Webhooks[index]
			break
		}
	}
	if hook == nil || !hook.Enabled {
		s.mu.Unlock()
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("{\"error\":\"webhook not found or disabled\"}\n"))
		return
	}
	bot := s.findBotLocked(hook.BotID)
	if bot == nil {
		s.mu.Unlock()
		w.WriteHeader(http.StatusGone)
		_, _ = w.Write([]byte("{\"error\":\"the webhook bot is gone\"}\n"))
		return
	}
	for _, thread := range bot.Threads {
		if thread.Busy {
			s.mu.Unlock()
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte("{\"error\":\"the bot is still working on another message\"}\n"))
			return
		}
	}
	text := strings.TrimSpace(hook.Prompt)
	if payload != "" {
		if text != "" {
			text += "\n\nWebhook payload:\n"
		}
		text += payload
	}
	if text == "" {
		s.mu.Unlock()
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("{\"error\":\"webhook has no prompt and the request has no payload\"}\n"))
		return
	}
	botID := bot.ID
	now := time.Now()
	thread := model.Thread{
		ID: newID("thread"), BotID: botID, Title: "Webhook: " + hook.Name + " · " + now.Format("Jan 2 15:04"),
		Kind: "task", CreatedAt: now, UpdatedAt: now,
	}
	thread.Messages = append(thread.Messages, model.Message{
		ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: text, CreatedAt: now, UpdatedAt: now,
	})
	bot.Threads = append([]model.Thread{thread}, bot.Threads...)
	bot.UpdatedAt = now
	hook.EventCount++
	hook.LastEventAt = now
	hook.UpdatedAt = now
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()

	if err := s.startTurn(botID, thread.ID, text, "", ""); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("{\"error\":\"could not start the turn\"}\n"))
		return
	}
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "threadId": thread.ID})
}
