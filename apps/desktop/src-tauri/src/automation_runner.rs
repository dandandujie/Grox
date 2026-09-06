//! 进程级自动化调度器。
//!
//! Host 负责时钟、持久化认领、会话创建、运行时注册、回合与结算。
//! WebView 只观察 started/settled 投影；页面重载或窗口隐藏不会中断执行链。

use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn automation_claim_error(message: String) -> AcpHostError {
    if message.contains("token 无效")
        || message.contains("无效会话 ID")
        || message.contains("错误详情不能超过")
    {
        AcpHostError::protocol("AUTOMATION_INVALID_RESULT", message)
    } else if message.contains("认领")
        || message.contains("正在执行")
        || message.contains("不存在")
        || message.contains("id 无效")
    {
        AcpHostError::operation("AUTOMATION_CLAIM_STALE", message)
    } else {
        storage_error(message)
    }
}

use crate::{
    acp_host::AcpHostError,
    automation_store::{AutomationCompletion, AutomationDispatch, AutomationStore},
    host_core::automations_path,
    runtime_lifecycle::ensure_agent_runtime_ready,
    foreground_turn::SessionProjectionTurn,
    host_prefs,
    host_core::host_prefs_dir_for_app,
    mcp_leases::McpLeaseStore,
    host_core::request_acp_json,
    session_runtime::{open_agent_session_inner, OpenAgentSessionRequest},
    turn_runtime::{
        bind_mode, bind_model, complete_deep_research_prompt, effort_fallback_chain,
        is_invalid_reasoning_effort, prompt_result_invalid_effort,
    },
    host_core::AcpState,
    host_core::RuntimePhase,
    host_core::AUTOMATIONS_MAX_BYTES,
    host_core::UPSTREAM_CLI_CLIENT_NAME,
};

const BOOT_DELAY_MS: u64 = 2_000;
const TICK_INTERVAL_MS: u64 = 30_000;
const CLAIM_RENEW_INTERVAL_MS: u64 = 30_000;

#[derive(Default)]
pub(crate) struct AutomationRunner {
    started: AtomicBool,
    dispatching: AtomicBool,
    last_tick_at: AtomicU64,
    active: Mutex<Option<AutomationRunnerActive>>,
}

