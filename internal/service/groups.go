package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func (s *Service) findGroupLocked(id string) *model.Group {
	for i := range s.st.State.Groups {
		if s.st.State.Groups[i].ID == id {
			return &s.st.State.Groups[i]
		}
	}
	return nil
}

func (s *Service) findGroupThreadLocked(g *model.Group, id string) *model.Thread {
	for i := range g.Threads {
		if g.Threads[i].ID == id {
			return &g.Threads[i]
		}
	}
	return nil
}

// groupResponderLocked picks the bot that answers a channel message.
// An @Name mention wins; otherwise the lead answers.
func (s *Service) groupResponderLocked(g *model.Group, text string) *model.Bot {
	members := make([]*model.Bot, 0, len(g.MemberIDs))
	for _, id := range g.MemberIDs {
		if bot := s.findBotLocked(id); bot != nil {
			members = append(members, bot)
		}
	}
	lower := strings.ToLower(text)
	for _, bot := range members {
		if strings.Contains(lower, "@"+strings.ToLower(bot.Name)) {
			return bot
		}
	}
	if lead := s.findBotLocked(g.LeadID); lead != nil {
		return lead
	}
	if len(members) > 0 {
		return members[0]
	}
	return nil
}

// CreateGroup adds a channel and opens it.
func (s *Service) CreateGroup(input model.CreateGroupInput) (model.Group, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return model.Group{}, fmt.Errorf("give the channel a name")
	}
	s.mu.Lock()
	members := []string{}
	seen := map[string]bool{}
	for _, id := range input.MemberIDs {
		if bot := s.findBotLocked(id); bot != nil && !seen[id] {
			members = append(members, id)
			seen[id] = true
		}
	}
	if len(members) == 0 {
		s.mu.Unlock()
		return model.Group{}, fmt.Errorf("add at least one bot to the channel")
	}
	lead := input.LeadID
	if !seen[lead] {
		lead = members[0]
	}
	color := input.Color
	if !allowedColors[color] {
		color = "purple"
	}
	now := time.Now()
	leadBot := s.findBotLocked(lead)
	thread := model.Thread{
		ID: newID("thread"), BotID: "", Title: "New conversation", Kind: "group",
		CreatedAt: now, UpdatedAt: now,
	}
	greeting := "This is the " + name + " channel."
	if leadBot != nil {
		greeting = "Hey — " + leadBot.Name + " here. This is the " + name + " channel."
	}
	greeting += "\n\nMention a bot with **@Name**, or just ask and the lead will take it. I can see the whole room."
	if leadBot != nil {
		thread.Messages = append(thread.Messages, model.Message{
			ID: newID("msg"), Role: model.RoleBot, Kind: model.KindText, Text: greeting,
			SenderID: leadBot.ID, SenderName: leadBot.Name, CreatedAt: now, UpdatedAt: now,
		})
	}
	group := model.Group{
		ID: newID("group"), Name: name, Description: strings.TrimSpace(input.Description), Color: color,
		MemberIDs: members, LeadID: lead, CreatedAt: now, UpdatedAt: now, Threads: []model.Thread{thread},
	}
	s.st.State.Groups = append(s.st.State.Groups, group)
	s.st.State.ActiveGroupID = group.ID
	s.st.State.ActiveBotID = ""
	s.st.State.ActiveThreadID = thread.ID
	s.touchLocked()
	s.saveLocked()
	out := cloneGroup(group)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// UpdateGroup edits the channel's identity or roster.
func (s *Service) UpdateGroup(groupID string, patch model.GroupPatch) (model.Group, error) {
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return model.Group{}, fmt.Errorf("channel not found")
	}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if name == "" {
			s.mu.Unlock()
			return model.Group{}, fmt.Errorf("the channel name cannot be empty")
		}
		g.Name = name
	}
	if patch.Description != nil {
		g.Description = strings.TrimSpace(*patch.Description)
	}
	if patch.Color != nil && allowedColors[*patch.Color] {
		g.Color = *patch.Color
	}
	if patch.MemberIDs != nil {
		members := []string{}
		seen := map[string]bool{}
		for _, id := range *patch.MemberIDs {
			if s.findBotLocked(id) != nil && !seen[id] {
				members = append(members, id)
				seen[id] = true
			}
		}
		if len(members) == 0 {
			s.mu.Unlock()
			return model.Group{}, fmt.Errorf("a channel needs at least one bot")
		}
		g.MemberIDs = members
		if !seen[g.LeadID] {
			g.LeadID = members[0]
		}
	}
	if patch.LeadID != nil {
		for _, id := range g.MemberIDs {
			if id == *patch.LeadID {
				g.LeadID = id
				break
			}
		}
	}
	if patch.Pinned != nil {
		g.Pinned = *patch.Pinned
	}
	if len(g.Threads) == 0 {
		now := time.Now()
		g.Threads = []model.Thread{{ID: newID("thread"), Title: "New conversation", Kind: "group", CreatedAt: now, UpdatedAt: now}}
	}
	g.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	out := cloneGroup(*g)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// DeleteGroup removes a channel.
