//! Short-lived confirmation tokens for destructive git IPC.
//!
//! `prepare_*` commands show a native OS dialog before minting a token.
//! Commit/push/worktree-remove then consume a matching token so a bare
//! `invoke` cannot skip the human gate without that dialog.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const TOKEN_TTL: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct GitConfirmStore {
    inner: Mutex<HashMap<String, Entry>>,
}

struct Entry {
    kind: Kind,
    cwd: String,
    expires: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Commit,
    Push,
    WorktreeRemove,
}

impl GitConfirmStore {
    pub fn issue_commit(&self, cwd: &str) -> Result<String, String> {
        self.issue(Kind::Commit, cwd)
    }

    pub fn issue_push(&self, cwd: &str) -> Result<String, String> {
        self.issue(Kind::Push, cwd)
    }

    pub fn issue_worktree_remove(&self, cwd: &str) -> Result<String, String> {
        self.issue(Kind::WorktreeRemove, cwd)
    }

    pub fn consume_commit(&self, cwd: &str, token: &str) -> Result<(), String> {
        self.consume(Kind::Commit, cwd, token)
    }

    pub fn consume_push(&self, cwd: &str, token: &str) -> Result<(), String> {
        self.consume(Kind::Push, cwd, token)
    }

    pub fn consume_worktree_remove(&self, cwd: &str, token: &str) -> Result<(), String> {
        self.consume(Kind::WorktreeRemove, cwd, token)
    }

    fn issue(&self, kind: Kind, cwd: &str) -> Result<String, String> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|error| format!("无法创建 git 确认令牌：{error}"))?;
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "git 确认表锁定失败".to_string())?;
        guard.retain(|_, entry| entry.expires > Instant::now());
        guard.insert(
            token.clone(),
            Entry {
                kind,
                cwd: cwd.to_string(),
                expires: Instant::now() + TOKEN_TTL,
            },
        );
        Ok(token)
    }

    fn consume(&self, kind: Kind, cwd: &str, token: &str) -> Result<(), String> {
        let token = token.trim();
        if token.is_empty() {
            return Err("缺少 git 操作确认令牌；请先在界面中确认".into());
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "git 确认表锁定失败".to_string())?;
        guard.retain(|_, entry| entry.expires > Instant::now());
        let Some(entry) = guard.get(token) else {
            return Err("git 确认令牌无效或已过期，请重新确认".into());
        };
        if entry.kind != kind || entry.cwd != cwd {
            return Err("git 确认令牌与当前操作不匹配".into());
        }
        guard.remove(token);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_token_is_single_use_and_cwd_bound() {
        let store = GitConfirmStore::default();
        let token = store.issue_commit("/project").unwrap();
        assert!(store.consume_commit("/other", &token).is_err());
        let token = store.issue_commit("/project").unwrap();
        store.consume_commit("/project", &token).unwrap();
        assert!(store.consume_commit("/project", &token).is_err());
    }

    #[test]
    fn push_token_rejects_commit_consume() {
        let store = GitConfirmStore::default();
        let token = store.issue_push("/project").unwrap();
        assert!(store.consume_commit("/project", &token).is_err());
        store.consume_push("/project", &token).unwrap();
    }

    #[test]
    fn worktree_remove_token_is_kind_bound() {
        let store = GitConfirmStore::default();
        let token = store.issue_worktree_remove("/project").unwrap();
        assert!(store.consume_commit("/project", &token).is_err());
        store.consume_worktree_remove("/project", &token).unwrap();
    }
}
