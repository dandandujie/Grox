# Grox 架构与产品体验深度评审（2026-09）

本文是继 `PRODUCT_RESET.md`（P0–P3 已完成）之后的下一轮评审与路线。所有结论基于代码事实与 Mock 实测证据，不引入新抽象层，不改变「明确不做」的边界。

## 评审方法

- 代码走读：前端约 25.1K 行 / Rust 约 36.7K 行；重点 `AcpBridge.ts`（4017 行）、`store.ts`（3538 行）、`main.rs`（11305 行）及各 capability 域。
- 质量门槛实测：`pnpm typecheck`、前端 365 项测试、`cargo test`、生产构建全部通过。
- 产品实测：浏览器 Mock 走完「提出 → 观察 → 决定 → 恢复」全闭环（首屏、发送任务、权限批准、回合完成态、回首页恢复、设置弹窗）。

## 总体判断

产品定位清晰（官方 CLI 的桌面工作台，不 fork 运行时），四步闭环在 UI 上完整落地：权限卡键盘优先、计划/问答/暂停/队列/恢复的供给齐全，完成态的信息密度（上下文 %、费用、轮数、Diff 撤销/审核）高于同类。上一轮重置的边界提取（hostActions、storeTypes、sessionProjection、capability 域）方向正确、执行到位。

当前主要风险已经转移：不在 UI 分层，而在**三个上帝文件的剩余体量**、**协议模型双份手工镜像**、**i18n 机制形同虚设**、**错误等级表达失真**四个点。

## 一、代码架构

### A1. `main.rs`（11305 行）是最大的结构性风险

它同时扮演四个角色：111 个 Tauri command 的编排层、共享内核（`AcpState` + 原子写 + `grok_home` + wire 读写）、进程管理器（`spawn_acp_process` 372 行，main.rs:7998）、以及一个完整的静态预览 HTTP 服务器（`handle_static_preview_request` 176 行，main.rs:5193）。

最关键的事实：**约 18 个模块向上依赖 main.rs**（`crate::{AcpState, request_acp_json, atomic_write_bounded_private, ...}`），依赖方向倒置——下层模块依赖「顶层编排」，导致任何编排层改动都可能波及协议、事务与仓储模块。

优化顺序（每步保持 291 项 Rust 测试全绿，不做行为变更）：

1. **内核下沉**：`AcpState`、wire 读写（`prepare_acp_line`/`write_acp_line`/`request_acp_json*`）、`atomic_write` 家族、`grok_home` 移入 `host_core.rs`；main.rs 只留命令编排。这一步直接解除 ~18 处反向依赖。
2. **拆 `spawn_acp_process`**：spawn + stdin 写循环 + stdout 派发循环 + 退出清算本是四个可独立测试的单元；stdout 派发循环内联了 journal、回合监控、callback、交互五方消费逻辑，是全文件最难测的部分。
3. **静态预览服务器独立**（`static_preview.rs`，含 CSP/mime/请求处理三块）。
4. **provider serde 模型并入 `provider_profiles.rs`**（main.rs:883-987 与领域模型并存）。

### A2. 协议模型双份手工镜像——最易腐化的接口点

Rust 侧出站模型（`session_event_journal.rs:26` 的 `HostSessionEvent`/`HostSessionProjection`）与 TS 侧 `bridge/types.ts`（642 行 "ACP type mirror"）纯手工同步；`AcpBridge.ts:773-798` 与 `:1782-1821` 再重复匹配一遍 wire kind。新增一个 ACP 工具类型需要改三处，无编译期互锁。

优化（按投入递增）：

- 最小方案：**合同测试互锁**——把 `.grox/official-cli.json` 基线下的真实 ACP 事件夹具做成共享 fixture，Rust 侧 serde 解码测试与 TS 侧 decoder 测试消费同一份 JSON，任一侧漂移即测试红。
- 长期方案：Rust 出站模型加 `schemars` 生成 JSON Schema，构建期产出 `bridge/types.generated.ts`，`types.ts` 只保留手写的 UI 侧类型。

### A3. `AcpBridge`（4017 行）与 `store`（3538 行）的剩余瘦身

`sessionProjection` 已拆出，但 `AcpBridge` 仍同时承担：传输生命周期、x.ai 扩展兼容解码、历史重放合并（`offlineMerge` 相关）、交互路由。建议下一步把「历史重放/离线合并」继续下沉为纯模块（可对照 `sessionProjection.ts` 的做法），让 Bridge 剩「连接 + 监听注册 + 状态编排」。