#[derive(Clone)]
struct AutomationRunnerActive {
    automation_id: String,
    started: Option<AutomationSessionStarted>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRunnerStatus {
    pub(crate) checked_at: Option<u64>,
    pub(crate) runtime_ready: bool,
    pub(crate) runtime_busy: bool,
    pub(crate) active_automation_id: Option<String>,
    pub(crate) active_session: Option<AutomationSessionStarted>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationSessionSettled {
    pub(crate) automation_id: String,
    pub(crate) source: crate::automation_store::AutomationDispatchSource,
    pub(crate) claimed_at: u64,
    pub(crate) session_id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) mode: Option<String>,
    pub(crate) requested_effort: Option<String>,
    pub(crate) effective_effort: Option<String>,
    pub(crate) usage: Option<Value>,
    pub(crate) automation: Option<Value>,
    pub(crate) error: Option<AcpHostError>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationSessionStarted {
    pub(crate) automation_id: String,
    pub(crate) source: crate::automation_store::AutomationDispatchSource,
    pub(crate) claimed_at: u64,
    pub(crate) session_id: String,
    pub(crate) automation: Value,
    pub(crate) warnings: Vec<AcpHostError>,
}

struct AutomationTurnResult {
    effective_effort: String,
    usage: Option<Value>,
}

struct DispatchReservation {
    app: AppHandle,
    automation_id: String,
}

impl Drop for DispatchReservation {
    fn drop(&mut self) {
        let runner = self.app.state::<AutomationRunner>();
        runner.clear_active(&self.automation_id);
        runner.release_dispatch();
    }
}

#[derive(Debug)]
struct ClaimedAutomationConfig {
    id: String,
    title: String,
    prompt: String,
    cwd: String,
    model: String,
    mode: String,
    requested_effort: String,
    permission_mode: String,
}

impl AutomationRunner {
    pub(crate) fn start(&self, app: AppHandle) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(BOOT_DELAY_MS)).await;
            loop {
                if let Err(error) = tick(&app).await {
                    tracing::error!(
                        target: "grox::automation",
                        domain = %error.domain,
                        code = %error.code,
                        "automation scheduler tick failed"
                    );
                    let _ = app.emit("automation-runner-error", error);
                }
                tokio::time::sleep(std::time::Duration::from_millis(TICK_INTERVAL_MS)).await;
            }
        });
    }

    pub(crate) async fn status(&self, state: &AcpState) -> AutomationRunnerStatus {
        let occupancy = state.sessions.snapshot();
        let phase = RuntimePhase::from_raw(state.runtime_phase.load(Ordering::Acquire));
        let active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        AutomationRunnerStatus {
            checked_at: match self.last_tick_at.load(Ordering::Acquire) {
                0 => None,
                value => Some(value),
            },
            runtime_ready: self.runtime_ready(state).await,
            runtime_busy: !occupancy.active_turn_session_ids.is_empty()
                || occupancy.lifecycle_active
                || occupancy.pending_lifecycle > 0
                || self.dispatching.load(Ordering::Acquire)
                || runtime_phase_blocks_dispatch(phase),
            active_automation_id: active.as_ref().map(|active| active.automation_id.clone()),
            active_session: active.and_then(|active| active.started),
        }
    }

    pub(crate) async fn reserve_dispatch(&self, state: &AcpState) -> Result<(), AcpHostError> {
        let occupancy = state.sessions.snapshot();
        if !occupancy.active_turn_session_ids.is_empty()
            || occupancy.lifecycle_active
            || occupancy.pending_lifecycle > 0
            || runtime_phase_blocks_dispatch(RuntimePhase::from_raw(
                state.runtime_phase.load(Ordering::Acquire),
            ))
        {
            return Err(AcpHostError::operation(
                "AUTOMATION_RUNTIME_BUSY",
                "已有会话、门禁或恢复流程占用 Agent 运行时",
            ));
        }
        if self
            .dispatching
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(AcpHostError::operation(
                "AUTOMATION_RUNTIME_BUSY",
                "已有自动化正在准备或使用 Agent 运行时",
            ));
        }
        Ok(())
    }

    pub(crate) fn release_dispatch(&self) {
        self.dispatching.store(false, Ordering::Release);
    }

    pub(crate) fn is_dispatching(&self) -> bool {
        self.dispatching.load(Ordering::Acquire)
    }

    pub(crate) async fn ready_generation(&self, state: &AcpState) -> Result<u64, AcpHostError> {
        let ready_generation = state.ready_generation.load(Ordering::Acquire);
        if ready_generation != 0
            && state
                .process
                .lock()
                .await
                .as_ref()
                .is_some_and(|process| process.generation == ready_generation)
        {
            return Ok(ready_generation);
        }
        Err(AcpHostError::environment(
            "AUTOMATION_RUNTIME_NOT_READY",
            "Grok Build 运行时尚未连接，无法启动自动化任务",
            false,
            false,
            "等待运行时连接完成后重试",
        ))
    }

    pub(crate) fn launch_reserved(&self, app: AppHandle, dispatch: AutomationDispatch) {
        let automation_id = dispatch
            .automation
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        *self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(AutomationRunnerActive {
            automation_id: automation_id.clone(),
            started: None,
        });
        tauri::async_runtime::spawn(async move {
            let reservation = DispatchReservation {
                app: app.clone(),
                automation_id,
            };
            let settled = execute_claimed_automation(&app, dispatch).await;
            drop(reservation);
            match settled.error.as_ref() {
                Some(error) => tracing::warn!(
                    target: "grox::automation",
                    automation_id = %settled.automation_id,
                    session_id = ?settled.session_id,
                    domain = %error.domain,
                    code = %error.code,
                    "automation execution failed"
                ),
                None => tracing::info!(
                    target: "grox::automation",
                    automation_id = %settled.automation_id,
                    session_id = ?settled.session_id,
                    "automation execution settled"
                ),
            }
            if let Err(error) = app.emit("automation-session-settled", settled.clone()) {
                tracing::error!(target: "grox::automation", error = %error, "automation settlement projection failed");
            }
            if let Some(error) = settled.error {
                let _ = app.emit("automation-runner-error", error);
            }
        });
    }

    fn set_active_session(&self, started: AutomationSessionStarted) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active
            .as_ref()
            .is_some_and(|active| active.automation_id == started.automation_id)
        {
            *active = Some(AutomationRunnerActive {
                automation_id: started.automation_id.clone(),
                started: Some(started),
            });
        }
    }

    fn clear_active(&self, automation_id: &str) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active
            .as_ref()
            .is_some_and(|active| active.automation_id == automation_id)
        {
            *active = None;
        }
    }

    async fn runtime_ready(&self, state: &AcpState) -> bool {
        self.ready_generation(state).await.is_ok()
    }
}

