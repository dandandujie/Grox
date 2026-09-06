//! Git worktree 与会话的 Host 所有权索引。
//!
//! `cwd` 是会话协议事实，但“这个目录能否被删除”是本机资源事实。Host 在
//! session/new|load 成功后持久化关联，并在本机删除事务完成后解除关联；
//! worktree 删除命令只读取这一索引、现存 journal 与自动化仓储，不信任
//! WebView 传来的会话目录快照。

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use crate::host_core::{atomic_write_bounded_private, git_text, read_bounded_text};
use serde::{Deserialize, Serialize};



pub(crate) const WORKTREE_BINDINGS_MAX_BYTES: u64 = 4 * 1024 * 1024;
const WORKTREE_BINDINGS_VERSION: u32 = 1;
const MAX_BINDINGS: usize = 4_000;
const MAX_SESSION_ID_CHARS: usize = 512;
const JOURNAL_SCAN_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorktreeBinding {
    session_id: String,
    worktree_path: String,
    repository_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    updated_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingFile {
    version: u32,
    bindings: BTreeMap<String, WorktreeBinding>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DetectedWorktree {
    path: PathBuf,
    repository_root: PathBuf,
    branch: Option<String>,
}

#[derive(Default)]
pub(crate) struct WorktreeOwnershipStore {
    lifecycle: Mutex<()>,
    transaction: Mutex<()>,
    openings: Mutex<BTreeMap<u64, PathBuf>>,
    next_opening: AtomicU64,
}

pub(crate) struct WorktreeUseLease<'a> {
    store: &'a WorktreeOwnershipStore,
    token: u64,
}

impl WorktreeOwnershipStore {
    /// 在发出 session/new|load 前登记 cwd。租约存活期间，删除门禁即使还
    /// 没拿到真实 sessionId 也会把目标视为被占用。
    pub(crate) fn begin_session_use(&self, cwd: &Path) -> Result<WorktreeUseLease<'_>, String> {
        let _lifecycle = self.lock_lifecycle();
        let current = cwd
            .canonicalize()
            .map_err(|error| format!("会话工作区在打开前已不可用：{error}"))?;
        let token = self.next_opening.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock_openings().insert(token, current);
        Ok(WorktreeUseLease { store: self, token })
    }

    pub(crate) fn opening_references(&self, target: &Path) -> usize {
        self.lock_openings()
            .values()
            .filter(|cwd| path_is_within(cwd, target))
            .count()
    }

    /// 绑定真实 sessionId；主工作树会清除该会话可能残留的旧关联。
    pub(crate) fn bind_session(
        &self,
        path: &Path,
        session_id: &str,
        cwd: &Path,
    ) -> Result<bool, String> {
        validate_session_id(session_id)?;
        let detected = detect_linked_worktree(cwd)?;
        let _lifecycle = self.lock_lifecycle();
        let _transaction = self.lock_transaction();
        let mut file = self.read_locked(path)?;
        let changed = if let Some(worktree) = detected {
            let mut binding = WorktreeBinding {
                session_id: session_id.to_string(),
                worktree_path: path_text(&worktree.path),
                repository_root: path_text(&worktree.repository_root),
                branch: worktree.branch,
                updated_at: now_ms(),
            };
            let unchanged = file.bindings.get(session_id).is_some_and(|current| {
                current.session_id == binding.session_id
                    && current.worktree_path == binding.worktree_path
                    && current.repository_root == binding.repository_root
                    && current.branch == binding.branch
            });
            if unchanged {
                false
            } else {
                if let Some(current) = file.bindings.get(session_id) {
                    binding.updated_at = current.updated_at.max(binding.updated_at);
                }
                file.bindings.insert(session_id.to_string(), binding);
                true
            }
        } else {
            file.bindings.remove(session_id).is_some()
        };
        if changed {
            self.write_locked(path, &file)?;
        }
        Ok(changed)
    }

    pub(crate) fn delete_sessions(&self, path: &Path, ids: &[String]) -> Result<(), String> {
        for id in ids {
            validate_session_id(id)?;
        }
        let _lifecycle = self.lock_lifecycle();
        let _transaction = self.lock_transaction();
        let mut file = self.read_locked(path)?;
        let before = file.bindings.len();
        for id in ids {
            file.bindings.remove(id);
        }
        if file.bindings.len() != before {
            self.write_locked(path, &file)?;
        }
        Ok(())
    }

    pub(crate) fn session_references(
        &self,
        path: &Path,
        target: &Path,
    ) -> Result<BTreeSet<String>, String> {
        let _transaction = self.lock_transaction();
        let file = self.read_locked(path)?;
        Ok(file
            .bindings
            .into_iter()
            .filter_map(|(id, binding)| {
                path_is_within(Path::new(&binding.worktree_path), target).then_some(id)
            })
            .collect())
    }

    pub(crate) fn count(&self, path: &Path) -> Result<usize, String> {
        let _transaction = self.lock_transaction();
        Ok(self.read_locked(path)?.bindings.len())
    }

    /// 删除、会话绑定和自动化 cwd patch 共用这一资源锁。删除方持锁完成
    /// “再次检查引用 -> git remove”，避免检查后新会话钻入即将消失的目录。
    pub(crate) fn lock_lifecycle(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn read_locked(&self, path: &Path) -> Result<BindingFile, String> {
        if !path.is_file() {
            return Ok(BindingFile {
                version: WORKTREE_BINDINGS_VERSION,
                bindings: BTreeMap::new(),
            });
        }
        let content = read_bounded_text(path, WORKTREE_BINDINGS_MAX_BYTES)
            .map_err(|error| format!("无法读取 worktree 会话索引：{error}"))?;
        let file = serde_json::from_str::<BindingFile>(&content)
            .map_err(|error| format!("worktree 会话索引不是有效 JSON：{error}"))?;
        validate_file(file)
    }

    fn write_locked(&self, path: &Path, file: &BindingFile) -> Result<(), String> {
        if file.bindings.len() > MAX_BINDINGS {
            return Err(format!("worktree 会话关联不能超过 {MAX_BINDINGS} 条"));
        }
        let content = serde_json::to_string(file)
            .map_err(|error| format!("无法序列化 worktree 会话索引：{error}"))?;
        atomic_write_bounded_private(path, &content, WORKTREE_BINDINGS_MAX_BYTES)
    }

    fn lock_transaction(&self) -> std::sync::MutexGuard<'_, ()> {
        self.transaction
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_openings(&self) -> std::sync::MutexGuard<'_, BTreeMap<u64, PathBuf>> {
        self.openings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Drop for WorktreeUseLease<'_> {
    fn drop(&mut self) {
        let _lifecycle = self.store.lock_lifecycle();
        self.store.lock_openings().remove(&self.token);
    }
}

fn validate_file(mut file: BindingFile) -> Result<BindingFile, String> {
    if file.version != WORKTREE_BINDINGS_VERSION {
        return Err(format!("不支持的 worktree 会话索引版本：{}", file.version));
    }
    if file.bindings.len() > MAX_BINDINGS {
        return Err(format!("worktree 会话关联不能超过 {MAX_BINDINGS} 条"));
    }
    for (id, binding) in &file.bindings {
        validate_session_id(id)?;
        if binding.session_id != *id
            || binding.worktree_path.trim().is_empty()
            || binding.repository_root.trim().is_empty()
            || !Path::new(&binding.worktree_path).is_absolute()
            || !Path::new(&binding.repository_root).is_absolute()
        {
            return Err(format!("worktree 会话关联无效：{id}"));
        }
    }
    // 反序列化旧文件时仍强制回写当前版本语义。
    file.version = WORKTREE_BINDINGS_VERSION;
    Ok(file)
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.trim() != id
        || id.is_empty()
        || id.chars().count() > MAX_SESSION_ID_CHARS
        || id.chars().any(char::is_control)
    {
        Err("worktree 关联包含无效会话 ID".into())
    } else {
        Ok(())
    }
}

fn detect_linked_worktree(cwd: &Path) -> Result<Option<DetectedWorktree>, String> {
    let top_level = match git_text(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    let worktree = PathBuf::from(top_level)
        .canonicalize()
        .map_err(|error| format!("无法解析会话 Git 工作树：{error}"))?;
    let listed = git_text(&worktree, &["worktree", "list", "--porcelain"])?;
    let primary = listed
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .map(PathBuf::from)
        .ok_or_else(|| "Git 未返回主工作树".to_string())?
        .canonicalize()
        .map_err(|error| format!("无法解析 Git 主工作树：{error}"))?;
    if worktree == primary {
        return Ok(None);
    }
    let branch = git_text(&worktree, &["branch", "--show-current"])
        .ok()
        .filter(|branch| !branch.is_empty());
    Ok(Some(DetectedWorktree {
        path: worktree,
        repository_root: primary,
        branch,
    }))
}

/// 兼容 v0.3.2 以前尚未建立 Host 索引的会话；journal 只补充引用，不反向
/// 覆盖所有权文件。任何已有 journal 无法读取时都拒绝删除 worktree，不能把
/// “诊断失败”误当成“没有引用”。
pub(crate) fn journal_session_references(
    app_config_dir: &Path,
    target: &Path,
) -> Result<BTreeSet<String>, String> {
    let mut references = BTreeSet::new();
    let sessions = app_config_dir.join("sessions");
    match fs::read_dir(&sessions) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!("无法枚举应用会话目录 {}：{error}", sessions.display())
                })?;
                collect_journal_reference(
                    &entry.path().join("journal.json"),
                    target,
                    &mut references,
                )?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法读取应用会话目录 {}：{error}", sessions.display())),
    }
    let legacy = app_config_dir.join("session-cache");
    match fs::read_dir(&legacy) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!("无法枚举旧版会话缓存 {}：{error}", legacy.display())
                })?;
                collect_journal_reference(&entry.path(), target, &mut references)?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法读取旧版会话缓存 {}：{error}", legacy.display())),
    }
    Ok(references)
}

