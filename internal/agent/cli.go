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

	"github.com/dandandujie/grox/internal/catalog"
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
		prompt = Compose(req.Bot, req.Thread, req.UserText, req.PlaybookText)
	}

	var args []string
	var stdin string
	approval := approvalMode(req.Bot.Approval)
	if approval == "ask" {
		approvalURL := req.HookURL
		if provider == "claude" {
			approvalURL = req.PermissionHookURL
		}
		if approvalURL == "" {
			return "", fmt.Errorf("%s cannot start because Grox's approval service is unavailable", cliName(provider))
		}
	}
	envExtras := map[string]string{}
	for key, value := range req.Env {
		envExtras[key] = value
	}
	cleanups := []func(){}
	defer func() {
		for _, cleanup := range cleanups {
			cleanup()
		}
	}()
	switch provider {
	case "grok":
		mode := "dontAsk"
		switch approval {
		case "auto", "ask":
			mode = "auto"
		case "full":
			mode = "bypassPermissions"
		}
		if req.MCPURL != "" || approval == "ask" || len(req.MCPServers) > 0 {
			home, cleanup, err := prepareGrokHome(req.MCPURL, req.HookURL, req.MCPServers...)
			if err != nil {
				return "", cliConfigError(provider, err)
			}
			envExtras["GROK_HOME"] = home
			cleanups = append(cleanups, cleanup)
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
		switch approval {
		case "auto":
			mode = "auto"
		case "full":
			mode = "bypassPermissions"
		case "ask":
			mode = "manual"
		}
		args = []string{
			"-p", "--model", req.Model.ID,
			"--output-format", "stream-json", "--verbose",
			"--include-partial-messages",
			"--permission-mode", mode,
			"--permission-prompts", prompts,
		}
		if approval == "ask" {
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
			data, err := json.Marshal(settings)
			if err != nil {
				return "", cliConfigError(provider, err)
			}
			args = append(args, "--settings", string(data))
		}
		if req.MCPURL != "" || len(req.MCPServers) > 0 {
			path, cleanup, err := writeMCPConfig(req.MCPURL, req.MCPServers...)
			if err != nil {
				return "", cliConfigError(provider, err)
			}
			cleanups = append(cleanups, cleanup)
			args = append(args, "--mcp-config", path, "--strict-mcp-config")
		}
		stdin = prompt
	case "openai":
		sandbox := "read-only"
		if approval == "auto" || approval == "ask" {
			sandbox = "workspace-write"
		}
		args = []string{"exec", "--json", "--skip-git-repo-check", "--color", "never", "-C", workdir, "-m", req.Model.ID}
		if approval == "full" {
			args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		} else {
			args = append(args, "-s", sandbox)
		}
		if req.MCPURL != "" || approval == "ask" || len(req.MCPServers) > 0 {
			script := ""
			if approval == "ask" {
				hookScript, cleanup, err := makeToolHookScript(req.HookURL, "codex")
				if err != nil {
					return "", cliConfigError(provider, err)
				}
				script = hookScript
				cleanups = append(cleanups, cleanup)
			}
			home, cleanup, err := prepareCodexHome(req.MCPURL, script, req.MCPServers...)
			if err != nil {
				return "", cliConfigError(provider, err)
			}
			envExtras["CODEX_HOME"] = home
			cleanups = append(cleanups, cleanup)
			if script != "" {
				args = append(args, "--enable", "hooks", "--dangerously-bypass-hook-trust")
			}
		}
		args = append(args, "-")
		stdin = prompt
	case "google":
		mode := "plan"
		switch approval {
		case "auto":
			mode = "auto_edit"
		case "full", "ask":
			mode = "yolo"
		}
		args = []string{"-p", prompt, "-m", req.Model.ID, "-o", "stream-json", "--skip-trust", "--approval-mode", mode}
		if req.MCPURL != "" || approval == "ask" || len(req.MCPServers) > 0 {
			home, cleanup, err := prepareGeminiHome(req.MCPURL, req.HookURL, req.MCPServers...)
			if err != nil {
				return "", cliConfigError(provider, err)
			}
			envExtras["GEMINI_CLI_HOME"] = home
			cleanups = append(cleanups, cleanup)
		}
	}

	for _, server := range req.MCPServers {
		if strings.TrimSpace(server.Token) != "" {
			envExtras[mcpEnvName(server.ID)] = server.Token
		}
	}

	cmd := catalog.CLICommand(ctx, binary, args...)
	cmd.Dir = workdir
	cmd.Env = append(cmd.Environ(), "NO_COLOR=1", "TERM=dumb", "FORCE_COLOR=0")
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
	if scanErr != nil {
		// The scanner can stop while the child still has a full output pipe.
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	<-stderrDone

	if ctx.Err() != nil {
		return text.String(), ctx.Err()
	}
	if eventErr != "" {
		return text.String(), fmt.Errorf("%s", eventErr)
	}
	if scanErr != nil {
		return text.String(), friendlyError(provider, stderrBuf.String(), scanErr)
	}
	if waitErr != nil {
		return text.String(), friendlyError(provider, stderrBuf.String(), waitErr)
	}
	if text.Len() == 0 && plain.Len() > 0 {
		cleaned := cleanOutput(plain.String())
		if cleaned != "" {
			sink.Text(cleaned)
			text.WriteString(cleaned)
		}
	}
	if strings.TrimSpace(text.String()) == "" {
		return "", friendlyError(provider, stderrBuf.String(), fmt.Errorf("no reply"))
	}
	return text.String(), nil
}

func cliConfigError(provider string, err error) error {
	return fmt.Errorf("could not configure %s for this turn: %w", cliName(provider), err)
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

func usageFromMap(value any) (TokenUsage, bool) {
	raw, ok := value.(map[string]any)
	if !ok || raw == nil {
		return TokenUsage{}, false
	}
	number := func(value any) int {
		if parsed, ok := value.(float64); ok {
			return int(parsed)
		}
		return 0
	}
	usage := TokenUsage{
		InputTokens:  number(raw["input_tokens"]) + number(raw["prompt_tokens"]),
		OutputTokens: number(raw["output_tokens"]) + number(raw["completion_tokens"]),
	}
	usage.TotalTokens = usage.InputTokens + usage.OutputTokens
	return usage, usage.TotalTokens > 0
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
		if usage, ok := usageFromMap(obj["usage"]); ok {
			reportUsage(sink, usage)
		}
		if failed, _ := obj["is_error"].(bool); failed {
			*eventErr = cliEventError(obj["result"], "the CLI marked this turn as failed")
			return
		}
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
		*eventErr = cliEventError(obj["error"], "Codex marked this turn as failed")
	case "turn.completed":
		*eventErr = ""
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
	case "result":
		if str(obj["status"]) == "error" {
			*eventErr = cliEventError(obj["error"], "Gemini marked this turn as failed")
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

func cliEventError(value any, fallback string) string {
	if details, ok := value.(map[string]any); ok {
		value = details["message"]
	}
	if message := str(value); message != "" {
		return message
	}
	return fallback
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
	curl, err := exec.LookPath("curl")
	if err != nil {
		return "", func() {}, fmt.Errorf("tool approvals require curl: %w", err)
	}
	if _, err := os.Stat("/bin/sh"); err != nil {
		return "", func() {}, fmt.Errorf("tool approvals require /bin/sh: %w", err)
	}
	file, err := os.CreateTemp("", "grox-hook-*.sh")
	if err != nil {
		return "", func() {}, err
	}
	path := file.Name()
	endpoint := hookURL + "?style=" + style
	allow := `{"decision":"allow"}`
	deny := `{"decision":"deny","reason":"Grox did not approve this tool call."}`
	if style == "codex" {
		allow = "{}"
		deny = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Grox did not approve this tool call."}}`
	}
	// The CLI can ignore a failed hook. Return an explicit denial when the
	// local service is unreachable or produces anything other than an allow.
	script := "#!/bin/sh\n" +
		"if reply=$(" + shellQuote(curl) + " --fail --silent --show-error --noproxy '*' --connect-timeout 3 --max-time 245 -X POST " + shellQuote(endpoint) +
		" -H 'Content-Type: application/json' --data-binary @-) && [ \"$reply\" = " + shellQuote(allow) + " ]; then\n" +
		"  printf '%s\\n' \"$reply\"\nelse\n  printf '%s\\n' " + shellQuote(deny) + "\nfi\n"
	if _, err := file.WriteString(script); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", func() {}, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", func() {}, err
	}
	if err := os.Chmod(path, 0o700); err != nil {
		_ = os.Remove(path)
		return "", func() {}, err
	}
	return path, func() { _ = os.Remove(path) }, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func toolHookCommand(script string) string {
	return "/bin/sh " + shellQuote(script)
}

func prepareGeminiHome(mcpURL, hookURL string, serversConfig ...model.MCPServerConfig) (string, func(), error) {
	home, err := os.MkdirTemp("", "grox-gemini-*")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(home) }
	// GEMINI_CLI_HOME replaces the user's home directory. The CLI still
	// appends .gemini when locating settings, auth and installed extensions.
	configDir := filepath.Join(home, ".gemini")
	if err := os.Mkdir(configDir, 0o700); err != nil {
		cleanup()
		return "", func() {}, err
	}
	settings := map[string]any{}
	if realHome, err := os.UserHomeDir(); err == nil {
		realDir := filepath.Join(realHome, ".gemini")
		linkHomeEntries(realDir, configDir, "settings.json")
		if err := readGeminiSettings(filepath.Join(realDir, "settings.json"), settings); err != nil {
			cleanup()
			return "", func() {}, fmt.Errorf("read Gemini settings: %w", err)
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
			if mcpTransport(server) == "stdio" {
				servers[mcpConfigName(server.Name)] = map[string]any{
					"type": "stdio", "command": server.Command, "args": append([]string(nil), server.Args...),
				}
				continue
			}
			entry := map[string]any{"url": server.URL, "type": "http"}
			if headers := mcpHeaders(server); len(headers) > 0 {
				entry["headers"] = headers
			}
			servers[mcpConfigName(server.Name)] = entry
		}
		settings["mcpServers"] = servers
	}
	if hookURL != "" {
		hooksConfig, _ := settings["hooksConfig"].(map[string]any)
		if enabled, ok := hooksConfig["enabled"].(bool); ok && !enabled {
			cleanup()
			return "", func() {}, fmt.Errorf("enable Hooks in Gemini settings before using Ask mode")
		}
		script, scriptCleanup, scriptErr := makeToolHookScript(hookURL, "gemini")
		if scriptErr != nil {
			cleanup()
			return "", func() {}, scriptErr
		}
		hooks, _ := settings["hooks"].(map[string]any)
		if hooks == nil {
			hooks = map[string]any{}
		}
		beforeTool, _ := hooks["BeforeTool"].([]any)
		hooks["BeforeTool"] = append(beforeTool, map[string]any{
			"matcher": "*",
			"hooks":   []any{map[string]any{"type": "command", "command": toolHookCommand(script), "timeout": 300_000}},
		})
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
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), data, 0o600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return home, cleanup, nil
}
