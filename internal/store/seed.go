package store

import (
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// DefaultPresets are the first-run starting points offered by New bot.
func DefaultPresets(now time.Time) []model.Preset {
	values := []struct{ name, title, description, soul string }{
		{"Research", "Research analyst", "Market maps, diligence, and clean sources.", "You are a research analyst. Lead with the finding, keep sources close, and say when the data is weak."},
		{"Inbox chief", "Inbox chief", "Drafts in your voice. Never sends without you.", "You are an inbox chief. Triage by what needs a human decision, draft replies that sound like the person you work for, and never send or delete without approval."},
		{"Code review", "Code reviewer", "Reads the diff before it types.", "You are a senior engineer who reviews code. Be direct, rank findings by risk, and separate correctness from style."},
		{"Operations", "Operations lead", "Turns plans into owners and dates.", "You are an operations lead. When asked to prioritize, force a tradeoff, name an owner, and end with a single next action."},
	}
	out := make([]model.Preset, 0, len(values))
	for index, value := range values {
		out = append(out, model.Preset{
			ID: "preset-" + strings.ToLower(strings.ReplaceAll(value.name, " ", "-")), Name: value.name, Title: value.title,
			Description: value.description, Soul: value.soul, Color: "green", CreatedAt: now, UpdatedAt: now,
		})
		_ = index
	}
	return out
}

func Seed(now time.Time) model.AppState {
	starter := model.Bot{
		ID: "bot-brody", Name: "Brody", Title: "Personal assistant", Color: "coral",
		Soul:    "Help the user finish a concrete task. Ask for missing inputs when they matter and report what you actually did.",
		ModelID: "grox-demo", Approval: model.ApprovalAsk, Department: "General", Notifications: true,
		CreatedAt: now, UpdatedAt: now, LastActiveAt: now,
		Threads: []model.Thread{{
			ID: "thread-brody-home", BotID: "bot-brody", Title: "New conversation", Kind: "chat",
			CreatedAt: now, UpdatedAt: now, Messages: []model.Message{},
		}},
	}
	return model.AppState{
		Version: 2, Bots: []model.Bot{starter}, Presets: DefaultPresets(now),
		Settings: model.Settings{
			Theme: "midnight", Language: "zh", SidebarWidth: 312,
			Notifications: true, EngineMode: "auto",
		},
		ActiveBotID: starter.ID, ActiveThreadID: starter.Threads[0].ID,
		CreatedAt: now, UpdatedAt: now, Revision: 1,
	}
}
