package service

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func (s *Service) newToolURLs(target claudeHookTarget) (string, string, error) {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	if s.approvalListener == nil {
		return "", "", fmt.Errorf("the approval server is not running")
	}
	hostPort := s.approvalListener.Addr().String()
	port := hostPort[strings.LastIndex(hostPort, ":")+1:]
	token := randomToken()
	s.approvalTokens[token] = target
	base := "http://127.0.0.1:" + port
	return base + "/mcp/" + token, base + "/hook/" + token, nil
}

func toolString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func (s *Service) handleToolHook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/hook/")
	s.approvalMu.Lock()
	target, ok := s.approvalTokens[token]
	s.approvalMu.Unlock()
	if !ok {
		http.Error(w, "unknown tool hook", http.StatusNotFound)
		return
	}
	var input map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil {
		http.Error(w, "invalid hook input", http.StatusBadRequest)
		return
	}
	toolName := toolString(input["tool_name"])
	if toolName == "" {
		toolName = toolString(input["toolName"])
	}
	if toolName == "" {
		toolName = "a tool"
	}
	toolInput := input["tool_input"]
	if toolInput == nil {
		toolInput = input["toolInput"]
	}
	rawInput, _ := json.Marshal(toolInput)
	command := toolName
	if text := strings.TrimSpace(string(rawInput)); text != "" && text != "null" {
		if len(text) > 1200 {
			text = text[:1200] + "…"
		}
		command += " " + text
	}
	style := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("style")))
	if style == "" {
		style = "grok"
	}
	suggestions := input["permission_suggestions"]
	if suggestions == nil {
		suggestions = input["permissionSuggestions"]
	}

	s.mu.Lock()
	owner := s.ownerLocked(target.BotID, target.GroupID, target.ThreadID)
	if owner.thread == nil {
		s.mu.Unlock()
		http.Error(w, "conversation not found", http.StatusNotFound)
		return
	}
	now := time.Now()
	approval := model.Approval{
		Title:   "Tool approval: " + toolName,
		Command: command,
		Reason:  "The CLI paused before running a tool and is waiting for your decision.",
		Risk:    "Allow it only if you understand the tool call.",
	}
	message := model.Message{
		ID: newID("msg"), Role: model.RoleBot, Kind: model.KindApproval,
		Status: model.StatusPending, Approval: &approval, SenderID: target.BotID,
		CreatedAt: now, UpdatedAt: now,
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
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	turn := &model.Turn{BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, Busy: true, Status: "Waiting for you"}
	s.mu.Unlock()
	s.emitEvent(model.Event{Type: "message", BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, MessageID: message.ID, Message: &message})
	s.emitEvent(model.Event{Type: "turn", BotID: target.BotID, GroupID: target.GroupID, ThreadID: target.ThreadID, Turn: turn})

	pending := &claudeHookApproval{ch: make(chan string, 1), suggestions: suggestions, target: target}
	s.approvalMu.Lock()
	s.hookApprovals[message.ID] = pending
	s.approvalMu.Unlock()

	decision := "deny"
	timer := time.NewTimer(240 * time.Second)
	defer timer.Stop()
	select {
	case decision = <-pending.ch:
	case <-r.Context().Done():
	case <-timer.C:
	}
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

	response := toolHookResponse(style, decision)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}

func toolHookResponse(style, decision string) any {
	denied := decision == "deny"
	switch style {
	case "codex":
		if denied {
			return map[string]any{"hookSpecificOutput": map[string]any{
				"hookEventName": "PreToolUse", "permissionDecision": "deny",
				"permissionDecisionReason": "Denied in Grox.",
			}}
		}
		return map[string]any{}
	case "claude":
		choice := map[string]any{"behavior": "allow"}
		if denied {
			choice = map[string]any{"behavior": "deny", "message": "Denied in Grox."}
		}
		return map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "PermissionRequest", "decision": choice}}
	default:
		if denied {
			return map[string]any{"decision": "deny", "reason": "Denied in Grox."}
		}
		return map[string]any{"decision": "allow"}
	}
}

func (s *Service) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		http.Error(w, "SSE is not used by this MCP server", http.StatusMethodNotAllowed)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/mcp/")
	s.approvalMu.Lock()
	_, ok := s.approvalTokens[token]
	s.approvalMu.Unlock()
	if !ok {
		http.Error(w, "unknown MCP session", http.StatusNotFound)
		return
	}
	var request map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&request); err != nil {
		writeMCP(w, nil, nil, &mcpError{Code: -32700, Message: "parse error"})
		return
	}
	method, _ := request["method"].(string)
	id := request["id"]
	switch method {
	case "initialize":
		version := "2025-06-18"
		if params, ok := request["params"].(map[string]any); ok {
			if value := toolString(params["protocolVersion"]); value != "" {
				version = value
			}
		}
		writeMCP(w, id, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "grox", "version": model.AppVersion},
		}, nil)
	case "notifications/initialized", "notifications/cancelled":
		w.WriteHeader(http.StatusAccepted)
	case "ping":
		writeMCP(w, id, map[string]any{}, nil)
	case "tools/list":
		tools := s.cachedComposioTools()
		if len(tools) == 0 {
			if fresh, err := s.ListComposioTools(); err == nil {
				tools = fresh
			}
		}
		items := make([]map[string]any, 0, len(tools))
		for _, tool := range tools {
			schema := tool.InputSchema
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			items = append(items, map[string]any{
				"name": tool.Slug, "description": tool.Description, "inputSchema": schema,
			})
		}
		writeMCP(w, id, map[string]any{"tools": items}, nil)
	case "tools/call":
		params, _ := request["params"].(map[string]any)
		slug := toolString(params["name"])
		args, _ := params["arguments"].(map[string]any)
		if slug == "" {
			writeMCP(w, id, nil, &mcpError{Code: -32602, Message: "tool name is required"})
			return
		}
		value, err := s.ExecuteComposioTool(slug, args)
		if err != nil {
			writeMCP(w, id, map[string]any{"content": []map[string]any{{"type": "text", "text": err.Error()}}, "isError": true}, nil)
			return
		}
		data, _ := json.MarshalIndent(value, "", "  ")
		writeMCP(w, id, map[string]any{"content": []map[string]any{{"type": "text", "text": string(data)}}}, nil)
	default:
		if id == nil {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeMCP(w, id, nil, &mcpError{Code: -32601, Message: "method not found"})
	}
}

type mcpError struct {
	Code    int
	Message string
}

func writeMCP(w http.ResponseWriter, id any, result any, errValue *mcpError) {
	w.Header().Set("Content-Type", "application/json")
	response := map[string]any{"jsonrpc": "2.0", "id": id}
	if errValue != nil {
		response["error"] = map[string]any{"code": errValue.Code, "message": errValue.Message}
	} else {
		response["result"] = result
	}
	_ = json.NewEncoder(w).Encode(response)
}
