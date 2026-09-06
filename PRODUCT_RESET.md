# Grox 产品重置与改造路线

## 第二轮实施结果（2026-09，对应 PRODUCT_REVIEW.md P0）

- `main.rs` 从 11 305 行降至约 9 000 行；共享内核下沉为 `host_core.rs`（AcpState、ACP wire 读写、原子文件写入、路径/CLI 解析、浏览器与 Computer Use 门禁），进程与连接生命周期下沉为 `runtime_lifecycle.rs`（spawn、stdout/stdin 循环、失败清算、自动重连）。
- 模块对 main.rs 的符号依赖从约 18 个模块 30+ 处降至 6 处已记录残留（provider 环境注入 DI、会话磁盘预览、worktree 事务、退出编排、模型解析）；内核符号一律 `crate::host_core::…`。
- `spawn_acp_process`（372 行）拆为代次清算、命令组装（无 AppHandle 依赖、可测）、stdout 派发、单行入站处理、退出清算、stderr 循环六个单元，行为不变。
- ACP 协议合同互锁落地：`fixtures/acp/` 保存 15 个真实形状的原始 ACP 行夹具，Rust 侧 `session_event_journal.rs` 合同测试把真实解码产物（归一化随机流 ID/时间戳后）与黄金逐字节比对，TS 侧 `hostEventContract.test.ts` 对同一份黄金做严格键集白名单与枚举域校验；两侧漂移（serde 字段、序列化策略、投影 kind、块操作枚举）任一变化即测试红，已用故意漂移双向验证。重新生成黄金：`GROX_PROTOCOL_FIXTURE_REGEN=1 cargo test protocol_contract`。
- 运行时通知分级落地：红色横幅只留给「任务无法进行」级故障；8 处非阻断降级（Computer/Browser Use 偏好迁移、自动化/供应商配置/Host 偏好/提示队列读取失败、页面缓存未更新、草稿恢复失败）改为金色「运行环境提示」并给出可执行动作（如「可在设置的通用页重新调整该能力」），新用户首屏不再出现红色错误横幅。分级入口：`ErrorFallback.severity` + `runtimeNoticeFromError(error, level)`。
- i18n 棘轮落地：`i18nRatchet.test.ts` 按文件冻结约 800 处存量内联双语三元，拦新增（新文案必须走 `t()`），并强制新组件登记；已用故意漂移验证报警有效。
- 决定层可访问性：`ChipSelect`（全局选择器）补齐 ArrowUp/Down 遍历、Home/End、Enter/Space 确认与 `aria-activedescendant`，键盘起点落在当前选中项；`PermissionCard` 补 `role="group"` 语义、快捷键 `aria-keyshortcuts` 与脚本展开按钮 `aria-expanded`；`PlanCard` 补简明可访问名。键盘选模型全流程已在 Mock 实测（打开→方向键→Enter 切到 GROK-4）。
- 模态可访问性闭环：新增 `hooks/useModalA11y`（首个可聚焦元素聚焦、Tab/Shift+Tab 容器内圈定、Escape 捕获消费并回调、关闭/卸载归还来源焦点），AccountSetup 两个变体、Composer 反馈框与 SettingsModal 接入 `role="dialog"` + `aria-modal`；Esc 分层消费（容器内下拉打开时先归下拉），设置弹窗分层序列已 Mock 实测；hook 行为有 4 项 jsdom 测试。
- 请求导航轨改 IntersectionObserver：回合行坐标在观察回调中缓存为文档相对值，滚动时只做纯算术选取，消除每帧全量 `querySelectorAll` + `getBoundingClientRect`；Mock 实测滚动高亮切换与点击跳转（22 个标记）正常。
- provider DI 反转完成：供应商 config.toml 覆盖域（auth/backend 覆盖存储、`[model.*]` 段改写、`[grox]` 元数据、`resolve_agent_model_id`，约 530 行）自 main.rs 下沉为 `provider_overrides.rs`；`provider_service::open_current` 统一装配 Host 操作，`apply_provider_environment` 归属 provider 域。runtime_lifecycle 与 media_service 不再引用 main.rs，内核反向依赖只剩 4 处已记录的业务函数（会话磁盘预览、worktree 事务、退出编排）；main.rs 降至约 8400 行。
- 首页 PromptOptionsMenu 补齐键盘与语义：触发器 `aria-expanded`/`aria-haspopup`，面板为 `role="dialog"`，三组互斥选项为 `radiogroup`/`radio` + `aria-checked`，方向键在组内移动（与 ChipSelect 同一套交互语言），Mock 实测语义结构。
- 全程保持 `cargo test` 全绿（292 项）与前端测试全绿（375 项）；新增/迁移代码无编译告警（仅存 4 处改动前已有的死代码告警）。

## 第一轮实施结果

- 组件层不再直接调用 Tauri `invoke` 或 ACP bridge；Host 与 runtime 副作用统一从 `hostActions.ts` 进入，并由架构测试防止回退。
- store 的公开契约已移到 `storeTypes.ts`，workflow 合并规则已移到纯投影模块；保留单一 Zustand store，避免把共享会话事务拆成互相回调的 slices。
- 供应商模型决策、Git diff 解析、会话 block 变换和本地 durable-state 读取已分别移入 `providerDomain.ts`、`diffDomain.ts`、`sessionDomain.ts`、`durableState.ts`。
- provider、automation、preview、workspace 能力快照统一由 `CapabilityState` 契约承载；对应状态变更规则保留在 capability 域函数中。
- ACP 会话事件到 UI 会话的投影已移到 `sessionProjection.ts`；`AcpBridge` 保留协议生命周期和兼容解码职责。
- 设置、媒体和自动化模块改为真正按需加载，首屏主 JS 从约 1.22 MB 降至约 1.14 MB。
- 前端 365 项测试、生产构建及 Rust 291 项测试通过。

