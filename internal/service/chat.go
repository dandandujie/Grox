package service

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dandandujie/grox/internal/agent"
	"github.com/dandandujie/grox/internal/browser"
	"github.com/dandandujie/grox/internal/catalog"
	"github.com/dandandujie/grox/internal/model"
)

// Send appends a user message and starts a bot turn.
func (s *Service) Send(botID, threadID, text string) (model.SendResult, error) {
	return s.sendInternal(botID, threadID, text, nil)
}

// SendWithAttachments sends a message with files previously stored by
// SaveAttachment.
func (s *Service) SendWithAttachments(botID, threadID, text string, attachments []model.Attachment) (model.SendResult, error) {
	return s.sendInternal(botID, threadID, text, attachments)
}

func (s *Service) sendInternal(botID, threadID, text string, attachments []model.Attachment) (model.SendResult, error) {
	text = strings.TrimSpace(text)
	if text == "" && len(attachments) == 0 {
		return model.SendResult{}, fmt.Errorf("write a message first")
	}
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("bot not found")
	}
	if threadID == "" {
		threadID = s.st.State.ActiveThreadID
	}
	thread := s.findThreadLocked(bot, threadID)
	if thread == nil {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("conversation not found")
	}
	if thread.Busy {
		s.mu.Unlock()
		return model.SendResult{}, fmt.Errorf("%s is still working on the last message", bot.Name)
	}
	attachments, err := s.savedAttachments(attachments)
	if err != nil {
		s.mu.Unlock()
		return model.SendResult{}, err
	}
	defer s.mu.Unlock()
	before := s.snapshotLocked()
	userMsgID := s.appendBotMessageLocked(bot, thread, text, attachments)
	if err := s.admitTurnLocked(before, bot, nil, thread, text, attachments, "", false); err != nil {
		return model.SendResult{}, err
	}
	return model.SendResult{BotID: botID, ThreadID: threadID, MessageID: userMsgID}, nil
}

func (s *Service) appendBotMessageLocked(bot *model.Bot, thread *model.Thread, text string, attachments []model.Attachment) string {
	now := time.Now()
	msg := model.Message{
		ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: text, Attachments: attachments,
		CreatedAt: now, UpdatedAt: now,
	}
	thread.Messages = append(thread.Messages, msg)
	if text != "" && (thread.Title == "" || thread.Title == "New conversation" || thread.Title == "New task") {
		thread.Title = titleFromText(text)
	}
	thread.Unread = 0
	bot.UpdatedAt = now
	s.st.State.ActiveBotID = bot.ID
	s.st.State.ActiveGroupID = ""
	s.st.State.ActiveThreadID = thread.ID
	return msg.ID
}

func titleFromText(text string) string {
	text = strings.TrimSpace(strings.ReplaceAll(text, "\n", " "))
	if utf8.RuneCountInString(text) > 54 {
		return string([]rune(text)[:51]) + "…"
	}
	return text
}