fn collect_journal_reference(
    path: &Path,
    target: &Path,
    output: &mut BTreeSet<String>,
) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let content = read_bounded_text(path, JOURNAL_SCAN_MAX_BYTES)
        .map_err(|error| format!("无法检查会话 journal {}：{error}", path.display()))?;
    let value = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("会话 journal 损坏 {}：{error}", path.display()))?;
    let session = value.get("session").unwrap_or(&value);
    let id = session
        .get("id")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .get("appSessionId")
                .and_then(serde_json::Value::as_str)
        });
    let cwd = session.get("cwd").and_then(serde_json::Value::as_str);
    let id = id.ok_or_else(|| format!("会话 journal 缺少会话 ID：{}", path.display()))?;
    let cwd = cwd.ok_or_else(|| format!("会话 journal 缺少工作区：{}", path.display()))?;
    validate_session_id(id)
        .map_err(|error| format!("会话 journal ID 无效 {}：{error}", path.display()))?;
    if path_is_within(Path::new(cwd), target) {
        output.insert(id.to_string());
    }
    Ok(())
}

pub(crate) fn path_is_within(candidate: &Path, target: &Path) -> bool {
    let Ok(target) = target.canonicalize() else {
        return false;
    };
    if let Ok(candidate) = candidate.canonicalize() {
        return candidate.starts_with(&target);
    }
    // journal/自动化保存的 cwd 可能指向 worktree 中后来被删除的子目录。
    // 复用写入目标的“最近现存父目录”解析，既保留这类真实引用，也拒绝
    // `..`、符号链接逃逸和仅有字符串前缀相同的相邻目录。
    crate::path_sandbox::checked_workspace_target(
        &target,
        &crate::path_sandbox::path_for_webview(candidate),
    )
    .is_ok()
}

