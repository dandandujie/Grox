package agent

import (
	"fmt"
	"strings"

	"github.com/dandandujie/grox/internal/model"
)

var demoZhIntents = strings.NewReplacer(
	"归档收件箱", "archive inbox", "部署", "deploy", "发布", "publish", "删除", "delete",
	"安装", "install ", "执行命令", "shell", "发送邮件", "send ",
	"选择", "choose", "优先", "decide", "计划", "plan", "本周", "week", "调研", "research",
	"搜索", "search", "收件箱", "inbox", "邮件", "email", "代码", "code", "审查", "review", "你好", "hello",
)

func demoIntentZh(text string) string {
	return demoZhIntents.Replace(text)
}

func demoCommandResultZh(command string) string {
	return fmt.Sprintf("演示审批流程已完成，没有执行命令。\n\n示例命令：\n\n`%s`", command)
}

func demoOptionsZh() []model.Option {
	return []model.Option{
		{ID: "a", Label: "交付最小可用版本", Description: "缩小范围，尽早收集反馈。"},
		{ID: "b", Label: "保住交付日期", Description: "保留关键路径，推迟次要功能。"},
		{ID: "c", Label: "让团队专注", Description: "明确一个首要目标，其余工作暂缓。"},
		{ID: "d", Label: "维持多项工作并行", Description: "为每项工作限定时间，接受较慢的进度。"},
	}
}

func demoChoiceReplyZh(prompt string) string {
	answer := strings.TrimSpace(strings.TrimPrefix(prompt, "My answer:"))
	answer = strings.TrimSpace(strings.TrimPrefix(answer, "[choice]"))
	return "已记录你的选择：" + answer + "。\n\n下一步，明确这项工作的负责人和完成日期，并约定怎样判断已经完成。"
}

func composeDemoReplyZh(req Request, intent string) string {
	const setup = "\n\n这是内置演示回复。可在**设置 → 引擎**接入 CLI 或 API 后执行真实任务。"
	switch {
	case strings.Contains(intent, "plan") || strings.Contains(intent, "week"):
		return "**本周目标**\n\n" + compactAsk(req.UserText) + "\n\n- 今天：明确交付物和负责人。\n- 周中：完成影响结果的关键工作，记录阻碍。\n- 周五：检查成果并记录下一步。" + setup
	case strings.Contains(intent, "research") || strings.Contains(intent, "search") || strings.Contains(intent, "latest") || strings.Contains(intent, "news") || strings.Contains(intent, "find"):
		return "**调研提纲**\n\n1. 写清调研要支持的决定。\n2. 核对近期变化并优先查找一手资料。\n3. 记录来源、日期与仍待验证的问题。" + setup
	case strings.Contains(intent, "inbox") || strings.Contains(intent, "email") || strings.Contains(intent, "reply"):
		return "**收件箱处理计划**\n\n- 将需要决定的邮件和需要回复的邮件分开。\n- 草拟简短回复，供你审核。\n- 得到批准后再发送。" + setup
	case strings.Contains(intent, "review") || strings.Contains(intent, "code") || strings.Contains(intent, "diff"):
		return "**代码审查准备**\n\n提供变更范围和复现方式，我会优先检查正确性和回归风险，再列出需要修正的具体位置。" + setup
	case strings.Contains(intent, "hello") || strings.TrimSpace(intent) == "hi":
		return "你好，我是 " + req.Bot.Name + "。你可以让我试着做一个计划，或体验任务审批。" + setup
	default:
		return "**任务起点**\n\n" + compactAsk(req.UserText) + "\n\n先明确希望得到的结果、截止时间和可用资料。然后就能列出第一步和需要你确认的事项。" + setup
	}
}
