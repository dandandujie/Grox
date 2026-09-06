//! Agent 进程与连接生命周期：spawn、stdin/stdout 循环、失败清算与自动重连。
//!
//! 从 main.rs 下沉（PRODUCT_REVIEW.md A1/P0）。此模块是 `spawn_acp_process` 拆分的
//! 落点：后续把 spawn / stdin 写循环 / stdout 派发 / 退出清算拆为独立可测单元。
//! 无 main.rs 依赖：provider 环境注入经 `provider_service`（DI 已下沉 provider_overrides）。

use crate::acp_host::AcpHostError;
use crate::acp_inbound::AcpInbound;
use crate::agent_runtime::{self, AgentRuntimeConnection};
use crate::provider_service::{self, apply_provider_environment};
use crate::client_callbacks::{self, ClientCallbackInbound, ClientCallbackRegistry};
use crate::host_core::{
    checked_reasoning_effort, cli_version_number, computer_use_gate_open, configured_grok_command,
    emit_host_session_event, ensure_computer_plugin, grok_home, write_acp_line, AcpState,
    AgentProcess,
    GrokRuntimeInfo, RuntimeConnectSpec, RuntimePhase, UPSTREAM_CLI_CLIENT_NAME,
};
use crate::interaction_service::InteractionInbound;
use crate::mcp_leases::McpLeaseStore;
use crate::path_sandbox::checked_workspace;
use crate::process_env;
use crate::session_runtime::shutdown_all_mcp_resources;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::{atomic::Ordering, Arc};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub(crate) async fn terminate_process(mut process: AgentProcess) {
    drop(process.stdin);
    // Job Object first: kills grandchildren that child.kill() alone orphans on Windows.
    #[cfg(windows)]
    if let Some(job) = process.job.take() {
        let _ = job.terminate_tree();
        drop(job);
    }
    let _ = process.child.kill().await;
    let _ = process.child.wait().await;
}

/// Host 内唯一的 ACP 启动事务。页面首次加载、崩溃重连与自动化调度都从这里
/// 取得同一个已握手代次；只有显式配置切换可以要求替换健康进程。
pub(crate) async fn ensure_agent_runtime_ready(
    app: &tauri::AppHandle,
    state: &Arc<AcpState>,
    leases: &Arc<McpLeaseStore>,
    cwd: String,
    reasoning_effort: Option<String>,
    force_reconnect: bool,
) -> Result<AgentRuntimeConnection, AcpHostError> {
    let _connect_guard = state.connect_lock.lock().await;
    if !force_reconnect {
        if let Some(connection) = state.ready_connection().await {
            tracing::debug!(
                target: "grox::runtime",
                generation = connection.generation,
                "reusing ready Agent runtime"
            );
            return Ok(connection);
        }
        let paused_generation = state.paused_generation.load(Ordering::Acquire);
        if paused_generation != 0
            && state
                .process
                .lock()
                .await
                .as_ref()
                .is_some_and(|process| process.generation == paused_generation)
        {
            return Err(AcpHostError::operation(
                "ACP_RUNTIME_PAUSED",
                "Agent 运行时正在执行配置切换，暂不能启动新任务",
            ));
        }
    }
    state.ready_generation.store(0, Ordering::Release);
    state.paused_generation.store(0, Ordering::Release);
    state.clear_cached_connection(None);
    state.set_runtime_phase(RuntimePhase::Starting);

    let connect_spec = RuntimeConnectSpec {
        cwd,
        reasoning_effort,
    };
    tracing::info!(
        target: "grox::runtime",
        force_reconnect,
        "starting Agent runtime connection"
    );

    let (generation, client_version) = match spawn_acp_process(
        app,
        state,
        leases,
        connect_spec.cwd.clone(),
        connect_spec.reasoning_effort.clone(),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            state.set_runtime_phase(RuntimePhase::Offline);
            tracing::error!(target: "grox::runtime", error = %error, "Agent process spawn failed");
            return Err(AcpHostError::environment(
                "ACP_SPAWN_FAILED",
                error,
                true,
                true,
                "请检查 CLI 安装、权限与当前工作目录后重试",
            ));
        }
    };

    state.set_runtime_phase(RuntimePhase::Initializing);
    let initialize =
        match agent_runtime::initialize(state, leases, generation, client_version.as_deref()).await
        {
            Ok(initialize) => initialize,
            Err(error) => {
                tracing::warn!(
                    target: "grox::runtime",
                    generation,
                    code = %error.code,
                    "Agent initialize failed"
                );
                discard_failed_runtime(state, leases, generation, error.clone()).await;
                return Err(error);
            }
        };

    state.set_runtime_phase(RuntimePhase::Authenticating);
    let auth = agent_runtime::authenticate(state, leases, generation, &initialize).await;
    let connection = AgentRuntimeConnection {
        generation,
        initialize,
        auth,
    };
    if let Err(error) = state.mark_runtime_ready(&connection).await {
        discard_failed_runtime(state, leases, generation, error.clone()).await;
        return Err(error);
    }
    state.remember_connect(connect_spec);
    tracing::info!(
        target: "grox::runtime",
        generation,
        auth_required = connection.auth.required,
        auth_in_progress = connection.auth.in_progress,
        "Agent runtime ready"
    );
    Ok(connection)
}

