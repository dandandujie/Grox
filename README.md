<div align="center">

# Grox

**本地优先的桌面个人助理工作区**

[快速开始](#快速开始) · [功能指南](#功能指南) · [架构](ARCHITECTURE.md) · [English](README.en.md)

</div>

Grox 把不同角色的 AI 助理放进同一个工作区。每位助理可以配置自己的模型、指令、目录和审批权限。你可以交代任务、审阅操作请求，或在频道中用 `@` 指定哪位助理回答。

使用 Go、MyGo 和 React 构建。接入你已安装的 Grok Build、Claude Code、Codex 或 Gemini CLI，也可连接兼容 OpenAI 的 API。工作区保存在本机，使用模型与连接应用时，请求由相应的引擎或服务处理。

## 快速开始

需要 Go 1.27.3+、Node.js 22.6+ 和系统 WebView。macOS 使用 WKWebView，Windows 使用 WebView2，Linux 使用 WebKitGTK 4.1。

```sh
git clone https://github.com/dandandujie/Grox.git
cd Grox
npm ci
npm run dev
```

运行 `npm run build` 为当前平台打包。Apple 芯片 Mac 的应用位于 `build/darwin-arm64/Grox.app`。仅体验界面可运行 `npm run dev:web`，用浏览器打开终端显示的地址。网页预览使用测试数据。

### 第一次打开

1. 默认语言是简体中文。可在欢迎页或「设置 → 常规 → 语言」选择 English，Grox 会记住选择。
2. 初始工作区只有 Brody 和一条空白会话。选「试用演示」可直接体验预设回复、问答和审批。要执行真实任务，先登录已安装的 CLI，或在「设置 → 引擎」填写 API 地址和模型 ID。
3. 发出任务后，可以在「工作台」找回待审批、待回答、进行中和最近会话。发送失败时草稿会保留。任务运行失败或停止后，可在会话中选择「恢复原请求」。

[查看首次使用指南](docs/ONBOARDING.md)

## 功能指南

| 场景 | 功能 |
| --- | --- |
| 分配与跟进 | 多助理、私聊、频道、工作台、消息搜索和文件附件。可以为助理设置[部门](docs/DEPARTMENTS.md)和[角色预设](docs/PRESETS.md)。 |
| 工具与权限 | 支持[电脑工具](docs/COMPUTER.md)、[受控浏览器](docs/BROWSER.md)、[MCP 服务器](docs/MCP.md)和 Composio 连接。可按助理设置[工具策略](docs/TOOL-POLICY.md)，在会话中处理审批和[提问](docs/QUESTIONS.md)。 |
| 重复工作 | [定时任务](docs/ROUTINES.md)、[Webhook](docs/WEBHOOKS.md)和[本地自动化 API](docs/API.md)。 |
| 持续使用 | [记忆](docs/MEMORY.md)、[技能](docs/SKILLS.md)、[工作手册](docs/PLAYBOOKS.md)、[团队包导入导出](docs/TEAMS.md)和[用量统计](docs/USAGE.md)。 |
| 手机、语音与头像 | 同一网络下可用手机浏览器继续对话。听写与朗读依赖系统和 WebView 的语音支持。助理使用本机生成的 [1-bit 黑白像素头像](docs/AVATARS.md)。 |

部分功能需要 CLI 登录、模型凭据、Chrome、系统权限或用户提供的 SSH 主机。验收范围和已知限制见[功能清单](docs/PARITY.md)和[安全说明](SECURITY.md)。

## 数据位置

macOS 的数据目录为 `~/Library/Application Support/Grox`，Linux 为 `$XDG_CONFIG_HOME/Grox` 或 `~/.config/Grox`，Windows 为 `%APPDATA%\Grox`。可以在「设置 → 数据与隐私」查看目录或导出不含密钥的工作区。

## 开发

运行 `npm run verify` 执行 TypeScript 类型检查、Go 测试和 `go vet`。Go 服务通过 MyGo IPC 提供绑定和事件，React 负责界面。参阅[架构](ARCHITECTURE.md)、[贡献指南](CONTRIBUTING.md)和[更新日志](CHANGELOG.md)。

Grox 的会话交互参考 [OpenMausBot](https://github.com/milind-soni/OpenMausBot)。头像系统由 Grox 本机生成。见[致谢](NOTICE)和 [Apache 2.0 许可证](LICENSE)。
