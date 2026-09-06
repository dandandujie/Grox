//! Host 权限决定审计。
//!
//! 仅记录会话/工具标识与决定，不记录命令、路径、prompt 或 tool rawInput。

use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};

use serde::Serialize;

use crate::{
    host_core::atomic_write_bounded_private,
    interaction_service::PermissionAuditRecord,
    host_core::restrict_private_file,
};

const AUDIT_DIR: &str = "audit";
const AUDIT_FILE: &str = "permission_decisions.jsonl";
const PREVIOUS_AUDIT_FILE: &str = "permission_decisions.previous.jsonl";
const MAX_AUDIT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_AUDIT_LINE_BYTES: u64 = 8 * 1024;
const MAX_ROTATED_BYTES: u64 = MAX_AUDIT_BYTES + MAX_AUDIT_LINE_BYTES;
const SUPPORT_ROWS: usize = 200;
static AUDIT_IO: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionAuditRow<'a> {
    schema_version: u8,
    recorded_at: String,
    delivery: &'a str,
    #[serde(flatten)]
    decision: &'a PermissionAuditRecord,
}

pub(crate) fn append(
    app_data: &Path,
    decision: &PermissionAuditRecord,
    delivery: &'static str,
) -> Result<(), String> {
    let _io = AUDIT_IO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = app_data.join(AUDIT_DIR);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("无法创建权限审计目录 {}：{error}", dir.display()))?;
    let path = dir.join(AUDIT_FILE);
    if path.metadata().map(|meta| meta.len()).unwrap_or(0) >= MAX_AUDIT_BYTES {
        // 保留一个上一代快照；两个文件都有硬上限，不会随运行时间无限增长。
        let previous = dir.join(PREVIOUS_AUDIT_FILE);
        let current = fs::read_to_string(&path)
            .map_err(|error| format!("无法轮换权限审计文件 {}：{error}", path.display()))?;
        atomic_write_bounded_private(&previous, &current, MAX_ROTATED_BYTES)?;
        atomic_write_bounded_private(&path, "", MAX_AUDIT_LINE_BYTES)?;
    }
    let row = PermissionAuditRow {
        schema_version: 1,
        recorded_at: chrono::Utc::now().to_rfc3339(),
        delivery,
        decision,
    };
    let mut line =
        serde_json::to_vec(&row).map_err(|error| format!("无法序列化权限审计事件：{error}"))?;
    line.push(b'\n');
    if line.len() as u64 > MAX_AUDIT_LINE_BYTES {
        return Err("权限审计事件超过大小限制".into());
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("无法打开权限审计文件 {}：{error}", path.display()))?;
    // Windows 没有 Unix 创建 mode；在写入任何审计内容前先收紧 ACL。
    #[cfg(not(unix))]
    restrict_private_file(&path)?;
    file.write_all(&line)
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("无法写入权限审计文件 {}：{error}", path.display()))?;
    restrict_private_file(&path)
}

/// 读取选定会话最近的权限决定，供本地支持包使用。
pub(crate) fn read_session(
    app_data: &Path,
    session_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let _io = AUDIT_IO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = app_data.join(AUDIT_DIR);
    let mut rows = VecDeque::new();
    for file_name in [PREVIOUS_AUDIT_FILE, AUDIT_FILE] {
        let path = dir.join(file_name);
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法读取权限审计文件 {}：{error}", path.display())),
        };
        if raw.len() as u64 > MAX_ROTATED_BYTES {
            return Err(format!("权限审计文件超过大小限制：{}", path.display()));
        }
        for (index, line) in raw.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let row = serde_json::from_str::<serde_json::Value>(line).map_err(|error| {
                format!(
                    "权限审计文件 {} 第 {} 行损坏：{error}",
                    path.display(),
                    index + 1
                )
            })?;
            if row.get("sessionId").and_then(serde_json::Value::as_str) != Some(session_id) {
                continue;
            }
            rows.push_back(row);
            if rows.len() > SUPPORT_ROWS {
                rows.pop_front();
            }
        }
    }
    Ok(rows.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> std::path::PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("grox-permission-audit-test-{n}"))
    }

    #[test]
    fn audit_excludes_raw_tool_payload() {
        let dir = temp_dir();
        let decision = PermissionAuditRecord {
            session_id: "session-1".into(),
            block_id: "interaction-2-3".into(),
            generation: 2,
            tool_call_id: Some("tool-4".into()),
            tool_kind: Some("execute".into()),
            decision: "allow_once".into(),
            wire_option_id: Some("allow-once".into()),
        };
        append(&dir, &decision, "delivered").unwrap();
        let raw = fs::read_to_string(dir.join(AUDIT_DIR).join(AUDIT_FILE)).unwrap();
        assert!(raw.contains("allow_once"));
        assert!(raw.contains("delivered"));
        assert!(!raw.contains("rawInput"));
        let rows = read_session(&dir, "session-1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["wireOptionId"], "allow-once");
        assert!(read_session(&dir, "other-session").unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
