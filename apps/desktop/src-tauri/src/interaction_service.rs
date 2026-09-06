//! Agent 反向交互请求的 Host 生命周期。
//!
//! 权限、计划审批和结构化提问都属于 Agent -> Client 的 JSON-RPC 请求。
//! rpc id、可选 wire option 以及进程代次必须由持有 stdio 的 Host 保存；
//! WebView 只拿不透明 block id 做界面投影，不能自行拼装或重放协议回复。

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::{
    acp_host::AcpHostError,
    acp_inbound::AcpInbound,
};

const MAX_RESOLVED_TOMBSTONES: usize = 2_048;
const MAX_PENDING_INTERACTIONS: usize = 256;
const MAX_INTERACTION_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_FEEDBACK_CHARS: usize = 16_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InteractionKind {
    Permission,
    Plan,
    Question,
}

impl InteractionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Plan => "plan",
            Self::Question => "question",
        }
    }

    fn cancelled_result(self) -> Value {
        match self {
            Self::Permission => json!({ "outcome": { "outcome": "cancelled" } }),
            Self::Plan | Self::Question => json!({ "outcome": "cancelled" }),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionProjection {
    pub(crate) block_id: String,
    pub(crate) session_id: String,
    pub(crate) kind: &'static str,
    pub(crate) params: Value,
}

#[derive(Clone, Debug)]
struct PendingInteraction {
    projection: InteractionProjection,
    params: Value,
    generation: u64,
    rpc_id: Value,
    rpc_key: String,
    kind: InteractionKind,
    resolving: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct InteractionReplyLease {
    pub(crate) block_id: String,
    pub(crate) session_id: String,
    pub(crate) kind: &'static str,
    pub(crate) generation: u64,
    pub(crate) line: String,
    pub(crate) permission_audit: Option<PermissionAuditRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionAuditRecord {
    pub(crate) session_id: String,
    pub(crate) block_id: String,
    pub(crate) generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_kind: Option<String>,
    pub(crate) decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) wire_option_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum InteractionInbound {
    NotInteraction,
    Opened(InteractionProjection),
    AutoReply(String),
    Duplicate,
}

#[derive(Default)]
struct RegistryState {
    generation: u64,
    pending: BTreeMap<String, PendingInteraction>,
    rpc_index: BTreeMap<String, String>,
    cancelled_sessions: BTreeSet<String>,
    resolved: BTreeSet<String>,
    resolved_order: VecDeque<String>,
}

#[derive(Default)]
pub(crate) struct InteractionRegistry {
    state: Mutex<RegistryState>,
    write_lock: tokio::sync::Mutex<()>,
    next_block_id: AtomicU64,
}

impl InteractionRegistry {
    pub(crate) async fn lock_writes(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.write_lock.lock().await
    }

    pub(crate) fn reset(&self, generation: u64) {
        let mut state = self.lock();
        state.generation = generation;
        state.pending.clear();
        state.rpc_index.clear();
        state.cancelled_sessions.clear();
        state.resolved.clear();
        state.resolved_order.clear();
    }

    #[cfg(test)]
    pub(crate) fn observe_inbound(&self, generation: u64, line: &str) -> InteractionInbound {
        let Ok(message) = AcpInbound::parse(line) else {
            return InteractionInbound::NotInteraction;
        };
        self.observe_decoded_inbound(generation, &message)
    }

    pub(crate) fn observe_decoded_inbound(
        &self,
        generation: u64,
        message: &AcpInbound,
    ) -> InteractionInbound {
        let Some(method) = message.method() else {
            return InteractionInbound::NotInteraction;
        };
        let params = message.params();
        let Some(kind) = interaction_kind(method) else {
            return InteractionInbound::NotInteraction;
        };
        let Some(rpc_id) = valid_rpc_id(message.id()) else {
            // 没有合法 id 的消息不是可回复请求；让普通协议诊断通道处理。
            return InteractionInbound::NotInteraction;
        };
        let rpc_key = rpc_id_key(&rpc_id);
        let session_id = params
            .get("sessionId")
            .or_else(|| params.get("session_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.chars().count() <= 512)
            .map(str::to_string);
        let Some(session_id) = session_id else {
            return InteractionInbound::AutoReply(response_line(&rpc_id, kind.cancelled_result()));
        };
        if !valid_interaction_payload(kind, params) {
            return InteractionInbound::AutoReply(response_line(&rpc_id, kind.cancelled_result()));
        }

        let mut state = self.lock();
        if state.generation != generation || state.cancelled_sessions.contains(&session_id) {
            return InteractionInbound::AutoReply(response_line(&rpc_id, kind.cancelled_result()));
        }
        if state.pending.len() >= MAX_PENDING_INTERACTIONS {
            return InteractionInbound::AutoReply(response_line(&rpc_id, kind.cancelled_result()));
        }
        if state.rpc_index.contains_key(&rpc_key) {
            // 同一代次的 rpc id 在完成前必须唯一。不能回复冲突的新请求，
            // 否则一次响应可能错误解除原门控。
            return InteractionInbound::Duplicate;
        }

        let sequence = self.next_block_id.fetch_add(1, Ordering::Relaxed) + 1;
        let block_id = format!("interaction-{generation}-{sequence}");
        let projection = InteractionProjection {
            block_id: block_id.clone(),
            session_id,
            kind: kind.as_str(),
            params: public_params(kind, params),
        };
        state.rpc_index.insert(rpc_key.clone(), block_id.clone());
        state.pending.insert(
            block_id,
            PendingInteraction {
                projection: projection.clone(),
                params: params.clone(),
                generation,
                rpc_id,
                rpc_key,
                kind,
                resolving: false,
            },
        );
        InteractionInbound::Opened(projection)
    }

    pub(crate) fn snapshots(&self) -> Vec<InteractionProjection> {
        self.lock()
            .pending
            .values()
            .map(|pending| pending.projection.clone())
            .collect()
    }

    pub(crate) fn claim_resolution(
        &self,
        session_id: &str,
        block_id: &str,
        decision: &Value,
    ) -> Result<InteractionReplyLease, AcpHostError> {
        validate_decision_size(decision)?;
        let mut state = self.lock();
        if state.resolved.contains(block_id) {
            return Err(AcpHostError::operation(
                "INTERACTION_ALREADY_RESOLVED",
                "该交互请求已经处理，不能重复回复",
            ));
        }
        let pending = state.pending.get_mut(block_id).ok_or_else(|| {
            AcpHostError::operation(
                "INTERACTION_EXPIRED",
                "交互请求已失效；不会把本次操作发送到其它会话",
            )
        })?;
        if pending.projection.session_id != session_id {
            return Err(AcpHostError::operation(
                "INTERACTION_SESSION_MISMATCH",
                "交互请求不属于当前会话",
            ));
        }
        if pending.resolving {
            return Err(AcpHostError::operation(
                "INTERACTION_RESPONSE_IN_PROGRESS",
                "交互回复正在发送，请勿重复操作",
            ));
        }
        let result = build_result(pending, decision)?;
        let permission_audit = (pending.kind == InteractionKind::Permission)
            .then(|| permission_audit_record(pending, block_id, decision, &result));
        pending.resolving = true;
        Ok(InteractionReplyLease {
            block_id: block_id.to_string(),
            session_id: session_id.to_string(),
            kind: pending.kind.as_str(),
            generation: pending.generation,
            line: response_line(&pending.rpc_id, result),
            permission_audit,
        })
    }

    pub(crate) fn claim_session_cancellations(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Vec<InteractionReplyLease> {
        let mut state = self.lock();
        if state.generation != generation {
            return Vec::new();
        }
        state.cancelled_sessions.insert(session_id.to_string());
        state
            .pending
            .values_mut()
            .filter(|pending| {
                pending.generation == generation
                    && pending.projection.session_id == session_id
                    && !pending.resolving
            })
            .map(|pending| {
                pending.resolving = true;
                InteractionReplyLease {
                    block_id: pending.projection.block_id.clone(),
                    session_id: pending.projection.session_id.clone(),
                    kind: pending.kind.as_str(),
                    generation,
                    line: response_line(&pending.rpc_id, pending.kind.cancelled_result()),
                    permission_audit: None,
                }
            })
            .collect()
    }

    pub(crate) fn begin_session_turn(&self, session_id: &str, generation: u64) {
        let mut state = self.lock();
        if state.generation == generation {
            state.cancelled_sessions.remove(session_id);
        }
    }

    /// 成功写入和写入结果不确定都会终结这个 block id。后者绝不能自动重发
    /// “允许”决定；用户只能在 Agent 重新发出新门控后再次操作。
    pub(crate) fn settle(&self, lease: &InteractionReplyLease) -> bool {
        let mut state = self.lock();
        let matches = state.pending.get(&lease.block_id).is_some_and(|pending| {
            pending.generation == lease.generation
                && pending.projection.session_id == lease.session_id
                && pending.resolving
        });
        if !matches {
            return false;
        }
        let pending = state
            .pending
            .remove(&lease.block_id)
            .expect("checked pending interaction");
        state.rpc_index.remove(&pending.rpc_key);
        remember_resolved(&mut state, lease.block_id.clone());
        true
    }

    pub(crate) fn release_claim(&self, lease: &InteractionReplyLease) {
        let mut state = self.lock();
        if let Some(pending) = state.pending.get_mut(&lease.block_id) {
            if pending.generation == lease.generation
                && pending.projection.session_id == lease.session_id
            {
                pending.resolving = false;
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn permission_audit_record(
    pending: &PendingInteraction,
    block_id: &str,
    decision: &Value,
    result: &Value,
) -> PermissionAuditRecord {
    let bounded = |value: &str| value.chars().take(256).collect::<String>();
    PermissionAuditRecord {
        session_id: bounded(&pending.projection.session_id),
        block_id: bounded(block_id),
        generation: pending.generation,
        tool_call_id: pending
            .params
            .pointer("/toolCall/toolCallId")
            .or_else(|| pending.params.get("toolCallId"))
            .and_then(Value::as_str)
            .map(bounded),
        tool_kind: pending
            .params
            .pointer("/toolCall/kind")
            .and_then(Value::as_str)
            .map(bounded),
        decision: decision
            .get("option")
            .and_then(Value::as_str)
            .map(bounded)
            .unwrap_or_else(|| "unknown".into()),
        wire_option_id: result
            .pointer("/outcome/optionId")
            .and_then(Value::as_str)
            .map(bounded),
    }
}

fn interaction_kind(method: &str) -> Option<InteractionKind> {
    match method {
        "session/request_permission" => Some(InteractionKind::Permission),
        "x.ai/exit_plan_mode" => Some(InteractionKind::Plan),
        "x.ai/ask_user_question" => Some(InteractionKind::Question),
        _ => None,
    }
}

fn valid_rpc_id(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(value) if !value.is_empty() && value.chars().count() <= 256 => {
            Some(Value::String(value.clone()))
        }
        Value::Number(value) => Some(Value::Number(value.clone())),
        _ => None,
    }
}

fn rpc_id_key(value: &Value) -> String {
    match value {
        Value::String(value) => format!("s:{value}"),
        Value::Number(value) => format!("n:{value}"),
        _ => unreachable!("rpc id validated before indexing"),
    }
}

fn valid_interaction_payload(kind: InteractionKind, params: &Value) -> bool {
    let Some(params) = params.as_object() else {
        return false;
    };
    match kind {
        InteractionKind::Permission => params
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|options| !options.is_empty()),
        InteractionKind::Plan => true,
        InteractionKind::Question => params
            .get("questions")
            .and_then(Value::as_array)
            .is_some_and(|questions| {
                questions.iter().any(|question| {
                    question
                        .get("question")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                })
            }),
    }
}

fn validate_decision_size(decision: &Value) -> Result<(), AcpHostError> {
    let size = serde_json::to_vec(decision)
        .map_err(|error| {
            AcpHostError::protocol(
                "INTERACTION_RESPONSE_INVALID",
                format!("交互回复不是合法 JSON：{error}"),
            )
        })?
        .len();
    if size > MAX_INTERACTION_RESPONSE_BYTES {
        return Err(AcpHostError::operation(
            "INTERACTION_RESPONSE_TOO_LARGE",
            "交互回复过大，已拒绝发送",
        ));
    }
    Ok(())
}

fn build_result(pending: &PendingInteraction, decision: &Value) -> Result<Value, AcpHostError> {
    match pending.kind {
        InteractionKind::Permission => build_permission_result(&pending.params, decision),
        InteractionKind::Plan => build_plan_result(decision),
        InteractionKind::Question => build_question_result(&pending.params, decision),
    }
}

fn public_params(kind: InteractionKind, params: &Value) -> Value {
    let mut public = params.clone();
    let Some(object) = public.as_object_mut() else {
        return public;
    };
    object.remove("_meta");
    if kind == InteractionKind::Permission {
        for option in object
            .get_mut("options")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(option) = option.as_object_mut() {
                let semantic = permission_option_semantic(&Value::Object(option.clone()));
                option.remove("optionId");
                option.remove("option_id");
                option.remove("_meta");
                if let Some(semantic) = semantic {
                    option.insert("kind".into(), Value::String(semantic.into()));
                }
            }
        }
    }
    public
}

fn build_permission_result(params: &Value, decision: &Value) -> Result<Value, AcpHostError> {
    let option = decision
        .get("option")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AcpHostError::operation("INTERACTION_RESPONSE_INVALID", "权限回复缺少 option")
        })?;
    let wanted = match option {
        "allow_once" => "allow_once",
        "allow_always" => "allow_always",
        "deny" => "deny",
        _ => {
            return Err(AcpHostError::operation(
                "INTERACTION_RESPONSE_INVALID",
                "权限回复包含未知选项",
            ))
        }
    };
    let option_id = params
        .get("options")
        .and_then(Value::as_array)
        .and_then(|options| {
            options.iter().find_map(|option| {
                let option_id = option
                    .get("optionId")
                    .or_else(|| option.get("option_id"))
                    .and_then(Value::as_str)?;
                let matches = permission_option_semantic(option) == Some(wanted);
                matches.then(|| option_id.to_string())
            })
        })
        .or_else(|| (wanted == "deny").then(String::new))
        .ok_or_else(|| {
            AcpHostError::operation(
                "INTERACTION_OPTION_EXPIRED",
                "Agent 没有提供该权限选项；不会发送猜测的 optionId",
            )
        })?;
    if option_id.is_empty() {
        return Ok(json!({ "outcome": { "outcome": "cancelled" } }));
    }
    Ok(json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id,
        }
    }))
}

fn permission_option_semantic(option: &Value) -> Option<&'static str> {
    let kind = option
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    match kind.as_str() {
        "allow_once" => return Some("allow_once"),
        "allow_always" => return Some("allow_always"),
        "reject_once" | "reject_always" | "deny" => return Some("deny"),
        _ if !kind.is_empty() => return None,
        _ => {}
    }
    let id = option
        .get("optionId")
        .or_else(|| option.get("option_id"))
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    if id.contains("reject") || id.contains("deny") {
        Some("deny")
    } else if id.contains("allow") && id.contains("always") {
        Some("allow_always")
    } else if id.contains("allow") {
        Some("allow_once")
    } else {
        None
    }
}

fn build_plan_result(decision: &Value) -> Result<Value, AcpHostError> {
    let option = decision
        .get("option")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AcpHostError::operation("INTERACTION_RESPONSE_INVALID", "计划回复缺少 option")
        })?;
    match option {
        "allow_once" | "allow_always" => Ok(json!({ "outcome": "approved" })),
        "deny" => {
            let feedback = decision
                .get("feedback")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(MAX_FEEDBACK_CHARS).collect::<String>());
            Ok(match feedback {
                Some(feedback) => json!({ "outcome": "cancelled", "feedback": feedback }),
                None => json!({ "outcome": "cancelled" }),
            })
        }
        _ => Err(AcpHostError::operation(
            "INTERACTION_RESPONSE_INVALID",
            "计划回复包含未知选项",
        )),
    }
}

