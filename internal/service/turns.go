package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/agent"
	"github.com/dandandujie/grox/internal/model"
)

type turnSink struct {
	svc      *Service
	key      string
	botID    string
	groupID  string
	threadID string
	engine   string
	model    model.Model
	message  string
	created  bool
	canceled bool
	usage    model.Usage
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
	return t.svc.ownerLocked(t.botID, t.groupID, t.threadID)
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
	owner := t.ownerLocked()
	if owner.thread == nil {
		t.svc.mu.Unlock()
		return
	}
	thread := owner.thread
	now := time.Now()
	if t.message == "" {
		msg := t.newMessage(model.KindText)
		thread.Messages = append(thread.Messages, msg)
		t.message = msg.ID
	}
	msg := t.svc.findMessageLocked(thread, t.message)
	if msg == nil {
		t.svc.mu.Unlock()
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
	t.svc.mu.Unlock()

	if created {
		base := msgCopy
		base.Text = ""
		t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: base.ID, Message: &base})
	}
	t.svc.emitEvent(model.Event{Type: "delta", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: t.message, Delta: delta})
}

func (t *turnSink) Status(status string) {
	t.svc.mu.Lock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		t.svc.mu.Unlock()
		return
	}
	owner.thread.Status = status
	turn := &model.Turn{BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Busy: true, Status: status, Engine: t.engine}
	t.svc.mu.Unlock()
	t.svc.emitEvent(model.Event{Type: "turn", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Turn: turn})
}

func (t *turnSink) Activity(activity model.Activity) {
	t.svc.mu.Lock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		t.svc.mu.Unlock()
		return
	}
	thread := owner.thread
	now := time.Now()
	if t.message == "" {
		msg := t.newMessage(model.KindText)
		thread.Messages = append(thread.Messages, msg)
		t.message = msg.ID
	}
	msg := t.svc.findMessageLocked(thread, t.message)
	if msg == nil {
		t.svc.mu.Unlock()
		return
	}
	if activity.StartedAt.IsZero() {
		activity.StartedAt = now
	}
	msg.Activities = append(msg.Activities, activity)
	msg.UpdatedAt = now
	thread.UpdatedAt = now
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	t.svc.touchLocked()
	out := cloneMessage(*msg)
	t.svc.mu.Unlock()
	t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: out.ID, Message: &out})
}

func (t *turnSink) Approval(approval model.Approval) {
	t.svc.mu.Lock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		t.svc.mu.Unlock()
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
	t.svc.mu.Unlock()
	t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: out.ID, Message: &out})
	t.svc.emitEvent(model.Event{Type: "turn", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Turn: turn})
}

func (t *turnSink) Options(text string, options []model.Option) {
	t.svc.mu.Lock()
	owner := t.ownerLocked()
	if owner.thread == nil {
		t.svc.mu.Unlock()
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
	t.svc.mu.Unlock()
	t.svc.emitEvent(model.Event{Type: "message", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, MessageID: out.ID, Message: &out})
	t.svc.emitEvent(model.Event{Type: "turn", BotID: t.botID, GroupID: t.groupID, ThreadID: t.threadID, Turn: turn})
}

func (s *Service) finishTurn(key string, sink *turnSink, runErr error, runID string) {
	s.mu.Lock()
	owner := s.ownerLocked(sink.botID, sink.groupID, sink.threadID)
	if owner.thread == nil {
		delete(s.turns, key)
		s.mu.Unlock()
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
				msg.Text += "**Couldn't finish this turn**\n\n" + runErr.Error() + "\n\nOpen **Settings → Engines** to check the connection."
			}
			if canceled && strings.TrimSpace(msg.Text) == "" {
				msg.Text = "_Stopped._"
			}
			final = ptr(cloneMessage(*msg))
		}
	} else if runErr != nil && !canceled {
		msg := model.Message{
			ID: newID("msg"), Role: model.RoleBot, Kind: model.KindText, Error: true,
			Text:     "**Couldn't finish this turn**\n\n" + runErr.Error() + "\n\nOpen **Settings → Engines** to check the connection.",
			SenderID: senderID, SenderName: senderName, CreatedAt: now, UpdatedAt: now,
			Engine: sink.engine, Model: sink.model.Name,
		}
		thread.Messages = append(thread.Messages, msg)
		final = ptr(cloneMessage(msg))
	} else if canceled {
		msg := model.Message{
			ID: newID("msg"), Role: model.RoleBot, Kind: model.KindText,
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
		for i := range s.st.State.Runs {
			if s.st.State.Runs[i].ID == runID {
				s.st.State.Runs[i].Status = status
				s.st.State.Runs[i].FinishedAt = now
				s.st.State.Runs[i].Summary = summary
				break
			}
		}
		for i := range s.st.State.Routines {
			if s.st.State.Routines[i].ID == runRoutineID(s, runID) {
				s.st.State.Routines[i].LastStatus = status
				break
			}
		}
	}
	delete(s.turns, key)
	s.touchLocked()
	s.saveLocked()
	state := s.snapshotLocked()
	rev := state.Revision
	turn := &model.Turn{BotID: sink.botID, GroupID: sink.groupID, ThreadID: sink.threadID, Busy: false, Engine: sink.engine}
	s.mu.Unlock()

	if final != nil {
		s.emitEvent(model.Event{Type: "message", BotID: sink.botID, GroupID: sink.groupID, ThreadID: sink.threadID, MessageID: final.ID, Message: final})
	}
	s.emitEvent(model.Event{Type: "turn", BotID: sink.botID, GroupID: sink.groupID, ThreadID: sink.threadID, Turn: turn})
	s.emitEvent(model.Event{Type: "state", Revision: rev, State: &state})
}