// admitTurnLocked commits the outgoing action and claims the thread in one
// operation. The caller validates that the thread is idle before mutating it.
func (s *Service) admitTurnLocked(before model.AppState, bot *model.Bot, group *model.Group, thread *model.Thread, agentText string, attachments []model.Attachment, runID string, demoContinuation bool) error {
	botID, threadID := bot.ID, thread.ID
	groupID := ""
	if group != nil {
		groupID = group.ID
	}
	now := time.Now()
	if group != nil {
		group.UpdatedAt = now
	}
	thread.Busy = true
	thread.Status = "Thinking"
	thread.UpdatedAt = now
	bot.LastActiveAt = now
	key := turnKey(botID, groupID, threadID)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	computer, computerErr := s.computerTargetLocked(bot)
	control := &turnControl{
		ctx: ctx, cancel: cancel, botID: botID, groupID: groupID, threadID: threadID,
		computer: computer, computerErr: computerErr, computerAllowed: make(map[string]bool),
	}
	if computerErr == nil && computer.remote == nil {
		control.browser = browser.NewSession(ctx)
	}
	s.turns[key] = control
	req, sel := s.engineRequestLocked(bot, thread, agentText, s.attachmentContext(attachments), groupID)
	if demoContinuation {
		req.EngineMode = "demo"
		sel = agent.Select(req)
	}
	var admissionErr error
	if sel.Kind == "unavailable" && runID == "" {
		admissionErr = fmt.Errorf("%s", sel.Note)
	} else {
		s.touchLocked()
		if err := s.st.SaveState(); err != nil {
			admissionErr = fmt.Errorf("save outgoing turn: %w", err)
		}
	}
	if admissionErr != nil {
		delete(s.turns, key)
		cancel()
		s.st.State = before
		return admissionErr
	}
	req.GroupID = groupID
	if sel.Kind == "api" && len(attachments) > 0 {
		req.LoadAPIAttachments = s.apiAttachmentLoader(attachments)
		req.ExtraContext = ""
	}
	if sel.Kind == "cli" {
		target := claudeHookTarget{BotID: botID, GroupID: groupID, ThreadID: threadID, control: control}
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
	s.emitStateLocked()
	turn := &model.Turn{BotID: botID, GroupID: groupID, ThreadID: threadID, Busy: true, Status: thread.Status, Engine: sel.Engine}
	s.emitEvent(model.Event{Type: "turn", BotID: botID, GroupID: groupID, ThreadID: threadID, Turn: turn})
	go func() {
		defer cancel()
		if control.browser != nil {
			defer control.browser.Close()
		}
		s.runTurn(ctx, key, control, req, sel, runID)
	}()
	return nil
}

// engineRequestLocked builds the provider request for a turn. It runs under
// s.mu and does not touch thread busy state.
func (s *Service) engineRequestLocked(bot *model.Bot, thread *model.Thread, agentText, extraContext string, groupIDs ...string) (agent.Request, agent.Selection) {
	groupID := ""
	if len(groupIDs) > 0 {
		groupID = groupIDs[0]
	}
	botCopy := cloneBot(*bot)
	threadCopy := cloneThread(*thread)
	if group := s.findGroupLocked(groupID); group != nil && strings.TrimSpace(group.Instructions) != "" {
		if strings.TrimSpace(botCopy.Soul) == "" {
			botCopy.Soul = "You are " + botCopy.Name + ", a helpful assistant."
		}
		botCopy.Soul += "\n\n## Channel instructions\n\n" + strings.TrimSpace(group.Instructions)
	}
	settings := s.st.State.Settings
	engineMode := settings.EngineMode
	engines := s.engines
	modelDef := s.modelByIDLocked(bot.ModelID)

	// An explicit engine choice in Settings applies to every bot. Use that
	// provider's default model so a Grok model never goes to the Codex CLI.
	if provider := agent.ProviderForEngineMode(settings.EngineMode); provider != "" {
		if modelDef.Provider != provider {
			if fallback := s.defaultModelForProviderLocked(provider); fallback.ID != "" {
				modelDef = fallback
			}
		}
	}
	apiBase := strings.TrimRight(strings.TrimSpace(settings.APIBaseURL), "/")
	apiKey := ""
	providerBase, providerKey := "", ""
	switch modelDef.Provider {
	case "grok":
		providerBase, providerKey = "https://api.x.ai/v1", s.st.Key("xai")
	case "openai":
		providerBase, providerKey = "https://api.openai.com/v1", s.st.Key("openai")
	}
	if apiBase == "" && providerKey != "" {
		apiBase = providerBase
	}
	if apiBase == providerBase || apiBase == providerBase+"/chat/completions" {
		apiKey = providerKey
	}
	if settings.EngineMode == "api" {
		if key := s.st.Key("api"); key != "" {
			apiKey = key
		}
	}

	cli := map[string]bool{}
	for _, e := range engines {
		if e.Status == "ready" {
			cli[e.ProviderID] = true
		}
	}
	skillText := s.enabledSkillTextLocked(bot)
	memoryText := s.memoryTextLocked(bot)
	recallText := s.memoryRecallLocked(bot, agentText)
	req := agent.Request{
		Bot: botCopy, Thread: threadCopy, UserText: agentText, History: threadCopy.Messages,
		Model: modelDef, WorkDir: bot.WorkingDir, EngineMode: engineMode, Language: settings.Language,
		APIBaseURL: apiBase, APIModel: settings.APIModel, APIKey: apiKey, CLIAvailable: cli,
		ExtraContext: extraContext, SkillText: skillText, PlaybookText: s.selectedPlaybookTextLocked(bot.ID, agentText), MemoryText: memoryText, RecallText: recallText,
		MCPServers: s.mcpConfigsForTurn(bot.ID),
	}
	req.Prompt = agent.Compose(botCopy, threadCopy, agentText, req.PlaybookText)
	if skillText != "" {
		req.Prompt += "\n\n## Enabled skills\n\n" + skillText
	}
	if memoryText != "" {
		req.Prompt += "\n\n## Memory\n\n" + memoryText
	}
	if recallText != "" {
		req.Prompt += "\n\n## Recalled memory\n\n" + recallText
	}
	if extraContext != "" {
		req.Prompt += "\n\n" + extraContext
	}
	sel := agent.Select(req)
	if sel.Kind == "api" && strings.TrimSpace(req.APIModel) != "" {
		req.Model.Name = strings.TrimSpace(req.APIModel)
	}
	if bot.Approval != model.ApprovalAsk {
		req.Tools = append(req.Tools, agent.Tool{
			Name:        "memory_forget",
			Description: "Remove matching top-level MEMORY.md entries and keep a copy in topics/archive.md. Use only when the person asked to forget something.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string"},
				},
				"required": []string{"query"},
			},
		})

		req.Tools = append(req.Tools, agent.Tool{
			Name:        "memory_tidy",
			Description: "Archive the oldest dated MEMORY.md entries when the memory file is over the 200-line / 24 KB load budget.",
			Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
		})

		req.Tools = append(req.Tools, agent.Tool{
			Name:        "memory_update",
			Description: "Save a durable memory note. Use for a preference or decision the person asked to remember, not for routine status.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"text":  map[string]any{"type": "string"},
					"topic": map[string]any{"type": "string"},
				},
				"required": []string{"text"},
			},
		})

		req.Tools = append(req.Tools, agent.Tool{
			Name:        "ask_user",
			Description: "Ask the person a question and wait for the answer before continuing. Use for a real fork in the work; do not use it for routine status updates.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"question": map[string]any{"type": "string"},
					"options": map[string]any{
						"type": "array",
						"items": map[string]any{"type": "object", "properties": map[string]any{
							"label":       map[string]any{"type": "string"},
							"description": map[string]any{"type": "string"},
						}, "required": []string{"label"}},
					},
				},
				"required": []string{"question"},
			},
		})
		for _, tool := range s.cachedComposioTools() {
			req.Tools = append(req.Tools, agent.Tool{Name: tool.Slug, Description: tool.Description, Parameters: tool.InputSchema})
		}
	}
	target := claudeHookTarget{
		BotID: botCopy.ID, GroupID: groupID, ThreadID: threadCopy.ID,
		control: s.turns[turnKey(botCopy.ID, groupID, threadCopy.ID)],
	}
	if sel.Kind == "api" && target.control != nil {
		req.Tools = append(computerToolsForTurn(target.control), req.Tools...)
	}
	filteredTools := req.Tools[:0]
	for _, tool := range req.Tools {
		if toolAllowed(bot.ToolPolicy, tool.Name) {
			filteredTools = append(filteredTools, tool)
		}
	}
	req.Tools = filteredTools
	if len(req.Tools) > 0 {
		var computerImages []agent.APIAttachment
		req.TakeAPIToolImages = func() []agent.APIAttachment {
			images := computerImages
			computerImages = nil
			return images
		}
		req.ExecuteTool = func(ctx context.Context, name string, arguments map[string]any) (string, error) {
			if !toolAllowed(botCopy.ToolPolicy, name) {
				return "", fmt.Errorf("tool %s is blocked by this bot's tool policy", name)
			}
			if isComputerTool(name) {
				result, err := s.executeComputerTool(ctx, target, name, arguments)
				if err == nil && result.image != nil && result.image.ImageMIME != "image/gif" {
					computerImages = append(computerImages, *result.image)
				}
				return result.text, err
			}
			if botCopy.Approval == model.ApprovalAsk {
				return "", fmt.Errorf("tool %s is unavailable in Ask mode", name)
			}
			switch name {
			case "memory_forget":
				return s.memoryForgetTool(target, arguments)
			case "memory_tidy":
				return s.memoryTidyTool(target)
			case "memory_update":
				return s.memoryUpdateTool(target, arguments)
			case "ask_user":
				return s.askUserTool(ctx, target, arguments)
			}
			value, err := s.ExecuteComposioTool(name, arguments)
			if err != nil {
				return "", err
			}
			data, err := json.Marshal(value)
			return string(data), err
		}
	}
	return req, sel
}