async fn execute_claimed_automation(
    app: &AppHandle,
    dispatch: AutomationDispatch,
) -> AutomationSessionSettled {
    let automation_id = dispatch
        .automation
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut settled = AutomationSessionSettled {
        automation_id: automation_id.clone(),
        source: dispatch.source.clone(),
        claimed_at: dispatch.claimed_at,
        session_id: None,
        model: None,
        mode: None,
        requested_effort: None,
        effective_effort: None,
        usage: None,
        automation: None,
        error: None,
    };
    let path = match automations_path(app).map_err(storage_error) {
        Ok(path) => path,
        Err(error) => {
            settled.error = Some(error);
            return settled;
        }
    };
    let store = app.state::<AutomationStore>();
    let claimed = match store.begin_execution(
        &path,
        &automation_id,
        &dispatch.token,
        unix_time_ms(),
        AUTOMATIONS_MAX_BYTES,
    ) {
        Ok(claimed) => claimed,
        Err(error) => {
            settled.error = Some(automation_claim_error(error));
            return settled;
        }
    };
    debug_assert!(claimed.lease_expires_at > unix_time_ms());
    let config = match claimed_automation_config(&claimed.automation) {
        Ok(config) => config,
        Err(error) => {
            return complete_execution(&store, &path, &dispatch, settled, None, Some(error));
        }
    };
    settled.model = Some(config.model.clone());
    settled.mode = Some(config.mode.clone());
    settled.requested_effort = Some(config.requested_effort.clone());
    settled.effective_effort = Some(config.requested_effort.clone());

    let state = app.state::<std::sync::Arc<AcpState>>();
    let leases = app.state::<std::sync::Arc<McpLeaseStore>>();
    let runner = app.state::<AutomationRunner>();
    let connection = match ensure_agent_runtime_ready(
        app,
        state.inner(),
        leases.inner(),
        config.cwd.clone(),
        Some(config.requested_effort.clone()),
        false,
    )
    .await
    {
        Ok(connection) => connection,
        Err(error) => {
            return complete_execution(&store, &path, &dispatch, settled, None, Some(error));
        }
    };
    if connection.auth.required {
        return complete_execution(
            &store,
            &path,
            &dispatch,
            settled,
            None,
            Some(AcpHostError::environment(
                "ACP_AUTH_REQUIRED",
                "Grok Build 需要用户完成登录，后台自动化不会擅自打开认证页面",
                false,
                true,
                "打开 Grox，完成 Grok 登录后重新运行该任务",
            )),
        );
    }
    if let Some(error) = connection.auth.error {
        return complete_execution(
            &store,
            &path,
            &dispatch,
            settled,
            None,
            Some(AcpHostError::environment(
                "ACP_AUTH_FAILED",
                format!("Grok Build 非交互认证失败：{error}"),
                false,
                true,
                "检查当前 Provider 凭据或在 Grox 中重新登录",
            )),
        );
    }
    let generation = connection.generation;
    let prefs = match host_prefs::load_prefs(&host_prefs_dir_for_app(app)) {
        Ok(prefs) => prefs,
        Err(error) => {
            return complete_execution(
                &store,
                &path,
                &dispatch,
                settled,
                None,
                Some(AcpHostError::environment(
                    "HOST_PREFS_READ_FAILED",
                    error,
                    false,
                    true,
                    "修复或移除损坏的 Host 偏好文件后重试",
                )),
            );
        }
    };
    let opened = match open_agent_session_inner(
        app,
        state.inner(),
        leases.inner(),
        OpenAgentSessionRequest {
            cwd: config.cwd.clone(),
            generation,
            session_id: None,
            preferred_model: Some(config.model.clone()),
            reasoning_effort: Some(config.requested_effort.clone()),
            permission_mode: config.permission_mode.clone(),
            computer_use_enabled: prefs.computer_use_enabled,
            browser_use_enabled: prefs.browser_use_enabled,
        },
    )
    .await
    {
        Ok(opened) => opened,
        Err(error) => {
            return complete_execution(&store, &path, &dispatch, settled, None, Some(error));
        }
    };
    let session_id = match opened
        .response
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        Some(session_id) => session_id.to_string(),
        None => {
            return complete_execution(
                &store,
                &path,
                &dispatch,
                settled,
                None,
                Some(AcpHostError::protocol(
                    "ACP_INVALID_RESPONSE",
                    "session/new 未返回 sessionId",
                )),
            );
        }
    };
    settled.session_id = Some(session_id.clone());
    if let Err(error) = store.bind_claim_session(
        &path,
        &config.id,
        &dispatch.token,
        &session_id,
        unix_time_ms(),
        AUTOMATIONS_MAX_BYTES,
    ) {
        return complete_execution(
            &store,
            &path,
            &dispatch,
            settled,
            Some(&session_id),
            Some(automation_claim_error(error)),
        );
    }
    let started = AutomationSessionStarted {
        automation_id: config.id.clone(),
        source: dispatch.source.clone(),
        claimed_at: dispatch.claimed_at,
        session_id: session_id.clone(),
        automation: claimed.automation.clone(),
        warnings: opened.warnings,
    };
    runner.set_active_session(started.clone());
    if let Err(error) = app.emit("automation-session-started", started) {
        tracing::error!(
            target: "grox::automation",
            automation_id = %config.id,
            session_id = %session_id,
            error = %error,
            "automation start projection failed"
        );
    }
    let rename_state = std::sync::Arc::clone(state.inner());
    let rename_leases = std::sync::Arc::clone(leases.inner());
    let rename_session_id = session_id.clone();
    let log_session_id = session_id.clone();
    let log_automation_id = config.id.clone();
    let rename_title = config.title.clone();
    let rename_cwd = config.cwd.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = request_acp_json(
            rename_state.as_ref(),
            rename_leases.as_ref(),
            "x.ai/session/rename",
            json!({
                "sessionId": rename_session_id,
                "title": rename_title,
                "cwd": rename_cwd,
                "kind": "build",
            }),
            generation,
            30_000,
            None,
        )
        .await
        {
            tracing::warn!(
                target: "grox::automation",
                automation_id = %log_automation_id,
                session_id = %log_session_id,
                code = %error.code,
                "automation session title sync failed"
            );
        }
    });

    let turn = run_claimed_turn(
        app,
        state.inner(),
        leases.inner(),
        runner.inner(),
        store.inner(),
        &path,
        &config.id,
        &dispatch.token,
        &session_id,
        &config.model,
        &config.mode,
        &config.requested_effort,
        &opened.effective_permission_mode,
        &config.prompt,
    )
    .await;
    let execution_error = match turn {
        Ok(turn) => {
            settled.effective_effort = Some(turn.effective_effort);
            settled.usage = turn.usage;
            None
        }
        Err(error) => Some(error),
    };
    complete_execution(
        &store,
        &path,
        &dispatch,
        settled,
        Some(&session_id),
        execution_error,
    )
}