`store` 的公开契约已到 `storeTypes.ts`，但 action 表仍有 90+ 个方法平铺在一个 `create()` 里。遵循 PRODUCT_RESET「不为降行数拆 slice」的原则，不动原子事务，先做**分组注释与 `storeTypes.ts` 按四步闭环分节**（提出/观察/决定/恢复 + capability 装载），让新能力找不到可以「顺手加字段」的地方。

### A4. 错误处理双轨制

老命令层 141 处 `Result<_, String>`（main.rs），新模块用结构化 `HostError`（code + hint），中间靠 `main.rs:2232` 手工桥接。前端因此无法稳定匹配错误码，产品层「错误 → 用户可执行动作」的映射做不了。建议：新命令一律 `HostError`，存量 String 错误在 touched-by 时迁移，不为迁移而迁移。

### A5. 死代码与死依赖（本轮已清理）

- `components/fx/Starfield.tsx`（302 行，三层视差星空 + 流星）：全仓零 import，已删除。
- `react-virtuoso`（package.json 声明依赖）：src 零 import，且 `layoutAdaptability.test.ts:90` 明确断言 Timeline 不得引入——已从依赖移除。
- `blocks.tsx:86` 流式标记「正在输出」缺英文分支：已修复为双语。

## 二、产品体验

### P1. 首屏第一秒：错误等级表达失真

实测 Mock 首屏即出现红色「运行环境错误：Browser Use 偏好迁移失败；检查应用数据目录的文件权限后重试」横幅（来源 `store.ts:1649/1658`）。这是**可选能力的偏好迁移失败**，却用了最高告警等级 + 开发者向文案，新用户第一眼看到的是红色报错而不是产品。

建议建立通知分级：红色横幅只留给「任务无法进行」级故障（CLI 缺失、认证失效、进程崩溃）；可选能力初始化失败降级为设置内徽标 + 静默重试，文案给出可执行动作而非「检查文件权限」。

### P2. 双语一致性：机制存在但形同虚设

`lib/i18n.ts` 只有 ~90 个 key，实际代码约 250 处用 `language === "zh-CN" ? ... : ...` 内联三元绕过 `t()`（Composer 58 处、Sidebar 63 处、SettingsModal 30 处、Timeline 27 处……）。英文界面已出现中文漏网（`blocks.tsx:86`，已修复）与英文硬编码 aria-label（`QuestionCard.tsx:84`）。

建议不推倒重来：先加 ESLint 自定义规则禁止新的内联双语三元（或强制走 `zh()/en()` 帮助函数），存量随 touched-by 迁移；ICU 复数/插值暂不需要。

### P3. 可访问性短板集中在「决定层」与「全屏模态」

- `PermissionCard`、`PlanCard`、`DiffView`、`AccountSetup`（全屏引导）aria 覆盖为 0；两个全屏 modal（AccountSetup、Composer 内反馈框）无 `role="dialog"` 与焦点陷阱，Tab 可逃逸到背景。
- `ChipSelect`（全局选择器）只有 Escape 关闭，无 ↑/↓ 键盘遍历——与权限卡「键盘优先」的高水准形成反差。
- 建议：PermissionCard/PlanCard 作为「决定层」优先补齐 role 与快捷键标注；ChipSelect 补方向键；模态统一一个 `useModalA11y`（focus trap + Esc + restore focus）。

### P4. 观察层的长会话性能

`RequestNodeRail`（Timeline.tsx:212-396）用 rAF 节流但每帧 `querySelectorAll` 全量遍历；「turn 窗口」策略（有意不用 Virtuoso，见 `timelineWindow.ts`）已控制渲染规模，但导航轨的 DOM 遍历随会话长度线性增长。建议改为 IntersectionObserver 标记可见区块，rAF 里只读缓存。

### P5. Mock 演示体验割裂

发送任意任务，Mock 返回的都是无关内容（middleware/rate limiter 演示脚本），且中英文混排。对外演示或截图场景观感割裂。建议 Mock 至少回显任务语义（标题、首条思考引用用户文本），演示脚本作为 `/demo` 命令而非默认路径。

### P6. 值得肯定的体验资产（保持不退化）

权限卡的数字快捷键与金色高亮、完成回合自动收纳为「已处理 N 段思考 · N 个工具」、Diff 卡的撤销/审核、Composer 的「插话 / 加入队列 / 停止」三态、状态栏上下文-% 与费用、离线恢复按真实调用 ID 保留公开工具输入。这些是产品差异化所在，建议纳入回归测试清单防止退化。