pub(crate) async fn discard_failed_runtime(
    state: &AcpState,
    leases: &McpLeaseStore,
    generation: u64,
    failure: AcpHostError,
) {
    state.mark_generation_unready(generation, RuntimePhase::Offline);
    state.requests.reject_generation(generation, failure).await;
    shutdown_all_mcp_resources(leases);
    let process = {
        let mut process = state.process.lock().await;
        if process
            .as_ref()
            .is_some_and(|process| process.generation == generation)
        {
            process.take()
        } else {
            None
        }
    };
    if let Some(process) = process {
        let next_generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        state.foreground_turns.reset(next_generation);
        state.interactions.reset(next_generation);
        state.client_callbacks.reset(next_generation).await;
        state.sessions.reset(next_generation);
        terminate_process(process).await;
    }
}

pub(crate) fn schedule_automatic_runtime_reconnect(
    app: tauri::AppHandle,
    state: Arc<AcpState>,
    leases: Arc<McpLeaseStore>,
    affected_session_ids: Vec<String>,
    interrupted_session_ids: Vec<String>,
) {
    let Some(spec) = state.last_connect() else {
        return;
    };
    let Some(claim) = state.claim_automatic_reconnect() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _ = app.emit(
            "agent-runtime-reconnect",
            RuntimeReconnectPayload {
                state: "reconnecting",
                attempt: 0,
                affected_session_ids: affected_session_ids.clone(),
                interrupted_session_ids: interrupted_session_ids.clone(),
                connection: None,
                error: None,
            },
        );
        let mut last_error = None;
        for attempt in 1..=2u8 {
            if app.state::<AppShutdown>().started.load(Ordering::Acquire)
                || state.automatic_reconnect_cancelled(claim)
            {
                state.finish_automatic_reconnect(claim);
                return;
            }
            tokio::time::sleep(Duration::from_millis(u64::from(attempt) * 800)).await;
            if app.state::<AppShutdown>().started.load(Ordering::Acquire)
                || state.automatic_reconnect_cancelled(claim)
            {
                state.finish_automatic_reconnect(claim);
                return;
            }
            match ensure_agent_runtime_ready(
                &app,
                &state,
                &leases,
                spec.cwd.clone(),
                spec.reasoning_effort.clone(),
                false,
            )
            .await
            {
                Ok(connection) => {
                    if state.automatic_reconnect_cancelled(claim) {
                        state.finish_automatic_reconnect(claim);
                        return;
                    }
                    let _ = app.emit(
                        "agent-runtime-reconnect",
                        RuntimeReconnectPayload {
                            state: "ready",
                            attempt,
                            affected_session_ids: affected_session_ids.clone(),
                            interrupted_session_ids: interrupted_session_ids.clone(),
                            connection: Some(connection),
                            error: None,
                        },
                    );
                    state.finish_automatic_reconnect(claim);
                    return;
                }
                Err(error) => last_error = Some(error),
            }
        }
        if state.automatic_reconnect_cancelled(claim) {
            state.finish_automatic_reconnect(claim);
            return;
        }
        let detail = last_error
            .as_ref()
            .map(|error| error.message.as_str())
            .unwrap_or("未知运行时错误");
        let error = AcpHostError::environment(
            "ACP_RECONNECT_FAILED",
            format!("Agent 自动重连失败：{detail}"),
            true,
            true,
            "检查 Grok Build CLI、认证与网络后重新连接；重发前先检查最后一轮结果",
        );
        let _ = app.emit(
            "agent-runtime-reconnect",
            RuntimeReconnectPayload {
                state: "offline",
                attempt: 2,
                affected_session_ids,
                interrupted_session_ids,
                connection: None,
                error: Some(error),
            },
        );
        state.finish_automatic_reconnect(claim);
    });
}

