package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/agent"
	"github.com/dandandujie/grox/internal/catalog"
	"github.com/dandandujie/grox/internal/model"
)

// Send appends a user message and starts a bot turn.
func (s *Service) Send(botID, threadID, text string) (model.SendResult, error) {
	return s.sendInternal(botID, threadID, text, nil, "", true)
}

// SendWithAttachments sends a message with files previously stored by
// SaveAttachment.
func (s *Service) SendWithAttachments(botID, threadID, text string, attachments []model.Attachment) (model.SendResult, error) {
	return s.sendInternal(botID, threadID, text, attachments, "", true)
}

func (s *Service) sendInternal(botID, threadID, text string, attachments []model.Attachment, runID string, appendUser bool) (model.SendResult, error) {
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
	if err := s.validateAttachments(attachments); err != nil {
		s.mu.Unlock()
		return model.SendResult{}, err
	}
	now := time.Now()
	userMsgID := ""
	if appendUser {
		msg := model.Message{
			ID: newID("msg"), Role: model.RoleUser, Kind: model.KindText, Text: text, Attachments: attachments,
			CreatedAt: now, UpdatedAt: now,
		}
		thread.Messages = append(thread.Messages, msg)
		userMsgID = msg.ID
		if text != "" && (thread.Title == "" || thread.Title == "New conversation" || thread.Title == "New task") {
			thread.Title = titleFromText(text)
		}
	}
	thread.UpdatedAt = now
	thread.Unread = 0
	bot.LastActiveAt = now
	bot.UpdatedAt = now
	s.st.State.ActiveBotID = botID
	s.st.State.ActiveThreadID = threadID
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()

	if err := s.startTurn(botID, threadID, text, s.attachmentContext(attachments), runID); err != nil {
		return model.SendResult{}, err
	}
	return model.SendResult{BotID: botID, ThreadID: threadID, MessageID: userMsgID}, nil
}

func titleFromText(text string) string {
	text = strings.TrimSpace(strings.ReplaceAll(text, "\n", " "))
	if len(text) > 54 {
		return text[:51] + "…"
	}
	return text
}

