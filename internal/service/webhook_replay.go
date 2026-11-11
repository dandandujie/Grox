package service

import (
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// ReplayWebhookDelivery starts a fresh task from a retained payload. It is a
// local, person-initiated action and does not require the original signature.
func (s *Service) ReplayWebhookDelivery(deliveryID string) (string, error) {
	s.mu.Lock()
	var delivery *model.WebhookDelivery
	for index := range s.st.State.WebhookDeliveries {
		if s.st.State.WebhookDeliveries[index].ID == deliveryID {
			delivery = &s.st.State.WebhookDeliveries[index]
			break
		}
	}
	if delivery == nil {
		s.mu.Unlock()
		return "", fmt.Errorf("delivery not found")
	}
	var hook *model.Webhook
	for index := range s.st.State.Webhooks {
		if s.st.State.Webhooks[index].ID == delivery.WebhookID {
			hook = &s.st.State.Webhooks[index]
			break
		}
	}
	if hook == nil {
		s.mu.Unlock()
		return "", fmt.Errorf("the webhook for this delivery is gone")
	}
	bot := s.findBotLocked(hook.BotID)
	if bot == nil {
		s.mu.Unlock()
		return "", fmt.Errorf("the webhook bot is gone")
	}
	for _, thread := range bot.Threads {
		if thread.Busy {
			s.mu.Unlock()
			return "", fmt.Errorf("the bot is still working on another message")
		}
	}
	text := strings.TrimSpace(hook.Prompt)
	if delivery.Payload != "" {
		if text != "" {
			text += "\n\nWebhook payload:\n"
		}
		text += delivery.Payload
	}
	if text == "" {
		s.mu.Unlock()
		return "", fmt.Errorf("the delivery has no payload or instruction")
	}
	now := time.Now()
	thread := model.Thread{
		ID: newID("thread"), BotID: bot.ID, Title: "Webhook replay: " + hook.Name + " · " + now.Format("Jan 2 15:04"),
		Kind: "task", CreatedAt: now, UpdatedAt: now,
		Messages: []model.Message{{
			ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: text, CreatedAt: now, UpdatedAt: now,
		}},
	}
	bot.Threads = append([]model.Thread{thread}, bot.Threads...)
	bot.UpdatedAt = now
	hook.EventCount++
	hook.LastEventAt = now
	hook.UpdatedAt = now
	replay := model.WebhookDelivery{
		ID: newID("delivery"), WebhookID: hook.ID, WebhookName: hook.Name, BotID: bot.ID,
		ThreadID: thread.ID, At: now, Status: "replayed", Payload: delivery.Payload,
	}
	s.st.State.WebhookDeliveries = append(s.st.State.WebhookDeliveries, replay)
	if len(s.st.State.WebhookDeliveries) > 50 {
		s.st.State.WebhookDeliveries = s.st.State.WebhookDeliveries[len(s.st.State.WebhookDeliveries)-50:]
	}
	threadID := thread.ID
	botID := bot.ID
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	if err := s.startTurn(botID, threadID, text, "", ""); err != nil {
		return "", err
	}
	return threadID, nil
}
