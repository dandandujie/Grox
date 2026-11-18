package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/dandandujie/grox/internal/model"
)

type fakeSink struct {
	text     strings.Builder
	activity []model.Activity
	approval *model.Approval
	options  []model.Option
	question string
	statuses []string
	usage    TokenUsage
}

func (f *fakeSink) Text(delta string)         { f.text.WriteString(delta) }
func (f *fakeSink) Status(status string)      { f.statuses = append(f.statuses, status) }
func (f *fakeSink) Activity(a model.Activity) { f.activity = append(f.activity, a) }
func (f *fakeSink) Approval(a model.Approval) { f.approval = &a }
func (f *fakeSink) Usage(usage TokenUsage)    { f.usage = usage }
func (f *fakeSink) Options(text string, options []model.Option) {
	f.question = text
	f.options = options
}

func demoRequest(bot model.Bot, text string) Request {
	return Request{Bot: bot, UserText: text, Thread: model.Thread{ID: "t", BotID: "b"}}
}

func TestDemoApprovalAndDecision(t *testing.T) {
	bot := model.Bot{Name: "Emaily", Title: "Inbox chief", Approval: model.ApprovalAsk}
	sink := &fakeSink{}
	if _, err := runDemo(context.Background(), demoRequest(bot, "archive my inbox"), sink); err != nil {
		t.Fatal(err)
	}
	if sink.approval == nil {
		t.Fatal("expected an approval card")
	}
	if !strings.Contains(sink.text.String(), "gmail archive") {
		t.Fatalf("expected the command in the preface, got %q", sink.text.String())
	}

	allowed := &fakeSink{}
	if _, err := runDemo(context.Background(), demoRequest(bot, "[approval:allowed] gmail archive --older-than 7d"), allowed); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(allowed.text.String(), "Archived 53 messages") {
		t.Fatalf("unexpected approval result %q", allowed.text.String())
	}
	if len(allowed.activity) == 0 {
		t.Fatal("expected a finished tool activity")
	}
}

func TestDemoOptionsAndAnswer(t *testing.T) {
	bot := model.Bot{Name: "Omiii", Title: "Operations"}
	sink := &fakeSink{}
	if _, err := runDemo(context.Background(), demoRequest(bot, "Which direction should I choose?"), sink); err != nil {
		t.Fatal(err)
	}
	if len(sink.options) < 3 {
		t.Fatalf("expected options, got %d", len(sink.options))
	}

	answer := &fakeSink{}
	if _, err := runDemo(context.Background(), demoRequest(bot, "My answer: Ship the smallest useful version"), answer); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(answer.text.String()), "smaller surface") {
		t.Fatalf("unexpected answer reply %q", answer.text.String())
	}
}

func TestDemoCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	bot := model.Bot{Name: "Test", Approval: model.ApprovalAuto}
	if _, err := runDemo(ctx, demoRequest(bot, "hello"), &fakeSink{}); err == nil {
		t.Fatal("expected a cancellation error")
	}
}

func TestDemoPlanFormatting(t *testing.T) {
	bot := model.Bot{Name: "Brody", Title: "Research & data", Approval: model.ApprovalAuto}
	sink := &fakeSink{}
	if _, err := runDemo(context.Background(), demoRequest(bot, "Help me plan this week"), sink); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sink.text.String(), "**Outcome**\n\n") {
		t.Fatalf("expected a paragraph break after Outcome, got %q", sink.text.String())
	}
}

func TestAnthropicResultUsage(t *testing.T) {
	sink := &fakeSink{}
	var text strings.Builder
	sawDelta := false
	eventErr := ""
	handleAnthropicEvent(map[string]any{
		"type": "result", "result": "All done.",
		"usage": map[string]any{"input_tokens": float64(4), "output_tokens": float64(6)},
	}, &text, &sawDelta, &eventErr, sink)
	if text.String() != "All done." || sink.usage.InputTokens != 4 || sink.usage.OutputTokens != 6 || sink.usage.TotalTokens != 10 {
		t.Fatalf("text=%q usage=%+v", text.String(), sink.usage)
	}
}

func TestChineseDemoRepliesAndApproval(t *testing.T) {
	req := demoRequest(model.Bot{Name: "Brody", Approval: model.ApprovalAsk}, "帮我规划本周计划")
	req.Language = "zh"
	plan := &fakeSink{}
	if _, err := runDemo(context.Background(), req, plan); err != nil || !strings.Contains(plan.text.String(), "本周目标") || !strings.Contains(plan.text.String(), req.UserText) {
		t.Fatalf("plan = %q, error = %v", plan.text.String(), err)
	}
	req.UserText = "执行命令"
	command := &fakeSink{}
	if _, err := runDemo(context.Background(), req, command); err != nil {
		t.Fatal(err)
	}
	if command.approval == nil || command.approval.Title != "批准此演示操作？" || !strings.Contains(command.text.String(), "不会实际执行") {
		t.Fatalf("approval = %+v, reply = %q", command.approval, command.text.String())
	}
}
