package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// runCLI runs a local agent CLI in headless mode and folds its event stream
// into text deltas and activity chips.
func runCLI(ctx context.Context, req Request, sink Sink) (string, error) {
	provider := req.Model.Provider
	binary := map[string]string{"grok": "grok", "claude": "claude", "openai": "codex", "google": "gemini"}[provider]
	if binary == "" {
		return "", fmt.Errorf("%s is not a CLI provider", provider)
	}
	workdir := req.WorkDir
	if workdir == "" {
		workdir, _ = os.UserHomeDir()
	}
	if info, err := os.Stat(workdir); err != nil || !info.IsDir() {
		workdir, _ = os.UserHomeDir()
	}

	prompt := req.Prompt
	if prompt == "" {
		prompt = Compose(req.Bot, req.Thread, req.UserText)
	}

	var args []string
	var stdin string
	envExtras := map[string]string{}
	cleanups := []func(){}
	defer func() {
		for _, cleanup := range cleanups {
			cleanup()
		}
	}()
	switch provider {
	case "grok":
		mode := "dontAsk"
		switch approvalMode(req.Bot.Approval) {
		case "auto":
			mode = "auto"
		case "full":
			mode = "bypassPermissions"
		case "ask":
			if req.HookURL != "" {
				mode = "auto"
			}
		}
		if req.MCPURL != "" || req.HookURL != "" || len(req.MCPServers) > 0 {
			if home, cleanup, err := prepareGrokHome(req.MCPURL, req.HookURL, req.MCPServers...); err == nil {
				envExtras["GROK_HOME"] = home
				cleanups = append(cleanups, cleanup)
			}
		}
		args = []string{
			"--permission-mode", mode,
			"-m", req.Model.ID,
			"--output-format", "streaming-messages-json",
			"--include-partial-messages",
			"--no-alt-screen",
			"--cwd", workdir,
			"-p", prompt,
		}
	case "claude":
		mode := "plan"
		prompts := "none"
		switch approvalMode(req.Bot.Approval) {
		case "auto":
			mode = "auto"
		case "full":
			mode = "bypassPermissions"
		case "ask":
			if req.PermissionHookURL != "" {
				mode = "manual"
			}
		}
		args = []string{
			"-p", "--model", req.Model.ID,
			"--output-format", "stream-json", "--verbose",
			"--include-partial-messages",
			"--permission-mode", mode,
			"--permission-prompts", prompts,
		}
		if req.PermissionHookURL != "" && approvalMode(req.Bot.Approval) == "ask" {
			settings := map[string]any{
				"hooks": map[string]any{
					"PermissionRequest": []any{map[string]any{
						"matcher": "*",
						"hooks": []any{map[string]any{
							"type": "http", "url": req.PermissionHookURL, "timeout": 300,
						}},
					}},
				},
			}
			if data, err := json.Marshal(settings); err == nil {
				args = append(args, "--settings", string(data))
			}
		}
		if req.MCPURL != "" || len(req.MCPServers) > 0 {
			if path, cleanup, err := writeMCPConfig(req.MCPURL, req.MCPServers...); err == nil {
				cleanups = append(cleanups, cleanup)
				args = append(args, "--mcp-config", path, "--strict-mcp-config")
			}
		}
		stdin = prompt
	case "openai":
		sandbox := "read-only"
		if approvalMode(req.Bot.Approval) == "auto" {
			sandbox = "workspace-write"
		}
		if approvalMode(req.Bot.Approval) == "ask" && req.HookURL != "" {
			sandbox = "workspace-write"
		}
		args = []string{"exec", "--json", "--skip-git-repo-check", "--color", "never", "-C", workdir, "-m", req.Model.ID}
		if approvalMode(req.Bot.Approval) == "full" {
			args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		} else {
			args = append(args, "-s", sandbox)
		}
		if req.MCPURL != "" || (req.HookURL != "" && approvalMode(req.Bot.Approval) == "ask") || len(req.MCPServers) > 0 {
			script := ""
			if req.HookURL != "" && approvalMode(req.Bot.Approval) == "ask" {
				if hookScript, cleanup, scriptErr := makeToolHookScript(req.HookURL, "codex"); scriptErr == nil {
					script = hookScript
					cleanups = append(cleanups, cleanup)
				}
			}
			if home, cleanup, homeErr := prepareCodexHome(req.MCPURL, script, req.MCPServers...); homeErr == nil {
				envExtras["CODEX_HOME"] = home
				cleanups = append(cleanups, cleanup)
				if script != "" {
					args = append(args, "--dangerously-bypass-hook-trust")
				}
			}
		}
		args = append(args, "-")
		stdin = prompt
	case "google":
		mode := "plan"
		switch approvalMode(req.Bot.Approval) {
		case "auto":
			mode = "auto_edit"
		case "full":
			mode = "yolo"
		case "ask":
			if req.HookURL != "" {
				mode = "yolo"
			}
		}
		args = []string{"-p", prompt, "-m", req.Model.ID, "-o", "stream-json", "--skip-trust", "--approval-mode", mode}
		if req.MCPURL != "" || req.HookURL != "" || len(req.MCPServers) > 0 {
			if home, cleanup, err := prepareGeminiHome(req.MCPURL, req.HookURL, req.MCPServers...); err == nil {
				envExtras["GEMINI_CLI_HOME"] = home
				cleanups = append(cleanups, cleanup)
			}
		}
	}

	for key, value := range req.Env {
		envExtras[key] = value
	}
	for _, server := range req.MCPServers {
		if strings.TrimSpace(server.Token) != "" {
			envExtras[mcpEnvName(server.ID)] = server.Token
		}
	}

	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = workdir
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "TERM=dumb", "FORCE_COLOR=0")
	for key, value := range envExtras {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", friendlyError(provider, "", err)
	}

	// Keep the tail of stderr for a useful error, and drain it so the child
	// cannot block on a full pipe.
	var stderrBuf bytes.Buffer
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				stderrBuf.Write(buf[:n])
				if stderrBuf.Len() > 8192 {
					trimmed := stderrBuf.Bytes()[stderrBuf.Len()-8192:]
					stderrBuf.Reset()
					stderrBuf.Write(trimmed)
				}
			}
			if err != nil {
				return
			}
		}
	}()

	var text strings.Builder
	var plain strings.Builder
	sawDelta := false
	var eventErr string
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "{") {
			if isNoiseLine(line) {
				continue
			}
			plain.WriteString(line)
			plain.WriteString("\n")
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			plain.WriteString(line)
			plain.WriteString("\n")
			continue
		}
		handleCLIEvent(provider, obj, &text, &sawDelta, &eventErr, sink)
	}
	scanErr := scanner.Err()
	waitErr := cmd.Wait()
	<-stderrDone

	if eventErr != "" && text.Len() == 0 {
		return "", fmt.Errorf("%s", eventErr)
	}
	if waitErr != nil && ctx.Err() == nil && text.Len() == 0 && plain.Len() == 0 {
		return "", friendlyError(provider, stderrBuf.String(), waitErr)
	}
	if scanErr != nil && text.Len() == 0 && plain.Len() == 0 {
		return "", friendlyError(provider, stderrBuf.String(), scanErr)
	}
	if text.Len() == 0 && plain.Len() > 0 {
		cleaned := cleanOutput(plain.String())
		if cleaned != "" {
			sink.Text(cleaned)
			text.WriteString(cleaned)
		}
	}
	if strings.TrimSpace(text.String()) == "" {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", friendlyError(provider, stderrBuf.String(), fmt.Errorf("no reply"))
	}
	return text.String(), nil
}

