package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

type questionWaiter struct {
	ch     chan string
	target claudeHookTarget
}

func (s *Service) questionTarget(messageID string) (claudeHookTarget, bool) {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	waiter, ok := s.questionWaiters[messageID]
	if !ok {
		return claudeHookTarget{}, false
	}
	return waiter.target, true
}

func chooseAnswer(options []model.Option, answer string) string {
	answer = strings.TrimSpace(answer)
	for _, option := range options {
		if option.ID == answer || strings.EqualFold(option.Label, answer) {
			if option.Description != "" {
				return option.Label + " — " + option.Description
			}
			return option.Label
		}
	}
	return answer
}

// askUser creates a real KindOptions card and blocks the calling tool until a
// person answers it. It is used by the MCP gateway and the API tool loop.
func (s *Service) askUser(ctx context.Context, target claudeHookTarget, question string, options []model.Option) (string, error) {
	question = strings.TrimSpace(question)
	if question == "" {
		return "", fmt.Errorf("question is empty")
	}
	s.mu.Lock()
	owner := s.hookOwnerLocked(target)
	if owner.thread == nil {
		s.mu.Unlock()
		return "", fmt.Errorf("conversation not found")
	}
	now := time.Now()
	if len(options) > 6 {
		options = options[:6]
	}
	message := model.Message{
		ID: newID("msg"), Role: model.RoleBot, Kind: model.KindOptions,
		Status: model.StatusPending, Text: question, Options: options,
		SenderID: target.BotID, CreatedAt: now, UpdatedAt: now,
	}
	if bot := s.findBotLocked(target.BotID); bot != nil {
		message.SenderName = bot.Name
	}
	owner.thread.Messages = append(owner.thread.Messages, message)
	owner.thread.Status = "Waiting for you"
	owner.thread.UpdatedAt = now
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	waiter := &questionWaiter{ch: make(chan string, 1), target: target}
	s.approvalMu.Lock()
	s.questionWaiters[message.ID] = waiter
	s.approvalMu.Unlock()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	turn := &model.Turn{BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, Busy: true, Status: "Waiting for you"}
	s.emitEvent(model.Event{Type: "message", BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, MessageID: message.ID, Message: &message})
	s.emitEvent(model.Event{Type: "turn", BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, Turn: turn})
	s.mu.Unlock()

	wait, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	select {
	case answer := <-waiter.ch:
		return answer, nil
	case <-wait.Done():
		s.mu.Lock()
		s.approvalMu.Lock()
		delete(s.questionWaiters, message.ID)
		s.approvalMu.Unlock()
		owner = s.ownerLocked(target.BotID, target.GroupID, target.ThreadID)
		if owner.thread != nil {
			if msg := s.findMessageLocked(owner.thread, message.ID); msg != nil && msg.Status == model.StatusPending {
				msg.Status = model.StatusDenied
				msg.UpdatedAt = time.Now()
				if owner.thread.Status != "Stopping" {
					owner.thread.Status = "Thinking"
				}
				s.touchLocked()
				s.saveLocked()
				s.emitStateLocked()
			}
		}
		s.mu.Unlock()
		return "", fmt.Errorf("waiting for a reply: %w", wait.Err())
	}
}

// resolveQuestion settles an agent-authored question without starting another
// turn. The blocked tool call receives the answer as its result.
func (s *Service) resolveQuestion(target claudeHookTarget, messageID, answer string) error {
	s.mu.Lock()
	owner := s.hookOwnerLocked(target)
	if owner.thread == nil {
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	msg := s.findMessageLocked(owner.thread, messageID)
	if msg == nil || msg.Kind != model.KindOptions {
		s.mu.Unlock()
		return fmt.Errorf("question not found")
	}
	if msg.Status != model.StatusPending {
		s.mu.Unlock()
		return fmt.Errorf("this question was already answered")
	}
	label := chooseAnswer(msg.Options, answer)
	if strings.TrimSpace(label) == "" {
		s.mu.Unlock()
		return fmt.Errorf("choose an answer first")
	}
	now := time.Now()
	msg.Status = model.StatusAnswered
	msg.UpdatedAt = now
	owner.thread.Messages = append(owner.thread.Messages, model.Message{
		ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: label,
		CreatedAt: now, UpdatedAt: now,
	})
	owner.thread.Status = "Thinking"
	owner.thread.UpdatedAt = now
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()

	s.approvalMu.Lock()
	waiter := s.questionWaiters[messageID]
	delete(s.questionWaiters, messageID)
	s.approvalMu.Unlock()
	if waiter != nil {
		waiter.ch <- label
	}
	return nil
}

func parseQuestionOptions(raw any) []model.Option {
	list, _ := raw.([]any)
	options := make([]model.Option, 0, len(list))
	for index, item := range list {
		if len(options) >= 6 {
			break
		}
		value, _ := item.(map[string]any)
		label, _ := value["label"].(string)
		description, _ := value["description"].(string)
		label = strings.TrimSpace(label)
		if label == "" {
			continue
		}
		options = append(options, model.Option{ID: fmt.Sprintf("opt-%d", index+1), Label: label, Description: strings.TrimSpace(description)})
	}
	return options
}

func (s *Service) askUserTool(ctx context.Context, target claudeHookTarget, arguments map[string]any) (string, error) {
	question, _ := arguments["question"].(string)
	if strings.TrimSpace(question) == "" {
		question, _ = arguments["text"].(string)
	}
	return s.askUser(ctx, target, question, parseQuestionOptions(arguments["options"]))
}
