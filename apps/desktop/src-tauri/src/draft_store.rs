//! 未发送草稿的 Host 权威仓储。
//!
//! 每个工作区保留一个草稿和单调 revision。删除只移除正文并推进 revision，
//! 因此页面刷新前排队的旧写入无法在发送成功后把草稿复活。

use std::{
    collections::BTreeMap,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{
    host_core::atomic_write_bounded_private,
    host_core::read_bounded_text,
};

const DRAFT_FILE_VERSION: u8 = 1;
const MAX_DRAFTS: usize = 32;
const MAX_TRACKED_WORKSPACES: usize = 512;
const MAX_ATTACHMENTS: usize = 32;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENT_BODY_BYTES: usize = 3 * 1024 * 1024 / 2;
const MAX_FIELD_BYTES: usize = 4 * 1024;
pub(crate) const DRAFTS_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DraftStoreError {
    Invalid(String),
    Conflict(String),
    Storage(String),
}

impl DraftStoreError {
    pub(crate) fn into_message(self) -> String {
        match self {
            Self::Invalid(message) | Self::Conflict(message) | Self::Storage(message) => message,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftAttachment {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) mime: String,
    pub(crate) size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) data: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftRecord {
    pub(crate) cwd: String,
    pub(crate) text: String,
    pub(crate) attachments: Vec<DraftAttachment>,
    pub(crate) updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftSnapshot {
    pub(crate) revision: u64,
    pub(crate) draft: Option<DraftRecord>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftFile {
    version: u8,
    revisions: BTreeMap<String, u64>,
    entries: BTreeMap<String, DraftRecord>,
}

impl Default for DraftFile {
    fn default() -> Self {
        Self {
            version: DRAFT_FILE_VERSION,
            revisions: BTreeMap::new(),
            entries: BTreeMap::new(),
        }
    }
}

#[derive(Default)]
pub(crate) struct DraftStore {
    transaction: Mutex<()>,
}

impl DraftStore {
    pub(crate) fn read(
        &self,
        path: &Path,
        workspace: &str,
    ) -> Result<DraftSnapshot, DraftStoreError> {
        validate_workspace_key(workspace).map_err(DraftStoreError::Invalid)?;
        let _transaction = self.lock_transaction();
        let document = read_document(path).map_err(DraftStoreError::Storage)?;
        Ok(snapshot(&document, workspace))
    }

    pub(crate) fn write(
        &self,
        path: &Path,
        workspace: &str,
        expected_revision: u64,
        text: String,
        attachments: Vec<DraftAttachment>,
    ) -> Result<DraftSnapshot, DraftStoreError> {
        validate_workspace_key(workspace).map_err(DraftStoreError::Invalid)?;
        let text = text.trim_end().to_string();
        if text.is_empty() && attachments.is_empty() {
            return self.delete(path, workspace, expected_revision);
        }
        validate_draft(&text, &attachments).map_err(DraftStoreError::Invalid)?;
        let _transaction = self.lock_transaction();
        let mut document = read_document(path).map_err(DraftStoreError::Storage)?;
        ensure_revision(&document, workspace, expected_revision)?;
        if !document.entries.contains_key(workspace) && document.entries.len() >= MAX_DRAFTS {
            return Err(DraftStoreError::Invalid(format!(
                "未发送草稿不能超过 {MAX_DRAFTS} 个工作区"
            )));
        }
        if !document.revisions.contains_key(workspace)
            && document.revisions.len() >= MAX_TRACKED_WORKSPACES
        {
            return Err(DraftStoreError::Storage(
                "草稿删除版本记录已满，请先导出诊断并清理应用数据".into(),
            ));
        }
        let revision = next_revision(expected_revision)?;
        document.revisions.insert(workspace.to_string(), revision);
        document.entries.insert(
            workspace.to_string(),
            DraftRecord {
                cwd: workspace.to_string(),
                text,
                attachments,
                updated_at: now_ms(),
            },
        );
        write_document(path, &document).map_err(DraftStoreError::Storage)?;
        Ok(snapshot(&document, workspace))
    }

    pub(crate) fn delete(
        &self,
        path: &Path,
        workspace: &str,
        expected_revision: u64,
    ) -> Result<DraftSnapshot, DraftStoreError> {
        validate_workspace_key(workspace).map_err(DraftStoreError::Invalid)?;
        let _transaction = self.lock_transaction();
        let mut document = read_document(path).map_err(DraftStoreError::Storage)?;
        ensure_revision(&document, workspace, expected_revision)?;
        if !document.revisions.contains_key(workspace)
            && document.revisions.len() >= MAX_TRACKED_WORKSPACES
        {
            return Err(DraftStoreError::Storage(
                "草稿删除版本记录已满，请先导出诊断并清理应用数据".into(),
            ));
        }
        let revision = next_revision(expected_revision)?;
        document.revisions.insert(workspace.to_string(), revision);
        document.entries.remove(workspace);
        write_document(path, &document).map_err(DraftStoreError::Storage)?;
        Ok(DraftSnapshot {
            revision,
            draft: None,
        })
    }

    pub(crate) fn status(
        &self,
        path: &Path,
    ) -> Result<(usize, usize, u64), DraftStoreError> {
        let _transaction = self.lock_transaction();
        let document = read_document(path).map_err(DraftStoreError::Storage)?;
        let bytes = path.metadata().map(|value| value.len()).unwrap_or(0);
        Ok((document.entries.len(), document.revisions.len(), bytes))
    }

    fn lock_transaction(&self) -> std::sync::MutexGuard<'_, ()> {
        self.transaction
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn read_document(path: &Path) -> Result<DraftFile, String> {
    if !path.is_file() {
        return Ok(DraftFile::default());
    }
    let content = read_bounded_text(path, DRAFTS_MAX_BYTES)
        .map_err(|error| format!("无法读取草稿文件：{error}"))?;
    if content.trim().is_empty() {
        return Err("草稿文件为空，拒绝当作无草稿继续".into());
    }
    let document = serde_json::from_str::<DraftFile>(&content)
        .map_err(|error| format!("草稿文件不是有效 JSON：{error}"))?;
    validate_document(&document)?;
    Ok(document)
}

fn validate_document(document: &DraftFile) -> Result<(), String> {
    if document.version != DRAFT_FILE_VERSION {
        return Err(format!("不支持的草稿文件版本：{}", document.version));
    }
    if document.entries.len() > MAX_DRAFTS
        || document.revisions.len() > MAX_TRACKED_WORKSPACES
    {
        return Err("草稿文件超过条目限制".into());
    }
    for (workspace, record) in &document.entries {
        validate_workspace_key(workspace)?;
        if record.cwd != *workspace || !document.revisions.contains_key(workspace) {
            return Err(format!("草稿工作区身份不匹配：{workspace}"));
        }
        validate_draft(&record.text, &record.attachments)?;
    }
    if document.revisions.values().any(|revision| *revision == 0) {
        return Err("草稿 revision 必须大于 0".into());
    }
    Ok(())
}

fn write_document(path: &Path, document: &DraftFile) -> Result<(), String> {
    let content = serde_json::to_string(document)
        .map_err(|error| format!("无法序列化草稿文件：{error}"))?;
    atomic_write_bounded_private(path, &content, DRAFTS_MAX_BYTES)
}

fn snapshot(document: &DraftFile, workspace: &str) -> DraftSnapshot {
    DraftSnapshot {
        revision: document.revisions.get(workspace).copied().unwrap_or(0),
        draft: document.entries.get(workspace).cloned(),
    }
}

fn ensure_revision(
    document: &DraftFile,
    workspace: &str,
    expected_revision: u64,
) -> Result<(), DraftStoreError> {
    let current = document.revisions.get(workspace).copied().unwrap_or(0);
    if current != expected_revision {
        return Err(DraftStoreError::Conflict(format!(
            "草稿写入冲突：磁盘版本 {current} 不等于提交基线 {expected_revision}"
        )));
    }
    Ok(())
}

fn next_revision(current: u64) -> Result<u64, DraftStoreError> {
    current
        .checked_add(1)
        .ok_or_else(|| DraftStoreError::Storage("草稿 revision 已耗尽".into()))
}

fn validate_workspace_key(workspace: &str) -> Result<(), String> {
    if workspace.trim().is_empty() || workspace.len() > MAX_FIELD_BYTES || workspace.contains('\0') {
        return Err("草稿工作区无效".into());
    }
    Ok(())
}

fn validate_draft(text: &str, attachments: &[DraftAttachment]) -> Result<(), String> {
    if text.len() > MAX_TEXT_BYTES {
        return Err("草稿正文不能超过 1 MB".into());
    }
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(format!("草稿附件不能超过 {MAX_ATTACHMENTS} 个"));
    }
    let mut body_bytes = 0usize;
    for attachment in attachments {
        if attachment.id.is_empty()
            || attachment.id.len() > MAX_FIELD_BYTES
            || attachment.name.is_empty()
            || attachment.name.len() > MAX_FIELD_BYTES
            || attachment.mime.is_empty()
            || attachment.mime.len() > MAX_FIELD_BYTES
            || !matches!(attachment.kind.as_str(), "image" | "text" | "binary")
        {
            return Err("草稿包含无效附件元数据".into());
        }
        body_bytes = body_bytes
            .saturating_add(attachment.text.as_ref().map(String::len).unwrap_or(0))
            .saturating_add(attachment.data.as_ref().map(String::len).unwrap_or(0));
    }
    if body_bytes > MAX_ATTACHMENT_BODY_BYTES {
        return Err("草稿附件正文不能超过 1.5 MB".into());
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    fn temp_file(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "grox-drafts-{label}-{}-{}.json",
            std::process::id(),
            now_ms()
        ))
    }

    fn attachment() -> DraftAttachment {
        DraftAttachment {
            id: "a1".into(),
            kind: "text".into(),
            name: "notes.txt".into(),
            mime: "text/plain".into(),
            size: 4,
            text: Some("body".into()),
            data: None,
        }
    }

    #[test]
    fn revision_tombstone_rejects_late_write() {
        let path = temp_file("tombstone");
        let store = DraftStore::default();
        let saved = store
            .write(&path, "/repo", 0, "hello".into(), vec![attachment()])
            .unwrap();
        assert_eq!(saved.revision, 1);
        let deleted = store.delete(&path, "/repo", 1).unwrap();
        assert_eq!(deleted.revision, 2);
        assert!(matches!(
            store
                .write(&path, "/repo", 1, "late".into(), vec![])
                .unwrap_err(),
            DraftStoreError::Conflict(_)
        ));
        assert_eq!(store.read(&path, "/repo").unwrap(), deleted);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn explicit_new_write_can_advance_a_tombstone() {
        let path = temp_file("rewrite");
        let store = DraftStore::default();
        let deleted = store.delete(&path, "/repo", 0).unwrap();
        let saved = store
            .write(
                &path,
                "/repo",
                deleted.revision,
                "next".into(),
                vec![],
            )
            .unwrap();
        assert_eq!(saved.revision, 2);
        assert_eq!(saved.draft.unwrap().text, "next");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn corrupt_existing_file_fails_closed_without_rewrite() {
        let path = temp_file("corrupt");
        fs::write(&path, "not-json").unwrap();
        let store = DraftStore::default();
        match store
            .write(&path, "/repo", 0, "new".into(), vec![])
            .unwrap_err()
        {
            DraftStoreError::Storage(message) => assert!(message.contains("不是有效 JSON")),
            error => panic!("expected storage error, got {error:?}"),
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "not-json");
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn draft_file_is_private_at_creation() {
        use std::os::unix::fs::PermissionsExt as _;

        let path = temp_file("mode");
        DraftStore::default()
            .write(&path, "/repo", 0, "private".into(), vec![])
            .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_file(path);
    }
}