func isNoiseLine(line string) bool {
	lower := strings.ToLower(line)
	for _, prefix := range []string{"npm ", "> ", "debug", "warning:", "node:", "experimentalwarning"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

func handleCLIEvent(provider string, obj map[string]any, text *strings.Builder, sawDelta *bool, eventErr *string, sink Sink) {
	if provider == "grok" || provider == "claude" {
		handleAnthropicEvent(obj, text, sawDelta, eventErr, sink)
		return
	}
	if provider == "openai" {
		handleCodexEvent(obj, text, eventErr, sink)
		return
	}
	handleGeminiEvent(obj, text, sawDelta, eventErr, sink)
}

// handleAnthropicEvent understands both Claude Code's stream-json and Grok's
// streaming-messages-json, which follows the same wire format.
func handleAnthropicEvent(obj map[string]any, text *strings.Builder, sawDelta *bool, eventErr *string, sink Sink) {
	typ := str(obj["type"])
	switch typ {
	case "error":
		msg := str(obj["message"])
		if msg == "" {
			msg = str(obj["error"])
		}
		if msg != "" && *eventErr == "" {
			*eventErr = msg
		}
	case "stream_event":
		ev, _ := obj["event"].(map[string]any)
		if ev == nil {
			ev = obj
		}
		handleAnthropicPayload(ev, text, sawDelta, sink)
	case "content_block_delta", "content_block_start", "content_block_stop", "message_start", "message_delta":
		handleAnthropicPayload(obj, text, sawDelta, sink)
	case "assistant":
		if *sawDelta {
			return
		}
		msg, _ := obj["message"].(map[string]any)
		if msg != nil {
			textFromContent(msg["content"], text, sink)
		}
	case "result":
		if *sawDelta || text.Len() > 0 {
			return
		}
		if result := str(obj["result"]); result != "" {
			sink.Text(result)
			text.WriteString(result)
		}
	}
}

func handleAnthropicPayload(ev map[string]any, text *strings.Builder, sawDelta *bool, sink Sink) {
	switch str(ev["type"]) {
	case "content_block_delta":
		delta, _ := ev["delta"].(map[string]any)
		if delta == nil {
			return
		}
		if d := str(delta["text"]); d != "" {
			*sawDelta = true
			sink.Text(d)
			text.WriteString(d)
		}
	case "content_block_start":
		block, _ := ev["content_block"].(map[string]any)
		if block != nil && str(block["type"]) == "tool_use" {
			sink.Activity(model.Activity{Label: "Using " + humanTool(str(block["name"])), Status: model.StatusRunning, StartedAt: time.Now()})
		}
	}
}

func textFromContent(content any, text *strings.Builder, sink Sink) {
	blocks, _ := content.([]any)
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		if block == nil {
			continue
		}
		switch str(block["type"]) {
		case "text":
			if t := str(block["text"]); t != "" {
				sink.Text(t)
				text.WriteString(t)
			}
		case "tool_use":
			sink.Activity(model.Activity{Label: "Using " + humanTool(str(block["name"])), Status: model.StatusRunning, StartedAt: time.Now()})
		}
	}
}

func handleCodexEvent(obj map[string]any, text *strings.Builder, eventErr *string, sink Sink) {
	typ := str(obj["type"])
	switch typ {
	case "error":
		if msg := str(obj["message"]); msg != "" && *eventErr == "" {
			*eventErr = msg
		}
	case "turn.failed":
		if msg := str(obj["error"]); msg != "" {
			*eventErr = msg
		}
	case "item.started", "item.completed", "item.updated":
		item, _ := obj["item"].(map[string]any)
		if item == nil {
			return
		}
		switch str(item["type"]) {
		case "agent_message":
			if typ == "item.completed" {
				if msg := str(item["text"]); msg != "" {
					sink.Text(msg)
					text.WriteString(msg)
				}
			}
		case "command_execution":
			if typ == "item.completed" {
				command := str(item["command"])
				if command == "" {
					command = str(item["aggregated_output"])
				}
				status := model.StatusOK
				if exit, ok := item["exit_code"]; ok && strings.TrimSpace(fmt.Sprint(exit)) != "0" {
					status = model.StatusError
				}
				sink.Activity(model.Activity{Label: "Ran a command", Detail: trimDetail(command), Status: status, StartedAt: time.Now()})
			}
		case "reasoning":
			if typ == "item.completed" {
				sink.Activity(model.Activity{Label: "Thought it through", Status: model.StatusOK, StartedAt: time.Now()})
			}
		case "web_search":
			if typ == "item.completed" {
				sink.Activity(model.Activity{Label: "Searched the web", Detail: trimDetail(str(item["query"])), Status: model.StatusOK, StartedAt: time.Now()})
			}
		case "mcp_tool_call":
			if typ == "item.completed" {
				sink.Activity(model.Activity{Label: "Used " + humanTool(str(item["tool"])), Status: model.StatusOK, StartedAt: time.Now()})
			}
		}
	}
}

func handleGeminiEvent(obj map[string]any, text *strings.Builder, sawDelta *bool, eventErr *string, sink Sink) {
	typ := str(obj["type"])
	switch typ {
	case "error":
		if msg := str(obj["message"]); msg != "" && *eventErr == "" {
			*eventErr = msg
		}
	case "message":
		if strings.ToLower(str(obj["role"])) != "assistant" && strings.ToLower(str(obj["role"])) != "model" {
			return
		}
		content := str(obj["content"])
		if content == "" {
			return
		}
		if delta, _ := obj["delta"].(bool); delta {
			*sawDelta = true
			sink.Text(content)
			text.WriteString(content)
		} else if !*sawDelta {
			sink.Text(content)
			text.WriteString(content)
			*sawDelta = true
		}
	case "tool_use":
		sink.Activity(model.Activity{Label: "Used " + humanTool(str(obj["name"])), Status: model.StatusRunning, StartedAt: time.Now()})
	case "tool_result":
		sink.Activity(model.Activity{Label: "Tool finished", Status: model.StatusOK, StartedAt: time.Now()})
	}
}

func humanTool(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "a tool"
	}
	name = strings.TrimPrefix(name, "mcp__")
	replacer := strings.NewReplacer("_", " ", "-", " ")
	return replacer.Replace(name)
}