fn build_question_result(params: &Value, decision: &Value) -> Result<Value, AcpHostError> {
    let outcome = decision
        .get("outcome")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AcpHostError::operation("INTERACTION_RESPONSE_INVALID", "问题回复缺少 outcome")
        })?;
    if outcome == "cancelled" {
        return Ok(json!({ "outcome": "cancelled" }));
    }
    if matches!(outcome, "chat_about_this" | "skip_interview") {
        let partial = checked_string_map(decision.get("partialAnswers"), question_names(params))?;
        return Ok(json!({
            "outcome": outcome,
            "partial_answers": partial,
        }));
    }
    if outcome != "accepted" {
        return Err(AcpHostError::operation(
            "INTERACTION_RESPONSE_INVALID",
            "问题回复包含未知 outcome",
        ));
    }

    let allowed = question_names(params);
    let answers = checked_answers(decision.get("answers"), &allowed)?;
    if answers.is_empty() {
        return Err(AcpHostError::operation(
            "INTERACTION_RESPONSE_INVALID",
            "至少需要回答一个问题",
        ));
    }
    let notes = checked_string_map(decision.get("notes"), allowed.clone())?;
    let annotations = question_annotations(params, &answers, &notes);
    Ok(if annotations.is_empty() {
        json!({ "outcome": "accepted", "answers": answers })
    } else {
        json!({
            "outcome": "accepted",
            "answers": answers,
            "annotations": annotations,
        })
    })
}