fn complete_execution(
    store: &AutomationStore,
    path: &Path,
    dispatch: &AutomationDispatch,
    mut settled: AutomationSessionSettled,
    session_id: Option<&str>,
    execution_error: Option<AcpHostError>,
) -> AutomationSessionSettled {
    let error_detail = execution_error
        .as_ref()
        .map(|error| error.message.chars().take(3_500).collect::<String>());
    match store.complete_claim(
        path,
        &settled.automation_id,
        &dispatch.token,
        AutomationCompletion {
            session_id,
            error: error_detail.as_deref(),
            completed_at: unix_time_ms(),
        },
        AUTOMATIONS_MAX_BYTES,
    ) {
        Ok(updated) => {
            settled.automation = Some(updated);
            settled.error = execution_error;
        }
        Err(error) => {
            let mut settlement_error = automation_claim_error(error);
            if let Some(execution_error) = execution_error {
                settlement_error.message = format!(
                    "{}；自动化结算也失败：{}",
                    execution_error.message, settlement_error.message
                );
            }
            settled.error = Some(settlement_error);
        }
    }
    settled
}

fn claimed_automation_config(automation: &Value) -> Result<ClaimedAutomationConfig, AcpHostError> {
    Ok(ClaimedAutomationConfig {
        id: automation_string(automation, "id")?,
        title: automation_string(automation, "title")?,
        prompt: automation_string(automation, "prompt")?,
        cwd: automation_string(automation, "cwd")?,
        model: automation_string(automation, "model")?,
        mode: automation_string(automation, "mode")?,
        requested_effort: automation_string(automation, "effort")?,
        permission_mode: automation_string(automation, "permissionMode")?,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_claimed_turn(
    app: &AppHandle,
    state: &AcpState,
    leases: &McpLeaseStore,
    runner: &AutomationRunner,
    store: &AutomationStore,
    path: &Path,
    id: &str,
    token: &str,
    session_id: &str,
    model: &str,
    mode: &str,
    requested_effort: &str,
    permission_mode: &str,
    prompt: &str,
) -> Result<AutomationTurnResult, AcpHostError> {
    let generation = runner.ready_generation(state).await?;
    let permit = state
        .sessions
        .acquire_turn(session_id.to_string(), generation)
        .await?;
    let _projection_turn =
        SessionProjectionTurn::begin(app, &state.session_events, session_id, generation);
    let gate_token = permit.token();

    renew_execution_claim(store, path, id, token)?;
    let mut effective_effort = bind_model(
        state,
        leases,
        session_id,
        model,
        requested_effort,
        generation,
        gate_token,
        None,
    )
    .await?;
    renew_execution_claim(store, path, id, token)?;
    bind_mode(
        state, leases, session_id, mode, generation, gate_token, None,
    )
    .await?;

    let dispatch_prompt = complete_deep_research_prompt(prompt);
    let mut attempted = std::collections::BTreeSet::new();
    attempted.insert(effective_effort.clone());
    let mut response = prompt_with_claim_renewal(
        state,
        leases,
        store,
        path,
        id,
        token,
        session_id,
        &dispatch_prompt,
        &effective_effort,
        permission_mode,
        generation,
        gate_token,
    )
    .await;

    if response
        .as_ref()
        .err()
        .is_some_and(is_invalid_reasoning_effort)
        || response
            .as_ref()
            .ok()
            .and_then(prompt_result_invalid_effort)
            .is_some()
    {
        response = Err(response.err().unwrap_or_else(|| {
            AcpHostError::protocol(
                "ACP_INVALID_REASONING_EFFORT",
                "当前模型或 API 拒绝了推理强度",
            )
        }));
        for candidate in effort_fallback_chain(requested_effort) {
            let bound = bind_model(
                state, leases, session_id, model, candidate, generation, gate_token, None,
            )
            .await?;
            if !attempted.insert(bound.clone()) {
                continue;
            }
            effective_effort = bound;
            match prompt_with_claim_renewal(
                state,
                leases,
                store,
                path,
                id,
                token,
                session_id,
                &dispatch_prompt,
                &effective_effort,
                permission_mode,
                generation,
                gate_token,
            )
            .await
            {
                Ok(value) if prompt_result_invalid_effort(&value).is_none() => {
                    response = Ok(value);
                    break;
                }
                Ok(value) => {
                    response = Err(AcpHostError::protocol(
                        "ACP_INVALID_REASONING_EFFORT",
                        prompt_result_invalid_effort(&value)
                            .unwrap_or_else(|| "当前模型或 API 拒绝了推理强度".into()),
                    ));
                }
                Err(error) if is_invalid_reasoning_effort(&error) => {
                    response = Err(error);
                }
                Err(error) => return Err(error),
            }
        }
    }

    let response = response?;
    let usage = response
        .get("_meta")
        .and_then(|meta| meta.get("usage"))
        .cloned();
    Ok(AutomationTurnResult {
        effective_effort,
        usage,
    })
}

#[allow(clippy::too_many_arguments)]
async fn prompt_with_claim_renewal(
    state: &AcpState,
    leases: &McpLeaseStore,
    store: &AutomationStore,
    path: &Path,
    id: &str,
    token: &str,
    session_id: &str,
    prompt: &str,
    effort: &str,
    permission_mode: &str,
    generation: u64,
    gate_token: u64,
) -> Result<Value, AcpHostError> {
    renew_execution_claim(store, path, id, token)?;
    let request = request_acp_json(
        state,
        leases,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt }],
            "_meta": {
                "reasoningEffort": effort,
                "clientIdentifier": UPSTREAM_CLI_CLIENT_NAME,
                "yoloMode": permission_mode == "bypass",
                "autoMode": permission_mode == "auto",
            },
        }),
        generation,
        0,
        Some(gate_token),
    );
    tokio::pin!(request);
    let mut renewal_error = None;
    loop {
        match tokio::time::timeout(Duration::from_millis(CLAIM_RENEW_INTERVAL_MS), &mut request)
            .await
        {
            Ok(result) => {
                if renewal_error.is_some() {
                    // Prompt 已经有权威结果时再做一次同步续租；若文件系统只是瞬时
                    // 抖动，最终结算不应被误记为 Agent 回合失败。
                    renew_execution_claim(store, path, id, token)?;
                }
                return result;
            }
            Err(_) => {
                match store.renew_claim(path, id, token, unix_time_ms(), AUTOMATIONS_MAX_BYTES) {
                    Ok(_) => renewal_error = None,
                    Err(error) => renewal_error = Some(error),
                }
            }
        }
    }
}