fn path_text(path: &Path) -> String {
    crate::path_sandbox::path_for_webview(path)
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
    use super::*;
    use std::process::Command;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "grox-worktree-{label}-{}-{}",
            std::process::id(),
            crate::CONFIG_WRITE_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository_with_worktree() -> (PathBuf, PathBuf) {
        let base = temp_dir("repo");
        let repo = base.join("source");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init"]);
        git(&repo, &["config", "user.email", "grox@example.invalid"]);
        git(&repo, &["config", "user.name", "Grox Test"]);
        fs::write(repo.join("README.md"), "test\n").unwrap();
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-m", "init"]);
        let worktree = base.join("linked");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "grox-test-linked",
                worktree.to_str().unwrap(),
            ],
        );
        (repo, worktree)
    }

    #[test]
    fn detects_only_linked_worktrees() {
        let (repo, worktree) = repository_with_worktree();
        assert!(detect_linked_worktree(&repo).unwrap().is_none());
        let linked = detect_linked_worktree(&worktree).unwrap().unwrap();
        assert_eq!(linked.path, worktree.canonicalize().unwrap());
        assert_eq!(linked.repository_root, repo.canonicalize().unwrap());
        fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    #[test]
    fn persists_binding_and_clears_it_when_session_returns_to_primary() {
        let (repo, worktree) = repository_with_worktree();
        let index = repo.parent().unwrap().join("bindings.json");
        let store = WorktreeOwnershipStore::default();
        assert!(store.bind_session(&index, "session-1", &worktree).unwrap());
        assert_eq!(
            store.session_references(&index, &worktree).unwrap(),
            BTreeSet::from(["session-1".to_string()])
        );
        assert!(store.bind_session(&index, "session-1", &repo).unwrap());
        assert!(store
            .session_references(&index, &worktree)
            .unwrap()
            .is_empty());
        fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    #[test]
    fn legacy_journal_reference_blocks_nested_workspace_removal() {
        let config = temp_dir("journal");
        let target = config.join("linked");
        let nested = target.join("packages").join("app");
        fs::create_dir_all(&nested).unwrap();
        let session_dir = config.join("sessions").join("session-1");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("journal.json"),
            serde_json::json!({
                "version": 1,
                "appSessionId": "session-1",
                "session": { "id": "session-1", "cwd": path_text(&nested) }
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            journal_session_references(&config, &target).unwrap(),
            BTreeSet::from(["session-1".to_string()])
        );
        fs::remove_dir_all(config).ok();
    }

    #[test]
    fn corrupt_legacy_journal_blocks_worktree_removal_scan() {
        let config = temp_dir("corrupt-journal");
        let target = config.join("linked");
        fs::create_dir_all(&target).unwrap();
        let session_dir = config.join("sessions").join("session-1");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("journal.json"), "not-json").unwrap();
        assert!(journal_session_references(&config, &target)
            .unwrap_err()
            .contains("journal 损坏"));
        fs::remove_dir_all(config).ok();
    }

    #[test]
    fn opening_session_lease_blocks_worktree_until_every_exit_path_drops_it() {
        let target = temp_dir("opening");
        let nested = target.join("package");
        fs::create_dir_all(&nested).unwrap();
        let store = WorktreeOwnershipStore::default();
        {
            let _opening = store.begin_session_use(&nested).unwrap();
            assert_eq!(store.opening_references(&target), 1);
        }
        assert_eq!(store.opening_references(&target), 0);
        fs::remove_dir_all(target).ok();
    }

    #[test]
    fn opening_session_rejects_a_workspace_removed_before_registration() {
        let target = temp_dir("removed-before-opening");
        let canonical = target.canonicalize().unwrap();
        fs::remove_dir_all(target).unwrap();
        let store = WorktreeOwnershipStore::default();
        assert!(store.begin_session_use(&canonical).is_err());
        assert_eq!(store.opening_references(&canonical), 0);
    }
}