pub(crate) async fn handle_client_callback_inbound(
    app: &tauri::AppHandle,
    state: &Arc<AcpState>,
    generation: u64,
    message: &AcpInbound,
) -> bool {
    // 短锁只保护 callback 登记与 reset 的先后关系。实际文件操作会重新取得该锁；
    // terminal/wait_for_exit 则必须脱离 stdout reader 独立等待。
    let inbound = {
        let _operation_guard = state.client_callbacks.lock_operations().await;
        state
            .client_callbacks
            .observe_decoded_inbound(generation, message)
    };
    match inbound {
        ClientCallbackInbound::NotCallback => false,
        ClientCallbackInbound::Request(lease) => {
            if ClientCallbackRegistry::waits_for_terminal_exit(&lease) {
                let callback_app = app.clone();
                let callback_state = Arc::clone(state);
                tauri::async_runtime::spawn(async move {
                    settle_client_callback(
                        &callback_app,
                        callback_state.as_ref(),
                        generation,
                        lease,
                    )
                    .await;
                });
            } else {
                // 文件写入和短终端操作保持 wire 到达顺序；只有可能无限
                // 等待的 wait_for_exit 脱离 stdout reader。
                settle_client_callback(app, state.as_ref(), generation, lease).await;
            }
            true
        }
        ClientCallbackInbound::AutoReply(response) => {
            state
                .foreground_turns
                .observe_outbound(generation, &response);
            if let Err(error) = write_acp_line(state.as_ref(), &response, generation).await {
                let _ = app.emit(
                    "acp-stderr",
                    format!("Client callback 自动拒绝回复失败：{error}"),
                );
            }
            true
        }
        ClientCallbackInbound::Duplicate => {
            let _ = app.emit(
                "acp-stderr",
                "Agent 复用了仍在处理的 Client callback rpc id；已拒绝覆盖原请求",
            );
            true
        }
        ClientCallbackInbound::Invalid => {
            let _ = app.emit(
                "acp-stderr",
                "Agent 发送了没有合法 rpc id 的 Client callback；无法安全回复",
            );
            true
        }
    }
}

pub(crate) async fn settle_client_callback(
    app: &tauri::AppHandle,
    state: &AcpState,
    generation: u64,
    lease: client_callbacks::ClientCallbackLease,
) {
    let response = state.client_callbacks.render_response(&lease).await;
    state
        .foreground_turns
        .observe_outbound(generation, &response);
    let write_result = write_acp_line(state, &response, generation).await;
    state.client_callbacks.settle(&lease);
    if let Err(error) = write_result {
        let (session_id, method) = ClientCallbackRegistry::describe(&lease);
        let _ = app.emit(
            "acp-stderr",
            format!("Client callback 回复失败（{method}，session={session_id}）：{error}"),
        );
    }
}

