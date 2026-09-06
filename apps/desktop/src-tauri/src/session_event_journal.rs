//! ACP 入站事件的 Host 权威解码、顺序与短期重放。
//!
//! WebView 可能在 Agent 仍运行时重载。原先裸 `app.emit` 没有序号和补放，
//! 页面消失期间的流片段会永久丢失。这里为所有需要投影给页面的消息分配
//! 单调序号并保留有界窗口；页面先订阅再按游标补放，因而不会留下竞态窗口。
//! JSON-RPC 与 x.ai 扩展封装只在 Host 解码，页面不会收到原始 wire 行或 rpc id。

use std::{
    collections::{BTreeMap, VecDeque},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Value};

use crate::acp_inbound::{AcpInbound, AcpInboundError};

const MAX_RETAINED_EVENTS: usize = 8_192;
const MAX_RETAINED_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPLAY_EVENTS: usize = 1_000;
const MAX_RETAINED_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ACTIVE_BLOCK_TEXT_BYTES: usize = 1024 * 1024;
const MAX_CONTENT_DEPTH: usize = 16;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSessionEvent {
    stream_id: String,
    sequence: u64,
    generation: u64,
    received_at: u64,
    session_id: Option<String>,
    method: Option<String>,
    update_type: Option<String>,
    projection: HostSessionProjection,
    journal_recoverable: bool,
    journal_acknowledged: bool,
    #[serde(skip)]
    wire_bytes: usize,
    #[serde(skip)]
    unsupported_response: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum HostSessionProjection {
    SessionUpdate {
        channel: &'static str,
        session_id: String,
        update_type: Option<String>,
        update: Value,
        block_ops: Vec<HostBlockOperation>,
    },
    BlockLifecycle {
        session_id: String,
        phase: &'static str,
        block_ops: Vec<HostBlockOperation>,
    },
    Notification {
        method: String,
        params: Value,
    },
    UnsupportedRequest {
        method: String,
    },
    OrphanResponse,
    ProtocolError {
        code: &'static str,
        message: String,
    },
}

/// Host 只投影消息块的身份和生命周期；具体卡片内容仍由 WebView 渲染。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostBlockOperation {
    action: &'static str,
    block_type: &'static str,
    block_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostActiveBlockSnapshot {
    generation: u64,
    session_id: String,
    block_type: &'static str,
    block_id: String,
    started_at: u64,
    updated_through: u64,
    text: String,
    text_complete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSessionEventReplay {
    stream_id: String,
    events: Vec<HostSessionEvent>,
    earliest_sequence: u64,
    latest_sequence: u64,
    truncated: bool,
    reset: bool,
    has_more: bool,
    active_blocks: Vec<HostActiveBlockSnapshot>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSessionEventStatus {
    stream_id: String,
    earliest_sequence: u64,
    latest_sequence: u64,
    retained_events: usize,
    retained_bytes: usize,
    dropped_through: u64,
    active_blocks: usize,
    active_block_bytes: usize,
    journal_recoverable_events: usize,
    journal_acknowledged_events: usize,
}

struct JournalState {
    stream_id: String,
    next_sequence: u64,
    dropped_through: u64,
    retained_bytes: usize,
    events: VecDeque<HostSessionEvent>,
    projection_generation: u64,
    projections: BTreeMap<(u64, String), SessionBlockState>,
}

#[derive(Clone)]
struct OpenBlock {
    id: String,
    started_at: u64,
    updated_through: u64,
    text: String,
    text_complete: bool,
}

#[derive(Default)]
struct SessionBlockState {
    assistant: Option<OpenBlock>,
    thinking: Option<OpenBlock>,
    user: Option<OpenBlock>,
    user_prompt_index: Option<u64>,
    plan: Option<OpenBlock>,
    tools: BTreeMap<String, OpenBlock>,
}

pub(crate) struct SessionEventJournal {
    state: Mutex<JournalState>,
}

impl Default for SessionEventJournal {
    fn default() -> Self {
        Self {
            state: Mutex::new(JournalState {
                stream_id: new_stream_id(),
                next_sequence: 1,
                dropped_through: 0,
                retained_bytes: 0,
                events: VecDeque::new(),
                projection_generation: 0,
                projections: BTreeMap::new(),
            }),
        }
    }
}

impl SessionEventJournal {
    #[cfg(test)]
    pub(crate) fn append(&self, generation: u64, line: String) -> HostSessionEvent {
        let wire_bytes = line.len();
        let inbound = AcpInbound::parse(&line);
        self.append_inbound(generation, wire_bytes, inbound.as_ref())
    }

    pub(crate) fn append_inbound(
        &self,
        generation: u64,
        wire_bytes: usize,
        inbound: Result<&AcpInbound, &AcpInboundError>,
    ) -> HostSessionEvent {
        let mut decoded = decode_inbound(inbound);
        let mut state = self.lock();
        let sequence = state.next_sequence;
        state.next_sequence = state.next_sequence.saturating_add(1);
        let received_at = unix_time_ms();
        project_block_identity(&mut state, generation, sequence, received_at, &mut decoded);
        let journal_recoverable = projection_is_journal_recoverable(&decoded.projection);
        let event = HostSessionEvent {
            stream_id: state.stream_id.clone(),
            sequence,
            generation,
            received_at,
            session_id: decoded.session_id,
            method: decoded.method,
            update_type: decoded.update_type,
            projection: decoded.projection,
            journal_recoverable,
            journal_acknowledged: false,
            wire_bytes,
            unsupported_response: decoded.unsupported_response,
        };

        retain_event(&mut state, event)
    }

    pub(crate) fn begin_turn(&self, generation: u64, session_id: &str) -> HostSessionEvent {
        self.append_lifecycle(generation, session_id, "turn_started", false)
    }

    pub(crate) fn finish_turn(&self, generation: u64, session_id: &str) -> HostSessionEvent {
        self.append_lifecycle(generation, session_id, "turn_finished", false)
    }

    pub(crate) fn reset_session(&self, generation: u64, session_id: &str) -> HostSessionEvent {
        self.append_lifecycle(generation, session_id, "session_reset", true)
    }

    pub(crate) fn remove_session(&self, generation: u64, session_id: &str) -> HostSessionEvent {
        let mut state = self.lock();
        let sequence = state.next_sequence;
        state.next_sequence = state.next_sequence.saturating_add(1);
        let mut block_ops = Vec::new();
        if prepare_projection_generation(&mut state, generation) {
            for ((_, projected_session_id), projection) in state.projections.iter_mut() {
                if projected_session_id == session_id {
                    close_text_blocks(projection, &mut block_ops);
                }
            }
            state
                .projections
                .retain(|(_, projected_session_id), _| projected_session_id != session_id);
        }
        let event = lifecycle_event(
            &state.stream_id,
            sequence,
            generation,
            session_id,
            "session_removed",
            block_ops,
        );
        retain_event(&mut state, event)
    }

    fn append_lifecycle(
        &self,
        generation: u64,
        session_id: &str,
        phase: &'static str,
        reset: bool,
    ) -> HostSessionEvent {
        let mut state = self.lock();
        let sequence = state.next_sequence;
        state.next_sequence = state.next_sequence.saturating_add(1);
        let key = (generation, session_id.to_string());
        let mut block_ops = Vec::new();
        if prepare_projection_generation(&mut state, generation) {
            let projection = state.projections.entry(key.clone()).or_default();
            close_text_blocks(projection, &mut block_ops);
            if reset {
                state.projections.remove(&key);
            }
        }
        let event = lifecycle_event(
            &state.stream_id,
            sequence,
            generation,
            session_id,
            phase,
            block_ops,
        );
        retain_event(&mut state, event)
    }

    pub(crate) fn replay(
        &self,
        requested_stream_id: Option<&str>,
        after_sequence: u64,
        limit: Option<usize>,
    ) -> HostSessionEventReplay {
        let state = self.lock();
        let reset = requested_stream_id != Some(state.stream_id.as_str());
        let after_sequence = if reset { 0 } else { after_sequence };
        let limit = limit
            .unwrap_or(MAX_REPLAY_EVENTS)
            .clamp(1, MAX_REPLAY_EVENTS);
        let latest_sequence = state.next_sequence.saturating_sub(1);
        let earliest_sequence = state
            .events
            .front()
            .map(|event| event.sequence)
            .unwrap_or_else(|| latest_sequence.saturating_add(1));
        let mut matching = state
            .events
            .iter()
            .filter(|event| event.sequence > after_sequence);
        let events = matching.by_ref().take(limit).cloned().collect::<Vec<_>>();
        let has_more = matching.next().is_some();
        let truncated = after_sequence < state.dropped_through;
        if truncated {
            tracing::warn!(
                target: "grox::session_events",
                requested_after = after_sequence,
                dropped_through = state.dropped_through,
                latest_sequence,
                "ACP event replay requested beyond retained window"
            );
        }

        let active_blocks = if has_more {
            Vec::new()
        } else {
            active_block_snapshots(&state)
        };
        HostSessionEventReplay {
            stream_id: state.stream_id.clone(),
            events,
            earliest_sequence,
            latest_sequence,
            truncated,
            reset,
            has_more,
            active_blocks,
        }
    }

    /// 只有应用会话 journal 成功原子落盘后才确认对应事件。确认按精确
    /// sequence 记录，不使用“最大游标”，避免一个会话越过另一个会话或
    /// workflow/localStorage 等不同持久化域的未落盘事件。
    pub(crate) fn acknowledge_session_events(
        &self,
        stream_id: &str,
        session_id: &str,
        sequences: &[u64],
    ) -> usize {
        if sequences.is_empty() {
            return 0;
        }
        let mut state = self.lock();
        if stream_id != state.stream_id {
            tracing::debug!(
                target: "grox::session_events",
                session_id,
                "ignoring journal acknowledgement from a previous Host stream"
            );
            return 0;
        }
        let requested = sequences
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let mut acknowledged = 0;
        for event in &mut state.events {
            if !requested.contains(&event.sequence)
                || event.session_id.as_deref() != Some(session_id)
                || !event.journal_recoverable
                || event.journal_acknowledged
            {
                continue;
            }
            event.journal_acknowledged = true;
            acknowledged += 1;
        }
        acknowledged
    }

    pub(crate) fn status(&self) -> HostSessionEventStatus {
        let state = self.lock();
        let latest_sequence = state.next_sequence.saturating_sub(1);
        HostSessionEventStatus {
            stream_id: state.stream_id.clone(),
            earliest_sequence: state
                .events
                .front()
                .map(|event| event.sequence)
                .unwrap_or_else(|| latest_sequence.saturating_add(1)),
            latest_sequence,
            retained_events: state.events.len(),
            retained_bytes: state.retained_bytes,
            dropped_through: state.dropped_through,
            active_blocks: active_block_count(&state),
            active_block_bytes: active_block_bytes(&state),
            journal_recoverable_events: state
                .events
                .iter()
                .filter(|event| event.journal_recoverable)
                .count(),
            journal_acknowledged_events: state
                .events
                .iter()
                .filter(|event| event.journal_acknowledged)
                .count(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, JournalState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn retain_event(state: &mut JournalState, event: HostSessionEvent) -> HostSessionEvent {
    let event_bytes = event.wire_bytes;
    if event_bytes > MAX_RETAINED_EVENT_BYTES {
        // 超大多模态消息仍实时投影，但不允许单条消息吃掉整个补放窗口。
        state.dropped_through = event.sequence;
        tracing::warn!(
            target: "grox::session_events",
            generation = event.generation,
            sequence = event.sequence,
            session_id = ?event.session_id,
            bytes = event_bytes,
            "ACP event exceeds replay retention limit"
        );
        return event;
    }
    state.retained_bytes = state.retained_bytes.saturating_add(event_bytes);
    state.events.push_back(event.clone());
    while state.events.len() > MAX_RETAINED_EVENTS || state.retained_bytes > MAX_RETAINED_BYTES {
        let Some(dropped) = state.events.pop_front() else {
            break;
        };
        state.retained_bytes = state.retained_bytes.saturating_sub(dropped.wire_bytes);
        state.dropped_through = state.dropped_through.max(dropped.sequence);
    }
    event
}

fn active_block_snapshots(state: &JournalState) -> Vec<HostActiveBlockSnapshot> {
    let mut snapshots = Vec::new();
    for ((generation, session_id), projection) in &state.projections {
        if *generation != state.projection_generation {
            continue;
        }
        for (block_type, block) in [
            ("user", projection.user.as_ref()),
            ("thinking", projection.thinking.as_ref()),
            ("assistant", projection.assistant.as_ref()),
        ] {
            let Some(block) = block else {
                continue;
            };
            snapshots.push(HostActiveBlockSnapshot {
                generation: *generation,
                session_id: session_id.clone(),
                block_type,
                block_id: block.id.clone(),
                started_at: block.started_at,
                updated_through: block.updated_through,
                text: block.text.clone(),
                text_complete: block.text_complete,
            });
        }
    }
    snapshots
}

fn active_block_count(state: &JournalState) -> usize {
    state
        .projections
        .iter()
        .filter(|((generation, _), _)| *generation == state.projection_generation)
        .map(|(_, projection)| {
            usize::from(projection.user.is_some())
                + usize::from(projection.thinking.is_some())
                + usize::from(projection.assistant.is_some())
        })
        .sum()
}

fn active_block_bytes(state: &JournalState) -> usize {
    state
        .projections
        .iter()
        .filter(|((generation, _), _)| *generation == state.projection_generation)
        .map(|(_, projection)| {
            projection.user.as_ref().map_or(0, |block| block.text.len())
                + projection
                    .thinking
                    .as_ref()
                    .map_or(0, |block| block.text.len())
                + projection
                    .assistant
                    .as_ref()
                    .map_or(0, |block| block.text.len())
        })
        .sum()
}

fn lifecycle_event(
    stream_id: &str,
    sequence: u64,
    generation: u64,
    session_id: &str,
    phase: &'static str,
    block_ops: Vec<HostBlockOperation>,
) -> HostSessionEvent {
    HostSessionEvent {
        stream_id: stream_id.to_string(),
        sequence,
        generation,
        received_at: unix_time_ms(),
        session_id: Some(session_id.to_string()),
        method: None,
        update_type: None,
        projection: HostSessionProjection::BlockLifecycle {
            session_id: session_id.to_string(),
            phase,
            block_ops,
        },
        journal_recoverable: phase != "session_removed",
        journal_acknowledged: false,
        wire_bytes: 0,
        unsupported_response: None,
    }
}

fn projection_is_journal_recoverable(projection: &HostSessionProjection) -> bool {
    let HostSessionProjection::SessionUpdate { update_type, .. } = projection else {
        return matches!(
            projection,
            HostSessionProjection::BlockLifecycle { phase, .. } if *phase != "session_removed"
        );
    };
    !matches!(
        update_type.as_deref(),
        None | Some(
            "current_mode_update"
                | "available_commands_update"
                | "workflow_updated"
                | "subagent_spawned"
                | "subagent_progress"
                | "subagent_finished"
                | "rewind_marker"
        )
    )
}

fn project_block_identity(
    state: &mut JournalState,
    generation: u64,
    sequence: u64,
    received_at: u64,
    decoded: &mut DecodedInbound,
) {
    if !prepare_projection_generation(state, generation) {
        return;
    }
    let HostSessionProjection::SessionUpdate {
        session_id,
        update,
        block_ops,
        ..
    } = &mut decoded.projection
    else {
        return;
    };
    let Some(update_type) = update.get("sessionUpdate").and_then(Value::as_str) else {
        return;
    };
    let stream_id = state.stream_id.clone();
    let projection = state
        .projections
        .entry((generation, session_id.clone()))
        .or_default();

    match update_type {
        "user_message_chunk" => {
            if update
                .get("_meta")
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("hideFromScrollback"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                return;
            }
            close_block(&mut projection.assistant, "assistant", block_ops);
            close_block(&mut projection.thinking, "thinking", block_ops);
            let prompt_index = update
                .get("_meta")
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("promptIndex"))
                .and_then(Value::as_u64);
            let combined = update
                .get("content")
                .and_then(Value::as_object)
                .and_then(|content| content.get("_meta"))
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("combinedDisplayTexts"))
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .filter(|items| items.len() >= 2);
            if let Some(combined) = combined {
                projection.user = None;
                for (index, text) in combined.into_iter().enumerate() {
                    let mut block =
                        new_block(&stream_id, sequence, &format!("user-{index}"), received_at);
                    append_block_text(&mut block, text, true);
                    block_ops.push(open_operation("user", &block, None));
                    projection.user = Some(block);
                }
                projection.user_prompt_index = prompt_index;
                return;
            }
            let begins_new_prompt = projection.user.is_none()
                || prompt_index.is_some_and(|index| {
                    projection
                        .user_prompt_index
                        .is_some_and(|previous| previous != index)
                });
            if begins_new_prompt {
                let block = new_block(&stream_id, sequence, "user", received_at);
                block_ops.push(open_operation("user", &block, None));
                projection.user = Some(block);
            } else if let Some(block) = &projection.user {
                block_ops.push(update_operation("user", block, None));
            }
            let (delta, complete) = content_text(update.get("content").unwrap_or(&Value::Null));
            if let Some(block) = projection.user.as_mut() {
                append_block_text(block, &delta, complete);
                block.updated_through = sequence;
            }
            if prompt_index.is_some() {
                projection.user_prompt_index = prompt_index;
            }
        }
        "agent_message_chunk" => {
            let (delta, complete) = content_text(update.get("content").unwrap_or(&Value::Null));
            // 空 tick 既不是内容，也不该打断正在累积的思考。放行的话，模型
            // 每次「想一点 → 空 tick → 再想一点」都会切出一个新的思考块，
            // 界面上就是一串碎片而不是一段连贯的思考。
            if delta.is_empty() {
                return;
            }
            close_block(&mut projection.user, "user", block_ops);
            close_block(&mut projection.thinking, "thinking", block_ops);
            project_stream_block(
                &stream_id,
                sequence,
                received_at,
                "assistant",
                &mut projection.assistant,
                &delta,
                complete,
                block_ops,
            );
        }
        "agent_thought_chunk" => {
            let (delta, complete) = content_text(update.get("content").unwrap_or(&Value::Null));
            // 同上：空的思考 tick 不该把正在流式输出的正文切断。
            if delta.is_empty() {
                return;
            }
            close_block(&mut projection.user, "user", block_ops);
            close_block(&mut projection.assistant, "assistant", block_ops);
            project_stream_block(
                &stream_id,
                sequence,
                received_at,
                "thinking",
                &mut projection.thinking,
                &delta,
                complete,
                block_ops,
            );
        }
        "tool_call" => {
            close_text_blocks(projection, block_ops);
            let source_id = update
                .get("toolCallId")
                .or_else(|| update.get("tool_call_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("host-tool-{sequence}"));
            if let Some(block) = projection.tools.get(&source_id) {
                block_ops.push(update_operation("tool", block, Some(source_id)));
            } else {
                let block = new_block(&stream_id, sequence, "tool", received_at);
                block_ops.push(open_operation("tool", &block, Some(source_id.clone())));
                projection.tools.insert(source_id, block);
            }
        }
        "tool_call_update" => {
            let Some(source_id) = update
                .get("toolCallId")
                .or_else(|| update.get("tool_call_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                return;
            };
            if let Some(block) = projection.tools.get(&source_id) {
                block_ops.push(update_operation("tool", block, Some(source_id)));
            } else {
                let block = new_block(&stream_id, sequence, "tool", received_at);
                block_ops.push(open_operation("tool", &block, Some(source_id.clone())));
                projection.tools.insert(source_id, block);
            }
        }
        "plan" => {
            close_block(&mut projection.user, "user", block_ops);
            if let Some(block) = &projection.plan {
                block_ops.push(update_operation("plan", block, None));
            } else {
                let block = new_block(&stream_id, sequence, "plan", received_at);
                block_ops.push(open_operation("plan", &block, None));
                projection.plan = Some(block);
            }
        }
        _ => {}
    }
}

fn prepare_projection_generation(state: &mut JournalState, generation: u64) -> bool {
    if generation < state.projection_generation {
        return false;
    }
    if generation > state.projection_generation {
        state.projection_generation = generation;
        state.projections.clear();
    }
    true
}

fn project_stream_block(
    stream_id: &str,
    sequence: u64,
    received_at: u64,
    block_type: &'static str,
    slot: &mut Option<OpenBlock>,
    delta: &str,
    delta_complete: bool,
    block_ops: &mut Vec<HostBlockOperation>,
) {
    if let Some(block) = slot {
        block_ops.push(update_operation(block_type, block, None));
    } else {
        let block = new_block(stream_id, sequence, block_type, received_at);
        block_ops.push(open_operation(block_type, &block, None));
        *slot = Some(block);
    }
    if let Some(block) = slot.as_mut() {
        append_block_text(block, delta, delta_complete);
        block.updated_through = sequence;
    }
}

fn close_text_blocks(projection: &mut SessionBlockState, ops: &mut Vec<HostBlockOperation>) {
    close_block(&mut projection.user, "user", ops);
    close_block(&mut projection.thinking, "thinking", ops);
    close_block(&mut projection.assistant, "assistant", ops);
    projection.user_prompt_index = None;
}

fn close_block(
    slot: &mut Option<OpenBlock>,
    block_type: &'static str,
    ops: &mut Vec<HostBlockOperation>,
) {
    let Some(block) = slot.take() else {
        return;
    };
    ops.push(HostBlockOperation {
        action: "close",
        block_type,
        block_id: block.id,
        source_id: None,
        started_at: Some(block.started_at),
    });
}

fn new_block(stream_id: &str, sequence: u64, suffix: &str, started_at: u64) -> OpenBlock {
    OpenBlock {
        id: format!("host-block-{stream_id}-{sequence}-{suffix}"),
        started_at,
        updated_through: sequence,
        text: String::new(),
        text_complete: true,
    }
}

fn append_block_text(block: &mut OpenBlock, delta: &str, delta_complete: bool) {
    let remaining = MAX_ACTIVE_BLOCK_TEXT_BYTES.saturating_sub(block.text.len());
    let mut end = remaining.min(delta.len());
    while end > 0 && !delta.is_char_boundary(end) {
        end -= 1;
    }
    block.text.push_str(&delta[..end]);
    if end < delta.len() || !delta_complete {
        block.text_complete = false;
    }
}

fn content_text(value: &Value) -> (String, bool) {
    fn append_str(text: &str, output: &mut String, complete: &mut bool) {
        let remaining = MAX_ACTIVE_BLOCK_TEXT_BYTES.saturating_sub(output.len());
        let mut end = remaining.min(text.len());
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        output.push_str(&text[..end]);
        if end < text.len() {
            *complete = false;
        }
    }

    fn append(value: &Value, depth: usize, output: &mut String, complete: &mut bool) {
        if depth > MAX_CONTENT_DEPTH || output.len() >= MAX_ACTIVE_BLOCK_TEXT_BYTES {
            *complete = false;
            return;
        }
        match value {
            Value::String(text) => append_str(text, output, complete),
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    append(item, depth + 1, output, complete);
                    if output.len() >= MAX_ACTIVE_BLOCK_TEXT_BYTES {
                        if index + 1 < items.len() {
                            *complete = false;
                        }
                        break;
                    }
                }
            }
            Value::Object(object) => {
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    if depth + 1 > MAX_CONTENT_DEPTH {
                        *complete = false;
                    } else {
                        append_str(text, output, complete);
                    }
                } else if let Some(content) = object.get("content") {
                    append(content, depth + 1, output, complete);
                }
            }
            _ => {}
        }
    }

    let mut output = String::new();
    let mut complete = true;
    append(value, 0, &mut output, &mut complete);
    (output, complete)
}

fn open_operation(
    block_type: &'static str,
    block: &OpenBlock,
    source_id: Option<String>,
) -> HostBlockOperation {
    HostBlockOperation {
        action: "open",
        block_type,
        block_id: block.id.clone(),
        source_id,
        started_at: Some(block.started_at),
    }
}

fn update_operation(
    block_type: &'static str,
    block: &OpenBlock,
    source_id: Option<String>,
) -> HostBlockOperation {
    HostBlockOperation {
        action: "update",
        block_type,
        block_id: block.id.clone(),
        source_id,
        started_at: None,
    }
}

impl HostSessionEvent {
    pub(crate) fn unsupported_response(&self) -> Option<&str> {
        self.unsupported_response.as_deref()
    }
}

struct DecodedInbound {
    session_id: Option<String>,
    method: Option<String>,
    update_type: Option<String>,
    projection: HostSessionProjection,
    unsupported_response: Option<String>,
}

#[cfg(test)]
fn decode(line: &str) -> DecodedInbound {
    let inbound = AcpInbound::parse(line);
    decode_inbound(inbound.as_ref())
}

fn decode_inbound(inbound: Result<&AcpInbound, &AcpInboundError>) -> DecodedInbound {
    let inbound = match inbound {
        Ok(inbound) => inbound,
        Err(error) => return protocol_error(error.code(), error.message()),
    };
    let Some(raw_method) = inbound.method() else {
        return if inbound.has_id() {
            DecodedInbound {
                session_id: None,
                method: None,
                update_type: None,
                projection: HostSessionProjection::OrphanResponse,
                unsupported_response: None,
            }
        } else {
            protocol_error("ACP_INVALID_MESSAGE", "ACP 消息既不是请求、通知也不是响应")
        };
    };
    let method = raw_method.to_string();
    let params = inbound.params();

    if inbound.has_id() {
        let id = inbound.id().unwrap_or(&Value::Null);
        let response = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Unsupported client method: {method}") },
        })
        .to_string();
        return DecodedInbound {
            session_id: session_id(params),
            method: Some(method.clone()),
            update_type: None,
            projection: HostSessionProjection::UnsupportedRequest { method },
            unsupported_response: Some(response),
        };
    }

    if matches!(
        method.as_str(),
        "session/update" | "x.ai/session/update" | "x.ai/session_notification"
    ) {
        let update = params.get("update").cloned();
        let Some(session_id) =
            session_id(params).or_else(|| update.as_ref().and_then(|update| session_id(update)))
        else {
            return DecodedInbound {
                session_id: None,
                method: Some(method.clone()),
                update_type: None,
                projection: HostSessionProjection::ProtocolError {
                    code: "ACP_MISSING_SESSION_ID",
                    message: format!("{method} 缺少 sessionId，事件已被隔离"),
                },
                unsupported_response: None,
            };
        };
        let Some(update) = update else {
            return DecodedInbound {
                session_id: Some(session_id),
                method: Some(method.clone()),
                update_type: None,
                projection: HostSessionProjection::ProtocolError {
                    code: "ACP_INVALID_SESSION_UPDATE",
                    message: format!("{method} 缺少 update，事件已被隔离"),
                },
                unsupported_response: None,
            };
        };
        if !update.is_object() {
            return DecodedInbound {
                session_id: Some(session_id),
                method: Some(method.clone()),
                update_type: None,
                projection: HostSessionProjection::ProtocolError {
                    code: "ACP_INVALID_SESSION_UPDATE",
                    message: format!("{method} 的 update 不是对象，事件已被隔离"),
                },
                unsupported_response: None,
            };
        }
        let update_type = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .map(str::to_string);
        let channel = if method == "x.ai/session_notification" {
            "notification"
        } else {
            "session"
        };
        return DecodedInbound {
            session_id: Some(session_id.clone()),
            method: Some(method),
            update_type: update_type.clone(),
            projection: HostSessionProjection::SessionUpdate {
                channel,
                session_id,
                update_type,
                update,
                block_ops: Vec::new(),
            },
            unsupported_response: None,
        };
    }

    DecodedInbound {
        session_id: session_id(params),
        method: Some(method.clone()),
        update_type: None,
        projection: HostSessionProjection::Notification {
            method,
            params: params.clone(),
        },
        unsupported_response: None,
    }
}

fn session_id(params: &Value) -> Option<String> {
    params
        .get("sessionId")
        .or_else(|| params.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= 512)
        .map(str::to_string)
}

fn protocol_error(code: &'static str, message: impl Into<String>) -> DecodedInbound {
    DecodedInbound {
        session_id: None,
        method: None,
        update_type: None,
        projection: HostSessionProjection::ProtocolError {
            code,
            message: message.into(),
        },
        unsupported_response: None,
    }
}

fn new_stream_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_ok() {
        return bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    }
    format!("fallback-{}-{}", std::process::id(), unix_time_ms())
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 协议合同测试：`fixtures/acp/` 下的原始 ACP 行经真实解码路径产出的
    /// HostSessionEvent JSON，就是 Rust↔TS 的协议边界。易变字段（streamId、
    /// 时间戳）归一化后与夹具中的黄金逐字节比对；TS 侧 `hostEventContract.test.ts`
    /// 消费同一份夹具做键集白名单。任一侧漂移（serde 字段改名、新增投影 kind、
    /// null 序列化策略变化）都会让对应测试变红。
    /// 重新生成黄金：`GROX_PROTOCOL_FIXTURE_REGEN=1 cargo test protocol_contract`
    fn normalized_host_event(event: &HostSessionEvent) -> serde_json::Value {
        let mut value = serde_json::to_value(event).expect("HostSessionEvent 必须可序列化");
        value["streamId"] = serde_json::Value::String("stream".into());
        value["generation"] = serde_json::Value::from(1);
        value["receivedAt"] = serde_json::Value::from(0);
        let block_ops = value
            .get_mut("projection")
            .and_then(|projection| projection.get_mut("blockOps"))
            .and_then(serde_json::Value::as_array_mut);
        if let Some(block_ops) = block_ops {
            for op in block_ops {
                if op.get("startedAt").is_some() {
                    op["startedAt"] = serde_json::Value::from(0);
                }
                // 块 id 内嵌随机 stream_id（new_block：host-block-{stream}-{seq}-{suffix}），
                // 归一化为固定前缀，保留序号与块类型。
                if let Some(id) = op.get("blockId").and_then(serde_json::Value::as_str) {
                    let parts: Vec<&str> = id.split('-').collect();
                    if parts.len() == 5 && parts[0] == "host" && parts[1] == "block" {
                        op["blockId"] = serde_json::Value::String(format!(
                            "host-block-stream-{}-{}",
                            parts[3], parts[4]
                        ));
                    }
                }
            }
        }
        value
    }

    #[test]
    fn protocol_contract_fixtures_match_host_event_shape() {
        let fixture_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/acp");
        let regen = std::env::var("GROX_PROTOCOL_FIXTURE_REGEN").is_ok();
        let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&fixture_dir)
            .expect("fixtures/acp 目录必须存在")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        assert!(!entries.is_empty(), "fixtures/acp 至少要有一个合同夹具");
        let mut checked = 0_usize;
        for entry in entries {
            let raw = std::fs::read_to_string(entry.path()).expect("夹具必须可读");
            let mut fixture: serde_json::Value = serde_json::from_str(&raw).expect("夹具必须是合法 JSON");
            let journal = SessionEventJournal::default();
            let mut events = Vec::new();
            for line in fixture["lines"].as_array().expect("夹具 lines 必须是数组") {
                events.push(journal.append(1, line.as_str().expect("夹具行必须是字符串").to_string()));
            }
            if let Some(lifecycle) = fixture.get("lifecycle").and_then(serde_json::Value::as_array) {
                for phase in lifecycle {
                    match phase.as_str().expect("lifecycle 条目必须是字符串") {
                        "turn_started" => events.push(journal.begin_turn(1, "s1")),
                        "turn_finished" => events.push(journal.finish_turn(1, "s1")),
                        other => panic!("未知 lifecycle 阶段：{other}"),
                    }
                }
            }
            let actual: Vec<serde_json::Value> = events.iter().map(normalized_host_event).collect();
            checked += actual.len();
            if regen {
                fixture["expected"] = serde_json::Value::Array(actual.clone());
                std::fs::write(
                    entry.path(),
                    format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap()),
                )
                .expect("夹具必须可写");
                continue;
            }
            let expected = fixture["expected"].as_array().expect("夹具 expected 必须是数组");
            assert_eq!(
                actual.as_slice(),
                expected.as_slice(),
                "协议夹具 {} 的 Host 事件形状漂移；如为有意变更，请同步 TS 侧 hostEventContract.test.ts 的白名单后用 GROX_PROTOCOL_FIXTURE_REGEN=1 重新生成",
                entry.file_name().to_string_lossy()
            );
        }
        assert!(
            checked >= 12,
            "合同夹具应覆盖全部投影 kind 与核心 updateType（当前只断言了 {checked} 个事件）"
        );
    }

    fn block_ops(event: &HostSessionEvent) -> &[HostBlockOperation] {
        match &event.projection {
            HostSessionProjection::SessionUpdate { block_ops, .. }
            | HostSessionProjection::BlockLifecycle { block_ops, .. } => block_ops,
            _ => &[],
        }
    }

    #[test]
    fn assigns_monotonic_sequence_and_extracts_session_identity() {
        let journal = SessionEventJournal::default();
        let first = journal.append(
            7,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"t"}}}}"#.into(),
        );
        let second = journal.append(
            7,
            r#"{"jsonrpc":"2.0","method":"x.ai/session_notification","params":{"sessionId":"s2","update":{"sessionUpdate":"turn_completed"}}}"#.into(),
        );

        assert_eq!(first.sequence, 1);
        assert_eq!(first.session_id.as_deref(), Some("s1"));
        assert_eq!(first.update_type.as_deref(), Some("agent_message_chunk"));
        assert_eq!(second.sequence, 2);
        assert_eq!(second.session_id.as_deref(), Some("s2"));
    }

    #[test]
    fn normalizes_wrapped_extension_metadata() {
        let decoded = decode(
            r#"{"method":"_x.ai/wrapped","params":{"method":"x.ai/session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call"}}}}"#,
        );
        assert_eq!(decoded.method.as_deref(), Some("x.ai/session/update"));
        assert_eq!(decoded.update_type.as_deref(), Some("tool_call"));
        assert!(matches!(
            decoded.projection,
            HostSessionProjection::SessionUpdate {
                channel: "session",
                session_id,
                ..
            } if session_id == "s1"
        ));
    }

    #[test]
    fn replay_resets_foreign_stream_and_pages_without_duplicates() {
        let journal = SessionEventJournal::default();
        for index in 0..3 {
            journal.append(1, format!(r#"{{"method":"notice/{index}"}}"#));
        }

        let first = journal.replay(Some("old-process"), 99, Some(2));
        assert!(first.reset);
        assert_eq!(first.events.len(), 2);
        assert!(first.has_more);
        let cursor = first.events.last().unwrap().sequence;
        let second = journal.replay(Some(&first.stream_id), cursor, Some(2));
        assert!(!second.reset);
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0].sequence, 3);
        assert!(!second.has_more);
    }

    #[test]
    fn malformed_json_remains_visible_but_is_classified() {
        let journal = SessionEventJournal::default();
        let event = journal.append(1, "not-json".into());
        assert!(matches!(
            &event.projection,
            HostSessionProjection::ProtocolError {
                code: "ACP_INVALID_JSON",
                ..
            }
        ));
        assert_eq!(
            journal.replay(Some(&event.stream_id), 0, None).events.len(),
            1
        );
    }

    #[test]
    fn unknown_client_request_is_rejected_without_exposing_rpc_id() {
        let journal = SessionEventJournal::default();
        let event = journal.append(
            4,
            r#"{"jsonrpc":"2.0","id":17,"method":"x.ai/unknown","params":{"sessionId":"s1"}}"#
                .into(),
        );

        assert!(matches!(
            &event.projection,
            HostSessionProjection::UnsupportedRequest { method }
                if method == "x.ai/unknown"
        ));
        assert_eq!(
            serde_json::from_str::<Value>(event.unsupported_response().unwrap()).unwrap()["id"],
            json!(17)
        );
        let public = serde_json::to_value(&event).unwrap();
        assert!(public.get("line").is_none());
        assert!(public.pointer("/projection/id").is_none());
    }

    #[test]
    fn public_projection_uses_webview_field_names() {
        let journal = SessionEventJournal::default();
        let event = journal.append(
            4,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"why"}}}}"#.into(),
        );

        let public = serde_json::to_value(event).unwrap();
        assert_eq!(public.pointer("/projection/sessionId"), Some(&json!("s1")));
        assert_eq!(
            public.pointer("/projection/updateType"),
            Some(&json!("agent_thought_chunk"))
        );
        assert!(public.pointer("/projection/blockOps/0/blockType").is_some());
        assert!(public.pointer("/projection/session_id").is_none());
        assert!(public.pointer("/projection/block_ops").is_none());
    }

    #[test]
    fn status_exposes_replay_window_without_event_bodies() {
        let journal = SessionEventJournal::default();
        journal.append(1, r#"{"method":"notice"}"#.into());
        let status = journal.status();
        assert_eq!(status.earliest_sequence, 1);
        assert_eq!(status.latest_sequence, 1);
        assert_eq!(status.retained_events, 1);
        assert!(status.retained_bytes > 0);
        assert_eq!(status.dropped_through, 0);
        assert_eq!(status.active_blocks, 0);
        assert_eq!(status.active_block_bytes, 0);
        assert_eq!(status.journal_recoverable_events, 0);
        assert_eq!(status.journal_acknowledged_events, 0);
    }

    #[test]
    fn keeps_stream_identity_stable_until_host_turn_finishes() {
        let journal = SessionEventJournal::default();
        journal.begin_turn(3, "s1");
        let first = journal.append(
            3,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a"}}}}"#.into(),
        );
        let second = journal.append(
            3,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"b"}}}}"#.into(),
        );
        assert_eq!(block_ops(&first)[0].action, "open");
        assert_eq!(block_ops(&second)[0].action, "update");
        assert_eq!(
            block_ops(&first)[0].block_id,
            block_ops(&second)[0].block_id
        );

        let finished = journal.finish_turn(3, "s1");
        assert_eq!(block_ops(&finished)[0].action, "close");
        assert_eq!(
            block_ops(&finished)[0].block_id,
            block_ops(&first)[0].block_id
        );

        journal.begin_turn(3, "s1");
        let next = journal.append(
            3,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"c"}}}}"#.into(),
        );
        assert_eq!(block_ops(&next)[0].action, "open");
        assert_ne!(block_ops(&next)[0].block_id, block_ops(&first)[0].block_id);
    }

    #[test]
    fn empty_ticks_do_not_fragment_a_thinking_run() {
        // 模型常见地「想一点 → 空 tick → 再想一点」。若空 tick 也关闭思考块，
        // 界面上就会出现思考 1 / 思考 2 / 思考 3 一串碎片。
        let journal = SessionEventJournal::default();
        let first = journal.append(
            5,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"先想一点"}}}}"#.into(),
        );
        let thinking_id = block_ops(&first)[0].block_id.clone();

        // 空的正文 tick：不产生任何块操作。
        let empty = journal.append(
            5,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":""}}}}"#.into(),
        );
        assert!(
            block_ops(&empty).is_empty(),
            "空 tick 不能产生块操作：{:?}",
            block_ops(&empty)
        );

        // 后续思考必须回到同一个块，而不是新开一个。
        let second = journal.append(
            5,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"再想一点"}}}}"#.into(),
        );
        assert_eq!(block_ops(&second)[0].action, "update");
        assert_eq!(block_ops(&second)[0].block_id, thinking_id);

        // 真正有内容的正文才结束这段思考。
        let body = journal.append(
            5,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"答案"}}}}"#.into(),
        );
        let ops = block_ops(&body);
        assert!(
            ops.iter().any(|op| op.action == "close" && op.block_id == thinking_id),
            "有内容的正文应当结束思考块：{ops:?}"
        );
    }

    #[test]
    fn isolates_parallel_session_projection_state() {
        let journal = SessionEventJournal::default();
        let first = journal.append(
            9,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"t"}}}}"#.into(),
        );
        let second = journal.append(
            9,
            r#"{"method":"session/update","params":{"sessionId":"s2","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"t"}}}}"#.into(),
        );
        assert_ne!(
            block_ops(&first)[0].block_id,
            block_ops(&second)[0].block_id
        );

        let finished = journal.finish_turn(9, "s1");
        assert_eq!(block_ops(&finished).len(), 1);
        assert_eq!(
            block_ops(&finished)[0].block_id,
            block_ops(&first)[0].block_id
        );
        let continued = journal.append(
            9,
            r#"{"method":"session/update","params":{"sessionId":"s2","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"t"}}}}"#.into(),
        );
        assert_eq!(block_ops(&continued)[0].action, "update");
        assert_eq!(
            block_ops(&continued)[0].block_id,
            block_ops(&second)[0].block_id
        );
    }

    #[test]
    fn session_reset_prevents_tool_blocks_from_reviving() {
        let journal = SessionEventJournal::default();
        let opened = journal.append(
            4,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"call-1"}}}"#.into(),
        );
        let updated = journal.append(
            4,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1"}}}"#.into(),
        );
        assert_eq!(
            block_ops(&opened)[0].block_id,
            block_ops(&updated)[0].block_id
        );

        journal.reset_session(4, "s1");
        let replayed = journal.append(
            4,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1"}}}"#.into(),
        );
        assert_eq!(block_ops(&replayed)[0].action, "open");
        assert_ne!(
            block_ops(&opened)[0].block_id,
            block_ops(&replayed)[0].block_id
        );
    }

    #[test]
    fn stale_generation_lifecycle_cannot_close_new_runtime_blocks() {
        let journal = SessionEventJournal::default();
        journal.append(
            5,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"t"}}}}"#.into(),
        );
        let current = journal.append(
            6,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"t"}}}}"#.into(),
        );
        assert_eq!(block_ops(&current)[0].action, "open");

        let stale_finish = journal.finish_turn(5, "s1");
        assert!(block_ops(&stale_finish).is_empty());
        let continued = journal.append(
            6,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"t"}}}}"#.into(),
        );
        assert_eq!(block_ops(&continued)[0].action, "update");
        assert_eq!(
            block_ops(&continued)[0].block_id,
            block_ops(&current)[0].block_id
        );
    }

    #[test]
    fn replay_includes_complete_active_text_snapshot_after_cursor() {
        let journal = SessionEventJournal::default();
        let first = journal.append(
            8,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}}}"#.into(),
        );
        let second = journal.append(
            8,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":[{"type":"text","text":"world"}]}}}"#.into(),
        );

        let replay = journal.replay(Some(&second.stream_id), second.sequence, None);
        assert!(replay.events.is_empty());
        assert_eq!(replay.active_blocks.len(), 1);
        let active = &replay.active_blocks[0];
        assert_eq!(active.session_id, "s1");
        assert_eq!(active.block_type, "assistant");
        assert_eq!(active.block_id, block_ops(&first)[0].block_id);
        assert_eq!(active.updated_through, second.sequence);
        assert_eq!(active.text, "hello world");
        assert!(active.text_complete);
        let status = journal.status();
        assert_eq!(status.active_blocks, 1);
        assert_eq!(status.active_block_bytes, "hello world".len());

        journal.finish_turn(8, "s1");
        assert!(journal
            .replay(Some(&second.stream_id), second.sequence, None)
            .active_blocks
            .is_empty());
        assert_eq!(journal.status().active_block_bytes, 0);
    }

    #[test]
    fn journal_acknowledgement_is_exact_session_scoped_and_replay_visible() {
        let journal = SessionEventJournal::default();
        let transcript = journal.append(
            8,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"saved"}}}}"#.into(),
        );
        let workflow = journal.append(
            8,
            r#"{"method":"x.ai/session_notification","params":{"sessionId":"s1","update":{"sessionUpdate":"workflow_updated","runId":"wf1"}}}"#.into(),
        );
        let removed = journal.remove_session(8, "s1");
        assert!(transcript.journal_recoverable);
        assert!(!workflow.journal_recoverable);
        assert!(!removed.journal_recoverable);

        assert_eq!(
            journal.acknowledge_session_events(
                &transcript.stream_id,
                "other-session",
                &[transcript.sequence]
            ),
            0
        );
        assert_eq!(
            journal.acknowledge_session_events(
                &transcript.stream_id,
                "s1",
                &[transcript.sequence, workflow.sequence]
            ),
            1
        );

        let replay = journal.replay(Some(&transcript.stream_id), 0, None);
        assert!(replay.events[0].journal_acknowledged);
        assert!(!replay.events[1].journal_acknowledged);
        let status = journal.status();
        assert_eq!(status.journal_recoverable_events, 1);
        assert_eq!(status.journal_acknowledged_events, 1);
    }

    #[test]
    fn replay_only_returns_active_snapshot_on_final_page() {
        let journal = SessionEventJournal::default();
        let first = journal.append(
            9,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"first"}}}}"#.into(),
        );
        journal.append(
            9,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"available_commands_update","availableCommands":[]}}}"#.into(),
        );

        let first_page = journal.replay(Some(&first.stream_id), 0, Some(1));
        assert!(first_page.has_more);
        assert!(first_page.active_blocks.is_empty());

        let final_page = journal.replay(
            Some(&first.stream_id),
            first_page.events[0].sequence,
            Some(1),
        );
        assert!(!final_page.has_more);
        assert_eq!(final_page.active_blocks.len(), 1);
        assert_eq!(final_page.active_blocks[0].text, "first");
    }

    #[test]
    fn active_snapshots_are_isolated_by_session() {
        let journal = SessionEventJournal::default();
        let first = journal.append(
            10,
            r#"{"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"alpha"}}}}"#.into(),
        );
        journal.append(
            10,
            r#"{"method":"session/update","params":{"sessionId":"s2","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"beta"}}}}"#.into(),
        );

        let mut snapshots = journal
            .replay(Some(&first.stream_id), u64::MAX, None)
            .active_blocks;
        snapshots.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].session_id, "s1");
        assert_eq!(snapshots[0].block_type, "assistant");
        assert_eq!(snapshots[0].text, "alpha");
        assert_eq!(snapshots[1].session_id, "s2");
        assert_eq!(snapshots[1].block_type, "thinking");
        assert_eq!(snapshots[1].text, "beta");
    }

    #[test]
    fn active_text_snapshot_is_bounded_without_splitting_utf8() {
        let mut block = new_block("stream", 1, "assistant", 1);
        let text = "好".repeat(MAX_ACTIVE_BLOCK_TEXT_BYTES);
        append_block_text(&mut block, &text, true);
        assert!(block.text.len() <= MAX_ACTIVE_BLOCK_TEXT_BYTES);
        assert!(block.text.is_char_boundary(block.text.len()));
        assert!(!block.text_complete);
    }
}
