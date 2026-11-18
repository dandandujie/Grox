# 用量统计

[English](USAGE.en.md)

引擎报告 Token 数时，回复底部显示输入、输出和合计。兼容 OpenAI 的 API 会累计同一轮的工具调用用量。Claude Code 与 Grok CLI 在结果事件提供用量时也会显示。Codex 和 Gemini 当前没有稳定的用量展示。

可在「设置 → 引擎 → Token 计价」填写每百万 Token 的输入和输出美元价格。Grox 根据已填价格估算成本。价格为零时仅显示用量，服务未报告用量时不显示这一栏。