/// Start a fresh ACP child and stream each stdout JSON-RPC line to the webview.
/// Only the Host connection transaction calls this helper, so a spawned child
/// can never be mistaken for an initialized runtime.
pub(crate) async fn spawn_acp_process(
    app: &tauri::AppHandle,
    state: &Arc<AcpState>,
    leases: &Arc<McpLeaseStore>,
    cwd: String,
    reasoning_effort: Option<String>,
) -> Result<(u64, Option<String>), String> {
    let cwd = checked_workspace(&cwd)?;

    // Invalidate the previous readers before terminating their process. On a
    // fast development reload Windows can still deliver a few buffered stdout
    // or stderr lines after `kill`; those lines must not reach the new ACP
    // connection.
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
    tracing::info!(target: "grox::runtime", generation, "spawning Grok Build ACP process");
    reset_previous_generation(state, leases, generation).await;

    let runtime = configured_grok_command();
    let client_version = runtime
        .version
        .as_deref()
        .and_then(cli_version_number)
        .map(|version| version.to_string());
    // Host gate only (env | host_prefs); WebView state is not authorization.
    let computer_plugin = if computer_use_gate_open() {
        Some(
            ensure_computer_plugin()
                .map_err(|error| format!("Computer Use Plugin 初始化失败：{error}"))?,
        )
    } else {
        None
    };

    let mut command =
        build_grok_command(&runtime, &cwd, reasoning_effort, computer_plugin.as_ref())?;
    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动 Grok CLI（{}）：{error}。可通过 GROK_DESKTOP_CLI 指定可执行文件。",
            runtime.path
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准输入".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准错误".to_string())?;
    // Windows: put ACP child in a Job Object so cancel kills nested tool trees.
    #[cfg(windows)]
    let job = {
        match process_job::ProcessJob::create_kill_on_close() {
            Ok(job) => {
                if let Some(pid) = child.id() {
                    if let Err(error) = job.assign_pid(pid) {
                        tracing::warn!(target: "grox::runtime", generation, pid, error = %error, "AssignProcessToJobObject failed");
                    }
                }
                Some(job)
            }
            Err(error) => {
                tracing::warn!(target: "grox::runtime", generation, error = %error, "CreateJobObject failed; descendant cleanup is degraded");
                None
            }
        }
    };
    *state.process.lock().await = Some(AgentProcess {
        child,
        stdin,
        generation,
        #[cfg(windows)]
        job,
    });

    let stdout_app = app.clone();
    let stdout_state = state.clone();
    let stdout_leases = leases.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if stdout_state.next_generation.load(Ordering::Relaxed) != generation {
                        break;
                    }
                    if line.trim().is_empty() {
                        continue;
                    }
                    if dispatch_inbound_line(&stdout_app, &stdout_state, generation, &line).await {
                        continue;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = stdout_app.emit("acp-stderr", format!("读取 ACP 输出失败：{error}"));
                    break;
                }
            }
        }
        finalize_agent_exit(&stdout_app, &stdout_state, &stdout_leases, generation).await;
    });

    let stderr_app = app.clone();
    let stderr_state = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stderr_state.next_generation.load(Ordering::Relaxed) != generation {
                break;
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                // Bound diagnostics before they cross into the webview.
                let safe = trimmed.chars().take(16_384).collect::<String>();
                let _ = stderr_app.emit("acp-stderr", safe);
            }
        }
    });

    Ok((generation, client_version))
}

/// 归零上一代次：重置认证/回合/交互/回调/会话注册表，拒绝在途请求，终止旧进程。
async fn reset_previous_generation(state: &AcpState, leases: &McpLeaseStore, generation: u64) {
    state.authentication.reset(AcpHostError::environment(
        "AUTH_RUNTIME_CHANGED",
        "Agent 重连取消了旧通道上的登录",
        false,
        false,
        "连接稳定后重新登录",
    ));
    state.foreground_turns.reset(generation);
    state.interactions.reset(generation);
    state.client_callbacks.reset(generation).await;
    state.sessions.reset(generation);
    state
        .requests
        .reject_all(AcpHostError::environment(
            "ACP_CHANNEL_REPLACED",
            "ACP 通道已切换，请在新通道上重试",
            true,
            true,
            "Agent 重连后检查最后一轮结果，再决定是否重新发送",
        ))
        .await;
    shutdown_all_mcp_resources(leases);

    if let Some(old) = state.process.lock().await.take() {
        terminate_process(old).await;
    }
}

