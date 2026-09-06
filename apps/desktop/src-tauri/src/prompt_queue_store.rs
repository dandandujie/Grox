//! 提示队列的原生事务仓储。
//!
//! 前端只提交发生变化的会话队列；Host 在同一把锁内读取、合并并原子替换文件，
//! 避免一个会话的整包快照覆盖另一个会话刚写入的数据。

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};

use crate::{
    host_core::atomic_write_bounded_private,
    host_core::read_bounded_text,
};

const MAX_QUEUE_ITEMS_PER_SESSION: usize = 1_000;
const MAX_ATTACHMENTS_PER_ITEM: usize = 64;
const MAX_CONSUMED_TOMBSTONES_PER_SESSION: usize = 4_096;
const HOST_RUNTIME_KEY: &str = "_hostRuntime";

pub(crate) struct PromptQueueStore {
    transaction: Mutex<()>,
    consumed: Mutex<BTreeMap<String, BTreeMap<String, u64>>>,
    owner_id: String,
    next_claim: AtomicU64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PromptQueueSettlement {
    Consumed,
    Retry,
}

pub(crate) struct PromptQueueClaim {
    pub(crate) session_id: String,
    pub(crate) item_id: String,
    pub(crate) token: String,
    pub(crate) generation: u64,
    pub(crate) entry: Value,
    pub(crate) queue: Vec<Value>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PromptQueueClaimError {
    Busy,
    Stale,
    Invalid(String),
    Storage(String),
}

impl Default for PromptQueueStore {
    fn default() -> Self {
        static STORE_NONCE: AtomicU64 = AtomicU64::new(0);
        Self {
            transaction: Mutex::new(()),
            consumed: Mutex::new(BTreeMap::new()),
            owner_id: format!(
                "{}-{}-{}",
                std::process::id(),
                unix_time_ms(),
                STORE_NONCE.fetch_add(1, Ordering::Relaxed) + 1
            ),
            next_claim: AtomicU64::new(0),
        }
    }
}

impl PromptQueueStore {
    pub(crate) fn read(&self, path: &Path, max_bytes: u64) -> Result<Option<String>, String> {
        let _transaction = self.lock_transaction();
        if !path.is_file() {
            return Ok(None);
        }
        let mut queues = self.read_locked(path, max_bytes)?;
        if self.recover_foreign_claims(&mut queues) {
            self.write_locked(path, queues.clone(), max_bytes)?;
        }
        serde_json::to_string(&public_queues(&queues))
            .map(Some)
            .map_err(|error| format!("无法序列化提示队列：{error}"))
    }

    pub(crate) fn patch(
        &self,
        path: &Path,
        upserts: BTreeMap<String, Value>,
        deletes: Vec<String>,
        max_bytes: u64,
    ) -> Result<(), String> {
        let delete_ids = deletes.into_iter().collect::<BTreeSet<_>>();
        if upserts.keys().any(|id| delete_ids.contains(id)) {
            return Err("同一提示队列 patch 不能同时更新和删除一个会话".into());
        }
        for (session_id, rows) in &upserts {
            validate_session_queue(session_id, rows, false)?;
        }

        let _transaction = self.lock_transaction();
        let mut queues = self.read_locked(path, max_bytes)?;
        self.recover_foreign_claims(&mut queues);
        for session_id in delete_ids {
            if queues
                .get(&session_id)
                .is_some_and(|rows| has_owned_claim(rows, &self.owner_id))
            {
                return Err(format!("会话 {session_id} 正在发送提示，不能删除队列"));
            }
            queues.remove(&session_id);
        }
        for (session_id, mut rows) in upserts {
            self.filter_consumed(&session_id, &mut rows);
            if let Some(existing) = queues.get(&session_id) {
                preserve_owned_claims(existing, &mut rows, &self.owner_id, &session_id)?;
            }
            if rows.as_array().is_some_and(Vec::is_empty) {
                queues.remove(&session_id);
            } else {
                queues.insert(session_id, rows);
            }
        }
        self.write_locked(path, queues, max_bytes)
    }

