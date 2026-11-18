# Grox 架构

[English · 完整设计与协议](ARCHITECTURE.en.md)

MyGo 窗口承载 React 应用。前端通过生成的 `src/mygo.ts` 调用 Go 服务，使用一个事件流接收消息和工作区更新。引擎凭据、网络与文件操作留在 Go 进程中。

```text
React / Vite
    │ MyGo 类型绑定与事件
internal/service  会话、消息、审批、调度和应用连接
    ├── internal/agent    内置演示、CLI、兼容 OpenAI 的 API
    ├── internal/store    工作区、密钥和默认值
    ├── internal/catalog  引擎探测和模型目录
    ├── internal/schedule 定时任务与时区
    └── internal/browser  单轮托管浏览器会话
```

## 数据与运行

- 私聊与频道都由线程保存对话。频道收到消息时可按 @ 提及选择一位成员，否则交由主答助理。
- 每轮请求绑定助理、会话、模型、工作目录与审批配置。先持久化请求，再运行引擎。前端按事件更新，任务结束后保存结果。
- 选择真实引擎时，缺少 CLI 或配置会提示修复。演示引擎由用户选择。
- 支持工具时，每轮 CLI 通过临时配置调用本机 MCP 网关，由相应 CLI 的钩子处理逐项审批。API 走独立的工具循环。详见[工具策略](docs/TOOL-POLICY.md)与[安全说明](SECURITY.md)。
- 桌面与手机伴侣使用同一工作区语言。React 根据 `settings.language` 选择文本和日期格式。历史记录、命令及第三方原始诊断保留原文。

## 开发入口

`main.go` 建立窗口与生命周期。`src/state/store.tsx` 管理前端状态和动作。`internal/store` 负责原子持久化。`cmd/fixture` 生成用于网页预览的工作区数据。