/// 组装 `grok agent … stdio` 命令行：参数、身份与凭据环境注入；不触碰进程状态。
///
/// 客户端身份必须跟随被启动 CLI 自己的版本号（写入 Agent 诊断日志，也可能被
/// 上游较新构建读取）；陈旧值既会误导登录诊断，也可能触发服务端版本门控返回
/// 403 "Grok Build is coming soon"。终端 CLI 的身份是 `grok-shell`，传入桌面
/// 客户端标记会让 OAuth 命中另一套上游资格门控，因此端到端保持官方 CLI 身份。
fn build_grok_command(
    runtime: &GrokRuntimeInfo,
    cwd: &std::path::Path,
    reasoning_effort: Option<String>,
    computer_plugin: Option<&std::path::PathBuf>,
) -> Result<Command, String> {
    let command_path = PathBuf::from(&runtime.path);
    let mut command = Command::new(&command_path);
    if let Some(path) = process_env::enriched_path_env() {
        command.env("PATH", path);
    }
    command.arg("agent");
    if let Some(effort) = checked_reasoning_effort(reasoning_effort)? {
        command.arg("--reasoning-effort").arg(effort);
    }
    if let Some(plugin) = computer_plugin {
        command.arg("--plugin-dir").arg(plugin);
    }
    command
        .arg("stdio")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(version) = runtime.version.as_deref().and_then(cli_version_number) {
        command.env("GROK_CLIENT_VERSION", version.to_string());
    }
    command.env("GROK_CLIENT_NAME", UPSTREAM_CLI_CLIENT_NAME);
    let service = provider_service::open_current(grok_home()?)?;
    apply_provider_environment(&mut command, &service)?;

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

/// 处理一行已判非空的入站 ACP 消息；返回 true 表示该行已被响应/回调消费。
///
/// 消费顺序即优先级：请求表响应 → 回合无效参数中止 → 客户端回调 → 交互门控。
async fn dispatch_inbound_line(
    app: &tauri::AppHandle,
    state: &Arc<AcpState>,
    generation: u64,
    line: &str,
) -> bool {
    let inbound = AcpInbound::parse(line);
    if let Ok(message) = &inbound {
        if state
            .requests
            .resolve_decoded_response(generation, line, message)
            .await
        {
            return true;
        }
    }
    if let Some(abort) = inbound.as_ref().ok().and_then(|message| {
        state
            .foreground_turns
            .observe_decoded_inbound(generation, message)
    }) {
        state
            .requests
            .reject(
                abort.request_id,
                abort.generation,
                AcpHostError::protocol("ACP_INVALID_REASONING_EFFORT", abort.message),
            )
            .await;
    }
    if let Ok(message) = &inbound {
        if handle_client_callback_inbound(app, state, generation, message).await {
            return true;
        }
    }
    let interaction = inbound
        .as_ref()
        .ok()
        .map(|message| {
            state
                .interactions
                .observe_decoded_inbound(generation, message)
        })
        .unwrap_or(InteractionInbound::NotInteraction);
    match interaction {
        InteractionInbound::NotInteraction => {
            let event =
                state
                    .session_events
                    .append_inbound(generation, line.len(), inbound.as_ref());
            if let Some(response) = event.unsupported_response() {
                state
                    .foreground_turns
                    .observe_outbound(generation, response);
                if let Err(error) = write_acp_line(state.as_ref(), response, generation).await {
                    let _ = app.emit(
                        "acp-stderr",
                        format!("Host 拒绝未知 Agent 回调失败：{error}"),
                    );
                }
            }
            // 只把已编号的 Host 事件投影给运行时所有者。页面重载期间即使无人
            // 监听，事件仍可由游标命令补放。
            emit_host_session_event(app, event);
        }
        InteractionInbound::Opened(interaction) => {
            // 反向 RPC 只投影给主窗口；rpc id 和 wire option 留在 Host，辅助
            // 窗口不能窃取或回复门控。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("interaction-opened", interaction);
            }
        }
        InteractionInbound::AutoReply(response) => {
            state
                .foreground_turns
                .observe_outbound(generation, &response);
            if let Err(error) = write_acp_line(state.as_ref(), &response, generation).await {
                let _ = app.emit("acp-stderr", format!("自动取消无效交互请求失败：{error}"));
            }
        }
        InteractionInbound::Duplicate => {
            let _ = app.emit(
                "acp-stderr",
                "Agent 在同一进程代次复用了仍待回复的交互 rpc id；已拒绝覆盖原门控",
            );
        }
    }
    false
}