    pub(crate) fn delete_sessions(
        &self,
        path: &Path,
        session_ids: &[String],
        max_bytes: u64,
    ) -> Result<(), String> {
        if session_ids.is_empty() {
            return Ok(());
        }
        let _transaction = self.lock_transaction();
        if !path.is_file() {
            // 空对象也是“原生仓储已初始化”标记，阻止重启后再次导入旧 localStorage。
            return self.write_locked(path, Map::new(), max_bytes);
        }
        let mut queues = self.read_locked(path, max_bytes)?;
        let mut changed = self.recover_foreign_claims(&mut queues);
        for session_id in session_ids {
            // 永久删除已经由 SessionStorage tombstone 授权，删除必须胜过活动
            // claim；晚到 settle 只能得到 stale，不能把会话或队列复活。
            changed |= queues.remove(session_id).is_some();
            self.lock_consumed().remove(session_id);
        }
        if changed {
            self.write_locked(path, queues, max_bytes)?;
        }
        Ok(())
    }

    pub(crate) fn claim(
        &self,
        path: &Path,
        session_id: &str,
        item_id: &str,
        generation: u64,
        max_bytes: u64,
    ) -> Result<PromptQueueClaim, PromptQueueClaimError> {
        if generation == 0 || session_id.is_empty() || item_id.is_empty() {
            return Err(PromptQueueClaimError::Invalid(
                "提示队列领取参数无效".into(),
            ));
        }
        let _transaction = self.lock_transaction();
        let mut queues = self
            .read_locked(path, max_bytes)
            .map_err(PromptQueueClaimError::Storage)?;
        self.recover_stale_claims(&mut queues, generation);
        let rows = queues
            .get_mut(session_id)
            .and_then(Value::as_array_mut)
            .ok_or(PromptQueueClaimError::Stale)?;
        if rows.iter().any(|row| {
            owned_runtime(row, &self.owner_id)
                .is_some_and(|runtime| runtime_generation(runtime) == Some(generation))
        }) {
            return Err(PromptQueueClaimError::Busy);
        }
        let claimable = rows
            .iter()
            .position(is_claimable)
            .ok_or(PromptQueueClaimError::Stale)?;
        if rows[claimable].get("id").and_then(Value::as_str) != Some(item_id) {
            return Err(PromptQueueClaimError::Stale);
        }
        let token = format!(
            "pq-{}-{}-{}",
            generation,
            unix_time_ms(),
            self.next_claim.fetch_add(1, Ordering::Relaxed) + 1
        );
        let entry = rows[claimable].clone();
        let item = rows[claimable]
            .as_object_mut()
            .ok_or_else(|| PromptQueueClaimError::Invalid("提示队列条目无效".into()))?;
        item.insert("state".into(), Value::String("sending".into()));
        item.insert(
            HOST_RUNTIME_KEY.into(),
            serde_json::json!({
                "owner": self.owner_id,
                "token": token,
                "generation": generation,
                "claimedAt": unix_time_ms(),
            }),
        );
        self.write_locked(path, queues.clone(), max_bytes)
            .map_err(PromptQueueClaimError::Storage)?;
        Ok(PromptQueueClaim {
            session_id: session_id.to_string(),
            item_id: item_id.to_string(),
            token,
            generation,
            entry,
            queue: public_session_queue(&queues, session_id),
        })
    }

