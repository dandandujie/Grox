//! 前台回合与自动化共用的 ACP 绑定规则。
//!
//! 模型、模式和推理强度降级必须只有一份协议解释；否则前台与自动化会在
//! 同一个 Grok Build 版本上产生不同结果。

use serde_json::{json, Value};

use crate::{
    acp_host::AcpHostError,
    mcp_leases::McpLeaseStore,
    host_core::request_acp_json_tracked,
    host_core::AcpState,
};

pub(crate) const TURN_RPC_TIMEOUT_MS: u64 = 30_000;

/// Host 请求观察器让上层事务记录“当前可取消的请求”，而不暴露请求表。
pub(crate) trait AcpRequestTracker: Send + Sync {
    fn request_started(&self, request_id: u64, method: &str) -> Result<(), AcpHostError>;
    fn request_finished(&self, request_id: u64);
}

pub(crate) async fn bind_model(
    state: &AcpState,
    leases: &McpLeaseStore,
    session_id: &str,
    model: &str,
    preferred_effort: &str,
    generation: u64,
    gate_token: u64,
    tracker: Option<&dyn AcpRequestTracker>,
) -> Result<String, AcpHostError> {
    let mut last_error = None;
    // 界面给的是上游模型名；CLI 认的是 config.toml 段名。中转档案借用官方
    // 模型名时两者不同，必须在这里收口，否则请求会落到官方段上。
    let model = crate::host_core::grok_home()
        .and_then(|home| crate::provider_overrides::resolve_agent_model_id(&home, model))
        .map_err(|error| {
            AcpHostError::environment(
                "PROVIDER_MODEL_RESOLVE_FAILED",
                error,
                false,
                false,
                "检查 ~/.grok/config.toml 是否可读，然后重新选择供应商",
            )
        })?;
    for effort in effort_fallback_chain(preferred_effort) {
        match request_acp_json_tracked(
            state,
            leases,
            "session/set_model",
            json!({
                "sessionId": session_id,
                "modelId": model,
                "_meta": { "reasoningEffort": effort },
            }),
            generation,
            TURN_RPC_TIMEOUT_MS,
            Some(gate_token),
            tracker,
        )
        .await
        {
            Ok(_) => return Ok(effort.to_string()),
            Err(error) if is_invalid_reasoning_effort(&error) => last_error = Some(error),
            Err(error) if is_method_unavailable(&error) => {
                // 旧 ACP 没有 set_model 时，session/prompt 仍携带本轮 effort。
                return Ok(preferred_effort.to_string());
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        AcpHostError::protocol(
            "ACP_INVALID_REASONING_EFFORT",
            "当前模型或 API 不接受任何受支持的推理强度",
        )
    }))
}

pub(crate) async fn bind_mode(
    state: &AcpState,
    leases: &McpLeaseStore,
    session_id: &str,
    mode: &str,
    generation: u64,
    gate_token: u64,
    tracker: Option<&dyn AcpRequestTracker>,
) -> Result<(), AcpHostError> {
    let mut last_error = None;
    for mode_id in mode_candidates(mode) {
        match request_acp_json_tracked(
            state,
            leases,
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": mode_id }),
            generation,
            TURN_RPC_TIMEOUT_MS,
            Some(gate_token),
            tracker,
        )
        .await
        {
            Ok(_) => return Ok(()),
            Err(error) if error.code == "ACP_RPC_INVALID_PARAMS" => last_error = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        AcpHostError::protocol(
            "ACP_SESSION_MODE_UNAVAILABLE",
            "当前 Agent 不支持所选会话模式",
        )
    }))
}

pub(crate) fn normalize_effort(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

pub(crate) fn effort_fallback_chain(preferred: &str) -> Vec<&str> {
    let mut efforts = Vec::with_capacity(4);
    for effort in [preferred, "high", "medium", "low"] {
        if !efforts.contains(&effort) {
            efforts.push(effort);
        }
    }
    efforts
}

pub(crate) fn mode_candidates(mode: &str) -> &'static [&'static str] {
    match mode {
        "plan" => &["plan", "Plan"],
        "ask" => &["ask", "Ask"],
        _ => &["default", "agent", "code", "normal", "Agent"],
    }
}

pub(crate) fn normalize_mode(mode: &str) -> Option<&'static str> {
    match mode.trim() {
        "agent" => Some("agent"),
        "plan" => Some("plan"),
        "ask" => Some("ask"),
        _ => None,
    }
}

pub(crate) fn is_method_unavailable(error: &AcpHostError) -> bool {
    error.code == "ACP_RPC_METHOD_NOT_FOUND"
}

pub(crate) fn is_invalid_reasoning_effort(error: &AcpHostError) -> bool {
    invalid_reasoning_effort_message(&error.message)
}

pub(crate) fn invalid_reasoning_effort_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("invalid reasoning effort")
        || (lower.contains("invalid-argument") && lower.contains("reasoning effort"))
        || lower.contains("unknown effort level")
}

pub(crate) fn prompt_result_invalid_effort(response: &Value) -> Option<String> {
    let stop = response
        .get("stop_reason")
        .or_else(|| response.get("stopReason"))
        .and_then(Value::as_str);
    let message = ["agent_result", "message", "error"]
        .into_iter()
        .find_map(|key| response.get(key))
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string())
        })?;
    ((stop == Some("error") || invalid_reasoning_effort_message(&message))
        && invalid_reasoning_effort_message(&message))
    .then_some(message)
}

pub(crate) fn complete_deep_research_prompt(prompt: &str) -> String {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    let query = if lower == "/deep-research" {
        Some("")
    } else if lower.starts_with("/deep-research ") {
        Some(trimmed["/deep-research".len()..].trim())
    } else {
        None
    };
    match query {
        Some(query) => format!("/workflow grox-deep-research {}", json!({ "query": query })),
        None => prompt.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_fallback_is_ordered_and_deduplicated() {
        assert_eq!(
            effort_fallback_chain("xhigh"),
            vec!["xhigh", "high", "medium", "low"]
        );
        assert_eq!(effort_fallback_chain("high"), vec!["high", "medium", "low"]);
    }

    #[test]
    fn agent_mode_keeps_current_default_then_compatibility_candidates() {
        assert_eq!(
            mode_candidates("agent"),
            &["default", "agent", "code", "normal", "Agent"]
        );
        assert_eq!(mode_candidates("plan"), &["plan", "Plan"]);
        assert_eq!(mode_candidates("ask"), &["ask", "Ask"]);
    }

    #[test]
    fn deep_research_alias_is_completed_in_host() {
        assert_eq!(
            complete_deep_research_prompt("/deep-research evidence"),
            r#"/workflow grox-deep-research {"query":"evidence"}"#
        );
        assert_eq!(
            complete_deep_research_prompt("ordinary prompt"),
            "ordinary prompt"
        );
    }

    #[test]
    fn invalid_effort_is_detected_from_rpc_and_result_body() {
        let error = AcpHostError::protocol(
            "ACP_RPC_FAILED",
            "invalid-argument: Invalid reasoning effort max",
        );
        assert!(is_invalid_reasoning_effort(&error));
        assert_eq!(
            prompt_result_invalid_effort(&json!({
                "stopReason": "error",
                "agent_result": "Unknown effort level"
            })),
            Some("Unknown effort level".into())
        );
        assert!(prompt_result_invalid_effort(&json!({ "stopReason": "end_turn" })).is_none());
    }
}