/// Agent 进程退出后的清算：标记离线、重置注册表、通知前端并调度自动重连。
async fn finalize_agent_exit(
    app: &tauri::AppHandle,
    state: &Arc<AcpState>,
    leases: &Arc<McpLeaseStore>,
    generation: u64,
) {
    let process = {
        let mut guard = state.process.lock().await;
        if guard
            .as_ref()
            .is_some_and(|process| process.generation == generation)
        {
            guard.take()
        } else {
            None
        }
    };
    let Some(mut process) = process else {
        return;
    };
    let occupancy = state.sessions.snapshot();
    let mut affected_session_ids = state.client_callbacks.bound_session_ids();
    affected_session_ids.extend(occupancy.active_turn_session_ids.iter().cloned());
    affected_session_ids.sort();
    affected_session_ids.dedup();
    let interrupted_session_ids = occupancy.active_turn_session_ids;
    state.mark_generation_unready(generation, RuntimePhase::Offline);
    shutdown_all_mcp_resources(leases);
    let next_generation = state
        .next_generation
        .compare_exchange(
            generation,
            generation + 1,
            Ordering::Relaxed,
            Ordering::Relaxed,
        )
        .map(|_| generation + 1)
        .unwrap_or_else(|current| current);
    state.foreground_turns.reset(next_generation);
    state.interactions.reset(next_generation);
    state.client_callbacks.reset(next_generation).await;
    state.sessions.reset(next_generation);
    drop(process.stdin);
    let code = process
        .child
        .wait()
        .await
        .ok()
        .and_then(|status| status.code());
    let exit_message = match code {
        Some(code) => format!("Grok Agent 已退出（代码 {code}）"),
        None => "Grok Agent 已退出".to_string(),
    };
    tracing::warn!(
        target: "grox::runtime",
        generation,
        exit_code = ?code,
        affected_sessions = affected_session_ids.len(),
        interrupted_sessions = interrupted_session_ids.len(),
        "Agent process exited"
    );
    state
        .requests
        .reject_generation(
            generation,
            AcpHostError::environment(
                "ACP_PROCESS_EXITED",
                exit_message,
                true,
                true,
                "Agent 重连后检查最后一轮结果，再决定是否重新发送",
            ),
        )
        .await;
    let _ = app.emit(
        "acp-exit",
        AcpExitPayload {
            code,
            reason: "exited",
            affected_session_ids: affected_session_ids.clone(),
            interrupted_session_ids: interrupted_session_ids.clone(),
        },
    );
    schedule_automatic_runtime_reconnect(
        app.clone(),
        Arc::clone(state),
        Arc::clone(leases),
        affected_session_ids,
        interrupted_session_ids,
    );
}

#[derive(Default)]
pub(crate) struct AppShutdown {
    pub(crate) started: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpExitPayload {
    pub(crate) code: Option<i32>,
    pub(crate) reason: &'static str,
    pub(crate) affected_session_ids: Vec<String>,
    pub(crate) interrupted_session_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeReconnectPayload {
    pub(crate) state: &'static str,
    pub(crate) attempt: u8,
    pub(crate) affected_session_ids: Vec<String>,
    pub(crate) interrupted_session_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) connection: Option<AgentRuntimeConnection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<AcpHostError>,
}