    pub(crate) fn settle(
        &self,
        path: &Path,
        claim: &PromptQueueClaim,
        settlement: PromptQueueSettlement,
        max_bytes: u64,
    ) -> Result<Vec<Value>, PromptQueueClaimError> {
        let _transaction = self.lock_transaction();
        let mut queues = self
            .read_locked(path, max_bytes)
            .map_err(PromptQueueClaimError::Storage)?;
        let rows = queues
            .get_mut(&claim.session_id)
            .and_then(Value::as_array_mut)
            .ok_or(PromptQueueClaimError::Stale)?;
        let index = rows
            .iter()
            .position(|row| row.get("id").and_then(Value::as_str) == Some(&claim.item_id))
            .ok_or(PromptQueueClaimError::Stale)?;
        let runtime =
            owned_runtime(&rows[index], &self.owner_id).ok_or(PromptQueueClaimError::Stale)?;
        if runtime.get("token").and_then(Value::as_str) != Some(&claim.token)
            || runtime_generation(runtime) != Some(claim.generation)
        {
            return Err(PromptQueueClaimError::Stale);
        }
        match settlement {
            PromptQueueSettlement::Consumed => {
                rows.remove(index);
            }
            PromptQueueSettlement::Retry => {
                let item = rows[index]
                    .as_object_mut()
                    .ok_or_else(|| PromptQueueClaimError::Invalid("提示队列条目无效".into()))?;
                item.remove(HOST_RUNTIME_KEY);
                item.insert("state".into(), Value::String("queued".into()));
            }
        }
        if rows.is_empty() {
            queues.remove(&claim.session_id);
        }
        self.write_locked(path, queues.clone(), max_bytes)
            .map_err(PromptQueueClaimError::Storage)?;
        if settlement == PromptQueueSettlement::Consumed {
            let mut consumed = self.lock_consumed();
            let session = consumed.entry(claim.session_id.clone()).or_default();
            session.insert(
                claim.item_id.clone(),
                self.next_claim.fetch_add(1, Ordering::Relaxed) + 1,
            );
            if session.len() > MAX_CONSUMED_TOMBSTONES_PER_SESSION {
                if let Some(oldest) = session
                    .iter()
                    .min_by_key(|(_, sequence)| **sequence)
                    .map(|(id, _)| id.clone())
                {
                    session.remove(&oldest);
                }
            }
        }
        Ok(public_session_queue(&queues, &claim.session_id))
    }

    fn read_locked(&self, path: &Path, max_bytes: u64) -> Result<Map<String, Value>, String> {
        if !path.is_file() {
            return Ok(Map::new());
        }
        let content = read_bounded_text(path, max_bytes)
            .map_err(|error| format!("无法读取提示队列：{error}"))?;
        if content.trim().is_empty() {
            return Err("提示队列文件为空，拒绝当作空队列继续".into());
        }
        let queues = serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("提示队列文件不是有效 JSON：{error}"))?
            .as_object()
            .cloned()
            .ok_or_else(|| "提示队列文件必须是 JSON 对象".to_string())?;
        for (session_id, rows) in &queues {
            validate_session_queue(session_id, rows, true)?;
        }
        Ok(queues)
    }

    fn write_locked(
        &self,
        path: &Path,
        queues: Map<String, Value>,
        max_bytes: u64,
    ) -> Result<(), String> {
        let content = serde_json::to_string(&queues)
            .map_err(|error| format!("无法序列化提示队列：{error}"))?;
        if content.len() as u64 > max_bytes {
            return Err(format!("提示队列不能超过 {} MB", max_bytes / 1024 / 1024));
        }
        atomic_write_bounded_private(path, &content, max_bytes)
    }

