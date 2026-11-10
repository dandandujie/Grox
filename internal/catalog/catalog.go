// Package catalog is the app's static knowledge: which engines exist, which
// models they serve, and which apps can be connected.
package catalog

import (
	"context"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// Providers returns the model picker's provider groups. availability is keyed
// by provider id ("grok", "claude", "openai", "google", "local").
func Providers(availability map[string]bool, defaultModel string) []model.Provider {
	providers := []model.Provider{
		{
			ID: "grok", Name: "xAI", Kind: "cli", Accent: "#f2f2f2",
			Models: []model.Model{
				{ID: "grok-4.6", Name: "Grok 4.6", Description: "Frontier reasoning · long context", Default: true},
				{ID: "grok-4.5", Name: "Grok 4.5", Description: "Fast, balanced generalist"},
				{ID: "grok-code-fast", Name: "Grok Code Fast", Description: "Built for agentic coding"},
				{ID: "grok-3-mini", Name: "Grok 3 Mini", Description: "Cheap and quick for small jobs"},
			},
		},
		{
			ID: "claude", Name: "Anthropic", Kind: "cli", Accent: "#d97757",
			Models: []model.Model{
				{ID: "claude-sonnet-5", Name: "Claude Sonnet 5", Description: "Everyday workhorse", Default: true},
				{ID: "claude-opus-4-6", Name: "Claude Opus 4.6", Description: "Deepest reasoning"},
				{ID: "claude-haiku-4-5", Name: "Claude Haiku 4.5", Description: "Fastest replies"},
			},
		},
		{
			ID: "openai", Name: "OpenAI", Kind: "cli", Accent: "#74aa9c",
			Models: []model.Model{
				{ID: "gpt-5.2", Name: "GPT-5.2", Description: "General reasoning", Default: true},
				{ID: "gpt-5.2-codex", Name: "GPT-5.2 Codex", Description: "Agentic coding"},
				{ID: "gpt-5-mini", Name: "GPT-5 Mini", Description: "Small and fast"},
			},
		},
		{
			ID: "google", Name: "Google", Kind: "cli", Accent: "#4285f4",
			Models: []model.Model{
				{ID: "gemini-3-pro", Name: "Gemini 3 Pro", Description: "Multimodal reasoning", Default: true},
				{ID: "gemini-3-flash", Name: "Gemini 3 Flash", Description: "Low latency"},
			},
		},
		{
			ID: "local", Name: "On this Mac", Kind: "local", Accent: "#38bdf8",
			Models: []model.Model{
				{ID: "grox-demo", Name: "Grox Demo", Description: "Scripted local engine · no account needed", Default: true},
			},
		},
	}

	for pi := range providers {
		p := &providers[pi]
		available := p.ID == "local" || availability[p.ID]
		p.Status = "missing"
		if available {
			p.Status = "ready"
		}
		if p.ID == "local" {
			p.Status = "builtin"
			p.Detail = "Always available"
		}
		for mi := range p.Models {
			m := &p.Models[mi]
			m.Provider = p.ID
			m.ProviderName = p.Name
			m.Accent = p.Accent
			m.Available = available
			if m.ID == defaultModel {
				m.Default = true
			}
		}
	}
	return providers
}

// DefaultModel picks the best available model, preferring the engine the
// person already has installed.
func DefaultModel(availability map[string]bool) string {
	order := []string{"grok", "claude", "openai", "google"}
	defaults := map[string]string{
		"grok": "grok-4.6", "claude": "claude-sonnet-5",
		"openai": "gpt-5.2", "google": "gemini-3-pro",
	}
	for _, id := range order {
		if availability[id] {
			return defaults[id]
		}
	}
	return "grox-demo"
}

// Engines probes the local agent CLIs. It never starts a session: a version
// print is enough to know what is installed.
func Engines(ctx context.Context) []model.EngineInfo {
	type probe struct {
		provider string
		command  string
		args     []string
	}
	probes := []probe{
		{"grok", "grok", []string{"--version"}},
		{"claude", "claude", []string{"--version"}},
		{"openai", "codex", []string{"--version"}},
		{"google", "gemini", []string{"--version"}},
	}

	results := make([]model.EngineInfo, len(probes))
	var wg sync.WaitGroup
	for i, p := range probes {
		wg.Add(1)
		go func(i int, p probe) {
			defer wg.Done()
			info := model.EngineInfo{ProviderID: p.provider, Command: p.command, Status: "missing"}
			path, err := exec.LookPath(p.command)
			if err != nil {
				info.Detail = "Not installed"
				results[i] = info
				return
			}
			info.Command = path
			info.Status = "ready"
			info.Detail = "Installed"
			cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			out, err := exec.CommandContext(cctx, path, p.args...).CombinedOutput()
			if err == nil {
				version := firstLine(string(out))
				version = strings.TrimSpace(strings.TrimPrefix(version, "Version:"))
				if len(version) > 80 {
					version = version[:80]
				}
				info.Version = version
				if version != "" {
					info.Detail = version
				}
			}
			results[i] = info
		}(i, p)
	}
	wg.Wait()
	return results
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// Apps is the connected-app marketplace. Icon is a simple-icons slug.
func Apps() []model.AppEntry {
	return []model.AppEntry{
		{ID: "slack", Name: "Slack", Description: "Post updates and read channels", Category: "Communication", Color: "#4A154B", Icon: "slack"},
		{ID: "github", Name: "GitHub", Description: "Issues, pull requests, and code", Category: "Developer", Color: "#181717", Icon: "github"},
		{ID: "gmail", Name: "Gmail", Description: "Read and send email", Category: "Communication", Color: "#EA4335", Icon: "gmail"},
		{ID: "google-calendar", Name: "Google Calendar", Description: "Read and create events", Category: "Productivity", Color: "#4285F4", Icon: "googlecalendar"},
		{ID: "google-sheets", Name: "Google Sheets", Description: "Read and update spreadsheets", Category: "Productivity", Color: "#34A853", Icon: "googlesheets"},
		{ID: "google-docs", Name: "Google Docs", Description: "Read and write documents", Category: "Productivity", Color: "#4285F4", Icon: "googledocs"},
		{ID: "google-drive", Name: "Google Drive", Description: "Browse and manage files", Category: "Productivity", Color: "#FBBC04", Icon: "googledrive"},
		{ID: "notion", Name: "Notion", Description: "Pages and databases", Category: "Productivity", Color: "#111111", Icon: "notion"},
		{ID: "linear", Name: "Linear", Description: "Issues and project tracking", Category: "Developer", Color: "#5E6AD2", Icon: "linear"},
		{ID: "sentry", Name: "Sentry", Description: "Errors and alerts", Category: "Developer", Color: "#362D59", Icon: "sentry"},
		{ID: "figma", Name: "Figma", Description: "Designs and comments", Category: "Design", Color: "#F24E1E", Icon: "figma"},
		{ID: "stripe", Name: "Stripe", Description: "Customers, invoices, and payments", Category: "Finance", Color: "#635BFF", Icon: "stripe"},
		{ID: "spotify", Name: "Spotify", Description: "Playlists and what is playing", Category: "Lifestyle", Color: "#1DB954", Icon: "spotify"},
		{ID: "x", Name: "X", Description: "Posts, mentions, and trends", Category: "Social", Color: "#111111", Icon: "x"},
		{ID: "discord", Name: "Discord", Description: "Servers and messages", Category: "Communication", Color: "#5865F2", Icon: "discord"},
		{ID: "telegram", Name: "Telegram", Description: "Chats and channels", Category: "Communication", Color: "#26A5E4", Icon: "telegram"},
		{ID: "postgres", Name: "Postgres", Description: "Query your databases", Category: "Developer", Color: "#4169E1", Icon: "postgresql"},
		{ID: "vercel", Name: "Vercel", Description: "Deployments and domains", Category: "Developer", Color: "#111111", Icon: "vercel"},
		{ID: "cloudflare", Name: "Cloudflare", Description: "Zones, DNS, and Workers", Category: "Developer", Color: "#F38020", Icon: "cloudflare"},
		{ID: "zapier", Name: "Zapier", Description: "Connect 7,000 more apps", Category: "Automation", Color: "#FF4F00", Icon: "zapier"},
	}
}

// SortedProviders keeps the picker order stable even if Providers changes.
func SortedProviders(in []model.Provider) []model.Provider {
	out := append([]model.Provider(nil), in...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
