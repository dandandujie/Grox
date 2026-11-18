package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/agent"
	"github.com/dandandujie/grox/internal/model"
)

func turnKey(botID, groupID, threadID string) string {
	if groupID != "" {
		return "group:" + groupID + "|" + threadID
	}
	return botID + "|" + threadID
}

type turnSink struct {
	svc            *Service
	key            string
	control        *turnControl
	botID          string
	groupID        string
	threadID       string
	engine         string
	model          model.Model
	message        string
	created        bool
	canceled       bool
	usage          model.Usage
	toolRound      bool
	toolActivities []model.Activity
}

type sinkOwner struct {
	thread *model.Thread
	bot    *model.Bot
	group  *model.Group
}

func (s *Service) ownerLocked(botID, groupID, threadID string) sinkOwner {
	if groupID != "" {
		g := s.findGroupLocked(groupID)
		if g == nil {
			return sinkOwner{}
		}
		return sinkOwner{thread: s.findGroupThreadLocked(g, threadID), group: g}
	}
	b := s.findBotLocked(botID)
	if b == nil {
		return sinkOwner{}
	}
	return sinkOwner{thread: s.findThreadLocked(b, threadID), bot: b}
}

func (t *turnSink) ownerLocked() sinkOwner {
	if t.svc.turns[t.key] != t.control {
		return sinkOwner{}
	}
	owner := t.svc.ownerLocked(t.botID, t.groupID, t.threadID)
	if owner.thread != nil && owner.thread.Status == "Stopping" {
		return sinkOwner{}
	}
	return owner
}

func (t *turnSink) senderLocked() (string, string) {
	if bot := t.svc.findBotLocked(t.botID); bot != nil {
		return bot.ID, bot.Name
	}
	return t.botID, ""
}

func (t *turnSink) newMessage(kind string) model.Message {
	senderID, senderName := t.senderLocked()
	now := time.Now()
	return model.Message{
		ID: newID("msg"), Role: model.RoleBot, Kind: kind, Pending: true,
		SenderID: senderID, SenderName: senderName, Engine: t.engine, Model: t.model.Name,
		CreatedAt: now, UpdatedAt: now,
	}
}

func (t *turnSink) Usage(usage agent.TokenUsage) {
	t.usage.InputTokens += usage.InputTokens
	t.usage.OutputTokens += usage.OutputTokens
	t.usage.TotalTokens += usage.TotalTokens
	t.usage.Source = t.engine
}

func (t *turnSink) Text(delta string) {
	t.svc.mu.Lock()
	defer t.svc.mu.Unlock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		return
	}
	thread := owner.thread
	now := time.Now()
	if t.message == "" {
		msg := t.newMessage(model.KindText)
		msg.Activities = t.toolActivities
		t.toolActivities = nil
		thread.Messages = append(thread.Messages, msg)
		t.message = msg.ID
	}
	msg := t.svc.findMessageLocked(thread, t.message)
	if msg == nil {
		return
	}
	msg.Text += delta
	msg.UpdatedAt = now
	thread.Status = "Writing"
	thread.UpdatedAt = now
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	t.svc.touchLocked()
	msgCopy := cloneMessage(*msg)
	created := !t.created
	t.created = true

	if created {
		base := msgCopy
		base.Text = ""
		t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: base.ID, Message: &base})
	}
	t.svc.emitEvent(model.Event{Type: "delta", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: t.message, Delta: delta})
}

func (t *turnSink) Status(status string) {
	t.svc.mu.Lock()
	defer t.svc.mu.Unlock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		return
	}
	owner.thread.Status = status
	turn := &model.Turn{BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Busy: true, Status: status, Engine: t.engine}
	t.svc.emitEvent(model.Event{Type: "turn", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Turn: turn})
}