func (s *Service) defaultModelForProviderLocked(provider string) model.Model {
	availability := s.availabilityLocked(s.engines)
	providers := catalog.Providers(availability, "")
	for _, p := range providers {
		if p.ID != provider {
			continue
		}
		for _, m := range p.Models {
			if m.Default {
				return m
			}
		}
		if len(p.Models) > 0 {
			return p.Models[0]
		}
	}
	return model.Model{}
}

var runAgent = agent.Run

func (s *Service) runTurn(ctx context.Context, key string, control *turnControl, req agent.Request, sel agent.Selection, runID string) {
	sink := &turnSink{svc: s, key: key, control: control, botID: req.Bot.ID, groupID: req.GroupID, threadID: req.Thread.ID, engine: sel.Engine, model: req.Model}
	finished := false
	defer func() {
		if finished {
			return
		}
		if recovered := recover(); recovered != nil {
			logPanic("turn", recovered)
			s.finishTurn(sink, fmt.Errorf("the engine stopped unexpectedly"), runID)
		}
	}()
	var err error
	if sel.Kind == "unavailable" {
		err = fmt.Errorf("%s", sel.Note)
	} else {
		if sel.Kind == "cli" {
			s.prefetchMCPOAuth(ctx, req.Bot.ID)
			s.mu.Lock()
			req.MCPServers = s.mcpConfigsForTurn(req.Bot.ID)
			s.mu.Unlock()
		}
		if err = ctx.Err(); err == nil {
			_, err = runAgent(ctx, sel, req, sink)
			if err == nil {
				err = ctx.Err()
			}
		}
	}
	s.finishTurn(sink, err, runID)
	finished = true
}

