package service

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

type claudeHookTarget struct {
	BotID    string
	GroupID  string
	ThreadID string
}

type claudeHookApproval struct {
	ch          chan string
	suggestions any
	target      claudeHookTarget
}

type claudeHookInput struct {
	ToolName              string          "json:\"tool_name\""
	ToolInput             json.RawMessage "json:\"tool_input\""
	PermissionSuggestions any             "json:\"permission_suggestions\""
}

func (s *Service) startApprovalServer() {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	if s.approvalServer != nil {
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/claude-hook/", s.handleClaudeHook)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 8 * time.Second}
	s.approvalListener = listener
	s.approvalServer = server
	go func() {
		_ = server.Serve(listener)
	}()
}

func (s *Service) stopApprovalServer() {
	s.approvalMu.Lock()
	server := s.approvalServer
	listener := s.approvalListener
	s.approvalServer = nil
	s.approvalListener = nil
	s.approvalMu.Unlock()
	if server != nil {
		_ = server.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
}

func (s *Service) newClaudeHookURL(target claudeHookTarget) (string, error) {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	if s.approvalListener == nil {
		return "", fmt.Errorf("the approval hook server is not running")
	}
	token := randomToken()
	s.approvalTokens[token] = target
	addr, ok := s.approvalListener.Addr().(*net.TCPAddr)
	if !ok {
		return "", fmt.Errorf("could not read the approval hook port")
	}
	return fmt.Sprintf("http://127.0.0.1:%d/claude-hook/%s", addr.Port, token), nil
}

func (s *Service) handleClaudeHook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/claude-hook/")
	s.approvalMu.Lock()
	target, ok := s.approvalTokens[token]
	if ok {
		delete(s.approvalTokens, token)
	}
	s.approvalMu.Unlock()
	if !ok || target.ThreadID == "" {
		http.Error(w, "unknown approval hook", http.StatusNotFound)
		return
	}
	var input claudeHookInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil {
		http.Error(w, "invalid hook input", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(input.ToolName) == "" {
		input.ToolName = "a tool"
	}
	command := input.ToolName
	if raw := strings.TrimSpace(string(input.ToolInput)); raw != "" {
		if len(raw) > 1200 {
			raw = raw[:1200] + "…"
		}
		command += " " + raw
	}
	s.mu.Lock()
	owner := s.ownerLocked(target.BotID, target.GroupID, target.ThreadID)
	if owner.thread == nil {
		s.mu.Unlock()
		http.Error(w, "conversation not found", http.StatusNotFound)
		return
	}
	now := time.Now()
	senderName := "Claude"
	senderID := target.BotID
	if bot := s.findBotLocked(target.BotID); bot != nil {
		senderName = bot.Name
	}
	approval := model.Approval{
		Title:   "Claude wants to use " + input.ToolName,
		Command: command,
		Reason:  "Claude Code paused before running a tool and is waiting for your decision.",
		Risk:    "This is a real tool call on this Mac. Allow it only if you understand the command.",
	}
	message := model.Message{
		ID: newID("msg"), Role: model.RoleBot, Kind: model.KindApproval,
		Status: model.StatusPending, Approval: &approval, SenderID: senderID, SenderName: senderName,
		CreatedAt: now, UpdatedAt: now,
	}
	owner.thread.Messages = append(owner.thread.Messages, message)
	owner.thread.Status = "Waiting for you"
	owner.thread.UpdatedAt = now
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	turn := &model.Turn{BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, Busy: true, Status: "Waiting for you"}
	s.mu.Unlock()
	s.emitEvent(model.Event{Type: "message", BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, MessageID: message.ID, Message: &message})
	s.emitEvent(model.Event{Type: "turn", BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, Turn: turn})

	pending := &claudeHookApproval{ch: make(chan string, 1), suggestions: input.PermissionSuggestions, target: target}
	s.approvalMu.Lock()
	s.hookApprovals[message.ID] = pending
	s.approvalMu.Unlock()

	decision := "deny"
	timer := time.NewTimer(240 * time.Second)
	defer timer.Stop()
	select {
	case decision = <-pending.ch:
	case <-r.Context().Done():
		decision = "deny"
	case <-timer.C:
		decision = "deny"
	}
	// If the turn was not resolved through Decide, settle the card now.
	s.mu.Lock()
	s.approvalMu.Lock()
	current := s.hookApprovals[message.ID]
	if current != nil {
		delete(s.hookApprovals, message.ID)
		owner = s.ownerLocked(target.BotID, target.GroupID, target.ThreadID)
		if owner.thread != nil {
			if msg := s.findMessageLocked(owner.thread, message.ID); msg != nil && msg.Status == model.StatusPending {
				msg.Status = model.StatusDenied
				msg.Approval.Decision = "denied"
				msg.Approval.DecidedAt = time.Now()
				msg.UpdatedAt = time.Now()
				owner.thread.Status = "Thinking"
				s.touchLocked()
				s.saveLocked()
				s.emitStateLocked()
			}
		}
	}
	s.approvalMu.Unlock()
	s.mu.Unlock()

	response := map[string]any{"behavior": "deny", "message": "Denied in Grox."}
	if decision != "deny" {
		response = map[string]any{"behavior": "allow"}
		if decision == "always" && pending.suggestions != nil {
			response["updatedPermissions"] = pending.suggestions
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName": "PermissionRequest",
			"decision":      response,
		},
	})
}

func (s *Service) hasClaudeHook(messageID string) bool {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	return s.hookApprovals[messageID] != nil
}

func (s *Service) resolveClaudeHook(messageID, decision string) error {
	s.mu.Lock()
	s.approvalMu.Lock()
	pending := s.hookApprovals[messageID]
	if pending == nil {
		s.approvalMu.Unlock()
		s.mu.Unlock()
		return fmt.Errorf("this approval is no longer waiting")
	}
	delete(s.hookApprovals, messageID)
	owner := s.ownerLocked(pending.target.BotID, pending.target.GroupID, pending.target.ThreadID)
	if owner.thread == nil {
		s.approvalMu.Unlock()
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	msg := s.findMessageLocked(owner.thread, messageID)
	if msg == nil || msg.Kind != model.KindApproval || msg.Approval == nil {
		s.approvalMu.Unlock()
		s.mu.Unlock()
		return fmt.Errorf("approval not found")
	}
	now := time.Now()
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
	owner.thread.Status = "Thinking"
	owner.thread.UpdatedAt = now
	if owner.bot != nil {
		owner.bot.UpdatedAt = now
	}
	if owner.group != nil {
		owner.group.UpdatedAt = now
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.approvalMu.Unlock()
	s.mu.Unlock()
	select {
	case pending.ch <- decision:
	default:
	}
	return nil
}