// StartToolRound closes any preamble before the tool emits approvals or files.
// Tool activity appears on the following reply, after the tool's messages.
func (t *turnSink) StartToolRound() {
	t.svc.mu.Lock()
	defer t.svc.mu.Unlock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		return
	}
	t.toolRound = true
	if t.message == "" {
		return
	}
	msg := t.svc.findMessageLocked(owner.thread, t.message)
	if msg != nil {
		msg.Pending = false
		msg.UpdatedAt = time.Now()
		t.svc.touchLocked()
		out := cloneMessage(*msg)
		t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: out.ID, Message: &out})
	}
	t.message = ""
	t.created = false
}

func (t *turnSink) Activity(activity model.Activity) {
	t.svc.mu.Lock()
	defer t.svc.mu.Unlock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		return
	}
	thread := owner.thread
	now := time.Now()
	if activity.StartedAt.IsZero() {
		activity.StartedAt = now
	}
	if t.toolRound && t.message == "" {
		t.toolActivities = append(t.toolActivities, activity)
		return
	}
	if t.message == "" {
		msg := t.newMessage(model.KindText)
		thread.Messages = append(thread.Messages, msg)
		t.message = msg.ID
	}
	msg := t.svc.findMessageLocked(thread, t.message)
	if msg == nil {
		return
	}
	msg.Activities = append(msg.Activities, activity)
	msg.UpdatedAt = now
	thread.UpdatedAt = now
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	t.svc.touchLocked()
	out := cloneMessage(*msg)
	t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: out.ID, Message: &out})
}

func (t *turnSink) Approval(approval model.Approval) {
	t.svc.mu.Lock()
	defer t.svc.mu.Unlock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		return
	}
	thread := owner.thread
	now := time.Now()
	msg := t.newMessage(model.KindApproval)
	msg.Pending = false
	msg.Status = model.StatusPending
	msg.Approval = &approval
	msg.CreatedAt, msg.UpdatedAt = now, now
	thread.Messages = append(thread.Messages, msg)
	thread.Status = "Waiting for you"
	thread.UpdatedAt = now
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	t.svc.touchLocked()
	out := cloneMessage(msg)
	turn := &model.Turn{BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Busy: true, Status: "Waiting for you", Engine: t.engine}
	t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: out.ID, Message: &out})
	t.svc.emitEvent(model.Event{Type: "turn", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Turn: turn})
}

func (t *turnSink) Options(text string, options []model.Option) {
	t.svc.mu.Lock()
	defer t.svc.mu.Unlock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		return
	}
	thread := owner.thread
	now := time.Now()
	msg := t.newMessage(model.KindOptions)
	msg.Pending = false
	msg.Text = text
	msg.Status = model.StatusPending
	msg.Options = options
	msg.CreatedAt, msg.UpdatedAt = now, now
	thread.Messages = append(thread.Messages, msg)
	thread.Status = "Waiting for you"
	thread.UpdatedAt = now
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	t.svc.touchLocked()
	out := cloneMessage(msg)
	turn := &model.Turn{BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Busy: true, Status: "Waiting for you", Engine: t.engine}
	t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: out.ID, Message: &out})
	t.svc.emitEvent(model.Event{Type: "turn", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Turn: turn})
}