## 先定产品，不先拆组件

Grox 的唯一核心工作是：用户提出一个工程任务，Agent 在真实工作区执行，用户能看懂进度、在需要时做决定，并在中断后继续。

因此产品闭环只有四个动作：

1. **提出**：选择工作区，输入任务，发送。
2. **观察**：看到当前回合、工具动作和最终结果。
3. **决定**：批准、回答、停止或继续。
4. **恢复**：重开任务、查看未完成状态、继续下一回合。

项目、账户、模型、预览、自动化、媒体、插件、worktree 都是支撑闭环的能力，不应成为平行的“产品中心”。任何新功能如果不能让上述四步更快、更安全或更可恢复，就不进入主界面。

## 当前根因（来自代码事实）

- `src/state/store.ts` 约 3902 行，同时持有导航、会话、队列、持久化、账户、供应商、预览、自动化和工作流状态；它是上帝组件，也是跨域变更的主要耦合点。
- `src/bridge/AcpBridge.ts` 约 4205 行，同时做 ACP 传输、协议兼容、事件归一化、历史恢复和业务策略；协议层与产品策略没有稳定边界。
- `SettingsModal.tsx` 约 905 行，集中了账户、供应商、扩展、配置文件和权限开关；设置页实际上承担了多个后台产品。
- 多个 UI 文件直接 `invoke(...)` 或调用 `bridge.callExtension(...)`（例如 `Inspector.tsx`、`PreviewPane.tsx`、`Sidebar.tsx`、`EnvironmentSummary.tsx`、`SettingsModal.tsx`），绕过状态层，导致“谁拥有副作用”没有单一答案。
- 构建产物主 JS 约 1.22 MB，说明所有后台能力默认进入首屏；这不是性能优化问题，而是产品边界没有被代码表达。

## 目标架构：一条主链，三类边界

```text
UI
  ↓ 只提交意图、订阅快照
Session Store（唯一产品状态入口）
  ↓ 只调用能力接口
Runtime Adapter（ACP / Mock）
  ↓
Grok CLI / Tauri Host
```

边界规则：

- UI 不直接调用 Tauri `invoke`，也不直接调用 ACP 扩展；所有副作用由 store action 或一个明确的 capability adapter 承担。
- Session Store 只拥有“会话闭环”状态：会话索引、当前会话、回合、门禁、草稿、队列、恢复状态。账户、供应商、自动化、预览改成独立 capability state，按需加载。
- Runtime Adapter 只负责协议生命周期和原始事件；“何时算完成、何时暂停队列、如何展示”留在产品层。
- 每个跨层数据只保留一个真相源：Agent 历史是上下文真相，应用 journal 是展示恢复真相，队列是未执行意图；禁止再复制一份“看起来更完整”的缓存。

## 改造顺序（按风险排序）

### P0：先收口副作用（已完成）

- 建立 `capabilities` 入口，把文件打开、外链、更新、扩展调用等已有 IPC 逐步收口；不改变行为，不新增抽象层。
- 加一条架构检查：`src/components/**` 禁止导入 `@tauri-apps/api/core` 和 `bridge` 的运行时对象。
- 保留现有 359 个测试作为回归门槛。

### P1：明确会话主链（已完成边界提取）

- 公开状态契约独立维护，workflow 与 session 投影保持纯函数。
- 保留单一 store 中需要原子更新的会话、门禁、队列和恢复事务；不为降低行数制造跨 slice 调用。
- 新能力不得直接扩张核心会话事务，先进入独立 capability 或 Host adapter。

### P2：协议层瘦身（已完成边界落地）

- 已将 session projection 移出 `AcpBridge`，并保留 `acpRpc.ts` 作为响应 decoder 的纯函数边界；`AcpBridge` 只负责运行时生命周期、监听注册与状态编排。
- workflow、provider、diff、session 等协议字段归一化均不再进入 React 组件；协议变化不会触碰 UI。
- 目标：协议变化只改 decoder/adapter，不触碰 React 与 session reducer。

### P3：重排产品表面（已完成加载边界）

- 首屏只保留“工作区 + 任务输入 + 最近任务”。媒体和自动化降为入口，不占用同一套 composer 状态。
- 右侧工作区只服务当前任务：文件、计划、预览、终端统一为 task tools；账户、供应商、插件全部留在设置。
- 删除没有证据支撑的快捷命令、重复入口和装饰动画；以“完成一个任务所需点击数”和“恢复中断任务成功率”衡量。

## 明确不做

- 不为了“未来扩展”引入通用事件总线、依赖注入容器、repository/factory 层。
- 不把所有逻辑搬到更多文件就算重构；拆分必须同时减少跨域依赖。
- 不在没有用户行为数据前删除媒体、自动化或多供应商能力；先把它们从核心路径移出，再用使用率决定去留。

## 验收指标

- 核心路径：新用户从打开到发送首个任务 ≤ 2 次非必要点击。
- 恢复路径：应用重启后能继续最近一次未完成会话，且不自动重放旧队列。
- 结构指标：UI 无直接 IPC；产品投影与协议生命周期分离；新增能力不增加核心会话事务字段。
- 质量门槛：`pnpm test`、`pnpm build`、`cargo test --manifest-path src-tauri/Cargo.toml` 全部通过。

本文件只定义产品边界和拆分顺序；真正删除功能前，先记录该功能的使用证据和替代路径。
