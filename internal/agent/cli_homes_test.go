package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dandandujie/grox/internal/model"
)

func TestPrepareCLIHomes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, dir := range []string{".grok", ".codex", ".gemini"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, ".grok", "config.toml"), []byte("[ui]\nscreen_mode = \"minimal\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("model = \"gpt-5.2\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".gemini", "settings.json"), []byte("{\"theme\":\"dark\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := model.MCPServerConfig{ID: "mcp-1", Name: "Linear", URL: "https://mcp.example.test/mcp", Token: "tok"}
	grokHome, grokCleanup, err := prepareGrokHome("http://127.0.0.1:1/mcp", "http://127.0.0.1:1/hook", server)
	if err != nil {
		t.Fatal(err)
	}
	grokConfig, _ := os.ReadFile(filepath.Join(grokHome, "config.toml"))
	if !strings.Contains(string(grokConfig), "[mcp_servers.grox]") || !strings.Contains(string(grokConfig), "PreToolUse") || !strings.Contains(string(grokConfig), "[mcp_servers.linear]") || !strings.Contains(string(grokConfig), "Authorization") {
		t.Fatalf("grok config = %s", grokConfig)
	}
	grokCleanup()
	codexHome, codexCleanup, err := prepareCodexHome("http://127.0.0.1:1/mcp", "/tmp/hook.sh", server)
	if err != nil {
		t.Fatal(err)
	}
	codexConfig, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if !strings.Contains(string(codexConfig), "mcp_servers.grox") || !strings.Contains(string(codexConfig), "PreToolUse") || !strings.Contains(string(codexConfig), "mcp_servers.linear") || !strings.Contains(string(codexConfig), "GROX_MCP_TOKEN_MCP_1") {
		t.Fatalf("codex config = %s", codexConfig)
	}
	codexCleanup()
	geminiHome, geminiCleanup, err := prepareGeminiHome("http://127.0.0.1:1/mcp", "http://127.0.0.1:1/hook", server)
	if err != nil {
		t.Fatal(err)
	}
	geminiRaw, _ := os.ReadFile(filepath.Join(geminiHome, "settings.json"))
	var geminiSettings map[string]any
	if err := json.Unmarshal(geminiRaw, &geminiSettings); err != nil {
		t.Fatal(err)
	}
	if _, ok := geminiSettings["mcpServers"]; !ok || !strings.Contains(string(geminiRaw), "mcp.example.test") {
		t.Fatalf("gemini settings = %s", geminiRaw)
	}
	if _, ok := geminiSettings["hooks"]; !ok {
		t.Fatalf("gemini hooks = %s", geminiRaw)
	}
	geminiCleanup()
	mcpPath, mcpCleanup, err := writeMCPConfig("http://127.0.0.1:1/mcp", server)
	if err != nil {
		t.Fatal(err)
	}
	mcpRaw, _ := os.ReadFile(mcpPath)
	if !strings.Contains(string(mcpRaw), "mcpServers") || !strings.Contains(string(mcpRaw), "mcp.example.test") || !strings.Contains(string(mcpRaw), "Authorization") {
		t.Fatalf("mcp config = %s", mcpRaw)
	}
	mcpCleanup()
}

func TestPrepareStdioMCPConfigs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, dir := range []string{".grok", ".codex", ".gemini"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	server := model.MCPServerConfig{ID: "mcp-local", Name: "Local tools", Transport: "stdio", Command: "/usr/local/bin/mcp-tool", Args: []string{"--stdio", "--profile", "work"}}
	grokHome, grokCleanup, err := prepareGrokHome("", "", server)
	if err != nil {
		t.Fatal(err)
	}
	grokConfig, _ := os.ReadFile(filepath.Join(grokHome, "config.toml"))
	if !strings.Contains(string(grokConfig), "command = \"/usr/local/bin/mcp-tool\"") || !strings.Contains(string(grokConfig), "--profile") {
		t.Fatalf("grok stdio config = %s", grokConfig)
	}
	grokCleanup()
	codexHome, codexCleanup, err := prepareCodexHome("", "", server)
	if err != nil {
		t.Fatal(err)
	}
	codexConfig, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if !strings.Contains(string(codexConfig), "mcp-tool") || !strings.Contains(string(codexConfig), "--stdio") {
		t.Fatalf("codex stdio config = %s", codexConfig)
	}
	codexCleanup()
	mcpPath, mcpCleanup, err := writeMCPConfig("", server)
	if err != nil {
		t.Fatal(err)
	}
	mcpRaw, _ := os.ReadFile(mcpPath)
	if !strings.Contains(string(mcpRaw), "\"type\":\"stdio\"") || !strings.Contains(string(mcpRaw), "mcp-tool") {
		t.Fatalf("claude stdio config = %s", mcpRaw)
	}
	mcpCleanup()
	geminiHome, geminiCleanup, err := prepareGeminiHome("", "", server)
	if err != nil {
		t.Fatal(err)
	}
	geminiRaw, _ := os.ReadFile(filepath.Join(geminiHome, "settings.json"))
	if !strings.Contains(string(geminiRaw), "mcp-tool") || !strings.Contains(string(geminiRaw), "stdio") {
		t.Fatalf("gemini stdio config = %s", geminiRaw)
	}
	geminiCleanup()
}