## 三、下一轮优先级

| 级别 | 事项 | 对应 | 状态 |
|---|---|---|---|
| P0（1-2 周） | main.rs 内核下沉 `host_core.rs`；拆 `spawn_acp_process` | A1 | ✅ 已完成（2026-09）：main.rs 11305→约 9000 行；反向依赖 30+ 处→6 处已记录残留；spawn 拆为 6 个单元；`cargo test` 291 项全绿 |
| P1（2-4 周） | 协议 fixture 互锁测试 → schemars codegen；新命令统一 HostError | A2/A4 | 🔶 合同互锁 + provider DI 反转已完成（2026-09）：`fixtures/acp/` 15 夹具互锁、provider 链零 main.rs 依赖（残留 4 处业务函数已记录）；schemars codegen 与 HostError 存量迁移待办 |
| P2 | 通知分级落地（迁移失败降级）；i18n lint 规则 | P1/P2 | ✅ 已完成（2026-09）：通知分级（8 处非阻断降级为金色「运行环境提示」）+ i18n 棘轮测试（`i18nRatchet.test.ts` 冻结约 800 处存量、拦新增） |
| P3 | a11y（决定层卡片、模态焦点陷阱、ChipSelect 键盘）；导航轨 IntersectionObserver | P3/P4 | ✅ 已完成（2026-09）：决定层 aria、ChipSelect 键盘导航、`useModalA11y` 模态焦点陷阱（AccountSetup/反馈框）、导航轨 IntersectionObserver 化（Mock 实测） |
| 随手 | Mock 回显任务语义 | P5 | 待办 |

### A2 后续（schemars codegen）评估结论（2026-09）

合同互锁测试已把漂移检测做实（双向红），codegen 的边际收益下降，**暂缓引入 schemars/ts-rs**。重新启用的触发条件（满足其一）：

1. ACP 投影模型在一个迭代内新增 ≥3 个投影 kind 或字段族（手工同步开始成为常态负担）；
2. 出现第二消费端（如 CLI 工具直接读 journal），需要机器可读的 schema 契约；
3. 合同测试因夹具维护成本开始被跳过或标记 ignore。

届时落地顺序：`HostSessionEvent`/`HostSessionProjection` 加 schemars → 构建期产出 `bridge/types.generated.ts` → `hostEventContract.test.ts` 的白名单改为对生成类型编译期校验 → 删除手写镜像注释。

### P0 落地明细（2026-09）

- 新增 `src-tauri/src/host_core.rs`：AcpState 及其 impl、RuntimePhase、wire 读写（`prepare_acp_line`/`write_acp_line`/`request_acp_json*`/`acp_request_inner`/`decode_host_acp_response`/`acp_method_allowed`/`acp_rpc_error`）、原子写家族、`grok_home`/`config_path`/各路径与字节常量、CLI 解析（`configured_grok_command` 等）、浏览器拉起与 Computer Use 门禁。
- 新增 `src-tauri/src/runtime_lifecycle.rs`：`spawn_acp_process`、`ensure_agent_runtime_ready`、自动重连调度、客户端回调入站处理、退出清算；`spawn_acp_process` 拆为 `reset_previous_generation` / `build_grok_command`（纯函数，无 AppHandle 依赖）/ `dispatch_inbound_line`（单行处理）/ `finalize_agent_exit` / stdout/stderr 循环。
- 已知残留（P1 跟进，均为业务函数的自然归属尚未拆出）：`apply_grox_provider_environment`（provider DI 装配仍在 main.rs，runtime_lifecycle 与 media_service 引用）、`preview_session_from_disk`（foreground_turn）、`create/rollback_managed_worktree`（session_runtime）、`request_host_exit`（tray）、`resolve_agent_model_id`（turn_runtime）。
- 注意：仓库未强制 rustfmt（基线即有全量漂移），本轮未做全局格式化，仅新增模块自身格式自洽。

## 验收指标（延续 PRODUCT_RESET）

- 结构：main.rs 中 `crate::` 自引用（其他模块 import main.rs 符号）归零；协议字段改动只触 decoder/adapter。
- 体验：首屏不再出现非阻断性红色横幅；英文界面无中文漏网（lint 守护）；决定层卡片键盘可完整操作。
- 质量门槛不变：`pnpm typecheck`、`pnpm test`、`pnpm build`、`cargo test` 全绿。