func (s *Service) DeleteGroup(groupID string) error {
	s.mu.Lock()
	idx := -1
	for i := range s.st.State.Groups {
		if s.st.State.Groups[i].ID == groupID {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.mu.Unlock()
		return fmt.Errorf("channel not found")
	}
	for _, thread := range s.st.State.Groups[idx].Threads {
		if turn := s.turns["group:"+groupID+"|"+thread.ID]; turn != nil {
			turn.cancel()
		}
	}
	s.st.State.Groups = append(s.st.State.Groups[:idx], s.st.State.Groups[idx+1:]...)
	if s.st.State.ActiveGroupID == groupID {
		s.st.State.ActiveGroupID = ""
		s.st.State.ActiveThreadID = ""
		s.chooseAnotherBotLocked()
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

// CreateGroupThread starts a fresh channel conversation.
func (s *Service) CreateGroupThread(groupID, title string) (model.Thread, error) {
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return model.Thread{}, fmt.Errorf("channel not found")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = "New conversation"
	}
	now := time.Now()
	thread := model.Thread{ID: newID("thread"), Title: title, Kind: "group", CreatedAt: now, UpdatedAt: now}
	g.Threads = append([]model.Thread{thread}, g.Threads...)
	g.UpdatedAt = now
	s.st.State.ActiveGroupID = groupID
	s.st.State.ActiveBotID = ""
	s.st.State.ActiveThreadID = thread.ID
	s.touchLocked()
	s.saveLocked()
	out := cloneThread(thread)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// SelectGroup opens a channel and marks it read.
func (s *Service) SelectGroup(groupID, threadID string) error {
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return fmt.Errorf("channel not found")
	}
	if threadID == "" {
		threadID = s.st.State.ActiveThreadID
	}
	thread := s.findGroupThreadLocked(g, threadID)
	if thread == nil {
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	g.Unread = 0
	s.st.State.ActiveGroupID = groupID
	s.st.State.ActiveBotID = ""
	s.st.State.ActiveThreadID = threadID
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

// MarkGroupRead clears the channel's unread count.
func (s *Service) MarkGroupRead(groupID string) error {
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return fmt.Errorf("channel not found")
	}
	g.Unread = 0
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

// SendGroup sends a message to a channel.
func (s *Service) SendGroup(groupID, threadID, text string) (model.SendResult, error) {
	return s.sendGroupInternal(groupID, threadID, text, nil)
}

// SendGroupWithAttachments sends a message with files to a channel.
func (s *Service) SendGroupWithAttachments(groupID, threadID, text string, attachments []model.Attachment) (model.SendResult, error) {
	return s.sendGroupInternal(groupID, threadID, text, attachments)
}

func (s *Service) sendGroupInternal(groupID, threadID, text string, attachments []model.Attachment) (model.SendResult, error) {
	text = strings.TrimSpace(text)
	if text == "" && len(attachments) == 0 {
		return model.SendResult{}, fmt.Errorf("write a message first")
	}
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("channel not found")
	}
	if threadID == "" {
		threadID = s.st.State.ActiveThreadID
	}
	thread := s.findGroupThreadLocked(g, threadID)
	if thread == nil {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("conversation not found")
	}
	if thread.Busy {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("the channel is still working on the last message")
	}
	if err := s.validateAttachments(attachments); err != nil {
		s.mu.Unlock()
		return model.SendResult{}, err
	}
	responder := s.groupResponderLocked(g, text)
	if responder == nil {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("this channel has no bots")
	}
	now := time.Now()
	userMsg := model.Message{
		ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: text, Attachments: attachments,
		CreatedAt: now, UpdatedAt: now,
	}
	thread.Messages = append(thread.Messages, userMsg)
	if text != "" && (thread.Title == "" || thread.Title == "New conversation") {
		thread.Title = titleFromText(text)
	}
	thread.UpdatedAt = now
	thread.Unread = 0
	g.Unread = 0
	g.UpdatedAt = now
	s.st.State.ActiveGroupID = groupID
	s.st.State.ActiveBotID = ""
	s.st.State.ActiveThreadID = threadID
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()

	if err := s.startGroupTurn(groupID, threadID, responder.ID, text, s.attachmentContext(attachments), ""); err != nil {
		return model.SendResult{}, err
	}
	return model.SendResult{GroupID: groupID, BotID: responder.ID, ThreadID: threadID, MessageID: userMsg.ID}, nil
}

func (s *Service) startGroupTurn(groupID, threadID, botID, agentText, extraContext, runID string) error {
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return fmt.Errorf("channel not found")
	}
	thread := s.findGroupThreadLocked(g, threadID)
	if thread == nil {
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	if thread.Busy {
		s.mu.Unlock()
		return fmt.Errorf("the channel is still working on the last message")
	}
	key := "group:" + groupID + "|" + threadID
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	s.turns[key] = &turnControl{cancel: cancel, botID: botID, groupID: groupID, threadID: threadID}
	now := time.Now()
	thread.Busy = true
	thread.Status = "Thinking"
	thread.UpdatedAt = now
	g.UpdatedAt = now
	bot.LastActiveAt = now
	req, sel := s.engineRequestLocked(bot, thread, agentText, extraContext, groupID)
	req.GroupID = groupID
	if sel.Kind == "cli" {
		target := claudeHookTarget{BotID: botID, GroupID: groupID, ThreadID: threadID}
		if mcpURL, hookURL, err := s.newToolURLs(target); err == nil {
			req.MCPURL = mcpURL
			if bot.Approval == model.ApprovalAsk {
				req.HookURL = hookURL
			}
		}
		if req.Model.Provider == "claude" && bot.Approval == model.ApprovalAsk {
			if hookURL, err := s.newClaudeHookURL(target); err == nil {
				req.PermissionHookURL = hookURL
			}
		}
	}
	s.touchLocked()
	turn := &model.Turn{BotID: botID, GroupID: groupID, ThreadID: threadID, Busy: true, Status: "Thinking", Engine: sel.Engine}
	s.mu.Unlock()

	s.emitEvent(model.Event{Type: "turn", BotID: botID, GroupID: groupID, ThreadID: threadID, Turn: turn})
	if sel.Note != "" {
		s.emitEvent(model.Event{Type: "toast", BotID: botID, GroupID: groupID, ThreadID: threadID, Toast: &model.Toast{Kind: "info", Title: sel.Note}})
	}
	go s.runTurn(ctx, key, req, sel, runID)
	return nil
}

// StopGroup interrupts a channel turn.
func (s *Service) StopGroup(groupID, threadID string) error {
	s.mu.Lock()
	key := "group:" + groupID + "|" + threadID
	turn := s.turns[key]
	if turn == nil {
		s.mu.Unlock()
		return nil
	}
	turn.cancel()
	if g := s.findGroupLocked(groupID); g != nil {
		if thread := s.findGroupThreadLocked(g, threadID); thread != nil {
			thread.Status = "Stopping"
		}
	}
	t := &model.Turn{GroupID: groupID, ThreadID: threadID, Busy: true, Status: "Stopping"}
	s.mu.Unlock()
	s.emitEvent(model.Event{Type: "turn", GroupID: groupID, ThreadID: threadID, Turn: t})
	return nil
}

func cloneGroup(in model.Group) model.Group {
	data, _ := json.Marshal(in)
	var out model.Group
	_ = json.Unmarshal(data, &out)
	return out
}

// UpdateGroupThread renames a channel conversation.
func (s *Service) UpdateGroupThread(groupID, threadID, title string) (model.Thread, error) {
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return model.Thread{}, fmt.Errorf("channel not found")
	}
	thread := s.findGroupThreadLocked(g, threadID)
	if thread == nil {
		s.mu.Unlock()
		return model.Thread{}, fmt.Errorf("conversation not found")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		s.mu.Unlock()
		return model.Thread{}, fmt.Errorf("the title cannot be empty")
	}
	thread.Title = title
	thread.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	out := cloneThread(*thread)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// DeleteGroupThread removes a channel conversation, keeping one empty one.
func (s *Service) DeleteGroupThread(groupID, threadID string) error {
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return fmt.Errorf("channel not found")
	}
	idx := -1
	for i := range g.Threads {
		if g.Threads[i].ID == threadID {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	if turn := s.turns["group:"+groupID+"|"+threadID]; turn != nil {
		turn.cancel()
	}
	g.Threads = append(g.Threads[:idx], g.Threads[idx+1:]...)
	if len(g.Threads) == 0 {
		now := time.Now()
		g.Threads = append(g.Threads, model.Thread{ID: newID("thread"), Title: "New conversation", Kind: "group", CreatedAt: now, UpdatedAt: now})
	}
	if s.st.State.ActiveGroupID == groupID && s.st.State.ActiveThreadID == threadID {
		s.st.State.ActiveThreadID = g.Threads[0].ID
	}
	g.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

// DecideGroup settles an approval card in a channel.
func (s *Service) DecideGroup(groupID, threadID, messageID, decision string) error {
	decision = strings.ToLower(strings.TrimSpace(decision))
	if decision != "allow" && decision != "always" && decision != "deny" {
		return fmt.Errorf("unknown decision %q", decision)
	}
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return fmt.Errorf("channel not found")
	}
	thread := s.findGroupThreadLocked(g, threadID)
	if thread == nil {
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	if s.hasClaudeHook(messageID) {
		s.mu.Unlock()
		return s.resolveClaudeHook(messageID, decision)
	}
	if thread.Busy {
		s.mu.Unlock()
		return fmt.Errorf("the channel is still working on the last message")
	}
	msg := s.findMessageLocked(thread, messageID)
	if msg == nil || msg.Kind != model.KindApproval || msg.Approval == nil {
		s.mu.Unlock()
		return fmt.Errorf("approval not found")
	}
	if msg.Status != model.StatusPending {
		s.mu.Unlock()
		return fmt.Errorf("this approval was already answered")
	}
	now := time.Now()
	command := msg.Approval.Command
	switch decision {
	case "allow":
		msg.Status = model.StatusAllowed
		msg.Approval.Decision = "allowed"
	case "always":
		msg.Status = model.StatusAlways
		msg.Approval.Decision = "always"
		if bot := s.findBotLocked(msg.SenderID); bot != nil {
			bot.Approval = model.ApprovalAuto
		}
	case "deny":
		msg.Status = model.StatusDenied
		msg.Approval.Decision = "denied"
	}
	msg.Approval.DecidedAt = now
	msg.UpdatedAt = now
	thread.UpdatedAt = now
	g.UpdatedAt = now
	responder := msg.SenderID
	if responder == "" {
		responder = g.LeadID
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	prompt := "[approval:denied] " + command
	if decision != "deny" {
		prompt = "[approval:allowed] " + command
	}
	return s.startGroupTurn(groupID, threadID, responder, prompt, "", "")
}

// AnswerGroup settles an option card in a channel.
func (s *Service) AnswerGroup(groupID, threadID, messageID, answer string) error {
	s.mu.Lock()
	g := s.findGroupLocked(groupID)
	if g == nil {
		s.mu.Unlock()
		return fmt.Errorf("channel not found")
	}
	thread := s.findGroupThreadLocked(g, threadID)
	if thread == nil {
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	if target, ok := s.questionTarget(messageID); ok {
		s.mu.Unlock()
		return s.resolveQuestion(target, messageID, answer)
	}
	if thread.Busy {
		s.mu.Unlock()
		return fmt.Errorf("the channel is still working on the last message")
	}
	msg := s.findMessageLocked(thread, messageID)
	if msg == nil || msg.Kind != model.KindOptions {
		s.mu.Unlock()
		return fmt.Errorf("question not found")
	}
	if msg.Status != model.StatusPending {
		s.mu.Unlock()
		return fmt.Errorf("this question was already answered")
	}
	label := strings.TrimSpace(answer)
	description := ""
	for _, opt := range msg.Options {
		if opt.ID == answer || strings.EqualFold(opt.Label, answer) {
			label = opt.Label
			description = opt.Description
			break
		}
	}
	if label == "" {
		s.mu.Unlock()
		return fmt.Errorf("choose an answer first")
	}
	now := time.Now()
	msg.Status = model.StatusAnswered
	msg.UpdatedAt = now
	visible := label
	if description != "" && !strings.EqualFold(description, label) {
		visible += " — " + description
	}
	thread.Messages = append(thread.Messages, model.Message{
		ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: visible, CreatedAt: now, UpdatedAt: now,
	})
	thread.UpdatedAt = now
	g.UpdatedAt = now
	responder := msg.SenderID
	if responder == "" {
		responder = g.LeadID
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return s.startGroupTurn(groupID, threadID, responder, "My answer: "+visible, "", "")
}
