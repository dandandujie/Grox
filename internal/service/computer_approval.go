package service

import (
	"context"
	"fmt"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// Computer operations request approval at the gateway, independent of CLI
// hooks. API turns and CLI turns resolve the same approval card.
func (s *Service) awaitComputerApproval(ctx context.Context, target claudeHookTarget, approval model.Approval) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()

	s.mu.Lock()
	owner := s.hookOwnerLocked(target)
	if owner.thread == nil || ctx.Err() != nil {
		s.mu.Unlock()
		return "", fmt.Errorf("the turn has ended")
	}
	now := time.Now()
	message := model.Message{
		ID: newID("msg"), Role: model.RoleBot, Kind: model.KindApproval,
		Status: model.StatusPending, Approval: &approval, SenderID: target.BotID,
		CreatedAt: now, UpdatedAt: now,
	}
	if bot := s.findBotLocked(target.BotID); bot != nil {
		message.SenderName = bot.Name
	}
	previousStatus := owner.thread.Status
	owner.thread.Messages = append(owner.thread.Messages, message)
	owner.thread.Status = "Waiting for you"
	owner.thread.UpdatedAt = now
	s.touchLocked()
	if err := s.st.SaveState(); err != nil {
		owner.thread.Messages = owner.thread.Messages[:len(owner.thread.Messages)-1]
		owner.thread.Status = previousStatus
		s.mu.Unlock()
		return "", fmt.Errorf("save computer approval: %w", err)
	}
	waiter := &claudeHookApproval{ch: make(chan string, 1), target: target}
	s.approvalMu.Lock()
	s.hookApprovals[message.ID] = waiter
	s.approvalMu.Unlock()
	s.emitStateLocked()
	s.mu.Unlock()

	select {
	case decision := <-waiter.ch:
		if decision == "allow" || decision == "always" {
			return decision, ctx.Err()
		}
		return "", fmt.Errorf("the person denied this computer operation")
	case <-ctx.Done():
		s.mu.Lock()
		defer s.mu.Unlock()
		s.approvalMu.Lock()
		delete(s.hookApprovals, message.ID)
		s.approvalMu.Unlock()
		owner = s.ownerLocked(target.BotID, target.GroupID, target.ThreadID)
		if owner.thread != nil {
			msg := s.findMessageLocked(owner.thread, message.ID)
			if msg != nil && msg.Status == model.StatusPending {
				msg.Status = model.StatusDenied
				msg.Approval.Decision = "denied"
				msg.Approval.DecidedAt = time.Now()
				msg.UpdatedAt = msg.Approval.DecidedAt
				if owner.thread.Status == "Waiting for you" {
					owner.thread.Status = "Thinking"
				}
				s.touchLocked()
				s.saveLocked()
				s.emitStateLocked()
			}
		}
		return "", fmt.Errorf("waiting for computer approval: %w", ctx.Err())
	}
}
