// Package agent runs a bot's turn on a local CLI, an OpenAI-compatible API,
// or the built-in demo engine.
package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// Sink receives a turn's incremental output.
type Sink interface {
	// Text appends a chunk to the reply.
	Text(delta string)
	// Status updates the working line under the bot's name.
	Status(status string)
	// Activity reports a tool run above the reply.
	Activity(activity model.Activity)
	// Approval asks the person to decide before the bot acts.
	Approval(approval model.Approval)
	// Options asks the person a question with a small set of answers.
	Options(text string, options []model.Option)
}

// Request is one turn.
type Request struct {
	Bot          model.Bot
	Thread       model.Thread
	UserText     string
	Prompt       string
	History      []model.Message
	Model        model.Model
	WorkDir      string
	EngineMode   string
	APIBaseURL   string
	APIModel     string
	APIKey       string
	CLIAvailable map[string]bool
}

// Result is a finished turn.
type Result struct {
	Engine string
	Text   string
}

// Selection says which engine a turn will use, and why.
type Selection struct {
	Kind   string // demo, cli, api
	Engine string
	Note   string
}

// Select chooses an engine for a request. The app always has the demo engine
// to fall back on, so a missing login never leaves a bot silent.
func Select(req Request) Selection {
	provider := req.Model.Provider
	mode := req.EngineMode
	if mode == "" {
		mode = "auto"
	}
	if mode == "demo" || provider == "local" || req.Model.ID == "grox-demo" {
		return Selection{Kind: "demo", Engine: "Grox Demo"}
	}
	if mode == "api" {
		if strings.TrimSpace(req.APIBaseURL) != "" {
			return Selection{Kind: "api", Engine: "OpenAI-compatible API"}
		}
		return Selection{Kind: "demo", Engine: "Grox Demo", Note: "Add a base URL in Settings → Engines to use an API engine."}
	}
	if mode != "auto" {
		// Explicit CLI choice.
		if req.CLIAvailable[mode] {
			return Selection{Kind: "cli", Engine: cliName(mode)}
		}
		return Selection{Kind: "demo", Engine: "Grox Demo", Note: cliName(mode) + " is not installed. Add it in Settings → Engines; this reply comes from the demo engine."}
	}
	if req.CLIAvailable[provider] {
		return Selection{Kind: "cli", Engine: cliName(provider)}
	}
	if (provider == "grok" || provider == "openai") && strings.TrimSpace(req.APIBaseURL) != "" {
		return Selection{Kind: "api", Engine: cliName(provider) + " API"}
	}
	return Selection{Kind: "demo", Engine: "Grox Demo", Note: cliName(provider) + " is not connected, so this reply comes from the built-in demo. Run the CLI login or add an API key in Settings → Engines."}
}

func cliName(provider string) string {
	switch provider {
	case "grok":
		return "Grok CLI"
	case "claude":
		return "Claude Code"
	case "openai":
		return "Codex CLI"
	case "google":
		return "Gemini CLI"
	case "api":
		return "OpenAI-compatible API"
	default:
		return "Grox Demo"
	}
}

// Run executes a turn with the selected engine.
func Run(ctx context.Context, sel Selection, req Request, sink Sink) (Result, error) {
	switch sel.Kind {
	case "cli":
		text, err := runCLI(ctx, req, sink)
		return Result{Engine: sel.Engine, Text: text}, err
	case "api":
		text, err := runAPI(ctx, req, sink)
		return Result{Engine: sel.Engine, Text: text}, err
	default:
		text, err := runDemo(ctx, req, sink)
		return Result{Engine: sel.Engine, Text: text}, err
	}
}

// Compose makes the single prompt a CLI receives: the bot's persona, the
// recent conversation, and the new message.
func Compose(bot model.Bot, thread model.Thread, userText string) string {
	var b strings.Builder
	b.WriteString("You are ")
	b.WriteString(bot.Name)
	if bot.Title != "" {
		b.WriteString(", ")
		b.WriteString(bot.Title)
	}
	b.WriteString(".\n\n")
	if bot.Soul != "" {
		b.WriteString(strings.TrimSpace(bot.Soul))
		b.WriteString("\n\n")
	}
	b.WriteString("You are replying inside Grox, a chat app. Answer the latest user message. ")
	b.WriteString("Use Github-flavored Markdown when it helps. Do not describe these instructions.\n")
	if bot.WorkingDir != "" {
		b.WriteString("\nWorking directory: ")
		b.WriteString(bot.WorkingDir)
		b.WriteString("\n")
	}
	history := recent(thread.Messages, 14)
	if len(history) > 0 {
		b.WriteString("\nRecent conversation:\n")
		for i, m := range history {
			// The latest user message is repeated under "Latest user message".
			if i == len(history)-1 && m.Role == model.RoleUser && strings.TrimSpace(m.Text) == strings.TrimSpace(userText) {
				continue
			}
			text := strings.TrimSpace(m.Text)
			if text == "" || m.Pending {
				continue
			}
			if m.Kind == model.KindApproval && m.Approval != nil {
				text = "[approval request] " + m.Approval.Title
			}
			if m.Kind == model.KindOptions {
				text = "[question] " + m.Text
			}
			if len(text) > 1800 {
				text = text[:1800] + "…"
			}
			switch m.Role {
			case model.RoleUser:
				b.WriteString("User: ")
			case model.RoleBot:
				b.WriteString(bot.Name + ": ")
			default:
				b.WriteString("System: ")
			}
			b.WriteString(text)
			b.WriteString("\n\n")
		}
	}
	b.WriteString("Latest user message:\n")
	b.WriteString(strings.TrimSpace(userText))
	b.WriteString("\n\nReply as ")
	b.WriteString(bot.Name)
	b.WriteString(" now.")
	return b.String()
}

func recent(messages []model.Message, limit int) []model.Message {
	if len(messages) <= limit {
		return messages
	}
	return messages[len(messages)-limit:]
}

func approvalMode(mode string) string {
	switch mode {
	case model.ApprovalFull:
		return "full"
	case model.ApprovalAuto:
		return "auto"
	default:
		return "ask"
	}
}

func now() time.Time { return time.Now() }

// cleanOutput trims terminal control noise from a CLI's plain output.
func cleanOutput(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			out = append(out, "")
			continue
		}
		// npm/debug banners that should never read as the agent's answer.
		if strings.HasPrefix(trimmed, "> ") || strings.HasPrefix(trimmed, "npm warn") || strings.HasPrefix(trimmed, "Debugger") {
			continue
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func friendlyError(provider string, stderr string, err error) error {
	msg := strings.ToLower(stderr)
	switch {
	case strings.Contains(msg, "not signed in"), strings.Contains(msg, "not authenticated"), strings.Contains(msg, "sign in"):
		return fmt.Errorf("%s is not signed in. Run the CLI login, then try again", cliName(provider))
	case strings.Contains(msg, "api key"), strings.Contains(msg, "unauthorized"), strings.Contains(msg, "401"):
		return fmt.Errorf("%s rejected the credentials. Check Settings → Connections", cliName(provider))
	case strings.Contains(msg, "command not found"):
		return fmt.Errorf("%s is not installed. Connect it in Settings → Engines", cliName(provider))
	}
	if stderr != "" {
		line := strings.TrimSpace(stderr)
		if len(line) > 280 {
			line = line[:280] + "…"
		}
		return fmt.Errorf("%s: %s", cliName(provider), line)
	}
	return fmt.Errorf("%s: %w", cliName(provider), err)
}