    fn lock_transaction(&self) -> std::sync::MutexGuard<'_, ()> {
        self.transaction
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_consumed(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, BTreeMap<String, u64>>> {
        self.consumed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn filter_consumed(&self, session_id: &str, rows: &mut Value) {
        let consumed = self.lock_consumed();
        let Some(consumed) = consumed.get(session_id) else {
            return;
        };
        if let Some(rows) = rows.as_array_mut() {
            rows.retain(|row| match row.get("id").and_then(Value::as_str) {
                Some(id) => !consumed.contains_key(id),
                None => true,
            });
        }
    }

    fn recover_foreign_claims(&self, queues: &mut Map<String, Value>) -> bool {
        recover_claims(queues, |runtime| {
            runtime.get("owner").and_then(Value::as_str) != Some(&self.owner_id)
        })
    }

    fn recover_stale_claims(&self, queues: &mut Map<String, Value>, generation: u64) -> bool {
        recover_claims(queues, |runtime| {
            runtime.get("owner").and_then(Value::as_str) != Some(&self.owner_id)
                || runtime_generation(runtime) != Some(generation)
        })
    }
}

fn validate_session_queue(
    session_id: &str,
    rows: &Value,
    allow_host_runtime: bool,
) -> Result<(), String> {
    let rows = rows
        .as_array()
        .ok_or_else(|| format!("会话 {session_id} 的提示队列必须是数组"))?;
    if rows.len() > MAX_QUEUE_ITEMS_PER_SESSION {
        return Err(format!(
            "会话 {session_id} 的提示队列不能超过 {MAX_QUEUE_ITEMS_PER_SESSION} 条"
        ));
    }
    let mut ids = BTreeSet::new();
    for row in rows {
        let item = row
            .as_object()
            .ok_or_else(|| format!("会话 {session_id} 的提示队列包含无效条目"))?;
        if item.contains_key(HOST_RUNTIME_KEY) && !allow_host_runtime {
            return Err(format!(
                "会话 {session_id} 的提示队列不能写入 Host 保留字段"
            ));
        }
        let id = required_string(item, "id", session_id)?;
        if !ids.insert(id) {
            return Err(format!("会话 {session_id} 的提示队列包含重复 id"));
        }
        required_text(item, "text", session_id)?;
        required_string(item, "model", session_id)?;
        required_enum(
            item,
            "effort",
            &["low", "medium", "high", "xhigh", "max"],
            session_id,
        )?;
        required_enum(item, "mode", &["agent", "plan", "ask"], session_id)?;
        required_enum(
            item,
            "permissionMode",
            &["default", "auto", "bypass"],
            session_id,
        )?;
        if item.get("createdAt").and_then(Value::as_f64).is_none() {
            return Err(format!("会话 {session_id} 的提示队列缺少 createdAt"));
        }
        if let Some(source) = item.get("source") {
            if !matches!(source.as_str(), Some("local" | "cli")) {
                return Err(format!("会话 {session_id} 的提示队列 source 无效"));
            }
        }
        if let Some(state) = item.get("state") {
            if !matches!(state.as_str(), Some("queued" | "interjected" | "sending")) {
                return Err(format!("会话 {session_id} 的提示队列 state 无效"));
            }
        }
        if item
            .get("heldByCli")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(format!("会话 {session_id} 的提示队列 heldByCli 无效"));
        }
        let attachments = item
            .get("attachments")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("会话 {session_id} 的提示队列缺少 attachments"))?;
        if attachments.len() > MAX_ATTACHMENTS_PER_ITEM {
            return Err(format!(
                "会话 {session_id} 的单条提示不能超过 {MAX_ATTACHMENTS_PER_ITEM} 个附件"
            ));
        }
        for attachment in attachments {
            validate_attachment(session_id, attachment)?;
        }
        if let Some(runtime) = item.get(HOST_RUNTIME_KEY) {
            validate_host_runtime(session_id, item, runtime)?;
        }
    }
    Ok(())
}

fn validate_host_runtime(
    session_id: &str,
    item: &Map<String, Value>,
    runtime: &Value,
) -> Result<(), String> {
    let runtime = runtime
        .as_object()
        .ok_or_else(|| format!("会话 {session_id} 的提示队列 Host 状态无效"))?;
    for key in ["owner", "token"] {
        if !runtime
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
        {
            return Err(format!("会话 {session_id} 的提示队列 Host 状态缺少 {key}"));
        }
    }
    for key in ["generation", "claimedAt"] {
        if runtime.get(key).and_then(Value::as_u64).is_none() {
            return Err(format!("会话 {session_id} 的提示队列 Host 状态缺少 {key}"));
        }
    }
    if item.get("state").and_then(Value::as_str) != Some("sending") {
        return Err(format!(
            "会话 {session_id} 的已领取提示必须处于 sending 状态"
        ));
    }
    Ok(())
}

fn public_queues(queues: &Map<String, Value>) -> Map<String, Value> {
    queues
        .iter()
        .map(|(session_id, rows)| (session_id.clone(), Value::Array(public_rows(rows))))
        .collect()
}

fn public_session_queue(queues: &Map<String, Value>, session_id: &str) -> Vec<Value> {
    queues.get(session_id).map(public_rows).unwrap_or_default()
}

fn public_rows(rows: &Value) -> Vec<Value> {
    rows.as_array()
        .into_iter()
        .flatten()
        .map(|row| {
            let mut row = row.clone();
            if let Some(item) = row.as_object_mut() {
                item.remove(HOST_RUNTIME_KEY);
            }
            row
        })
        .collect()
}

fn is_claimable(row: &Value) -> bool {
    let Some(item) = row.as_object() else {
        return false;
    };
    item.get(HOST_RUNTIME_KEY).is_none()
        && item.get("source").and_then(Value::as_str) != Some("cli")
        && item.get("heldByCli").and_then(Value::as_bool) != Some(true)
        && item.get("state").and_then(Value::as_str) != Some("sending")
}

fn owned_runtime<'a>(row: &'a Value, owner_id: &str) -> Option<&'a Map<String, Value>> {
    row.get(HOST_RUNTIME_KEY)
        .and_then(Value::as_object)
        .filter(|runtime| runtime.get("owner").and_then(Value::as_str) == Some(owner_id))
}