fn renew_execution_claim(
    store: &AutomationStore,
    path: &Path,
    id: &str,
    token: &str,
) -> Result<u64, AcpHostError> {
    store
        .renew_claim(path, id, token, unix_time_ms(), AUTOMATIONS_MAX_BYTES)
        .map_err(automation_claim_error)
}

fn automation_string(automation: &Value, key: &str) -> Result<String, AcpHostError> {
    automation
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AcpHostError::protocol(
                "AUTOMATION_INVALID_RESULT",
                format!("Host 认领的自动化缺少 {key}"),
            )
        })
}

async fn tick(app: &AppHandle) -> Result<(), AcpHostError> {
    let runner = app.state::<AutomationRunner>();
    let state = app.state::<std::sync::Arc<AcpState>>();
    let checked_at = unix_time_ms();
    runner.last_tick_at.store(checked_at, Ordering::Release);
    let status = runner.status(state.inner()).await;
    let _ = app.emit("automation-runner-tick", status.clone());
    if status.runtime_busy {
        return Ok(());
    }
    if runner.reserve_dispatch(state.inner()).await.is_err() {
        return Ok(());
    }

    let path = match automations_path(app).map_err(storage_error) {
        Ok(path) => path,
        Err(error) => {
            runner.release_dispatch();
            return Err(error);
        }
    };
    let store = app.state::<AutomationStore>();
    let dispatch = match store
        .claim_due(&path, checked_at, AUTOMATIONS_MAX_BYTES)
        .map_err(storage_error)
    {
        Ok(dispatch) => dispatch,
        Err(error) => {
            runner.release_dispatch();
            return Err(error);
        }
    };
    if let Some(dispatch) = dispatch {
        runner.launch_reserved(app.clone(), dispatch);
    } else {
        runner.release_dispatch();
    }
    Ok(())
}

