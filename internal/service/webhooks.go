package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
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
	deliveries := append([]model.WebhookDelivery(nil), s.st.State.WebhookDeliveries...)
	s.mu.Unlock()
	if items == nil {
		items = []model.Webhook{}
	}
	if len(deliveries) > 20 {
		deliveries = deliveries[len(deliveries)-20:]
	}
	return model.WebhookInfo{BaseURL: base, Error: errText, Items: items, Deliveries: deliveries}
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
		Token: randomToken(), Enabled: input.Enabled, RequireSignature: input.RequireSignature,
		CreatedAt: now, UpdatedAt: now,
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
	if patch.RequireSignature != nil {
		hook.RequireSignature = *patch.RequireSignature
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

func (s *Service) verifyWebhookSignature(r *http.Request, token string, body []byte) (int, string) {
	rawTimestamp := strings.TrimSpace(r.Header.Get("X-Grox-Timestamp"))
	timestamp, err := strconv.ParseInt(rawTimestamp, 10, 64)
	if err != nil {
		return http.StatusUnauthorized, "missing or invalid X-Grox-Timestamp"
	}
	now := time.Now().Unix()
	if timestamp < now-300 || timestamp > now+300 {
		return http.StatusUnauthorized, "webhook timestamp is outside the five-minute window"
	}
	provided := strings.TrimSpace(r.Header.Get("X-Grox-Signature"))
	provided = strings.TrimPrefix(provided, "sha256=")
	mac := hmac.New(sha256.New, []byte(token))
	_, _ = mac.Write([]byte(rawTimestamp + "."))
	_, _ = mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(strings.ToLower(provided)), []byte(expected)) {
		return http.StatusUnauthorized, "invalid webhook signature"
	}
	if delivery := strings.TrimSpace(r.Header.Get("X-Grox-Delivery")); delivery != "" {
		s.webhookMu.Lock()
		defer s.webhookMu.Unlock()
		if seen, ok := s.webhookReplays[delivery]; ok && time.Since(seen) < 10*time.Minute {
			return http.StatusConflict, "webhook delivery was already accepted"
		}
		s.webhookReplays[delivery] = time.Now()
		if len(s.webhookReplays) > 1000 {
			cutoff := time.Now().Add(-10 * time.Minute)
			for key, at := range s.webhookReplays {
				if at.Before(cutoff) {
					delete(s.webhookReplays, key)
				}
			}
		}
	}
	return 0, ""
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
	requireSignature := hook.RequireSignature
	s.mu.Unlock()
	if requireSignature {
		if status, message := s.verifyWebhookSignature(r, token, body); status != 0 {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
			return
		}
	}
	s.mu.Lock()
	hook = nil
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
	delivery := model.WebhookDelivery{
		ID: newID("delivery"), WebhookID: hook.ID, WebhookName: hook.Name, BotID: botID,
		ThreadID: thread.ID, At: now, Status: "accepted", Payload: payload,
	}
	if len(delivery.Payload) > 8192 {
		delivery.Payload = delivery.Payload[:8192] + "…"
	}
	s.st.State.WebhookDeliveries = append(s.st.State.WebhookDeliveries, delivery)
	if len(s.st.State.WebhookDeliveries) > 50 {
		s.st.State.WebhookDeliveries = s.st.State.WebhookDeliveries[len(s.st.State.WebhookDeliveries)-50:]
	}
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
