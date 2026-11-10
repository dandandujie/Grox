package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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

func prepareGrokHome(mcpURL, hookURL string) (string, func(), error) {
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
	if hookURL != "" {
		config += "\n[[hooks.PreToolUse]]\nmatcher = \"*\"\nhooks = [{ type = \"http\", url = " + tomlString(hookURL+"?style=grok") + ", timeout = 300 }]\n"
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return home, cleanup, nil
}

func prepareCodexHome(mcpURL, hookScript string) (string, func(), error) {
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
	if hookScript != "" {
		config += "\n[[hooks.PreToolUse]]\nmatcher = \"*\"\nhooks = [{ type = \"command\", command = " + tomlString(hookScript) + ", timeout = 300 }]\n"
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return home, cleanup, nil
}

func writeMCPConfig(mcpURL string) (string, func(), error) {
	file, err := os.CreateTemp("", "grox-mcp-*.json")
	if err != nil {
		return "", func() {}, err
	}
	path := file.Name()
	cleanup := func() { _ = os.Remove(path) }
	config := map[string]any{"mcpServers": map[string]any{"grox": map[string]any{"type": "http", "url": mcpURL}}}
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
