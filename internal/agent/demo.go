package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

// runDemo produces a useful, deterministic reply without a network or an
// account. It is also the safety net when a CLI is missing or signed out.
func runDemo(ctx context.Context, req Request, sink Sink) (string, error) {
	prompt := strings.TrimSpace(req.UserText)
	lower := strings.ToLower(prompt)
	mode := approvalMode(req.Bot.Approval)

	sink.Status("Thinking")
	if !sleep(ctx, 420*time.Millisecond) {
		return "", context.Canceled
	}

	// Results of a decision or an answer come back as synthetic prompts.
	if strings.HasPrefix(prompt, "[approval:allowed]") || strings.HasPrefix(prompt, "[approval:denied]") {
		allowed := strings.HasPrefix(prompt, "[approval:allowed]")
		command := strings.TrimSpace(strings.TrimPrefix(prompt, "[approval:allowed]"))
		command = strings.TrimSpace(strings.TrimPrefix(command, "[approval:denied]"))
		if allowed {
			sink.Status("Running")
			if !sleep(ctx, 700*time.Millisecond) {
				return "", context.Canceled
			}
			sink.Activity(model.Activity{Label: "Command finished", Detail: "exit 0", Status: model.StatusOK, StartedAt: time.Now()})
			answer := resultForCommand(req.Bot, command)
			if err := streamText(ctx, sink, answer); err != nil {
				return "", err
			}
			return answer, nil
		}
		answer := "Understood — I stopped before running anything. Nothing was changed, and I left the work where it was.\n\nIf you want, tell me a narrower scope and I will bring back a fresh approval card."
		if err := streamText(ctx, sink, answer); err != nil {
			return "", err
		}
		return answer, nil
	}
	if strings.HasPrefix(prompt, "My answer:") || strings.HasPrefix(prompt, "[choice]") {
		answer := chooseReply(req.Bot, prompt)
		if err := streamText(ctx, sink, answer); err != nil {
			return "", err
		}
		return answer, nil
	}

	// A risky action surfaces a real approval card when the bot is set to Ask.
	if wantsCommand(lower) {
		command := commandFor(lower)
		preface := fmt.Sprintf("I can do that, but it changes something outside this chat. Here is the smallest command that gets it done:\n\n**%s**", command)
		if err := streamText(ctx, sink, preface); err != nil {
			return "", err
		}
		if mode == "ask" {
			sink.Status("Waiting for you")
			sink.Approval(model.Approval{
				Title:   approvalTitle(lower),
				Command: command,
				Reason:  "The demo engine only asks when a step would touch your files, inbox, or a remote service.",
				Risk:    "You can approve once or allow this bot to decide next time",
			})
			return preface, nil
		}
		sink.Status("Running")
		if !sleep(ctx, 600*time.Millisecond) {
			return "", context.Canceled
		}
		sink.Activity(model.Activity{Label: "Command finished", Detail: "exit 0", Status: model.StatusOK, StartedAt: time.Now()})
		answer := "Done. " + resultForCommand(req.Bot, command)
		if err := streamText(ctx, sink, answer); err != nil {
			return "", err
		}
		return answer, nil
	}

	// A decision question renders the option card people know from the app.
	if wantsOptions(lower) {
		preface := optionPreface(req.Bot)
		if err := streamText(ctx, sink, preface); err != nil {
			return "", err
		}
		sink.Status("Waiting for you")
		sink.Options(optionQuestion(req.Bot), optionsFor(req.Bot))
		return preface, nil
	}

	answer := composeDemoReply(req, lower)
	if strings.Contains(lower, "search") || strings.Contains(lower, "latest") || strings.Contains(lower, "research") {
		sink.Status("Researching")
		sink.Activity(model.Activity{Label: "Building a search plan", Detail: "Checking the demo engine's knowledge", Status: model.StatusOK, StartedAt: time.Now()})
	}
	if err := streamText(ctx, sink, answer); err != nil {
		return "", err
	}
	return answer, nil
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// streamText sends the reply a few words at a time so the transcript feels
// alive, while still ending instantly when the turn is stopped.
func streamText(ctx context.Context, sink Sink, text string) error {
	chunks := chunks(text)
	for _, chunk := range chunks {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		sink.Text(chunk)
		if !sleep(ctx, 16*time.Millisecond) {
			return ctx.Err()
		}
	}
	return nil
}

func chunks(text string) []string {
	out := []string{}
	start := 0
	words := 0
	for i := 0; i < len(text); i++ {
		if text[i] == ' ' {
			words++
		}
		if words >= 5 && i > start {
			out = append(out, text[start:i+1])
			start = i + 1
			words = 0
		}
	}
	if start < len(text) {
		out = append(out, text[start:])
	}
	if len(out) == 0 {
		out = append(out, text)
	}
	return out
}

func wantsCommand(lower string) bool {
	for _, word := range []string{"run ", "shell", "terminal", "deploy", "install ", "delete", "remove ", "archive", "send ", "push ", "publish"} {
		if strings.Contains(lower, word) {
			return true
		}
	}
	return false
}

func commandFor(lower string) string {
	switch {
	case strings.Contains(lower, "archive") && strings.Contains(lower, "inbox"):
		return "gmail archive --query \"category:promotions OR category:updates\" --older-than 7d"
	case strings.Contains(lower, "inbox"):
		return "gmail archive --query \"category:promotions\" --older-than 7d"
	case strings.Contains(lower, "deploy") || strings.Contains(lower, "publish"):
		return "git push origin main"
	case strings.Contains(lower, "delete") || strings.Contains(lower, "remove"):
		return "rm -rf ./dist"
	case strings.Contains(lower, "install"):
		return "npm install"
	case strings.Contains(lower, "send"):
		return "gmail send --draft 3"
	default:
		return "pwd && ls -la"
	}
}

func approvalTitle(lower string) string {
	switch {
	case strings.Contains(lower, "archive"):
		return "Archive matching messages?"
	case strings.Contains(lower, "delete") || strings.Contains(lower, "remove"):
		return "Delete generated files?"
	case strings.Contains(lower, "deploy") || strings.Contains(lower, "publish"):
		return "Push and deploy this branch?"
	case strings.Contains(lower, "install"):
		return "Install dependencies?"
	default:
		return "Run this command?"
	}
}

func resultForCommand(bot model.Bot, command string) string {
	switch {
	case strings.Contains(command, "gmail archive"):
		return "Archived 53 messages and left the three that need a human. The archive is reversible for 30 days; I can undo it from here."
	case strings.Contains(command, "git push"):
		return "The branch is pushed and the preview deployment is building. I will keep the checks in view and report back if one fails."
	case strings.Contains(command, "rm -rf"):
		return "Removed ./dist. The source tree is untouched, and the next build will recreate it."
	case strings.Contains(command, "npm install"):
		return "Dependencies are installed and the lockfile is unchanged. npm run build is next if you want it."
	case strings.Contains(command, "gmail send"):
		return "Three drafts are sent. I kept the originals in the thread so you can see exactly what went out."
	default:
		return "The command finished cleanly. " + bot.Name + " is ready for the next step."
	}
}

func wantsOptions(lower string) bool {
	for _, word := range []string{"which", "choose", "choose between", "priorit", "decide", "prefer", "what should"} {
		if strings.Contains(lower, word) {
			return true
		}
	}
	return false
}

func optionPreface(bot model.Bot) string {
	switch {
	case strings.Contains(strings.ToLower(bot.Title), "operation"):
		return "Three things are asking for the same week. I can force a useful tradeoff if you pick the constraint."
	case strings.Contains(strings.ToLower(bot.Title), "research"):
		return "The answer changes with the question. Pick the lens and I will do the work from there."
	default:
		return "There is a real tradeoff here. Pick the answer that is closest; we can expand from there."
	}
}

func optionQuestion(bot model.Bot) string {
	if strings.Contains(strings.ToLower(bot.Title), "operation") {
		return "What should this week optimize for?"
	}
	return "Which direction should I take?"
}

func optionsFor(bot model.Bot) []model.Option {
	return []model.Option{
		{ID: "a", Label: "Ship the smallest useful version", Description: "Cut scope, get feedback sooner."},
		{ID: "b", Label: "Protect the date", Description: "Keep the commitment, trade features."},
		{ID: "c", Label: "Protect the team's focus", Description: "One priority, everything else waits."},
		{ID: "d", Label: "A bit of everything", Description: "Keep all threads moving; accept slower progress."},
	}
}

func chooseReply(bot model.Bot, prompt string) string {
	answer := strings.TrimSpace(strings.TrimPrefix(prompt, "My answer:"))
	answer = strings.TrimSpace(strings.TrimPrefix(answer, "[choice]"))
	lower := strings.ToLower(answer)
	switch {
	case strings.Contains(lower, "ship"):
		return "Good. Then the week is about a smaller surface, not more effort.\n\n- **Cut** everything that does not unblock an external tester.\n- **Name one owner** for the beta build and one for the feedback loop.\n- **Friday** is the demo, not the finish line: the only question is whether a stranger can finish the core task.\n\nI would write that down as a one-line decision before the next standup: *This week we ship the smallest useful beta; every other request waits for Monday.*"
	case strings.Contains(lower, "date"):
		return "Then we protect the date and spend scope, not quality.\n\n- Keep the launch-critical path; move two stretch items out of the milestone today.\n- Give the remaining work a single owner and a daily 15-minute checkpoint.\n- Tell the team what is explicitly **not** shipping; silence reads as a promise.\n\nIf the date still needs magic by Wednesday, we move it deliberately rather than discover it late."
	case strings.Contains(lower, "focus"):
		return "Then the answer is one priority, written down where everyone can see it.\n\n- Pick the outcome that would make the week a success even if nothing else moved.\n- Put everything else in a *not this week* list and assign no one.\n- Review on Thursday, not Friday; Friday is for finishing, not deciding.\n\nTell me the outcome you would protect and I will turn it into the weekly plan."
	case strings.Contains(lower, "everything"):
		return "That is allowed, but it needs an honest cost.\n\n- Keep all three threads alive with explicit time boxes rather than background anxiety.\n- Expect each to move at about half speed; say that out loud so no one is surprised.\n- Re-check Thursday and cut the weakest thread if two are clearly ahead.\n\nI would still name a primary: *everything moves, but the beta decides the week.*"
	case strings.Contains(lower, "work"):
		return "Then let us start with the shape of your work, not a tool tour.\n\n- Tell me the one project that has the most ambiguity right now.\n- I will turn it into a short brief: outcome, constraints, open questions.\n- From there we pick the right bot and the right model for the job.\n\nWhat is the project?"
	default:
		return "Noted — " + answer + ". I will keep that as the working constraint.\n\nHere is what I would do next:\n\n- Write the decision down in one sentence so it can be disagreed with.\n- Give it a single owner and a date this week.\n- Bring me the first blocker; I will take that part from there."
	}
}

func composeDemoReply(req Request, lower string) string {
	bot := req.Bot
	title := strings.ToLower(bot.Title)
	name := bot.Name
	ask := compactAsk(req.UserText)

	switch {
	case strings.Contains(lower, "plan") || strings.Contains(lower, "launch") || strings.Contains(lower, "organize") || strings.Contains(lower, "week") || strings.Contains(lower, "todo"):
		return "Here is a plan I would actually run.\n\n**Outcome**\n\n" + capitalized(ask) + "\n\n**This week**\n- **Today** — write the one-sentence decision and name the owner.\n- **Tuesday** — cut the list to the work that changes the outcome. Park the rest by name.\n- **Thursday** — review what is real, not what was reported as done.\n- **Friday** — ship the smallest useful version and capture what was learned.\n\n**Watch for**\n\nThe plan fails if every item still belongs to you. Pick one thing to hand over before the week starts.\n\nWant me to turn this into a task list with dates?"
	case strings.Contains(lower, "search") || strings.Contains(lower, "latest") || strings.Contains(lower, "news") || strings.Contains(lower, "research") || strings.Contains(lower, "find"):
		return "I would frame this as three questions, not one search.\n\n1. **What changed recently?** — new releases, pricing, or policy shifts that affect the decision.\n2. **Who is actually doing it?** — shipped work beats announcements; look for primary sources.\n3. **What would make us wrong?** — the strongest counter-case, not the most common one.\n\nI am running on the built-in demo engine, so I will not invent live sources. Connect a CLI or API in **Settings → Engines** and I will do the real sweep and bring back citations.\n\nIf you want a head start, tell me the exact decision this research should unblock."
	case strings.Contains(lower, "email") || strings.Contains(lower, "inbox") || strings.Contains(lower, "reply"):
		return "I can triage this in one pass.\n\n- Separate **needs a decision** from **needs a reply**; they are different queues.\n- Draft in your voice, short enough to edit rather than rewrite.\n- Leave sending behind an approval, always.\n\nI am the demo engine right now, so I cannot read a real inbox. Connect Gmail in **Connected apps** and I will work on the actual messages."
	case strings.Contains(lower, "review") || strings.Contains(lower, "diff") || strings.Contains(lower, "code") || strings.Contains(lower, "bug"):
		return "I can review this well if I can see the actual diff and the failure mode.\n\n- Point me at the branch or paste the changed files.\n- Tell me what worried you; that is usually the highest-signal starting point.\n- I will rank findings by **correctness first**, then operability, then style, and keep them separate.\n\nThis is the demo engine, so I will not pretend I read your repository. Connect Codex or Claude Code in **Settings → Engines** and point me at the branch."
	case strings.Contains(lower, "hi") || strings.Contains(lower, "hello") || strings.Contains(lower, "hey"):
		suffix := ""
		if bot.Title != "" {
			suffix = " — " + bot.Title
		}
		return "Hey. I am " + name + suffix + ".\n\nI am running on the built-in demo engine, so we can explore the app before you connect a real agent. Ask me to plan something, or open **Settings → Engines** to put a real model behind me.\n\nWhat are we working on?"
	default:
		if strings.Contains(title, "research") {
			return "The short answer: I would not treat this as a single question yet.\n\n" + capitalized(ask) + " has three parts — what is true today, what it costs to find out, and what decision the answer would change. I would spend the first pass on the third.\n\n- Give me the decision and the deadline; I will work backwards.\n- I will separate **known**, **estimated**, and **unverified** rather than blending them.\n- The output is a one-page brief, not a data dump.\n\nThis is the demo engine. Connect Grok or another CLI in **Settings → Engines** and I will run the real research with sources."
		}
		return "I have enough to start, but I want to be precise about the outcome.\n\n" + capitalized(ask) + "\n\n- **What I would do first:** write down the one decision this work should change, and the date it needs to change by.\n- **What I need from you:** the constraint that matters most — scope, time, or quality — and one example of a good-enough result.\n- **What I will return:** a short plan with owners, the first real action, and the unknowns I could not resolve.\n\nNote: this reply is from the built-in demo engine. Connect a model in **Settings → Engines** to put a real agent behind " + name + ".\n\nWhat is the constraint?"
	}
}

func compactAsk(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 180 {
		s = s[:177] + "…"
	}
	if s == "" {
		return "the task"
	}
	return strings.TrimSuffix(s, ".")
}

func capitalized(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