fn runtime_generation(runtime: &Map<String, Value>) -> Option<u64> {
    runtime.get("generation").and_then(Value::as_u64)
}

fn has_owned_claim(rows: &Value, owner_id: &str) -> bool {
    rows.as_array().is_some_and(|rows| {
        rows.iter()
            .any(|row| owned_runtime(row, owner_id).is_some())
    })
}

fn preserve_owned_claims(
    existing: &Value,
    incoming: &mut Value,
    owner_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let Some(existing) = existing.as_array() else {
        return Ok(());
    };
    let incoming = incoming
        .as_array_mut()
        .ok_or_else(|| format!("会话 {session_id} 的提示队列必须是数组"))?;
    for (existing_index, claimed) in existing
        .iter()
        .enumerate()
        .filter(|(_, row)| owned_runtime(row, owner_id).is_some())
    {
        let id = claimed
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(index) = incoming
            .iter()
            .position(|row| row.get("id").and_then(Value::as_str) == Some(id))
        else {
            return Err(format!("会话 {session_id} 的提示 {id} 正在发送，不能删除"));
        };
        if index != existing_index {
            return Err(format!("会话 {session_id} 的提示 {id} 正在发送，不能移动"));
        }
        incoming[index] = claimed.clone();
    }
    Ok(())
}

fn recover_claims(
    queues: &mut Map<String, Value>,
    should_recover: impl Fn(&Map<String, Value>) -> bool,
) -> bool {
    let mut changed = false;
    for rows in queues.values_mut().filter_map(Value::as_array_mut) {
        for row in rows.iter_mut().filter_map(Value::as_object_mut) {
            let recover = row
                .get(HOST_RUNTIME_KEY)
                .and_then(Value::as_object)
                .is_some_and(&should_recover);
            let orphan_sending = row.get(HOST_RUNTIME_KEY).is_none()
                && row.get("state").and_then(Value::as_str) == Some("sending")
                && row.get("source").and_then(Value::as_str) != Some("cli");
            if recover || orphan_sending {
                row.remove(HOST_RUNTIME_KEY);
                row.insert("state".into(), Value::String("queued".into()));
                changed = true;
            }
        }
    }
    changed
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn validate_attachment(session_id: &str, value: &Value) -> Result<(), String> {
    let attachment = value
        .as_object()
        .ok_or_else(|| format!("会话 {session_id} 的提示队列包含无效附件"))?;
    required_string(attachment, "id", session_id)?;
    required_enum(attachment, "kind", &["image", "text", "binary"], session_id)?;
    required_string(attachment, "name", session_id)?;
    required_string(attachment, "mime", session_id)?;
    if !attachment
        .get("size")
        .and_then(Value::as_f64)
        .is_some_and(|size| size >= 0.0)
    {
        return Err(format!("会话 {session_id} 的提示队列附件缺少 size"));
    }
    for optional in ["text", "data"] {
        if attachment
            .get(optional)
            .is_some_and(|value| !value.is_string())
        {
            return Err(format!("会话 {session_id} 的提示队列附件 {optional} 无效"));
        }
    }
    Ok(())
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    session_id: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("会话 {session_id} 的提示队列缺少 {key}"))
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    session_id: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("会话 {session_id} 的提示队列缺少 {key}"))
}