func (s *Service) finishTurn(sink *turnSink, runErr error, runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revokeTurnHooks(sink.control)
	if s.turns[sink.key] != sink.control {
		return
	}
	delete(s.turns, sink.key)
	owner := s.ownerLocked(sink.botID, sink.groupID, sink.threadID)
	if owner.thread == nil {
		return
	}
	thread := owner.thread
	now := time.Now()
	canceled := errors.Is(runErr, context.Canceled) || sink.canceled
	senderID, senderName := sink.senderLocked()
	var final *model.Message
	if sink.message != "" {
		msg := s.findMessageLocked(thread, sink.message)
		if msg != nil {
			msg.Pending = false
			msg.UpdatedAt = now
			if runErr != nil && !canceled {
				msg.Error = true
				if strings.TrimSpace(msg.Text) != "" {
					msg.Text += "\n\n"
				}
				msg.Text += "**Couldn't finish this turn**\n\n" + runErr.Error()
			}
			if canceled {
				msg.Status = "stopped"
				if strings.TrimSpace(msg.Text) == "" {
					msg.Text = "_Stopped._"
				}
			}
			final = ptr(cloneMessage(*msg))
		}
	} else if runErr != nil && !canceled {
		msg := model.Message{
			ID: newID("msg"), Role: model.RoleBot, Kind: model.KindText, Error: true, Activities: sink.toolActivities,
			Text:     "**Couldn't finish this turn**\n\n" + runErr.Error(),
			SenderID: senderID, SenderName: senderName, CreatedAt: now, UpdatedAt: now,
			Engine: sink.engine, Model: sink.model.Name,
		}
		thread.Messages = append(thread.Messages, msg)
		final = ptr(cloneMessage(msg))
	} else if canceled {
		msg := model.Message{
			ID: newID("msg"), Role: model.RoleBot, Kind: model.KindText, Status: "stopped",
			Text: "_Stopped._", SenderID: senderID, SenderName: senderName,
			CreatedAt: now, UpdatedAt: now, Engine: sink.engine, Model: sink.model.Name,
		}
		thread.Messages = append(thread.Messages, msg)
		final = ptr(cloneMessage(msg))
	}
	logBot := owner.bot
	if logBot == nil {
		logBot = s.findBotLocked(sink.botID)
	}
	s.appendDailyLogLocked(logBot, thread, final, now)
	if sink.usage.TotalTokens > 0 {
		usage := sink.usage
		prices := s.st.State.Settings
		usage.CostUSD = float64(usage.InputTokens)/1_000_000*prices.InputPricePerMillion + float64(usage.OutputTokens)/1_000_000*prices.OutputPricePerMillion
		if final != nil {
			final.Usage = &usage
			if msg := s.findMessageLocked(thread, final.ID); msg != nil {
				msg.Usage = &usage
			}
		}
	}
	thread.Busy = false
	thread.Status = ""
	thread.UpdatedAt = now
	if owner.bot != nil {
		owner.bot.LastActiveAt = now
		owner.bot.UpdatedAt = now
	}
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	active := s.st.State.ActiveThreadID == sink.threadID
	if sink.groupID != "" {
		active = active && s.st.State.ActiveGroupID == sink.groupID
	} else {
		active = active && s.st.State.ActiveBotID == sink.botID
	}
	if !active {
		thread.Unread++
		if owner.group != nil {
			owner.group.Unread++
		}
	}
	status := "completed"
	summary := ""
	if runErr != nil && !canceled {
		status = "failed"
	}
	if canceled {
		status = "stopped"
	}
	if text := messageSummary(thread, sink.message); text != "" {
		summary = text
	}
	if runID != "" {
		if runErr != nil && !canceled && summary == "" {
			summary = runErr.Error()
		}
		s.finishRoutineRunLocked(runID, status, summary, now)
	}
	s.touchLocked()
	if err := s.st.SaveState(); err != nil {
		s.emitEvent(model.Event{Type: "toast", Toast: &model.Toast{
			Kind: "error", Title: "Couldn't save the finished turn", Body: err.Error(),
		}})
	}
	turn := &model.Turn{BotID: sink.botID, GroupID: sink.groupID, ThreadID: sink.threadID, Busy: false, Engine: sink.engine}
	if final != nil {
		s.emitEvent(model.Event{Type: "message", BotID: sink.botID, GroupID: sink.groupID, ThreadID: sink.threadID, MessageID: final.ID, Message: final})
	}
	s.emitEvent(model.Event{Type: "turn", BotID: sink.botID, GroupID: sink.groupID, ThreadID: sink.threadID, Turn: turn})
	s.emitStateLocked()

}
