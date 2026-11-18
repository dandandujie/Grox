# 技能

[English](SKILLS.en.md)

技能是带有 `SKILL.md` 的文件夹。可放在工作区数据目录的 `skills/`、`~/.grox/skills/`，以及助理工作目录的 `.grox/skills/` 或 `.claude/skills/`。Grox 也扫描 `~/.claude/skills/`。

```markdown
---
name: weekly-review
description: 整理本周进展
---
先核对本周的目标和完成情况，再列出下周优先事项。
```

在助理的「技能」页重新扫描，打开技能可检查全文。技能默认关闭。只启用可信的内容，启用后指令会随请求发给模型，并受长度限制。技能文件中的脚本由所用引擎按自己的能力和权限处理。
