//! 普通前台回合的 Host 事务。
//!
//! WebView 可以投影流内容，但不能拥有请求号、取消目标、回合许可或 watchdog。
//! 这些状态需要跨异步边界保持一致，并在页面异常、进程退出和协议降级时一起清算。

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, WebviewWindow};

use crate::{
    acp_inbound::AcpInbound,
    acp_host::AcpHostError,
    host_core::ensure_main_acp_owner,
    host_prefs,
    mcp_leases::McpLeaseStore,
    host_core::prepare_acp_line,
    prompt_queue_store::{
        PromptQueueClaim, PromptQueueClaimError, PromptQueueSettlement, PromptQueueStore,
    },
    host_core::request_acp_json_tracked,
    turn_runtime::{
        bind_mode, bind_model, effort_fallback_chain, invalid_reasoning_effort_message,
        is_invalid_reasoning_effort, normalize_effort, normalize_mode,
        prompt_result_invalid_effort, AcpRequestTracker,
    },
    host_core::write_acp_line,
    host_core::AcpState,
    host_core::PROMPT_QUEUES_MAX_BYTES,
    host_core::UPSTREAM_CLI_CLIENT_NAME,
};

const WATCHDOG_POLL_MS: u64 = 15_000;
const SOFT_STALL_MS: u64 = 5 * 60_000;
const DEFAULT_ABSOLUTE_HOURS: u64 = 4;
const PRE_CANCEL_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForegroundTurnRequest {
    session_id: String,
    turn_id: String,
    generation: u64,
    prompt: Value,
    model: String,
    effort: String,
    mode: String,
    queue_item_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForegroundTurnResult {
    response: Value,
    requested_effort: String,
    effective_effort: String,
    assistant_text: Option<String>,
}

fn disk_assistant_messages(session_id: &str) -> Vec<String> {
    crate::preview_session_from_disk(session_id.to_string())
        .ok()
        .flatten()
        .map(|preview| {
            preview
                .entries
                .into_iter()
                .filter_map(|entry| match entry {
                    crate::SessionPreviewEntry::Message { role, text } if role == "assistant" => {
                        Some(text)
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn new_disk_assistant_text(session_id: &str, previous_count: usize) -> Option<String> {
    for delay_ms in [0, 50, 150, 300] {
        if delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        let messages = disk_assistant_messages(session_id);
        if messages.len() > previous_count {
            return messages.last().cloned();
        }
    }
    None
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForegroundTurnSnapshot {
    session_id: String,
    turn_id: String,
    generation: u64,
    phase: &'static str,
    current_method: Option<String>,
    started_at: u64,
    last_activity_at: u64,
    open_tools: usize,
    open_gates: usize,
    cancelled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForegroundTurnStalled {
    session_id: String,
    silent_for_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptQueueChanged {
    session_id: String,
    item_id: String,
    queue: Vec<Value>,
    reason: &'static str,
}

struct PreparedForegroundTurn {
    prompt: Value,
    model: String,
    requested_effort: String,
    mode: &'static str,
    permission_mode: Option<String>,
}

/// 将 UI 可见的流式块边界绑定到同一个 Host turn lease。任何 `?`、取消或
/// watchdog 退出都会经过 Drop，下一轮不会继续复用上一轮的 assistant/thinking。
pub(crate) struct SessionProjectionTurn<'a> {
    app: &'a tauri::AppHandle,
    journal: &'a crate::session_event_journal::SessionEventJournal,
    session_id: &'a str,
    generation: u64,
}

impl<'a> SessionProjectionTurn<'a> {
    pub(crate) fn begin(
        app: &'a tauri::AppHandle,
        journal: &'a crate::session_event_journal::SessionEventJournal,
        session_id: &'a str,
        generation: u64,
    ) -> Self {
        crate::host_core::emit_host_session_event(app, journal.begin_turn(generation, session_id));
        Self {
            app,
            journal,
            session_id,
            generation,
        }
    }
}

impl Drop for SessionProjectionTurn<'_> {
    fn drop(&mut self) {
        crate::host_core::emit_host_session_event(
            self.app,
            self.journal.finish_turn(self.generation, self.session_id),
        );
    }
}

struct ActiveTurn {
    token: u64,
    turn_id: String,
    generation: u64,
    phase: &'static str,
    current_request_id: Option<u64>,
    current_method: Option<String>,
    started_at: Instant,
    started_at_ms: u64,
    last_activity_at: Instant,
    last_activity_at_ms: u64,
    open_tools: BTreeSet<String>,
    open_gates: BTreeSet<String>,
    stall_notified: bool,
    cancelled: bool,
}

#[derive(Default)]
struct RegistryState {
    generation: u64,
    active: BTreeMap<String, ActiveTurn>,
    pending_cancels: BTreeMap<String, (u64, String, Instant)>,
}

#[derive(Default)]
pub(crate) struct ForegroundTurnRegistry {
    state: Mutex<RegistryState>,
    next_token: AtomicU64,
}

pub(crate) struct ForegroundTurnLease {
    registry: Arc<ForegroundTurnRegistry>,
    session_id: String,
    turn_id: String,
    generation: u64,
    token: u64,
}

#[derive(Clone)]
pub(crate) struct InvalidEffortAbort {
    pub(crate) request_id: u64,
    pub(crate) generation: u64,
    pub(crate) message: String,
}

struct CancelTarget {
    request_id: Option<u64>,
    active: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WatchdogDecision {
    Ok,
    SoftStall(u64),
    Absolute(u64),
}

impl ForegroundTurnRegistry {
    pub(crate) fn reset(&self, generation: u64) {
        let mut state = self.lock();
        state.generation = generation;
        state.active.clear();
        state.pending_cancels.clear();
    }

    pub(crate) fn begin(
        self: &Arc<Self>,
        session_id: String,
        turn_id: String,
        generation: u64,
    ) -> Result<ForegroundTurnLease, AcpHostError> {
        let now = Instant::now();
        let mut state = self.lock();
        if state.generation != generation {
            return Err(channel_replaced());
        }
        state
            .pending_cancels
            .retain(|_, (_, _, created)| now.duration_since(*created) <= PRE_CANCEL_TTL);
        if state.pending_cancels.get(&session_id).is_some_and(
            |(cancel_generation, cancel_turn_id, _)| {
                *cancel_generation == generation && cancel_turn_id == &turn_id
            },
        ) {
            state.pending_cancels.remove(&session_id);
            return Err(AcpHostError::operation(
                "SESSION_PROMPT_CANCELLED",
                "当前回合已在发送前停止",
            ));
        }
        if state.active.contains_key(&session_id) {
            return Err(AcpHostError::operation(
                "SESSION_TURN_ALREADY_ACTIVE",
                format!("会话已有活动前台回合：{session_id}"),
            ));
        }
        let token = self.next_token.fetch_add(1, Ordering::Relaxed) + 1;
        let now_ms = unix_time_ms();
        state.active.insert(
            session_id.clone(),
            ActiveTurn {
                token,
                turn_id: turn_id.clone(),
                generation,
                phase: "preparing",
                current_request_id: None,
                current_method: None,
                started_at: now,
                started_at_ms: now_ms,
                last_activity_at: now,
                last_activity_at_ms: now_ms,
                open_tools: BTreeSet::new(),
                open_gates: BTreeSet::new(),
                stall_notified: false,
                cancelled: false,
            },
        );
        Ok(ForegroundTurnLease {
            registry: Arc::clone(self),
            session_id,
            turn_id,
            generation,
            token,
        })
    }

    fn cancel(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
        generation: u64,
    ) -> Result<CancelTarget, AcpHostError> {
        let mut state = self.lock();
        if state.generation != generation {
            return Err(channel_replaced());
        }
        if let Some(turn) = state.active.get_mut(session_id) {
            if turn.generation != generation {
                return Err(channel_replaced());
            }
            if turn_id.is_some_and(|turn_id| turn_id != turn.turn_id) {
                return Ok(CancelTarget {
                    request_id: None,
                    active: false,
                });
            }
            turn.cancelled = true;
            turn.phase = "cancelling";
            return Ok(CancelTarget {
                request_id: turn.current_request_id,
                active: true,
            });
        }
        // execute_foreground_turn 与 stop 是两个 IPC；stop 可能在前者取得
        // turn permit 前先到达。短期墓碑保证这种竞态不会反向启动新回合。
        if let Some(turn_id) = turn_id {
            state.pending_cancels.insert(
                session_id.to_string(),
                (generation, turn_id.to_string(), Instant::now()),
            );
        }
        Ok(CancelTarget {
            request_id: None,
            active: false,
        })
    }

    #[cfg(test)]
    pub(crate) fn observe_inbound(
        &self,
        generation: u64,
        line: &str,
    ) -> Option<InvalidEffortAbort> {
        let inbound = AcpInbound::parse(line).ok()?;
        self.observe_decoded_inbound(generation, &inbound)
    }

    pub(crate) fn observe_decoded_inbound(
        &self,
        generation: u64,
        inbound: &AcpInbound,
    ) -> Option<InvalidEffortAbort> {
        let event = parse_inbound(inbound)?;
        let session_id = event.session_id?;
        let mut state = self.lock();
        if state.generation != generation {
            return None;
        }
        let turn = state.active.get_mut(&session_id)?;
        if turn.generation != generation || turn.cancelled {
            return None;
        }
        let now = Instant::now();
        turn.last_activity_at = now;
        turn.last_activity_at_ms = unix_time_ms();
        turn.stall_notified = false;

        if let Some(update) = event.update.as_ref() {
            observe_tool_state(turn, update);
        }
        if event.is_gate {
            if let Some(id) = event.rpc_id {
                turn.open_gates.insert(id);
            }
        }
        let message = event.update.as_ref().and_then(invalid_effort_from_update)?;
        if turn.current_method.as_deref() != Some("session/prompt") {
            return None;
        }
        Some(InvalidEffortAbort {
            request_id: turn.current_request_id?,
            generation,
            message,
        })
    }

    pub(crate) fn observe_outbound(&self, generation: u64, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if message.get("method").is_some() {
            return;
        }
        let Some(id) = message.get("id").map(rpc_id_key) else {
            return;
        };
        let mut state = self.lock();
        if state.generation != generation {
            return;
        }
        for turn in state.active.values_mut() {
            if turn.open_gates.remove(&id) {
                turn.last_activity_at = Instant::now();
                turn.last_activity_at_ms = unix_time_ms();
                turn.stall_notified = false;
                break;
            }
        }
    }

    pub(crate) fn snapshots(&self) -> Vec<ForegroundTurnSnapshot> {
        let state = self.lock();
        state
            .active
            .iter()
            .map(|(session_id, turn)| ForegroundTurnSnapshot {
                session_id: session_id.clone(),
                turn_id: turn.turn_id.clone(),
                generation: turn.generation,
                phase: turn.phase,
                current_method: turn.current_method.clone(),
                started_at: turn.started_at_ms,
                last_activity_at: turn.last_activity_at_ms,
                open_tools: turn.open_tools.len(),
                open_gates: turn.open_gates.len(),
                cancelled: turn.cancelled,
            })
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl ForegroundTurnLease {
    fn turn_id(&self) -> &str {
        &self.turn_id
    }

    fn mark_prompt_started(&self) -> Result<(), AcpHostError> {
        let mut state = self.registry.lock();
        let turn = matching_turn_mut(&mut state, self)?;
        ensure_not_cancelled(turn)?;
        let now = Instant::now();
        turn.phase = "prompting";
        turn.started_at = now;
        turn.started_at_ms = unix_time_ms();
        turn.last_activity_at = now;
        turn.last_activity_at_ms = turn.started_at_ms;
        turn.open_tools.clear();
        turn.open_gates.clear();
        turn.stall_notified = false;
        Ok(())
    }

    fn ensure_active(&self) -> Result<(), AcpHostError> {
        let mut state = self.registry.lock();
        let turn = matching_turn_mut(&mut state, self)?;
        ensure_not_cancelled(turn)
    }

    fn watchdog_decision(&self, absolute_ms: u64) -> WatchdogDecision {
        let state = self.registry.lock();
        let Some(turn) = state.active.get(&self.session_id) else {
            return WatchdogDecision::Ok;
        };
        if turn.token != self.token || turn.generation != self.generation || turn.cancelled {
            return WatchdogDecision::Ok;
        }
        let now = Instant::now();
        watchdog_decision_for(
            duration_ms(now.saturating_duration_since(turn.started_at)),
            duration_ms(now.saturating_duration_since(turn.last_activity_at)),
            !turn.open_tools.is_empty() || !turn.open_gates.is_empty(),
            turn.stall_notified,
            absolute_ms,
        )
    }

    fn mark_stall_notified(&self) -> bool {
        let mut state = self.registry.lock();
        let Ok(turn) = matching_turn_mut(&mut state, self) else {
            return false;
        };
        if turn.stall_notified || turn.cancelled {
            return false;
        }
        turn.stall_notified = true;
        true
    }
}

impl AcpRequestTracker for ForegroundTurnLease {
    fn request_started(&self, request_id: u64, method: &str) -> Result<(), AcpHostError> {
        let mut state = self.registry.lock();
        let turn = matching_turn_mut(&mut state, self)?;
        ensure_not_cancelled(turn)?;
        turn.current_request_id = Some(request_id);
        turn.current_method = Some(method.to_string());
        Ok(())
    }

    fn request_finished(&self, request_id: u64) {
        let mut state = self.registry.lock();
        let Ok(turn) = matching_turn_mut(&mut state, self) else {
            return;
        };
        if turn.current_request_id == Some(request_id) {
            turn.current_request_id = None;
            turn.current_method = None;
        }
    }
}

impl Drop for ForegroundTurnLease {
    fn drop(&mut self) {
        let mut state = self.registry.lock();
        let remove = state
            .active
            .get(&self.session_id)
            .is_some_and(|turn| turn.token == self.token && turn.generation == self.generation);
        if remove {
            state.active.remove(&self.session_id);
        }
    }
}

fn matching_turn_mut<'a>(
    state: &'a mut RegistryState,
    lease: &ForegroundTurnLease,
) -> Result<&'a mut ActiveTurn, AcpHostError> {
    if state.generation != lease.generation {
        return Err(channel_replaced());
    }
    state
        .active
        .get_mut(&lease.session_id)
        .filter(|turn| turn.token == lease.token && turn.generation == lease.generation)
        .ok_or_else(channel_replaced)
}

fn ensure_not_cancelled(turn: &ActiveTurn) -> Result<(), AcpHostError> {
    if turn.cancelled {
        Err(AcpHostError::operation(
            "SESSION_PROMPT_CANCELLED",
            "当前回合已停止",
        ))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn execute_foreground_turn(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    queues: tauri::State<'_, PromptQueueStore>,
    request: ForegroundTurnRequest,
) -> Result<ForegroundTurnResult, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    let session_id = checked_short_string(&request.session_id, "sessionId", 512)?;
    let turn_id = checked_short_string(&request.turn_id, "turnId", 128)?;
    let correlation_turn_id = turn_id.clone();
    ensure_ready_generation(state.inner(), request.generation).await?;
    tracing::info!(
        target: "grox::turn",
        session_id = %session_id,
        turn_id = %turn_id,
        generation = request.generation,
        queued = request.queue_item_id.is_some(),
        "foreground turn requested"
    );

    let queue_path = request
        .queue_item_id
        .as_ref()
        .map(|_| crate::host_core::prompt_queues_path(&app))
        .transpose()
        .map_err(prompt_queue_storage_error)?;
    let queue_claim = match (request.queue_item_id.as_deref(), queue_path.as_ref()) {
        (Some(item_id), Some(path)) => {
            let item_id = checked_short_string(item_id, "queueItemId", 512)?;
            let claim = queues
                .claim(
                    path,
                    &session_id,
                    &item_id,
                    request.generation,
                    PROMPT_QUEUES_MAX_BYTES,
                )
                .map_err(prompt_queue_claim_error)?;
            emit_prompt_queue_changed(&window, &claim, claim.queue.clone(), "claimed");
            Some(claim)
        }
        _ => None,
    };
    let prepared = match queue_claim.as_ref() {
        Some(claim) => prepare_queued_turn(&claim.entry),
        None => prepare_requested_turn(
            request.prompt,
            &request.model,
            &request.effort,
            &request.mode,
        ),
    };
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            if let (Some(path), Some(claim)) = (queue_path.as_ref(), queue_claim.as_ref()) {
                if let Ok(queue) = queues.settle(
                    path,
                    claim,
                    PromptQueueSettlement::Retry,
                    PROMPT_QUEUES_MAX_BYTES,
                ) {
                    emit_prompt_queue_changed(&window, claim, queue, "recovered");
                }
            }
            return Err(error);
        }
    };
    let result = execute_prepared_foreground_turn(
        &app,
        state.inner(),
        leases.inner(),
        &session_id,
        turn_id,
        request.generation,
        prepared,
    )
    .await;

    match &result {
        Ok(value) => tracing::info!(
            target: "grox::turn",
            session_id = %session_id,
            turn_id = %correlation_turn_id,
            generation = request.generation,
            effective_effort = %value.effective_effort,
            "foreground turn settled"
        ),
        Err(error) => tracing::warn!(
            target: "grox::turn",
            session_id = %session_id,
            turn_id = %correlation_turn_id,
            generation = request.generation,
            domain = %error.domain,
            code = %error.code,
            "foreground turn failed"
        ),
    }

    if let (Some(path), Some(claim)) = (queue_path.as_ref(), queue_claim.as_ref()) {
        let settlement = queue_settlement_for_result(&result);
        let queue = queues
            .settle(path, claim, settlement, PROMPT_QUEUES_MAX_BYTES)
            .map_err(prompt_queue_settlement_error)?;
        emit_prompt_queue_changed(
            &window,
            claim,
            queue,
            if settlement == PromptQueueSettlement::Consumed {
                "consumed"
            } else {
                "recovered"
            },
        );
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute_prepared_foreground_turn(
    app: &tauri::AppHandle,
    state: &AcpState,
    leases: &McpLeaseStore,
    session_id: &str,
    turn_id: String,
    generation: u64,
    prepared: PreparedForegroundTurn,
) -> Result<ForegroundTurnResult, AcpHostError> {
    let assistant_count_before = disk_assistant_messages(session_id).len();
    let permit = state
        .sessions
        .acquire_turn(session_id.to_string(), generation)
        .await?;
    let turn = state
        .foreground_turns
        .begin(session_id.to_string(), turn_id, generation)?;
    let _projection_turn =
        SessionProjectionTurn::begin(app, &state.session_events, session_id, generation);
    {
        let _write_guard = state.interactions.lock_writes().await;
        state
            .interactions
            .begin_session_turn(session_id, generation);
    }
    let gate_token = permit.token();

    let mut effective_effort = bind_model(
        state,
        leases,
        session_id,
        &prepared.model,
        &prepared.requested_effort,
        generation,
        gate_token,
        Some(&turn),
    )
    .await?;
    bind_mode(
        state,
        leases,
        session_id,
        prepared.mode,
        generation,
        gate_token,
        Some(&turn),
    )
    .await?;

    let prefs = host_prefs::load_prefs(&crate::host_core::host_prefs_dir_for_app(app)).map_err(|error| {
        AcpHostError::environment(
            "HOST_PREFS_READ_FAILED",
            error,
            false,
            true,
            "修复或移除损坏的 Host 偏好文件后重试",
        )
    })?;
    let host_permission_mode = prefs.permission_mode;
    let permission_mode = prepared
        .permission_mode
        .as_deref()
        .map(|requested| {
            crate::permission_policy::restrict_requested_mode(host_permission_mode, requested)
                .map(|restricted| restricted.effective.as_str())
                .map_err(|()| prompt_queue_invalid())
        })
        .transpose()?
        .unwrap_or_else(|| host_permission_mode.as_str());
    let absolute_hours = prefs
        .prompt_absolute_hours
        .map(u64::from)
        .filter(|hours| (1..=24).contains(hours))
        .unwrap_or(DEFAULT_ABSOLUTE_HOURS);
    let absolute_ms = absolute_hours * 60 * 60_000;

    let mut attempted = BTreeSet::new();
    attempted.insert(effective_effort.clone());
    let mut response = prompt_once(
        app,
        state,
        leases,
        &turn,
        session_id,
        prepared.prompt.clone(),
        &effective_effort,
        permission_mode,
        generation,
        gate_token,
        absolute_ms,
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
        for candidate in effort_fallback_chain(&prepared.requested_effort) {
            let bound = bind_model(
                state,
                leases,
                session_id,
                &prepared.model,
                candidate,
                generation,
                gate_token,
                Some(&turn),
            )
            .await?;
            if !attempted.insert(bound.clone()) {
                continue;
            }
            effective_effort = bound;
            match prompt_once(
                app,
                state,
                leases,
                &turn,
                session_id,
                prepared.prompt.clone(),
                &effective_effort,
                permission_mode,
                generation,
                gate_token,
                absolute_ms,
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
                Err(error) if is_invalid_reasoning_effort(&error) => response = Err(error),
                Err(error) => return Err(error),
            }
        }
    }

    let response = response?;
    turn.ensure_active()?;
    let assistant_text = new_disk_assistant_text(session_id, assistant_count_before).await;
    Ok(ForegroundTurnResult {
        response,
        requested_effort: prepared.requested_effort,
        effective_effort,
        assistant_text,
    })
}

fn prepare_requested_turn(
    prompt: Value,
    model: &str,
    effort: &str,
    mode: &str,
) -> Result<PreparedForegroundTurn, AcpHostError> {
    Ok(PreparedForegroundTurn {
        prompt: prepare_prompt_content(prompt)?,
        model: checked_short_string(model, "model", 512)?,
        requested_effort: normalize_effort(effort)
            .ok_or_else(|| AcpHostError::operation("SESSION_EFFORT_INVALID", "推理强度无效"))?
            .to_string(),
        mode: normalize_mode(mode)
            .ok_or_else(|| AcpHostError::operation("SESSION_MODE_INVALID", "会话模式无效"))?,
        permission_mode: None,
    })
}

fn prepare_queued_turn(entry: &Value) -> Result<PreparedForegroundTurn, AcpHostError> {
    let entry = entry.as_object().ok_or_else(prompt_queue_invalid)?;
    let model = queue_string(entry, "model")?;
    let effort = queue_string(entry, "effort")?;
    let mode = queue_string(entry, "mode")?;
    let permission_mode = queue_string(entry, "permissionMode")?;
    if !matches!(permission_mode, "default" | "auto" | "bypass") {
        return Err(prompt_queue_invalid());
    }
    Ok(PreparedForegroundTurn {
        prompt: prepare_prompt_content(queue_prompt_content(entry)?)?,
        model: checked_short_string(model, "model", 512)?,
        requested_effort: normalize_effort(effort)
            .ok_or_else(prompt_queue_invalid)?
            .to_string(),
        mode: normalize_mode(mode).ok_or_else(prompt_queue_invalid)?,
        permission_mode: Some(permission_mode.to_string()),
    })
}

fn queue_prompt_content(entry: &serde_json::Map<String, Value>) -> Result<Value, AcpHostError> {
    let text = entry
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(prompt_queue_invalid)?;
    let attachments = entry
        .get("attachments")
        .and_then(Value::as_array)
        .ok_or_else(prompt_queue_invalid)?;
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for attachment in attachments {
        let attachment = attachment.as_object().ok_or_else(prompt_queue_invalid)?;
        let kind = queue_string(attachment, "kind")?;
        let mime = queue_string(attachment, "mime")?;
        let name = queue_string(attachment, "name")?;
        let safe_name = name
            .chars()
            .map(|ch| {
                if matches!(ch, '\\' | '/' | '#' | '?') {
                    '_'
                } else {
                    ch
                }
            })
            .collect::<String>();
        let uri = format!(
            "file://{}",
            if safe_name.is_empty() {
                "attachment"
            } else {
                &safe_name
            }
        );
        match kind {
            "image" => {
                if let Some(data) = attachment.get("data").and_then(Value::as_str) {
                    blocks.push(json!({
                        "type": "image",
                        "data": data,
                        "mimeType": mime,
                        "uri": uri,
                    }));
                }
            }
            "text" => {
                if let Some(text) = attachment.get("text").and_then(Value::as_str) {
                    blocks.push(json!({
                        "type": "resource",
                        "resource": { "uri": uri, "mimeType": mime, "text": text },
                    }));
                }
            }
            "binary" => {
                if let Some(data) = attachment.get("data").and_then(Value::as_str) {
                    blocks.push(json!({
                        "type": "resource",
                        "resource": { "uri": uri, "mimeType": mime, "blob": data },
                    }));
                }
            }
            _ => return Err(prompt_queue_invalid()),
        }
    }
    Ok(Value::Array(blocks))
}

fn queue_string<'a>(
    entry: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, AcpHostError> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(prompt_queue_invalid)
}

fn emit_prompt_queue_changed(
    window: &WebviewWindow,
    claim: &PromptQueueClaim,
    queue: Vec<Value>,
    reason: &'static str,
) {
    let _ = window.emit(
        "prompt-queue-changed",
        PromptQueueChanged {
            session_id: claim.session_id.clone(),
            item_id: claim.item_id.clone(),
            queue,
            reason,
        },
    );
}

fn prompt_queue_invalid() -> AcpHostError {
    AcpHostError::environment(
        "PROMPT_QUEUE_INVALID",
        "Host 无法读取已领取的提示队列条目",
        false,
        true,
        "检查队列内容和附件后，确认并继续",
    )
}

fn prompt_queue_storage_error(message: String) -> AcpHostError {
    AcpHostError::environment(
        "PROMPT_QUEUE_STORAGE_FAILED",
        message,
        false,
        true,
        "检查应用数据目录的磁盘空间和文件权限",
    )
}

fn prompt_queue_claim_error(error: PromptQueueClaimError) -> AcpHostError {
    match error {
        PromptQueueClaimError::Busy => AcpHostError {
            domain: "operation".into(),
            code: "PROMPT_QUEUE_CLAIM_BUSY".into(),
            message: "该会话已有 Host 正在派发的队列提示".into(),
            recoverable: true,
            fatal: false,
            hold_queue: true,
            action: Some("等待当前回合结束；若运行时已退出，请确认最后一轮后恢复队列".into()),
        },
        PromptQueueClaimError::Stale => AcpHostError {
            domain: "operation".into(),
            code: "PROMPT_QUEUE_CLAIM_STALE".into(),
            message: "队列顺序已变化，Host 拒绝发送过期条目".into(),
            recoverable: true,
            fatal: false,
            hold_queue: true,
            action: Some("核对最新队列后，确认并继续".into()),
        },
        PromptQueueClaimError::Invalid(message) => AcpHostError::environment(
            "PROMPT_QUEUE_INVALID",
            message,
            false,
            true,
            "检查队列内容和附件后，确认并继续",
        ),
        PromptQueueClaimError::Storage(message) => prompt_queue_storage_error(message),
    }
}

fn prompt_queue_settlement_error(error: PromptQueueClaimError) -> AcpHostError {
    let detail = match error {
        PromptQueueClaimError::Busy => "队列认领仍被占用".into(),
        PromptQueueClaimError::Stale => "队列认领已失效".into(),
        PromptQueueClaimError::Invalid(message) | PromptQueueClaimError::Storage(message) => {
            message
        }
    };
    AcpHostError::environment(
        "PROMPT_QUEUE_SETTLE_FAILED",
        format!("回合已经结束，但提示队列未能结算：{detail}"),
        true,
        true,
        "不要直接重发；先检查最后一轮和应用数据目录，再清理或恢复队列",
    )
}

fn queue_settlement_for_result(
    result: &Result<ForegroundTurnResult, AcpHostError>,
) -> PromptQueueSettlement {
    if result.is_ok()
        || result
            .as_ref()
            .err()
            .is_some_and(|error| error.code == "SESSION_PROMPT_CANCELLED")
    {
        PromptQueueSettlement::Consumed
    } else {
        // 通道替换、供应商切换、协议失败和环境退出都无法证明 Agent 未执行，
        // 因此保留原条目并由前端的 holdQueue 门禁等待人工确认。
        PromptQueueSettlement::Retry
    }
}

#[allow(clippy::too_many_arguments)]
async fn prompt_once(
    app: &tauri::AppHandle,
    state: &AcpState,
    leases: &McpLeaseStore,
    turn: &ForegroundTurnLease,
    session_id: &str,
    prompt: Value,
    effort: &str,
    permission_mode: &str,
    generation: u64,
    gate_token: u64,
    absolute_ms: u64,
) -> Result<Value, AcpHostError> {
    turn.mark_prompt_started()?;
    let request = request_acp_json_tracked(
        state,
        leases,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": prompt,
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
        Some(turn),
    );
    tokio::pin!(request);
    loop {
        match tokio::time::timeout(Duration::from_millis(WATCHDOG_POLL_MS), &mut request).await {
            Ok(result) => return result,
            Err(_) => match turn.watchdog_decision(absolute_ms) {
                WatchdogDecision::Ok => {}
                WatchdogDecision::SoftStall(silent_for_ms) => {
                    // 学习 grok-app：普通静默只提示，不把可能仍在运行的长任务
                    // 当成失败。用户仍可 Stop，硬上限仍会回收僵尸回合。
                    if turn.mark_stall_notified() {
                        let _ = app.emit(
                            "foreground-turn-stalled",
                            ForegroundTurnStalled {
                                session_id: session_id.to_string(),
                                silent_for_ms,
                            },
                        );
                    }
                }
                WatchdogDecision::Absolute(_) => {
                    let hours = absolute_ms / 3_600_000;
                    let message =
                        format!("本轮已超过 {hours} 小时上限。已自动终止，可发消息继续。");
                    let failure = AcpHostError::environment(
                        "SESSION_PROMPT_ABSOLUTE_TIMEOUT",
                        message.clone(),
                        true,
                        true,
                        "检查最后一轮是否已在 CLI 侧完成，再决定是否重新发送",
                    );
                    let target =
                        turn.registry
                            .cancel(session_id, Some(turn.turn_id()), generation)?;
                    if let Some(request_id) = target.request_id {
                        state
                            .requests
                            .reject(request_id, generation, failure.clone())
                            .await;
                    }
                    cancel_pending_interactions(app, state, leases, session_id, generation).await?;
                    let _ =
                        send_cancel_notification(state, leases, session_id, generation, "watchdog")
                            .await;
                    return Err(failure);
                }
            },
        }
    }
}

#[tauri::command]
pub(crate) async fn cancel_foreground_turn(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    session_id: String,
    turn_id: Option<String>,
    generation: u64,
    reason: String,
    kind: String,
) -> Result<bool, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    let session_id = checked_short_string(&session_id, "sessionId", 512)?;
    let reason = checked_short_string(&reason, "取消原因", 1_000)?;
    let failure = match kind.as_str() {
        "watchdog" => AcpHostError::environment(
            "ACP_REQUEST_STALLED",
            reason,
            true,
            true,
            "检查网络、模型或供应商配置，并确认最后一轮结果后重试",
        ),
        "protocol_recovery" => AcpHostError::protocol("ACP_REQUEST_ABORTED_FOR_RECOVERY", reason),
        "user" => AcpHostError::operation("SESSION_PROMPT_CANCELLED", reason),
        _ => {
            return Err(AcpHostError::operation(
                "SESSION_CANCEL_KIND_INVALID",
                "ACP 取消类型无效",
            ))
        }
    };
    let turn_id = turn_id
        .as_deref()
        .map(|turn_id| checked_short_string(turn_id, "turnId", 128))
        .transpose()?;
    let target = state
        .foreground_turns
        .cancel(&session_id, turn_id.as_deref(), generation)?;
    if let Some(request_id) = target.request_id {
        state.requests.reject(request_id, generation, failure).await;
    }
    let cancelled_interactions = cancel_pending_interactions(
        window.app_handle(),
        state.inner(),
        leases.inner(),
        &session_id,
        generation,
    )
    .await?;
    // 先清算 Host 请求与 FSM，再做可能受阻的 stdin 写入。
    if target.active || cancelled_interactions > 0 {
        send_cancel_notification(
            state.inner(),
            leases.inner(),
            &session_id,
            generation,
            &kind,
        )
        .await?;
    }
    Ok(target.active || cancelled_interactions > 0)
}

#[tauri::command]
pub(crate) fn foreground_turn_status(
    state: tauri::State<'_, Arc<AcpState>>,
) -> Vec<ForegroundTurnSnapshot> {
    state.foreground_turns.snapshots()
}

async fn cancel_pending_interactions(
    app: &tauri::AppHandle,
    state: &AcpState,
    leases: &McpLeaseStore,
    session_id: &str,
    generation: u64,
) -> Result<usize, AcpHostError> {
    let _write_guard = state.interactions.lock_writes().await;
    let pending = state
        .interactions
        .claim_session_cancellations(session_id, generation);
    for lease in &pending {
        let line = match prepare_acp_line(lease.line.clone(), leases) {
            Ok(line) => line,
            Err(error) => {
                for claimed in &pending {
                    state.interactions.settle(claimed);
                }
                return Err(AcpHostError::protocol("INTERACTION_CANCEL_INVALID", error));
            }
        };
        state
            .foreground_turns
            .observe_outbound(lease.generation, &line);
        if let Err(error) = write_acp_line(state, &line, lease.generation).await {
            // 写入失败后每个反向 RPC 的送达情况都不确定；全部终结，避免
            // 重连后把旧批准或回答写进新的 Agent 进程。
            for claimed in &pending {
                state.interactions.settle(claimed);
            }
            return Err(AcpHostError::environment(
                "INTERACTION_CANCEL_FAILED",
                error,
                false,
                true,
                "重新连接 Agent；旧交互请求已失效",
            ));
        }
        state.interactions.settle(lease);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(
                "interaction-closed",
                json!({
                    "sessionId": &lease.session_id,
                    "blockId": &lease.block_id,
                    "kind": lease.kind,
                    "reason": "cancelled",
                }),
            );
        }
    }
    Ok(pending.len())
}

async fn send_cancel_notification(
    state: &AcpState,
    leases: &McpLeaseStore,
    session_id: &str,
    generation: u64,
    trigger: &str,
) -> Result<(), AcpHostError> {
    let line = json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": {
            "sessionId": session_id,
            "_meta": {
                "trigger": trigger,
                "cancelSubagents": true,
            },
        },
    })
    .to_string();
    let line = prepare_acp_line(line, leases)
        .map_err(|error| AcpHostError::protocol("ACP_INVALID_REQUEST", error))?;
    write_acp_line(state, &line, generation)
        .await
        .map_err(|error| {
            AcpHostError::environment(
                "SESSION_CANCEL_FAILED",
                error,
                false,
                true,
                "等待当前回合结束，或重启运行时",
            )
        })
}

async fn ensure_ready_generation(state: &AcpState, generation: u64) -> Result<(), AcpHostError> {
    if state.ready_generation.load(Ordering::Acquire) != generation {
        return Err(AcpHostError::environment(
            "ACP_RUNTIME_NOT_READY",
            "Grok Build 运行时尚未就绪，无法发送前台回合",
            false,
            false,
            "等待运行时连接完成后重试",
        ));
    }
    let process = state.process.lock().await;
    if process
        .as_ref()
        .is_some_and(|process| process.generation == generation)
    {
        Ok(())
    } else {
        Err(channel_replaced())
    }
}

fn prepare_prompt_content(mut prompt: Value) -> Result<Value, AcpHostError> {
    let blocks = prompt.as_array_mut().ok_or_else(|| {
        AcpHostError::protocol("ACP_INVALID_REQUEST", "session/prompt 的 prompt 必须是数组")
    })?;
    if blocks.is_empty() || blocks.len() > 64 {
        return Err(AcpHostError::protocol(
            "ACP_INVALID_REQUEST",
            "session/prompt 的内容块数量无效",
        ));
    }
    let first = blocks
        .first_mut()
        .and_then(Value::as_object_mut)
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .ok_or_else(|| AcpHostError::protocol("ACP_INVALID_REQUEST", "prompt 首块必须是文本"))?;
    let text = first
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| AcpHostError::protocol("ACP_INVALID_REQUEST", "prompt 文本无效"))?;
    first.insert(
        "text".into(),
        Value::String(crate::turn_runtime::complete_deep_research_prompt(text)),
    );
    Ok(prompt)
}

fn checked_short_string(
    value: &str,
    field: &str,
    max_chars: usize,
) -> Result<String, AcpHostError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars {
        return Err(AcpHostError::operation(
            "SESSION_TURN_INPUT_INVALID",
            format!("{field} 无效"),
        ));
    }
    Ok(value.to_string())
}

struct ParsedInbound {
    session_id: Option<String>,
    rpc_id: Option<String>,
    is_gate: bool,
    update: Option<Value>,
}

fn parse_inbound(message: &AcpInbound) -> Option<ParsedInbound> {
    let method = message.method()?;
    let params = message.params();
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let update = matches!(
        method,
        "session/update" | "x.ai/session/update" | "x.ai/session_notification"
    )
    .then(|| params.get("update").cloned())
    .flatten();
    let is_gate = matches!(
        method,
        "session/request_permission" | "x.ai/exit_plan_mode" | "x.ai/ask_user_question"
    );
    Some(ParsedInbound {
        session_id,
        rpc_id: message.id().map(rpc_id_key),
        is_gate,
        update,
    })
}

fn observe_tool_state(turn: &mut ActiveTurn, update: &Value) {
    let update_type = update.get("sessionUpdate").and_then(Value::as_str);
    if !matches!(update_type, Some("tool_call" | "tool_call_update")) {
        return;
    }
    let Some(tool_id) = update.get("toolCallId").and_then(Value::as_str) else {
        return;
    };
    let status = update
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending")
        .to_ascii_lowercase();
    if matches!(
        status.as_str(),
        "pending" | "running" | "awaiting_permission"
    ) {
        turn.open_tools.insert(tool_id.to_string());
    } else {
        turn.open_tools.remove(tool_id);
    }
}

fn invalid_effort_from_update(update: &Value) -> Option<String> {
    let update_type = update.get("sessionUpdate").and_then(Value::as_str);
    let body = if update_type == Some("retry_state") {
        update.get("retryState").unwrap_or(update)
    } else {
        update
    };
    let stop = body
        .get("stop_reason")
        .or_else(|| body.get("stopReason"))
        .and_then(Value::as_str);
    let message = ["agent_result", "message", "reason", "error"]
        .into_iter()
        .find_map(|key| body.get(key))
        .and_then(|value| {
            value.as_str().map(str::to_string).or_else(|| {
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        })?;
    let failed = stop == Some("error")
        || body.get("type").and_then(Value::as_str) == Some("failed")
        || body.get("error_type").and_then(Value::as_str) == Some("api")
        || invalid_reasoning_effort_message(&message);
    (failed && invalid_reasoning_effort_message(&message)).then_some(message)
}

fn rpc_id_key(value: &Value) -> String {
    match value {
        Value::String(value) => format!("s:{value}"),
        Value::Number(value) => format!("n:{value}"),
        _ => format!("other:{value}"),
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

fn watchdog_decision_for(
    elapsed_ms: u64,
    silent_ms: u64,
    has_open_work: bool,
    stall_notified: bool,
    absolute_ms: u64,
) -> WatchdogDecision {
    if elapsed_ms >= absolute_ms {
        return WatchdogDecision::Absolute(elapsed_ms);
    }
    if has_open_work || stall_notified {
        return WatchdogDecision::Ok;
    }
    if silent_ms >= SOFT_STALL_MS {
        WatchdogDecision::SoftStall(silent_ms)
    } else {
        WatchdogDecision::Ok
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn channel_replaced() -> AcpHostError {
    AcpHostError::environment(
        "ACP_CHANNEL_REPLACED",
        "ACP 通道已切换，当前回合已失效",
        true,
        true,
        "Agent 重连后检查最后一轮结果，再决定是否重新发送",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_effort_update_targets_only_the_active_prompt_request() {
        let registry = Arc::new(ForegroundTurnRegistry::default());
        registry.reset(7);
        let turn = registry.begin("s1".into(), "turn-1".into(), 7).unwrap();
        turn.request_started(42, "session/prompt").unwrap();
        let abort = registry
            .observe_inbound(
                7,
                r#"{"jsonrpc":"2.0","method":"x.ai/session_notification","params":{"sessionId":"s1","update":{"sessionUpdate":"retry_state","retryState":{"error":"Invalid reasoning effort max"}}}}"#,
            )
            .unwrap();
        assert_eq!(abort.request_id, 42);
        assert_eq!(abort.generation, 7);
        assert!(abort.message.contains("Invalid reasoning effort"));
    }

    #[test]
    fn tool_and_operator_gates_are_host_observed() {
        let registry = Arc::new(ForegroundTurnRegistry::default());
        registry.reset(2);
        let turn = registry.begin("s1".into(), "turn-1".into(), 2).unwrap();
        turn.mark_prompt_started().unwrap();
        registry.observe_inbound(
            2,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","status":"running"}}}"#,
        );
        registry.observe_inbound(
            2,
            r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s1"}}"#,
        );
        let snapshot = registry.snapshots().pop().unwrap();
        assert_eq!(snapshot.open_tools, 1);
        assert_eq!(snapshot.open_gates, 1);

        registry.observe_outbound(2, r#"{"jsonrpc":"2.0","id":9,"result":{}}"#);
        registry.observe_inbound(
            2,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed"}}}"#,
        );
        let snapshot = registry.snapshots().pop().unwrap();
        assert_eq!(snapshot.open_tools, 0);
        assert_eq!(snapshot.open_gates, 0);
    }

    #[test]
    fn string_and_numeric_reverse_rpc_ids_do_not_share_a_gate_slot() {
        let registry = Arc::new(ForegroundTurnRegistry::default());
        registry.reset(4);
        let turn = registry.begin("s1".into(), "turn-1".into(), 4).unwrap();
        turn.mark_prompt_started().unwrap();
        registry.observe_inbound(
            4,
            r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s1"}}"#,
        );
        registry.observe_inbound(
            4,
            r#"{"jsonrpc":"2.0","id":"9","method":"x.ai/ask_user_question","params":{"sessionId":"s1"}}"#,
        );
        assert_eq!(registry.snapshots()[0].open_gates, 2);
        registry.observe_outbound(4, r#"{"jsonrpc":"2.0","id":9,"result":{}}"#);
        assert_eq!(registry.snapshots()[0].open_gates, 1);
    }

    #[test]
    fn stop_before_begin_is_consumed_by_the_matching_generation() {
        let registry = Arc::new(ForegroundTurnRegistry::default());
        registry.reset(3);
        assert!(!registry.cancel("s1", Some("turn-1"), 3).unwrap().active);
        let error = registry
            .begin("s1".into(), "turn-1".into(), 3)
            .err()
            .unwrap();
        assert_eq!(error.code, "SESSION_PROMPT_CANCELLED");
        assert!(registry.begin("s1".into(), "turn-2".into(), 3).is_ok());
    }

    #[test]
    fn soft_stall_never_overrides_open_work_but_absolute_timeout_does() {
        assert!(matches!(
            watchdog_decision_for(6 * 60_000, 6 * 60_000, false, false, 4 * 60 * 60_000,),
            WatchdogDecision::SoftStall(_)
        ));
        assert_eq!(
            watchdog_decision_for(6 * 60_000, 6 * 60_000, true, false, 4 * 60 * 60_000,),
            WatchdogDecision::Ok
        );
        assert!(matches!(
            watchdog_decision_for(6 * 60_000, 6 * 60_000, true, false, 5 * 60_000),
            WatchdogDecision::Absolute(_)
        ));
    }

    #[test]
    fn prompt_alias_is_rewritten_without_touching_attachments() {
        let prompt = prepare_prompt_content(json!([
            {"type":"text","text":"/deep-research evidence"},
            {"type":"image","data":"abc","mimeType":"image/png"}
        ]))
        .unwrap();
        assert_eq!(
            prompt[0]["text"],
            r#"/workflow grox-deep-research {"query":"evidence"}"#
        );
        assert_eq!(prompt[1]["data"], "abc");
    }

    #[test]
    fn queued_turn_is_built_from_the_persisted_entry() {
        let prepared = prepare_queued_turn(&json!({
            "id": "q1",
            "text": "queued truth",
            "attachments": [
                {
                    "id": "a1",
                    "kind": "text",
                    "name": "a/b.txt",
                    "mime": "text/plain",
                    "size": 4,
                    "text": "body"
                }
            ],
            "model": "grok-build",
            "effort": "high",
            "mode": "plan",
            "permissionMode": "bypass",
            "createdAt": 1
        }))
        .unwrap();

        assert_eq!(prepared.prompt[0]["text"], "queued truth");
        assert_eq!(prepared.prompt[1]["resource"]["uri"], "file://a_b.txt");
        assert_eq!(prepared.model, "grok-build");
        assert_eq!(prepared.mode, "plan");
        assert_eq!(prepared.permission_mode.as_deref(), Some("bypass"));
    }

    #[test]
    fn queue_consumes_only_success_or_explicit_user_cancel() {
        let success = Ok(ForegroundTurnResult {
            response: json!({}),
            requested_effort: "high".into(),
            effective_effort: "high".into(),
            assistant_text: None,
        });
        assert_eq!(
            queue_settlement_for_result(&success),
            PromptQueueSettlement::Consumed
        );
        let cancelled = Err(AcpHostError::operation(
            "SESSION_PROMPT_CANCELLED",
            "用户停止",
        ));
        assert_eq!(
            queue_settlement_for_result(&cancelled),
            PromptQueueSettlement::Consumed
        );
        let provider_switch = Err(channel_replaced());
        assert_eq!(
            queue_settlement_for_result(&provider_switch),
            PromptQueueSettlement::Retry
        );
        let protocol = Err(AcpHostError::protocol("ACP_RESPONSE_INVALID", "bad"));
        assert_eq!(
            queue_settlement_for_result(&protocol),
            PromptQueueSettlement::Retry
        );
    }
}