func messageSummary(thread *model.Thread, id string) string {
	if id == "" {
		return ""
	}
	for i := len(thread.Messages) - 1; i >= 0; i-- {
		if thread.Messages[i].ID != id {
			continue
		}
		text := strings.TrimSpace(thread.Messages[i].Text)
		text = strings.ReplaceAll(text, "\n", " ")
		if len(text) > 200 {
			text = text[:197] + "…"
		}
		return text
	}
	return ""
}

func ptr[T any](v T) *T { return &v }

// Stop interrupts the active turn in a conversation.
func (s *Service) Stop(botID, threadID string) error {
	s.mu.Lock()
	key := botID + "|" + threadID
	turn := s.turns[key]
	if turn == nil {
		s.mu.Unlock()
		return nil
	}
	turn.cancel()
	bot := s.findBotLocked(botID)
	if bot != nil {
		if thread := s.findThreadLocked(bot, threadID); thread != nil {
			thread.Status = "Stopping"
		}
	}
	t := &model.Turn{BotID: botID, ThreadID: threadID, Busy: true, Status: "Stopping"}
	s.emitEvent(model.Event{Type: "turn", BotID: botID, ThreadID: threadID, Turn: t})
	s.mu.Unlock()
	return nil
}

func (s *Service) cancelTurnLocked(botID, threadID string) {
	key := botID + "|" + threadID
	if turn := s.turns[key]; turn != nil {
		turn.cancel()
	}
}

// Decide settles an approval card and continues the turn.
func (s *Service) Decide(botID, threadID, messageID, decision string) error {
	decision = strings.ToLower(strings.TrimSpace(decision))
	if decision != "allow" && decision != "always" && decision != "deny" {
		return fmt.Errorf("unknown decision %q", decision)
	}
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	thread := s.findThreadLocked(bot, threadID)
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
		return fmt.Errorf("%s is still working on the last message", bot.Name)
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
	defer s.mu.Unlock()
	before := s.snapshotLocked()
	now := time.Now()
	command := msg.Approval.Command
	switch decision {
	case "allow":
		msg.Status = model.StatusAllowed
		msg.Approval.Decision = "allowed"
	case "always":
		msg.Status = model.StatusAlways
		msg.Approval.Decision = "always"
	case "deny":
		msg.Status = model.StatusDenied
		msg.Approval.Decision = "denied"
	}
	msg.Approval.DecidedAt = now
	msg.UpdatedAt = now
	thread.UpdatedAt = now
	bot.UpdatedAt = now
	prompt := "[approval:denied] " + command
	if decision != "deny" {
		prompt = "[approval:allowed] " + command
	}
	return s.admitTurnLocked(before, bot, nil, thread, prompt, nil, "", true)
}

// Answer settles an options card, adds the chosen answer as a user message,
// and continues the turn.
func (s *Service) Answer(botID, threadID, messageID, answer string) error {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	thread := s.findThreadLocked(bot, threadID)
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
		return fmt.Errorf("%s is still working on the last message", bot.Name)
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
	defer s.mu.Unlock()
	before := s.snapshotLocked()
	now := time.Now()
	msg.Status = model.StatusAnswered
	msg.UpdatedAt = now
	visible := label
	if description != "" && !strings.EqualFold(description, label) {
		visible += " — " + description
	}
	thread.Messages = append(thread.Messages, model.Message{
		ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: visible,
		CreatedAt: now, UpdatedAt: now,
	})
	thread.UpdatedAt = now
	thread.Unread = 0
	bot.LastActiveAt = now
	bot.UpdatedAt = now
	return s.admitTurnLocked(before, bot, nil, thread, "My answer: "+visible, nil, "", true)
}

func homeDir() string {
	home, _ := os.UserHomeDir()
	return home
}
