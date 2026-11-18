# 本地自动化 API

[English](API.en.md)

「设置 → 自动化」可启用 JSON API。默认关闭，仅监听 `127.0.0.1`。启用或重新生成令牌后，界面只展示一次新令牌。所有 `/v1` 请求都需要 `Authorization: Bearer <token>`。

| 路径 | 用途 |
| --- | --- |
| `GET /health` | 返回服务标识。 |
| `GET /v1/state`、`/v1/bots`、`/v1/groups`、`/v1/routines` | 查询工作区、助理、频道与定时任务。 |
| `GET /v1/events` | 订阅工作区、消息和任务事件。 |
| `POST /v1/bots/{botID}/threads/{threadID}/messages` | 提交 `{"text":"…"}` 启动私聊任务。 |
| `POST /v1/groups/{groupID}/threads/{threadID}/messages` | 启动频道任务。 |
| `POST /v1/routines/{routineID}/run` | 立即运行定时任务。 |

私聊与频道线程同样提供 `approvals/{messageID}`、`answers/{messageID}`。批准或拒绝提交 `{"decision":"allow"}` 或 `{"decision":"deny"}`，回答提交 `{"answer":"…"}`。任务端点返回 HTTP 202 后异步执行。请求体上限 64 KB，使用与桌面相同的服务方法。
