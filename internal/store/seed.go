package store

import (
	"time"

	"github.com/dandandujie/grox/internal/catalog"
	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/schedule"
)

// Seed builds the first-run workspace: a small, opinionated team that makes
// the app useful before anyone connects a key.
func Seed(now time.Time) model.AppState {
	brodyThread := model.Thread{
		ID: "thread-brody-home", BotID: "bot-brody", Title: "The AI market map", Kind: "chat",
		CreatedAt: now.Add(-26 * time.Hour), UpdatedAt: now.Add(-90 * time.Minute),
		Messages: []model.Message{
			seedMsg("m-brody-1", model.RoleUser, model.KindText,
				"Rebuild my AI market map. Last time the sheet was stale, and I want sources and a confidence column this time.",
				now.Add(-26*time.Hour)),
			seedMsg("m-brody-2", model.RoleBot, model.KindText,
				`I rebuilt the list around the gap you flagged: the old sheet was six months stale and missed the entire agent wave.

**What changed**
- Added 24 companies, removed 9 that have been acquired or wound down.
- Every row now carries source, last checked, and confidence.
- The big gap is agents: Anthropic, OpenAI, Cursor, Cognition, and Sierra all moved.

**Four things to know**
- **Coordinates differ by source.** The original rows have exact HQ coordinates; new rows are city-level. There is a precision column so you can filter.
- **Valuations are a cross-row trap.** They are as-of dates, not a snapshot. Do not sort by them.
- **Private coverage is thin.** Wikipedia keeps public companies tidy and private ones messy. Confidence below 0.7 is flagged.
- **Defunct companies are included on purpose.** They explain why a category looks less crowded than it really is.

The sheet is called **AI market map — Nov 2026**, with Companies, Summary, and Notes tabs. I would spend the next pass on the private agents list rather than refreshing public caps; that is where the decision is actually moving.`,
				now.Add(-90*time.Minute)),
		},
	}
	gitscoutThread := model.Thread{
		ID: "thread-gitscout-home", BotID: "bot-gitscout", Title: "Auth refactor review", Kind: "chat",
		CreatedAt: now.Add(-7 * time.Hour), UpdatedAt: now.Add(-5 * time.Hour), Unread: 1,
		Messages: []model.Message{
			seedMsg("m-git-1", model.RoleUser, model.KindText,
				"Review the auth refactor on the open branch. I care more about the session edge cases than style.",
				now.Add(-7*time.Hour)),
			{
				ID: "m-git-2", Role: model.RoleBot, Kind: model.KindText,
				Text: `Reviewed the diff and ran the suite. Nothing is on fire, but two session edge cases would bite in production:

- **Refresh during a revoke race.** The refresh token is rotated before the old session is revoked. A concurrent retry can revive a session you just killed. Move the revoke into the same transaction as the rotation.
- **Clock skew on the 5-minute grace window.** The window is computed with server time only; clients behind by more than a minute see a one-time 401. Prefer the token's iat with a small skew allowance.

The rest is solid. I would ship the transaction fix before the grace window; it is the one with a security consequence.`,
				Activities: []model.Activity{
					{Label: "Reading diff", Detail: "14 files · +312 −188", Status: model.StatusOK, StartedAt: now.Add(-5*time.Hour - 40*time.Second)},
					{Label: "Running tests", Detail: "auth · 48 passed", Status: model.StatusOK, StartedAt: now.Add(-5*time.Hour - 20*time.Second)},
				},
				CreatedAt: now.Add(-5 * time.Hour), UpdatedAt: now.Add(-5 * time.Hour),
			},
		},
	}
	emailyThread := model.Thread{
		ID: "thread-emaily-home", BotID: "bot-emaily", Title: "Morning inbox sweep", Kind: "chat",
		CreatedAt: now.Add(-3 * time.Hour), UpdatedAt: now.Add(-2 * time.Hour), Unread: 2,
		Messages: []model.Message{
			seedMsg("m-mail-1", model.RoleUser, model.KindText,
				"Sweep the inbox. Draft anything that needs a reply and tell me what can be archived.",
				now.Add(-3*time.Hour)),
			seedMsg("m-mail-2", model.RoleBot, model.KindText,
				`Three messages need you today, and the rest is noise.

- **Alex · contract redlines** — replies with two questions. A draft is ready.
- **Nina · Thursday offsite** — she needs a headcount by noon. A draft is ready.
- **Stripe · failed payout** — this one looks like a real action item. I did not touch it.

There are 41 newsletters and 12 notifications I can archive.`,
				now.Add(-2*time.Hour-20*time.Minute)),
			{
				ID: "m-mail-3", Role: model.RoleBot, Kind: model.KindApproval,
				Status: model.StatusPending,
				Approval: &model.Approval{
					Title:   "Archive 53 low-value messages?",
					Command: "gmail archive --query \"category:promotions OR category:updates\" --older-than 7d",
					Reason:  "Keeps the three messages that need you and clears the rest from the inbox.",
					Risk:    "Reversible for 30 days",
				},
				CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: now.Add(-2 * time.Hour),
			},
		},
	}
	omiiiThread := model.Thread{
		ID: "thread-omiii-home", BotID: "bot-omiii", Title: "This week's priorities", Kind: "chat",
		CreatedAt: now.Add(-48 * time.Hour), UpdatedAt: now.Add(-27 * time.Hour), Unread: 1,
		Messages: []model.Message{
			seedMsg("m-ops-1", model.RoleUser, model.KindText,
				"Help me choose the one thing the team should finish this week.",
				now.Add(-48*time.Hour)),
			seedMsg("m-ops-2", model.RoleBot, model.KindText,
				`The week is carrying three "musts" and none of them has an owner. Before I recommend a winner, what is the actual constraint: shipping the beta, keeping the launch date, or protecting the team's focus?`,
				now.Add(-27*time.Hour)),
			{
				ID: "m-ops-3", Role: model.RoleBot, Kind: model.KindOptions,
				Status: model.StatusPending,
				Text:   "What should this week optimize for?",
				Options: []model.Option{
					{ID: "a", Label: "Ship the beta", Description: "Cut everything that does not unblock external testers."},
					{ID: "b", Label: "Hold the launch date", Description: "Protect the date, trade scope instead."},
					{ID: "c", Label: "Protect focus", Description: "One priority, everything else waits."},
					{ID: "d", Label: "A bit of everything", Description: "Keep every thread moving, accept slower progress."},
				},
				CreatedAt: now.Add(-27 * time.Hour), UpdatedAt: now.Add(-27 * time.Hour),
			},
		},
	}
	onyxThread := model.Thread{
		ID: "thread-onyx-home", BotID: "bot-onyx", Title: "Getting to know you", Kind: "chat",
		CreatedAt: now.Add(-10 * time.Minute), UpdatedAt: now.Add(-9 * time.Minute),
		Messages: []model.Message{
			seedMsg("m-onyx-1", model.RoleBot, model.KindText,
				"Hey — I'm Onyx. Nice to meet you.", now.Add(-10*time.Minute)),
			{
				ID: "m-onyx-2", Role: model.RoleBot, Kind: model.KindOptions,
				Status: model.StatusPending,
				Text:   "What do you mostly want help with?",
				Options: []model.Option{
					{ID: "a", Label: "Work & projects", Description: "Research, writing, code, and planning."},
					{ID: "b", Label: "Writing & research", Description: "Long-form thinking, sources, and first drafts."},
					{ID: "c", Label: "Life admin", Description: "Inbox, calendar, travel, and the small stuff."},
					{ID: "d", Label: "A bit of everything", Description: "Start broad and let the shape emerge."},
				},
				CreatedAt: now.Add(-9 * time.Minute), UpdatedAt: now.Add(-9 * time.Minute),
			},
		},
	}

	bots := []model.Bot{
		{
			ID: "bot-brody", Name: "Brody", Title: "Research & data", Color: "coral",
			Description: "Market maps, diligence, and clean sources.",
			Soul:        "You are Brody, a research analyst. Lead with the finding, keep sources close, and say when the data is weak. Prefer tables and short, decisive prose over a wall of caveats.",
			ModelID:     "grok-4.6", Approval: model.ApprovalAsk, MascotShape: "cursor", Expression: "idle",
			Notifications: true, CreatedAt: now.Add(-720 * time.Hour), UpdatedAt: now.Add(-90 * time.Minute),
			LastActiveAt: now.Add(-90 * time.Minute), Threads: []model.Thread{brodyThread},
		},
		{
			ID: "bot-gitscout", Name: "GitScout", Title: "Code review", Color: "green",
			Description: "Reads the diff before it types.",
			Soul:        "You are GitScout, a senior engineer who reviews code. Be direct, rank findings by risk, and always separate a correctness problem from a style preference.",
			ModelID:     "gpt-5.2-codex", Approval: model.ApprovalAsk, MascotShape: "cursor", Expression: "working",
			Notifications: true, CreatedAt: now.Add(-700 * time.Hour), UpdatedAt: now.Add(-5 * time.Hour),
			LastActiveAt: now.Add(-5 * time.Hour), Threads: []model.Thread{gitscoutThread},
		},
		{
			ID: "bot-emaily", Name: "Emaily", Title: "Inbox chief", Color: "teal",
			Description: "Drafts in your voice. Never sends without you.",
			Soul:        "You are Emaily, an inbox chief. Triage by what needs a human decision, draft replies that sound like the person you work for, and never send or delete without approval.",
			ModelID:     "claude-sonnet-5", Approval: model.ApprovalAsk, MascotShape: "blob", Expression: "curious",
			Notifications: true, CreatedAt: now.Add(-650 * time.Hour), UpdatedAt: now.Add(-2 * time.Hour),
			LastActiveAt: now.Add(-2 * time.Hour), Threads: []model.Thread{emailyThread},
		},
		{
			ID: "bot-omiii", Name: "Omiii", Title: "Operations", Color: "green",
			Description: "Turns plans into owners and dates.",
			Soul:        "You are Omiii, an operations lead. When asked to prioritize, force a tradeoff, name an owner, and end with a single next action.",
			ModelID:     "gemini-3-pro", Approval: model.ApprovalAuto, MascotShape: "circle", Expression: "happy",
			Notifications: true, CreatedAt: now.Add(-600 * time.Hour), UpdatedAt: now.Add(-27 * time.Hour),
			LastActiveAt: now.Add(-27 * time.Hour), Threads: []model.Thread{omiiiThread},
		},
		{
			ID: "bot-onyx", Name: "Onyx", Title: "Personal", Color: "blue",
			Description: "A second brain for the week.",
			Soul:        "You are Onyx, a warm, concise personal assistant. Learn how the person likes to work, remember it, and keep the week honest without adding pressure.",
			ModelID:     "claude-sonnet-5", Approval: model.ApprovalAsk, MascotShape: "cursor", Expression: "curious",
			Notifications: true, CreatedAt: now.Add(-20 * time.Hour), UpdatedAt: now.Add(-9 * time.Minute),
			LastActiveAt: now.Add(-9 * time.Minute), Threads: []model.Thread{onyxThread},
		},
	}

	launchThread := model.Thread{
		ID: "thread-launch-home", BotID: "", Title: "Thursday launch", Kind: "group",
		CreatedAt: now.Add(-5 * time.Hour), UpdatedAt: now.Add(-4 * time.Hour), Unread: 1,
		Messages: []model.Message{
			seedMsg("m-launch-1", model.RoleUser, model.KindText,
				"Where are we on the Thursday launch? Give me the short version.", now.Add(-5*time.Hour)),
			{
				ID: "m-launch-2", Role: model.RoleBot, Text: "The checklist is at 9 of 12. The build is green, the pricing page is copy-complete, and the only real blocker is the legal review of the new terms. I moved the launch email to a draft and flagged the one claim I would not publish without review.",
				SenderID: "bot-omiii", SenderName: "Omiii",
				CreatedAt: now.Add(-4*time.Hour - 20*time.Minute), UpdatedAt: now.Add(-4*time.Hour - 20*time.Minute),
			},
			{
				ID: "m-launch-3", Role: model.RoleBot, Text: "Positioning is ready. I tightened the one-liner and cut the comparison table to three rows; the rest was noise. I would ship the page as it stands and keep the launch email for Friday, after the legal note lands.",
				SenderID: "bot-brody", SenderName: "Brody",
				Activities: []model.Activity{
					{Label: "Reviewed the launch page", Detail: "7 edits proposed", Status: model.StatusOK, StartedAt: now.Add(-4*time.Hour - 10*time.Minute)},
				},
				CreatedAt: now.Add(-4 * time.Hour), UpdatedAt: now.Add(-4 * time.Hour),
			},
		},
	}

	state := model.AppState{
		Version: 1, Bots: bots, Connections: map[string]model.Connection{},
		Groups: []model.Group{{
			ID: "group-launch", Name: "Launch room", Description: "Brody, Omiii and Emaily keep the launch moving.", Color: "purple",
			MemberIDs: []string{"bot-brody", "bot-omiii", "bot-emaily"}, LeadID: "bot-brody", Unread: 1,
			CreatedAt: now.Add(-120 * time.Hour), UpdatedAt: now.Add(-4 * time.Hour), Threads: []model.Thread{launchThread},
		}},
		Settings: model.Settings{
			Theme: "midnight", Language: "en", SidebarWidth: 312, Advanced: true,
			Notifications: true, Sounds: false, EngineMode: "auto",
		},
		ActiveBotID: "bot-brody", ActiveThreadID: "thread-brody-home",
		CreatedAt: now, UpdatedAt: now, Revision: 1,
	}
	for _, app := range catalog.Apps() {
		state.Connections[app.ID] = model.Connection{ID: app.ID}
	}
	for _, id := range []string{"github", "slack", "linear"} {
		state.Connections[id] = model.Connection{ID: id, Connected: true, Account: "workspace", ConnectedAt: now.Add(-200 * time.Hour)}
	}
	state.Runs = []model.Run{
		{ID: "run-seed-1", RoutineID: "routine-brody-brief", BotID: "bot-brody", ThreadID: "thread-brody-home", Title: "Morning research brief", Status: "completed", StartedAt: now.Add(-26 * time.Hour), FinishedAt: now.Add(-26*time.Hour + 4*time.Minute), Summary: "Rebuilt the AI market map and wrote the notes tab."},
		{ID: "run-seed-2", RoutineID: "routine-emaily-sweep", BotID: "bot-emaily", ThreadID: "thread-emaily-home", Title: "Inbox sweep", Status: "completed", StartedAt: now.Add(-3 * time.Hour), FinishedAt: now.Add(-3*time.Hour + 2*time.Minute), Summary: "Triaged 56 messages, drafted 2 replies."},
	}
	routines := []model.Routine{
		{ID: "routine-brody-brief", BotID: "bot-brody", Name: "Morning research brief", Prompt: "Scan the last 24 hours in AI infrastructure. Send me three things that changed and one thing I should read in full.", Cadence: "weekdays", TimeOfDay: "08:00", Enabled: true, CreatedAt: now.Add(-300 * time.Hour)},
		{ID: "routine-emaily-sweep", BotID: "bot-emaily", Name: "Inbox sweep", Prompt: "Triage the inbox. Draft replies for anything that needs me, and list what can be archived.", Cadence: "weekdays", TimeOfDay: "09:00", Enabled: true, CreatedAt: now.Add(-280 * time.Hour)},
		{ID: "routine-gitscout-health", BotID: "bot-gitscout", Name: "Repo health check", Prompt: "Check open pull requests and failing CI. Summarize what needs a human today.", Cadence: "weekly", TimeOfDay: "10:00", Weekday: 1, Enabled: false, CreatedAt: now.Add(-260 * time.Hour)},
		{ID: "routine-omiii-week", BotID: "bot-omiii", Name: "Weekly plan", Prompt: "Look at the week ahead and name the single constraint. Give me one priority and the tradeoff.", Cadence: "weekly", TimeOfDay: "09:30", Weekday: 1, Enabled: true, CreatedAt: now.Add(-240 * time.Hour)},
	}
	for i := range routines {
		routines[i].UpdatedAt = routines[i].CreatedAt
		routines[i].NextRun = schedule.Next(routines[i], now)
	}
	state.Routines = routines
	return state
}

func seedMsg(id, role, kind, text string, at time.Time) model.Message {
	return model.Message{ID: id, Role: role, Kind: kind, Text: text, CreatedAt: at, UpdatedAt: at}
}