fn required_enum(
    object: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
    session_id: &str,
) -> Result<(), String> {
    let value = required_string(object, key, session_id)?;
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!("会话 {session_id} 的提示队列 {key} 无效"))
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc, thread};

    use super::*;

    fn row(id: &str) -> Value {
        serde_json::json!({
            "id": id,
            "text": id,
            "attachments": [],
            "model": "grok-build",
            "effort": "high",
            "mode": "agent",
            "permissionMode": "auto",
            "createdAt": 1,
        })
    }

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "grox-prompt-queue-{name}-{}-{}.json",
            std::process::id(),
            crate::CONFIG_WRITE_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn patch_preserves_unrelated_sessions() {
        let path = temp_file("preserve");
        fs::write(&path, serde_json::json!({ "a": [row("a1")] }).to_string()).unwrap();
        let store = PromptQueueStore::default();
        store
            .patch(
                &path,
                BTreeMap::from([("b".into(), serde_json::json!([row("b1")]))]),
                vec![],
                1024 * 1024,
            )
            .unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["a"][0]["id"], "a1");
        assert_eq!(value["b"][0]["id"], "b1");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn concurrent_session_patches_do_not_overwrite_each_other() {
        let path = temp_file("concurrent");
        let store = Arc::new(PromptQueueStore::default());
        let first_store = Arc::clone(&store);
        let first_path = path.clone();
        let first = thread::spawn(move || {
            first_store
                .patch(
                    &first_path,
                    BTreeMap::from([("a".into(), serde_json::json!([row("a1")]))]),
                    vec![],
                    1024 * 1024,
                )
                .unwrap();
        });
        let second_store = Arc::clone(&store);
        let second_path = path.clone();
        let second = thread::spawn(move || {
            second_store
                .patch(
                    &second_path,
                    BTreeMap::from([("b".into(), serde_json::json!([row("b1")]))]),
                    vec![],
                    1024 * 1024,
                )
                .unwrap();
        });
        first.join().unwrap();
        second.join().unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn deletion_and_validation_are_transactional() {
        let path = temp_file("delete");
        let store = PromptQueueStore::default();
        fs::write(
            &path,
            serde_json::json!({ "a": [row("a1")], "b": [row("b1")] }).to_string(),
        )
        .unwrap();
        store
            .delete_sessions(&path, &["a".into()], 1024 * 1024)
            .unwrap();
        assert!(store
            .patch(
                &path,
                BTreeMap::from([("b".into(), serde_json::json!([{"id":"bad"}]))]),
                vec![],
                1024 * 1024,
            )
            .is_err());

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(value.get("a").is_none());
        assert_eq!(value["b"][0]["id"], "b1");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn deletion_initializes_an_empty_native_store() {
        let path = temp_file("empty-delete");
        let store = PromptQueueStore::default();
        store
            .delete_sessions(&path, &["deleted-session".into()], 1024 * 1024)
            .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn zero_length_file_fails_closed() {
        let path = temp_file("zero-length");
        fs::write(&path, "").unwrap();
        assert!(PromptQueueStore::default()
            .read(&path, 1024 * 1024)
            .unwrap_err()
            .contains("文件为空"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn claim_is_durable_but_host_runtime_is_not_exposed() {
        let path = temp_file("claim");
        fs::write(
            &path,
            serde_json::json!({ "s": [row("q1"), row("q2")] }).to_string(),
        )
        .unwrap();
        let store = PromptQueueStore::default();
        let claim = store.claim(&path, "s", "q1", 7, 1024 * 1024).unwrap();

        assert_eq!(claim.entry["id"], "q1");
        assert_eq!(claim.queue[0]["state"], "sending");
        assert!(claim.queue[0].get(HOST_RUNTIME_KEY).is_none());
        let disk: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(disk["s"][0][HOST_RUNTIME_KEY]["token"], claim.token);
        let public: Value =
            serde_json::from_str(&store.read(&path, 1024 * 1024).unwrap().unwrap()).unwrap();
        assert!(public["s"][0].get(HOST_RUNTIME_KEY).is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ordinary_patch_cannot_erase_or_forge_an_active_claim() {
        let path = temp_file("claim-patch");
        fs::write(
            &path,
            serde_json::json!({ "s": [row("q1"), row("q2")] }).to_string(),
        )
        .unwrap();
        let store = PromptQueueStore::default();
        store.claim(&path, "s", "q1", 3, 1024 * 1024).unwrap();

        assert!(store
            .patch(
                &path,
                BTreeMap::from([("s".into(), serde_json::json!([row("q2")]))]),
                vec![],
                1024 * 1024,
            )
            .is_err());
        assert!(store
            .patch(
                &path,
                BTreeMap::from([("s".into(), serde_json::json!([row("q2"), row("q1")]),)]),
                vec![],
                1024 * 1024,
            )
            .is_err());
        let mut forged = row("q1");
        forged[HOST_RUNTIME_KEY] = serde_json::json!({
            "owner": "browser",
            "token": "forged",
            "generation": 3,
            "claimedAt": 1,
        });
        forged["state"] = Value::String("sending".into());
        assert!(store
            .patch(
                &path,
                BTreeMap::from([("s".into(), serde_json::json!([forged, row("q2")]))]),
                vec![],
                1024 * 1024,
            )
            .is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn settlement_consumes_success_and_requeues_ambiguous_failure() {
        let path = temp_file("settle");
        fs::write(
            &path,
            serde_json::json!({ "s": [row("q1"), row("q2")] }).to_string(),
        )
        .unwrap();
        let store = PromptQueueStore::default();
        let first = store.claim(&path, "s", "q1", 4, 1024 * 1024).unwrap();
        let queue = store
            .settle(&path, &first, PromptQueueSettlement::Retry, 1024 * 1024)
            .unwrap();
        assert_eq!(queue[0]["id"], "q1");
        assert_eq!(queue[0]["state"], "queued");

        let retry = store.claim(&path, "s", "q1", 4, 1024 * 1024).unwrap();
        let queue = store
            .settle(&path, &retry, PromptQueueSettlement::Consumed, 1024 * 1024)
            .unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0]["id"], "q2");
        assert_eq!(
            store.settle(&path, &first, PromptQueueSettlement::Consumed, 1024 * 1024,),
            Err(PromptQueueClaimError::Stale)
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn late_browser_patch_cannot_resurrect_a_consumed_claim() {
        let path = temp_file("claim-tombstone");
        fs::write(
            &path,
            serde_json::json!({ "s": [row("q1"), row("q2")] }).to_string(),
        )
        .unwrap();
        let store = PromptQueueStore::default();
        let claim = store.claim(&path, "s", "q1", 8, 1024 * 1024).unwrap();
        store
            .settle(&path, &claim, PromptQueueSettlement::Consumed, 1024 * 1024)
            .unwrap();

        // 模拟在 Host 结算前已经进入 WebView Promise 链的旧整会话 patch。
        store
            .patch(
                &path,
                BTreeMap::from([("s".into(), serde_json::json!([row("q1"), row("q2")]))]),
                vec![],
                1024 * 1024,
            )
            .unwrap();
        let disk: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(disk["s"].as_array().unwrap().len(), 1);
        assert_eq!(disk["s"][0]["id"], "q2");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn process_restart_and_generation_change_recover_a_stranded_claim() {
        let path = temp_file("claim-recovery");
        fs::write(&path, serde_json::json!({ "s": [row("q1")] }).to_string()).unwrap();
        let first_store = PromptQueueStore::default();
        let first = first_store.claim(&path, "s", "q1", 1, 1024 * 1024).unwrap();

        let same_process = first_store.claim(&path, "s", "q1", 2, 1024 * 1024).unwrap();
        assert_ne!(same_process.token, first.token);
        drop(first_store);

        let restarted = PromptQueueStore::default();
        let public: Value =
            serde_json::from_str(&restarted.read(&path, 1024 * 1024).unwrap().unwrap()).unwrap();
        assert_eq!(public["s"][0]["state"], "queued");
        assert!(public["s"][0].get(HOST_RUNTIME_KEY).is_none());
        assert!(restarted.claim(&path, "s", "q1", 1, 1024 * 1024).is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_sending_row_without_a_host_claim_is_recovered() {
        let path = temp_file("orphan-sending");
        let mut orphan = row("q1");
        orphan["state"] = Value::String("sending".into());
        fs::write(&path, serde_json::json!({ "s": [orphan] }).to_string()).unwrap();

        let store = PromptQueueStore::default();
        let public: Value =
            serde_json::from_str(&store.read(&path, 1024 * 1024).unwrap().unwrap()).unwrap();
        assert_eq!(public["s"][0]["state"], "queued");
        assert!(store.claim(&path, "s", "q1", 1, 1024 * 1024).is_ok());
        let _ = fs::remove_file(path);
    }
}