func trimDetail(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) > 120 {
		return s[:117] + "…"
	}
	return s
}

func str(v any) string {
	switch value := v.(type) {
	case string:
		return value
	case nil:
		return ""
	default:
		return fmt.Sprint(value)
	}
}

func makeToolHookScript(hookURL, style string) (string, func(), error) {
	file, err := os.CreateTemp("", "grox-hook-*.sh")
	if err != nil {
		return "", func() {}, err
	}
	path := file.Name()
	endpoint := hookURL + "?style=" + style
	script := "#!/bin/sh\ncurl -sS --max-time 300 -X POST " + shellQuote(endpoint) + " -H 'Content-Type: application/json' --data-binary @-\n"
	if _, err := file.WriteString(script); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", func() {}, err
	}
	_ = file.Close()
	if err := os.Chmod(path, 0o700); err != nil {
		_ = os.Remove(path)
		return "", func() {}, err
	}
	return path, func() { _ = os.Remove(path) }, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func prepareGeminiHome(mcpURL, hookURL string, serversConfig ...model.MCPServerConfig) (string, func(), error) {
	home, err := os.MkdirTemp("", "grox-gemini-*")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(home) }
	realHome, err := os.UserHomeDir()
	if err == nil {
		realDir := filepath.Join(realHome, ".gemini")
		if entries, readErr := os.ReadDir(realDir); readErr == nil {
			for _, entry := range entries {
				if entry.Name() == "settings.json" {
					continue
				}
				_ = os.Symlink(filepath.Join(realDir, entry.Name()), filepath.Join(home, entry.Name()))
			}
		}
	}
	settings := map[string]any{}
	if data, readErr := os.ReadFile(filepath.Join(home, "settings.json")); readErr == nil {
		_ = json.Unmarshal(data, &settings)
	}
	// Merge the real user settings file when it exists (the symlink loop skipped it).
	if realHome != "" {
		if data, readErr := os.ReadFile(filepath.Join(realHome, ".gemini", "settings.json")); readErr == nil {
			var realSettings map[string]any
			if json.Unmarshal(data, &realSettings) == nil {
				for key, value := range realSettings {
					if _, exists := settings[key]; !exists {
						settings[key] = value
					}
				}
			}
		}
	}
	if mcpURL != "" || len(serversConfig) > 0 {
		servers, _ := settings["mcpServers"].(map[string]any)
		if servers == nil {
			servers = map[string]any{}
		}
		if mcpURL != "" {
			servers["grox"] = map[string]any{"url": mcpURL, "type": "http"}
		}
		for _, server := range serversConfig {
			entry := map[string]any{"url": server.URL, "type": "http"}
			if auth := mcpAuthorization(server); auth != "" {
				entry["headers"] = map[string]any{"Authorization": auth}
			}
			servers[mcpConfigName(server.Name)] = entry
		}
		settings["mcpServers"] = servers
	}
	if hookURL != "" {
		script, scriptCleanup, scriptErr := makeToolHookScript(hookURL, "gemini")
		if scriptErr != nil {
			cleanup()
			return "", func() {}, scriptErr
		}
		hooks, _ := settings["hooks"].(map[string]any)
		if hooks == nil {
			hooks = map[string]any{}
		}
		hooks["BeforeTool"] = []any{map[string]any{
			"matcher": "*",
			"hooks":   []any{map[string]any{"type": "command", "command": script, "timeout": 300}},
		}}
		settings["hooks"] = hooks
		// The script must outlive this helper; put its cleanup on the home cleanup.
		previous := cleanup
		cleanup = func() { scriptCleanup(); previous() }
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	if err := os.WriteFile(filepath.Join(home, "settings.json"), data, 0o600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return home, cleanup, nil
}