fn runtime_phase_blocks_dispatch(phase: RuntimePhase) -> bool {
    matches!(
        phase,
        RuntimePhase::Starting
            | RuntimePhase::Initializing
            | RuntimePhase::Authenticating
            | RuntimePhase::Paused
    )
}

pub(crate) fn should_keep_process_alive_on_close(
    any_enabled_automation: bool,
    host_busy: bool,
) -> bool {
    any_enabled_automation || host_busy
}

pub(crate) fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

pub(crate) fn storage_error(message: String) -> AcpHostError {
    AcpHostError::environment(
        "AUTOMATION_STORAGE_FAILED",
        message,
        false,
        false,
        "检查应用数据目录的权限和磁盘空间后重试",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn automation() -> Value {
        json!({
            "id": "auto-1",
            "title": "Nightly review",
            "prompt": "review the repository",
            "cwd": "/tmp/repo",
            "model": "grok-build",
            "effort": "high",
            "mode": "agent",
            "permissionMode": "auto",
        })
    }

    #[test]
    fn claimed_config_contains_every_host_execution_input() {
        let config = claimed_automation_config(&automation()).unwrap();
        assert_eq!(config.id, "auto-1");
        assert_eq!(config.title, "Nightly review");
        assert_eq!(config.cwd, "/tmp/repo");
        assert_eq!(config.requested_effort, "high");
        assert_eq!(config.permission_mode, "auto");
    }

    #[test]
    fn claimed_config_rejects_missing_host_inputs() {
        let mut value = automation();
        value.as_object_mut().unwrap().remove("cwd");
        let error = claimed_automation_config(&value).unwrap_err();
        assert_eq!(error.code, "AUTOMATION_INVALID_RESULT");
        assert!(error.message.contains("cwd"));
    }

    #[test]
    fn offline_runtime_can_be_claimed_but_transitions_cannot() {
        assert!(!runtime_phase_blocks_dispatch(RuntimePhase::Stopped));
        assert!(!runtime_phase_blocks_dispatch(RuntimePhase::Offline));
        assert!(!runtime_phase_blocks_dispatch(RuntimePhase::Ready));
        assert!(runtime_phase_blocks_dispatch(RuntimePhase::Starting));
        assert!(runtime_phase_blocks_dispatch(RuntimePhase::Initializing));
        assert!(runtime_phase_blocks_dispatch(RuntimePhase::Authenticating));
        assert!(runtime_phase_blocks_dispatch(RuntimePhase::Paused));

        tauri::async_runtime::block_on(async {
            let state = AcpState::default();
            let runner = AutomationRunner::default();
            assert!(!runner.status(&state).await.runtime_ready);
            runner.reserve_dispatch(&state).await.unwrap();
            assert_eq!(
                runner.reserve_dispatch(&state).await.unwrap_err().code,
                "AUTOMATION_RUNTIME_BUSY"
            );
            runner.release_dispatch();
            runner.reserve_dispatch(&state).await.unwrap();
            runner.release_dispatch();
        });
    }

    #[test]
    fn close_keeps_host_alive_only_for_background_responsibilities() {
        assert!(!should_keep_process_alive_on_close(false, false));
        assert!(should_keep_process_alive_on_close(true, false));
        assert!(should_keep_process_alive_on_close(false, true));
        assert!(should_keep_process_alive_on_close(true, true));
    }

    #[test]
    fn runner_status_restores_the_active_automation_projection() {
        tauri::async_runtime::block_on(async {
            let runner = AutomationRunner::default();
            let state = AcpState::default();
            *runner
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(AutomationRunnerActive {
                automation_id: "auto-1".into(),
                started: None,
            });
            let preparing = runner.status(&state).await;
            assert_eq!(preparing.active_automation_id.as_deref(), Some("auto-1"));
            assert!(preparing.active_session.is_none());

            runner.set_active_session(AutomationSessionStarted {
                automation_id: "auto-1".into(),
                source: crate::automation_store::AutomationDispatchSource::Scheduled,
                claimed_at: 42,
                session_id: "session-1".into(),
                automation: automation(),
                warnings: Vec::new(),
            });
            let running = runner.status(&state).await;
            assert_eq!(
                running
                    .active_session
                    .as_ref()
                    .map(|started| started.session_id.as_str()),
                Some("session-1")
            );

            runner.clear_active("auto-1");
            assert!(runner.status(&state).await.active_automation_id.is_none());
        });
    }
}
