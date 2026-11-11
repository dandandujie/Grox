package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/dandandujie/grox/internal/model"
)

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
		config += "\n[mcp_servers." + name + "]\nurl = " + tomlString(server.URL) + "\nenabled = true\n"
		if auth := mcpAuthorization(server); auth != "" {
			config += "\n[mcp_servers." + name + ".headers]\nAuthorization = " + tomlString(auth) + "\n"
		}
	}
	if hookURL != "" {
		config += "\n[[hooks.PreToolUse]]\nmatcher = \"*\"\nhooks = [{ type = \"http\", url = " + tomlString(hookURL+"?style=grok") + ", timeout = 300 }]\n"
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
		config += "\n[mcp_servers." + name + "]\nurl = " + tomlString(server.URL) + "\nenabled = true\n"
		if strings.TrimSpace(server.Token) != "" {
			config += "bearer_token_env_var = " + tomlString(mcpEnvName(server.ID)) + "\n"
		}
	}
	if hookScript != "" {
		config += "\n[[hooks.PreToolUse]]\nmatcher = \"*\"\nhooks = [{ type = \"command\", command = " + tomlString(hookScript) + ", timeout = 300 }]\n"
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
		entry := map[string]any{"type": "http", "url": server.URL}
		if auth := mcpAuthorization(server); auth != "" {
			entry["headers"] = map[string]any{"Authorization": auth}
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
