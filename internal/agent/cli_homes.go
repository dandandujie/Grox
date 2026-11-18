package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/dandandujie/grox/internal/model"
)

func readGeminiSettings(path string, settings map[string]any) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	// Gemini's settings loader accepts JSON with C-style comments. Replace
	// comments with whitespace while keeping slashes inside strings intact.
	inString := false
	for i := 0; i < len(data); i++ {
		switch data[i] {
		case '"':
			inString = !inString
		case '\\':
			if inString {
				i++
			}
		case '/':
			if inString || i+1 == len(data) {
				continue
			}
			if data[i+1] == '/' {
				for i < len(data) && data[i] != '\n' {
					data[i] = ' '
					i++
				}
			} else if data[i+1] == '*' {
				data[i], data[i+1] = ' ', ' '
				i += 2
				for i+1 < len(data) && (data[i] != '*' || data[i+1] != '/') {
					data[i] = ' '
					i++
				}
				if i+1 >= len(data) {
					return fmt.Errorf("unterminated block comment")
				}
				data[i], data[i+1] = ' ', ' '
				i++
			}
		}
	}
	parsed := settings
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	if parsed == nil {
		return fmt.Errorf("settings must be a JSON object")
	}
	return nil
}

func tomlString(value string) string {
	return strconv.Quote(value)
}

func linkHomeEntries(source, target, skip string) {
	entries, err := os.ReadDir(source)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Name() == skip {
			continue
		}
		_ = os.Symlink(filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name()))
	}
}

func baseConfig(sourcePath string) string {
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(data), "\n") + "\n"
}

func mcpConfigName(name string) string {
	value := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	dash := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if b.Len() > 0 && !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "mcp"
	}
	if out == "grox" {
		out = "remote-grox"
	}
	return out
}

func mcpEnvName(id string) string {
	value := strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(id))
	return "GROX_MCP_TOKEN_" + value
}

func mcpTransport(server model.MCPServerConfig) string {
	if strings.EqualFold(strings.TrimSpace(server.Transport), "stdio") {
		return "stdio"
	}
	return "http"
}

func tomlArgs(args []string) string {
	parts := make([]string, 0, len(args))
	for _, arg := range args {
		parts = append(parts, tomlString(arg))
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

func mcpHeaders(server model.MCPServerConfig) map[string]string {
	out := map[string]string{}
	for name, value := range server.Headers {
		out[name] = value
	}
	if auth := mcpAuthorization(server); auth != "" {
		if _, exists := out["Authorization"]; !exists {
			out["Authorization"] = auth
		}
	}
	return out
}

func mcpAuthorization(server model.MCPServerConfig) string {
	if strings.TrimSpace(server.Token) == "" {
		return ""
	}
	return "Bearer " + strings.TrimSpace(server.Token)
}

func prepareGrokHome(mcpURL, hookURL string, servers ...model.MCPServerConfig) (string, func(), error) {
	home, err := os.MkdirTemp("", "grox-grok-home-*")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(home) }
	realHome, _ := os.UserHomeDir()
	realDir := filepath.Join(realHome, ".grok")
	linkHomeEntries(realDir, home, "config.toml")
	config := baseConfig(filepath.Join(realDir, "config.toml"))
	if mcpURL != "" {
		config += "\n[mcp_servers.grox]\nurl = " + tomlString(mcpURL) + "\nenabled = true\n"
	}
	for _, server := range servers {
		name := mcpConfigName(server.Name)
		if mcpTransport(server) == "stdio" {
			config += "\n[mcp_servers." + name + "]\ncommand = " + tomlString(server.Command) + "\nargs = " + tomlArgs(server.Args) + "\nenabled = true\n"
			continue
		}
		config += "\n[mcp_servers." + name + "]\nurl = " + tomlString(server.URL) + "\nenabled = true\n"
		headers := mcpHeaders(server)
		if len(headers) > 0 {
			config += "\n[mcp_servers." + name + ".headers]\n"
			for header, value := range headers {
				config += tomlString(header) + " = " + tomlString(value) + "\n"
			}
		}
	}
	if hookURL != "" {
		script, scriptCleanup, err := makeToolHookScript(hookURL, "grok")
		if err != nil {
			cleanup()
			return "", func() {}, err
		}
		config += "\n[[hooks.PreToolUse]]\nmatcher = \"*\"\nhooks = [{ type = \"command\", command = " + tomlString(toolHookCommand(script)) + ", timeout = 300 }]\n"
		cleanup = func() {
			scriptCleanup()
			_ = os.RemoveAll(home)
		}
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return home, cleanup, nil
}

func prepareCodexHome(mcpURL, hookScript string, servers ...model.MCPServerConfig) (string, func(), error) {
	home, err := os.MkdirTemp("", "grox-codex-home-*")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(home) }
	realHome, _ := os.UserHomeDir()
	realDir := filepath.Join(realHome, ".codex")
	linkHomeEntries(realDir, home, "config.toml")
	config := baseConfig(filepath.Join(realDir, "config.toml"))
	if mcpURL != "" {
		config += "\n[mcp_servers.grox]\nurl = " + tomlString(mcpURL) + "\nenabled = true\n"
	}
	for _, server := range servers {
		name := mcpConfigName(server.Name)
		if mcpTransport(server) == "stdio" {
			config += "\n[mcp_servers." + name + "]\ncommand = " + tomlString(server.Command) + "\nargs = " + tomlArgs(server.Args) + "\nenabled = true\n"
			continue
		}
		config += "\n[mcp_servers." + name + "]\nurl = " + tomlString(server.URL) + "\nenabled = true\n"
		if strings.TrimSpace(server.Token) != "" {
			config += "bearer_token_env_var = " + tomlString(mcpEnvName(server.ID)) + "\n"
		}
	}
	if hookScript != "" {
		config += "\n[[hooks.PreToolUse]]\nmatcher = \"*\"\nhooks = [{ type = \"command\", command = " + tomlString(toolHookCommand(hookScript)) + ", timeout = 300 }]\n"
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return home, cleanup, nil
}

func writeMCPConfig(mcpURL string, servers ...model.MCPServerConfig) (string, func(), error) {
	file, err := os.CreateTemp("", "grox-mcp-*.json")
	if err != nil {
		return "", func() {}, err
	}
	path := file.Name()
	cleanup := func() { _ = os.Remove(path) }
	serverMap := map[string]any{}
	if mcpURL != "" {
		serverMap["grox"] = map[string]any{"type": "http", "url": mcpURL}
	}
	for _, server := range servers {
		if mcpTransport(server) == "stdio" {
			serverMap[mcpConfigName(server.Name)] = map[string]any{
				"type": "stdio", "command": server.Command, "args": append([]string(nil), server.Args...),
			}
			continue
		}
		entry := map[string]any{"type": "http", "url": server.URL}
		if headers := mcpHeaders(server); len(headers) > 0 {
			entry["headers"] = headers
		}
		serverMap[mcpConfigName(server.Name)] = entry
	}
	config := map[string]any{"mcpServers": serverMap}
	data, err := json.Marshal(config)
	if err != nil {
		_ = file.Close()
		cleanup()
		return "", func() {}, err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		cleanup()
		return "", func() {}, err
	}
	_ = file.Close()
	return path, cleanup, nil
}
