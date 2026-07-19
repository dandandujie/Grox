use serde::{Deserialize, Deserializer};

use crate::types::{FinishReason, Role};

pub fn empty_string_as_none<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<String>::deserialize(deserializer)?;
    Ok(opt.filter(|s| !s.is_empty()))
}

/// Lenient `Option<FinishReason>`: unknown provider-specific values
/// (e.g. "max_tokens", "stop_sequence") deserialize to `None` instead of
/// failing the whole chunk.
pub fn option_finish_reason_lenient<'de, D>(deserializer: D) -> Result<Option<FinishReason>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw.as_deref().and_then(|value| match value {
        "stop" => Some(FinishReason::Stop),
        "length" => Some(FinishReason::Length),
        "tool_calls" => Some(FinishReason::ToolCalls),
        "content_filter" => Some(FinishReason::ContentFilter),
        "function_call" => Some(FinishReason::FunctionCall),
        _ => None,
    }))
}

/// Lenient `Option<Role>`: unknown or empty values (e.g. `""`) deserialize
/// to `None` instead of failing the whole chunk.
pub fn option_role_lenient<'de, D>(deserializer: D) -> Result<Option<Role>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw.as_deref().and_then(|value| match value {
        "system" => Some(Role::System),
        "user" => Some(Role::User),
        "assistant" => Some(Role::Assistant),
        "tool" => Some(Role::Tool),
        _ => None,
    }))
}