fn question_names(params: &Value) -> BTreeSet<String> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|question| question.get("question").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn checked_answers(
    value: Option<&Value>,
    allowed: &BTreeSet<String>,
) -> Result<Map<String, Value>, AcpHostError> {
    let object = value.and_then(Value::as_object).ok_or_else(|| {
        AcpHostError::operation("INTERACTION_RESPONSE_INVALID", "问题回复缺少 answers")
    })?;
    let mut result = Map::new();
    for (question, answer) in object {
        if !allowed.contains(question) {
            return Err(AcpHostError::operation(
                "INTERACTION_QUESTION_MISMATCH",
                "回答包含不属于当前门控的问题",
            ));
        }
        let values = answer.as_array().ok_or_else(|| {
            AcpHostError::operation("INTERACTION_RESPONSE_INVALID", "问题答案必须是字符串数组")
        })?;
        let values = values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(|value| Value::String(value.chars().take(MAX_FEEDBACK_CHARS).collect()))
                    .ok_or_else(|| {
                        AcpHostError::operation(
                            "INTERACTION_RESPONSE_INVALID",
                            "问题答案必须是字符串数组",
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if !values.is_empty() {
            result.insert(question.clone(), Value::Array(values));
        }
    }
    Ok(result)
}

fn checked_string_map(
    value: Option<&Value>,
    allowed: BTreeSet<String>,
) -> Result<Map<String, Value>, AcpHostError> {
    let mut result = Map::new();
    let Some(object) = value.and_then(Value::as_object) else {
        return Ok(result);
    };
    for (question, answer) in object {
        if !allowed.contains(question) {
            return Err(AcpHostError::operation(
                "INTERACTION_QUESTION_MISMATCH",
                "回复包含不属于当前门控的问题",
            ));
        }
        let Some(answer) = answer.as_str() else {
            return Err(AcpHostError::operation(
                "INTERACTION_RESPONSE_INVALID",
                "补充回答必须是字符串",
            ));
        };
        let answer = answer.trim();
        if !answer.is_empty() {
            result.insert(
                question.clone(),
                Value::String(answer.chars().take(MAX_FEEDBACK_CHARS).collect()),
            );
        }
    }
    Ok(result)
}

fn question_annotations(
    params: &Value,
    answers: &Map<String, Value>,
    notes: &Map<String, Value>,
) -> Map<String, Value> {
    let mut result = Map::new();
    for question in params
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(text) = question.get("question").and_then(Value::as_str) else {
            continue;
        };
        let selected = answers
            .get(text)
            .and_then(Value::as_array)
            .and_then(|values| values.first())
            .and_then(Value::as_str);
        let preview = selected.and_then(|selected| {
            question
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|option| option.get("label").and_then(Value::as_str) == Some(selected))
                .and_then(|option| option.get("preview"))
                .and_then(Value::as_str)
        });
        let note = notes.get(text).and_then(Value::as_str);
        if preview.is_some() || note.is_some() {
            let mut annotation = Map::new();
            if let Some(preview) = preview {
                annotation.insert("preview".into(), Value::String(preview.to_string()));
            }
            if let Some(note) = note {
                annotation.insert("notes".into(), Value::String(note.to_string()));
            }
            result.insert(text.to_string(), Value::Object(annotation));
        }
    }
    result
}

fn response_line(rpc_id: &Value, result: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": result,
    })
    .to_string()
}

