//! Local session support package. Structured app diagnostics are redacted;
//! the optional official CLI trace is kept byte-for-byte and therefore needs
//! an explicit user confirmation before export.

use std::{
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const MAX_OFFICIAL_TRACE_BYTES: u64 = 128 * 1024 * 1024;

struct IncompleteBundle {
    path: PathBuf,
    complete: bool,
}

impl Drop for IncompleteBundle {
    fn drop(&mut self) {
        if !self.complete {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "apikey",
        "token",
        "secret",
        "password",
        "authorization",
        "cookie",
        "credential",
    ]
    .iter()
    .any(|marker| key.contains(marker))
}

pub(crate) fn redact_token_markers(text: &str) -> String {
    let mut output = text.to_string();
    for variable in ["HOME", "USERPROFILE"] {
        if let Ok(directory) = std::env::var(variable) {
            if !directory.trim().is_empty() {
                output = output.replace(&directory, "$HOME");
                output = output.replace(&directory.replace('\\', "/"), "$HOME");
            }
        }
    }
    for marker in ["Bearer ", "bearer ", "sk-", "xai-"] {
        let mut offset = 0;
        while let Some(relative) = output[offset..].find(marker) {
            let start = offset + relative;
            let secret_start = start + marker.len();
            let end = output[secret_start..]
                .char_indices()
                .find_map(|(index, character)| {
                    (character.is_whitespace() || matches!(character, '"' | '\'' | ',' | ';'))
                        .then_some(secret_start + index)
                })
                .unwrap_or(output.len());
            if end <= secret_start {
                offset = secret_start;
                continue;
            }
            let replacement = if marker.trim().eq_ignore_ascii_case("bearer") {
                "Bearer [REDACTED]"
            } else {
                "[REDACTED]"
            };
            output.replace_range(start..end, replacement);
            offset = start + replacement.len();
        }
    }
    output
}

fn redact_value(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if sensitive_key(key)
                    && !value.is_number()
                    && !value.is_boolean()
                    && !value.is_null()
                {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    redact_value(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_value),
        Value::String(text) => *text = redact_token_markers(text),
        _ => {}
    }
}

fn safe_json(mut value: Value) -> Result<String, String> {
    redact_value(&mut value);
    serde_json::to_string_pretty(&value).map_err(|error| format!("无法序列化支持信息：{error}"))
}

fn add_text(
    zip: &mut ZipWriter<fs::File>,
    options: SimpleFileOptions,
    name: &str,
    content: &str,
) -> Result<(), String> {
    zip.start_file(name, options)
        .map_err(|error| format!("无法创建支持包条目 {name}：{error}"))?;
    zip.write_all(content.as_bytes())
        .map_err(|error| format!("无法写入支持包条目 {name}：{error}"))
}

pub struct SessionSupportBundle<'a> {
    pub session_id: &'a str,
    pub meta: Value,
    pub runtime: Value,
    pub journal: Value,
    pub permission_audit: Value,
    pub client: Value,
    pub host_log: String,
    pub official_trace: Option<&'a Path>,
}

pub fn write_session_support_bundle(input: SessionSupportBundle<'_>) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let short_id = input
        .session_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    let path = std::env::temp_dir().join(format!(
        "Grox-session-support-{}-{timestamp}-{}.zip",
        if short_id.is_empty() {
            "session"
        } else {
            &short_id
        },
        std::process::id(),
    ));
    let mut cleanup = IncompleteBundle {
        path: path.clone(),
        complete: false,
    };
    let mut file_options = fs::OpenOptions::new();
    file_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        file_options.mode(0o600);
    }
    let file = file_options
        .open(&path)
        .map_err(|error| format!("无法创建会话支持包 {}：{error}", path.display()))?;
    #[cfg(not(unix))]
    crate::host_core::restrict_private_file(&path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    add_text(&mut zip, options, "meta.json", &safe_json(input.meta)?)?;
    add_text(
        &mut zip,
        options,
        "runtime.json",
        &safe_json(input.runtime)?,
    )?;
    add_text(
        &mut zip,
        options,
        "journal.json",
        &safe_json(input.journal)?,
    )?;
    add_text(
        &mut zip,
        options,
        "permission-audit.json",
        &safe_json(input.permission_audit)?,
    )?;
    add_text(&mut zip, options, "client.json", &safe_json(input.client)?)?;
    add_text(&mut zip, options, "host-log.txt", &input.host_log)?;
    add_text(
        &mut zip,
        options,
        "README.txt",
        "Grox v0.3.2 local session support package\n\n\
meta.json     app, OS and CLI version facts\n\
runtime.json  shared Agent process topology and connection state\n\
journal.json  journal health and selected-session metadata (no transcript body)\n\
permission-audit.json  selected-session decisions (no raw tool input)\n\
client.json   redacted UI state, queue state and recent error notices\n\
host-log.txt  redacted tail of native lifecycle/error logs\n\
official/     optional official `grok trace --local` archive\n\n\
The official trace may contain conversation and tool records. This package is\n\
created locally and is never uploaded by Grox. Review it before sharing.\n",
    )?;

    if let Some(trace) = input.official_trace.filter(|path| path.is_file()) {
        let metadata = trace
            .metadata()
            .map_err(|error| format!("无法读取官方 trace 元数据：{error}"))?;
        if metadata.len() > MAX_OFFICIAL_TRACE_BYTES {
            return Err("官方会话 trace 超过 128 MB，拒绝装入支持包".into());
        }
        let extension = trace
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| {
                value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
            })
            .unwrap_or("bin");
        let name = format!("official/grok-trace.{extension}");
        zip.start_file(&name, options)
            .map_err(|error| format!("无法创建官方 trace 条目：{error}"))?;
        let file = fs::File::open(trace)
            .map_err(|error| format!("无法打开官方 trace {}：{error}", trace.display()))?;
        std::io::copy(&mut file.take(MAX_OFFICIAL_TRACE_BYTES + 1), &mut zip)
            .map_err(|error| format!("无法写入官方 trace：{error}"))?;
    }

    zip.finish()
        .map_err(|error| format!("无法完成会话支持包：{error}"))?;
    cleanup.complete = true;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_redaction_removes_keys_and_inline_tokens() {
        let value = serde_json::json!({
            "apiKey": "abc",
            "inputTokens": 42,
            "nested": { "message": "request Bearer token-value failed", "other": "sk-secret" },
        });
        let safe = safe_json(value).unwrap();
        assert!(!safe.contains("token-value"));
        assert!(!safe.contains("sk-secret"));
        assert!(!safe.contains("\"abc\""));
        assert!(safe.contains("[REDACTED]"));
        assert!(safe.contains("42"));
    }

    #[test]
    fn support_bundle_contains_only_named_structured_entries_without_trace() {
        let path = write_session_support_bundle(SessionSupportBundle {
            session_id: "session-123",
            meta: serde_json::json!({ "appVersion": "0.3.2" }),
            runtime: serde_json::json!({ "topology": "shared" }),
            journal: serde_json::json!({ "count": 1 }),
            permission_audit: serde_json::json!({ "readable": true, "entries": [] }),
            client: serde_json::json!({ "status": "failed" }),
            host_log: "host log unavailable".into(),
            official_trace: None,
        })
        .unwrap();
        let file = fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(archive.by_name("meta.json").is_ok());
        assert!(archive.by_name("runtime.json").is_ok());
        assert!(archive.by_name("journal.json").is_ok());
        assert!(archive.by_name("permission-audit.json").is_ok());
        assert!(archive.by_name("client.json").is_ok());
        assert!(archive.by_name("host-log.txt").is_ok());
        assert!(archive.by_name("official/grok-trace.zip").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::remove_file(path).unwrap();
    }
}