// startTurn prepares the request and runs the selected engine in the
// background. It must be called without s.mu held.
func (s *Service) startTurn(botID, threadID, agentText, extraContext, runID string) error {
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
	if thread.Busy {
		s.mu.Unlock()
		return fmt.Errorf("%s is still working on the last message", bot.Name)
	}
	key := botID + "|" + threadID
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	s.turns[key] = &turnControl{cancel: cancel, botID: botID, threadID: threadID}

	now := time.Now()
	thread.Busy = true
	thread.Status = "Thinking"
	bot.LastActiveAt = now
	thread.UpdatedAt = now
	req, sel := s.engineRequestLocked(bot, thread, agentText, extraContext)
	if sel.Kind == "cli" {
		target := claudeHookTarget{BotID: botID, ThreadID: threadID}
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
	turn := &model.Turn{BotID: botID, ThreadID: threadID, Busy: true, Status: "Thinking", Engine: sel.Engine}
	s.mu.Unlock()

	s.emitEvent(model.Event{Type: "turn", BotID: botID, ThreadID: threadID, Turn: turn})
	if sel.Note != "" {
		s.emitEvent(model.Event{Type: "toast", BotID: botID, ThreadID: threadID, Toast: &model.Toast{Kind: "info", Title: sel.Note}})
	}
	go s.runTurn(ctx, key, req, sel, runID)
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
	settings := s.st.State.Settings
	engineMode := settings.EngineMode
	// Approvals and question cards in this build are produced by the demo
	// engine. Resolve them with the same engine instead of forwarding a
	// synthetic prompt to a real CLI that never asked for it.
	if strings.HasPrefix(agentText, "[approval:") || strings.HasPrefix(agentText, "My answer:") || strings.HasPrefix(agentText, "[choice]") {
		engineMode = "demo"
	}
	engines := s.engines
	modelDef := s.modelByIDLocked(bot.ModelID)

	// An explicit engine choice in Settings applies to every bot. Use that
	// provider's default model so a Grok model never goes to the Codex CLI.
	if provider := providerForEngineMode(settings.EngineMode); provider != "" {
		if modelDef.Provider != provider {
			if fallback := s.defaultModelForProviderLocked(provider); fallback.ID != "" {
				modelDef = fallback
			}
		}
	}
	apiBase := strings.TrimSpace(settings.APIBaseURL)
	apiKey := ""
	switch modelDef.Provider {
	case "grok":
		apiKey = s.st.Key("xai")
		if apiBase == "" && apiKey != "" {
			apiBase = "https://api.x.ai/v1"
		}
	case "openai":
		apiKey = s.st.Key("openai")
		if apiBase == "" && apiKey != "" {
			apiBase = "https://api.openai.com/v1"
		}
	}
	if settings.EngineMode == "api" {
		if key := s.st.Key("api"); key != "" {
			apiKey = key
		}
	}
	if apiBase == "" && apiKey != "" && modelDef.Provider == "grok" {
		apiBase = "https://api.x.ai/v1"
	}
	if apiBase == "" && apiKey != "" && modelDef.Provider == "openai" {
		apiBase = "https://api.openai.com/v1"
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
		Model: modelDef, WorkDir: bot.WorkingDir, EngineMode: engineMode,
		APIBaseURL: apiBase, APIModel: settings.APIModel, APIKey: apiKey, CLIAvailable: cli,
		ExtraContext: extraContext, SkillText: skillText, MemoryText: memoryText, RecallText: recallText,
	}
	req.Prompt = agent.Compose(botCopy, threadCopy, agentText)
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
	if bot.Approval != model.ApprovalAsk {
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
		req.ExecuteTool = func(ctx context.Context, name string, arguments map[string]any) (string, error) {
			if name == "ask_user" {
				return s.askUserTool(claudeHookTarget{BotID: bot.ID, GroupID: groupID, ThreadID: thread.ID}, arguments)
			}
			value, err := s.ExecuteComposioTool(name, arguments)
			if err != nil {
				return "", err
			}
			data, err := json.Marshal(value)
			if err != nil {
				return "", err
			}
			return string(data), nil
		}
	}
	return req, sel
}

func providerForEngineMode(mode string) string {
	switch mode {
	case "grok":
		return "grok"
	case "claude":
		return "claude"
	case "codex":
		return "openai"
	case "gemini":
		return "google"
	}
	return ""
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

func (s *Service) runTurn(ctx context.Context, key string, req agent.Request, sel agent.Selection, runID string) {
	sink := &turnSink{svc: s, key: key, botID: req.Bot.ID, groupID: req.GroupID, threadID: req.Thread.ID, engine: sel.Engine, model: req.Model}
	_, err := agent.Run(ctx, sel, req, sink)
	if err != nil && sel.Kind == "cli" && !errors.Is(err, context.Canceled) && isConnectionError(err) {
		// A CLI that is installed but signed out should not make the app
		// silent. Use the local demo for this reply and say so.
		fallback := agent.Selection{Kind: "demo", Engine: "Grox Demo"}
		sink.engine = fallback.Engine
		s.emitEvent(model.Event{Type: "toast", BotID: req.Bot.ID, GroupID: req.GroupID, ThreadID: req.Thread.ID, Toast: &model.Toast{
			Kind: "info", Title: freshConnectionNote(err), Body: "This reply came from the built-in demo engine. Connect the CLI or add a key in Settings → Engines.",
		}})
		if _, demoErr := agent.Run(ctx, fallback, req, sink); demoErr == nil {
			err = nil
		}
	}
	s.finishTurn(key, sink, err, runID)
}

func isConnectionError(err error) bool {
	message := strings.ToLower(err.Error())
	for _, part := range []string{"not signed in", "not authenticated", "signed out", "login", "api key", "unauthorized", "401", "command not found", "no such file"} {
		if strings.Contains(message, part) {
			return true
		}
	}
	return false
}

func freshConnectionNote(err error) string {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "signed in") || strings.Contains(message, "authenticated") || strings.Contains(message, "login") {
		return "That CLI is not signed in"
	}
	return "That engine is not available"
}

func runRoutineID(s *Service, runID string) string {
	for _, r := range s.st.State.Runs {
		if r.ID == runID {
			return r.RoutineID
		}
	}
	return ""
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
	s.mu.Unlock()
	s.emitEvent(model.Event{Type: "turn", BotID: botID, ThreadID: threadID, Turn: t})
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
	now := time.Now()
	command := msg.Approval.Command
	switch decision {
	case "allow":
		msg.Status = model.StatusAllowed
		msg.Approval.Decision = "allowed"
	case "always":
		msg.Status = model.StatusAlways
		msg.Approval.Decision = "always"
		bot.Approval = model.ApprovalAuto
	case "deny":
		msg.Status = model.StatusDenied
		msg.Approval.Decision = "denied"
	}
	msg.Approval.DecidedAt = now
	msg.UpdatedAt = now
	thread.UpdatedAt = now
	bot.UpdatedAt = now
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()

	prompt := "[approval:denied] " + command
	if decision != "deny" {
		prompt = "[approval:allowed] " + command
	}
	return s.startTurn(botID, threadID, prompt, "", "")
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
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()

	return s.startTurn(botID, threadID, "My answer: "+visible, "", "")
}

func homeDir() string {
	home, _ := os.UserHomeDir()
	return home
}