fn remember_resolved(state: &mut RegistryState, block_id: String) {
    if state.resolved.insert(block_id.clone()) {
        state.resolved_order.push_back(block_id);
    }
    while state.resolved_order.len() > MAX_RESOLVED_TOMBSTONES {
        if let Some(expired) = state.resolved_order.pop_front() {
            state.resolved.remove(&expired);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permission_line(id: Value) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": { "toolCallId": "tool-1", "title": "Run" },
                "options": [
                    { "optionId": "once-wire", "kind": "allow_once" },
                    { "optionId": "always-wire", "kind": "allow_always" },
                    { "optionId": "deny-wire", "kind": "reject_once" }
                ]
            }
        })
        .to_string()
    }

    #[test]
    fn host_projection_hides_rpc_id_and_uses_authoritative_wire_option() {
        let registry = InteractionRegistry::default();
        registry.reset(7);
        let InteractionInbound::Opened(opened) =
            registry.observe_inbound(7, &permission_line(json!(9)))
        else {
            panic!("expected opened interaction");
        };
        let public = serde_json::to_value(&opened).unwrap();
        assert!(public.get("rpcId").is_none());
        assert_eq!(public["blockId"], "interaction-7-1");
        assert!(!public.to_string().contains("once-wire"));
        assert_eq!(public["params"]["options"][0]["kind"], "allow_once");

        let lease = registry
            .claim_resolution("s1", &opened.block_id, &json!({ "option": "allow_always" }))
            .unwrap();
        let response: Value = serde_json::from_str(&lease.line).unwrap();
        assert_eq!(response["id"], 9);
        assert_eq!(response["result"]["outcome"]["optionId"], "always-wire");
        assert!(registry.settle(&lease));
        assert_eq!(
            registry
                .claim_resolution("s1", &opened.block_id, &json!({ "option": "allow_once" }))
                .unwrap_err()
                .code,
            "INTERACTION_ALREADY_RESOLVED"
        );

        let InteractionInbound::Opened(denied) =
            registry.observe_inbound(7, &permission_line(json!(10)))
        else {
            panic!("expected second interaction");
        };
        let lease = registry
            .claim_resolution("s1", &denied.block_id, &json!({ "option": "deny" }))
            .unwrap();
        let response: Value = serde_json::from_str(&lease.line).unwrap();
        assert_eq!(response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(response["result"]["outcome"]["optionId"], "deny-wire");
    }

    #[test]
    fn scoped_grok_build_options_keep_host_owned_wire_ids() {
        assert_eq!(
            permission_option_semantic(&json!({
                "optionId": "allow-always-mcp",
                "name": "Always allow this MCP tool"
            })),
            Some("allow_always")
        );
        let registry = InteractionRegistry::default();
        registry.reset(9);
        let line = json!({
            "jsonrpc": "2.0",
            "id": 33,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": {
                    "toolCallId": "tool-9",
                    "kind": "execute",
                    "rawInput": { "command": "secret --token hidden" }
                },
                "options": [
                    { "optionId": "allow-once", "kind": "allow_once" },
                    { "optionId": "allow-always-command", "kind": "allow_always", "_meta": { "scope": "bash" } },
                    { "optionId": "reject-once", "kind": "reject_once" }
                ]
            }
        })
        .to_string();
        let InteractionInbound::Opened(opened) = registry.observe_inbound(9, &line) else {
            panic!("expected opened permission");
        };
        assert_eq!(opened.params["options"][1]["kind"], "allow_always");
        assert!(opened.params["options"][1].get("optionId").is_none());
        assert!(opened.params["options"][1].get("_meta").is_none());

        let lease = registry
            .claim_resolution("s1", &opened.block_id, &json!({ "option": "allow_always" }))
            .unwrap();
        let response: Value = serde_json::from_str(&lease.line).unwrap();
        assert_eq!(
            response["result"]["outcome"]["optionId"],
            "allow-always-command"
        );
        let audit = lease.permission_audit.unwrap();
        assert_eq!(audit.decision, "allow_always");
        assert_eq!(
            audit.wire_option_id.as_deref(),
            Some("allow-always-command")
        );
        assert_eq!(audit.tool_kind.as_deref(), Some("execute"));
        assert!(!serde_json::to_string(&audit).unwrap().contains("secret"));
    }

    #[test]
    fn stale_session_and_concurrent_double_click_cannot_reply() {
        let registry = InteractionRegistry::default();
        registry.reset(3);
        let InteractionInbound::Opened(opened) =
            registry.observe_inbound(3, &permission_line(json!(4)))
        else {
            panic!("expected opened interaction");
        };
        assert_eq!(
            registry
                .claim_resolution(
                    "other",
                    &opened.block_id,
                    &json!({ "option": "allow_once" })
                )
                .unwrap_err()
                .code,
            "INTERACTION_SESSION_MISMATCH"
        );
        let lease = registry
            .claim_resolution("s1", &opened.block_id, &json!({ "option": "allow_once" }))
            .unwrap();
        assert_eq!(
            registry
                .claim_resolution("s1", &opened.block_id, &json!({ "option": "allow_once" }))
                .unwrap_err()
                .code,
            "INTERACTION_RESPONSE_IN_PROGRESS"
        );
        registry.release_claim(&lease);
        assert!(registry
            .claim_resolution("s1", &opened.block_id, &json!({ "option": "allow_once" }))
            .is_ok());
    }

    #[test]
    fn generation_reset_expires_old_gate_and_distinguishes_string_ids() {
        let registry = InteractionRegistry::default();
        registry.reset(1);
        assert!(matches!(
            registry.observe_inbound(1, &permission_line(json!("9"))),
            InteractionInbound::Opened(_)
        ));
        assert!(matches!(
            registry.observe_inbound(1, &permission_line(json!(9))),
            InteractionInbound::Opened(_)
        ));
        assert_eq!(registry.snapshots().len(), 2);
        registry.reset(2);
        assert!(registry.snapshots().is_empty());
        assert!(matches!(
            registry.observe_inbound(1, &permission_line(json!(10))),
            InteractionInbound::AutoReply(_)
        ));
    }

    #[test]
    fn stop_claims_every_gate_in_only_the_target_session() {
        let registry = InteractionRegistry::default();
        registry.reset(5);
        let first = registry.observe_inbound(5, &permission_line(json!(1)));
        let mut second_line: Value = serde_json::from_str(&permission_line(json!(2))).unwrap();
        second_line["params"]["sessionId"] = json!("s2");
        registry.observe_inbound(5, &second_line.to_string());
        assert!(matches!(first, InteractionInbound::Opened(_)));

        let cancellations = registry.claim_session_cancellations("s1", 5);
        assert_eq!(cancellations.len(), 1);
        let response: Value = serde_json::from_str(&cancellations[0].line).unwrap();
        assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
        assert!(registry.settle(&cancellations[0]));
        assert_eq!(registry.snapshots().len(), 1);
        assert_eq!(registry.snapshots()[0].session_id, "s2");
        assert!(matches!(
            registry.observe_inbound(5, &permission_line(json!(3))),
            InteractionInbound::AutoReply(_)
        ));
        registry.begin_session_turn("s1", 5);
        assert!(matches!(
            registry.observe_inbound(5, &permission_line(json!(4))),
            InteractionInbound::Opened(_)
        ));
    }

    #[test]
    fn question_answers_are_limited_to_host_stored_questions() {
        let registry = InteractionRegistry::default();
        registry.reset(8);
        let line = json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "_x.ai/ask_user_question",
            "params": {
                "sessionId": "s1",
                "questions": [{
                    "question": "Choose",
                    "options": [{ "label": "A", "preview": "preview-a" }]
                }]
            }
        })
        .to_string();
        let InteractionInbound::Opened(opened) = registry.observe_inbound(8, &line) else {
            panic!("expected opened question");
        };
        let error = registry
            .claim_resolution(
                "s1",
                &opened.block_id,
                &json!({
                    "outcome": "accepted",
                    "answers": { "forged": ["yes"] },
                    "notes": {}
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "INTERACTION_QUESTION_MISMATCH");

        let lease = registry
            .claim_resolution(
                "s1",
                &opened.block_id,
                &json!({
                    "outcome": "accepted",
                    "answers": { "Choose": ["A"] },
                    "notes": { "Choose": "because" }
                }),
            )
            .unwrap();
        let response: Value = serde_json::from_str(&lease.line).unwrap();
        assert_eq!(
            response["result"]["annotations"]["Choose"]["preview"],
            "preview-a"
        );
        assert_eq!(
            response["result"]["annotations"]["Choose"]["notes"],
            "because"
        );
    }

    #[test]
    fn malformed_gate_is_cancelled_without_becoming_ui_state() {
        let registry = InteractionRegistry::default();
        registry.reset(1);
        let inbound = registry.observe_inbound(
            1,
            r#"{"jsonrpc":"2.0","id":3,"method":"session/request_permission","params":{"options":[]}}"#,
        );
        let InteractionInbound::AutoReply(line) = inbound else {
            panic!("expected automatic cancellation");
        };
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], 3);
        assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
        assert!(registry.snapshots().is_empty());
    }
}
