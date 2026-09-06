//! ACP Agent -> Client 文件回调的 Host 生命周期。
//!
//! Grox 在 initialize 中宣告了 fs 能力，因此 stdio Host 必须负责应答。
//! WebView 不应持有 session -> cwd 映射，更不能在页面重载后用当前工作区
//! 猜测请求归属。session/new 尚未返回 id 时由唯一的 lifecycle opening
//! 临时绑定 cwd；成功后再提交为代次内的正式会话绑定。

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use serde_json::{json, Value};

use crate::{
    acp_inbound::AcpInbound,
    host_core::acp_read_file,
    host_core::acp_read_text_file,
    host_core::acp_write_text_file,
    path_sandbox::path_for_webview,
    terminal_host::{TerminalHost, TerminalMethod},
};

const MAX_CALLBACK_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSION_ID_CHARS: usize = 512;
const MAX_PATH_CHARS: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CallbackMethod {
    ReadText,
    ReadFile,
    WriteText,
    Terminal(TerminalMethod),
}

#[derive(Clone, Debug)]
pub(crate) struct ClientCallbackLease {
    generation: u64,
    rpc_id: Value,
    rpc_key: String,
    session_id: String,
    workspace: PathBuf,
    owner_token: Option<u64>,
    method: CallbackMethod,
    params: Value,
}

#[derive(Clone, Debug)]
pub(crate) enum ClientCallbackInbound {
    NotCallback,
    Request(ClientCallbackLease),
    AutoReply(String),
    Duplicate,
    Invalid,
}

#[derive(Clone, Debug)]
pub(crate) struct SessionOpenLease {
    token: u64,
    generation: u64,
}

#[derive(Clone, Debug)]
struct SessionOpening {
    token: u64,
    generation: u64,
    requested_session_id: Option<String>,
    observed_session_id: Option<String>,
    workspace: PathBuf,
}

#[derive(Clone, Debug)]
struct SessionBinding {
    token: u64,
    workspace: PathBuf,
}

#[derive(Default)]
struct RegistryState {
    generation: u64,
    sessions: BTreeMap<String, SessionBinding>,
    opening: Option<SessionOpening>,
    pending_rpc: BTreeSet<String>,
}

#[derive(Default)]
pub(crate) struct ClientCallbackRegistry {
    state: Mutex<RegistryState>,
    operation_lock: tokio::sync::Mutex<()>,
    next_open_token: AtomicU64,
    terminals: TerminalHost,
}

impl ClientCallbackRegistry {
    pub(crate) async fn lock_operations(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.operation_lock.lock().await
    }

    pub(crate) async fn reset(&self, generation: u64) {
        let _operation_guard = self.lock_operations().await;
        {
            let mut state = self.lock();
            state.generation = generation;
            state.sessions.clear();
            state.opening = None;
            state.pending_rpc.clear();
        }
        self.terminals.reset(generation).await;
    }

    pub(crate) fn begin_session_open(
        &self,
        generation: u64,
        requested_session_id: Option<&str>,
        workspace: &Path,
    ) -> Result<SessionOpenLease, String> {
        let mut state = self.lock();
        if state.generation != generation {
            return Err("会话打开属于已替换的 Agent 进程".into());
        }
        if state.opening.is_some() {
            return Err("已有会话正在绑定 Client callback 工作区".into());
        }
        let token = self.next_open_token.fetch_add(1, Ordering::Relaxed) + 1;
        state.opening = Some(SessionOpening {
            token,
            generation,
            requested_session_id: requested_session_id.map(str::to_string),
            observed_session_id: None,
            workspace: workspace.to_path_buf(),
        });
        Ok(SessionOpenLease { token, generation })
    }

    pub(crate) fn commit_session_open(
        &self,
        lease: &SessionOpenLease,
        session_id: &str,
    ) -> Result<(), String> {
        let mut state = self.lock();
        let opening = state
            .opening
            .as_ref()
            .filter(|opening| {
                opening.token == lease.token && opening.generation == lease.generation
            })
            .ok_or_else(|| "会话 callback 绑定已失效".to_string())?;
        if opening
            .requested_session_id
            .as_deref()
            .is_some_and(|expected| expected != session_id)
            || opening
                .observed_session_id
                .as_deref()
                .is_some_and(|observed| observed != session_id)
        {
            return Err("Agent 在 session/new|load 期间使用了不一致的 sessionId".into());
        }
        let workspace = opening.workspace.clone();
        state.opening = None;
        state.sessions.insert(
            session_id.to_string(),
            SessionBinding {
                token: lease.token,
                workspace,
            },
        );
        Ok(())
    }

    pub(crate) async fn abort_session_open(&self, lease: &SessionOpenLease) {
        let _operation_guard = self.lock_operations().await;
        let aborted = {
            let mut state = self.lock();
            if state.opening.as_ref().is_some_and(|opening| {
                opening.token == lease.token && opening.generation == lease.generation
            }) {
                state.opening = None;
                true
            } else {
                false
            }
        };
        if aborted {
            self.terminals
                .release_owner(lease.generation, lease.token)
                .await;
        }
    }

    pub(crate) async fn unbind_session(&self, session_id: &str) {
        let _operation_guard = self.lock_operations().await;
        let generation = {
            let mut state = self.lock();
            state.sessions.remove(session_id);
            state.generation
        };
        self.terminals
            .release_session(generation, session_id)
            .await;
    }

    pub(crate) fn pending_len(&self) -> usize {
        self.lock().pending_rpc.len()
    }

    pub(crate) fn bound_len(&self) -> usize {
        self.lock().sessions.len()
    }

    pub(crate) fn bound_session_ids(&self) -> Vec<String> {
        self.lock().sessions.keys().cloned().collect()
    }

    pub(crate) fn bound_session_workspaces(&self) -> Vec<(String, PathBuf)> {
        self.lock()
            .sessions
            .iter()
            .map(|(session_id, binding)| (session_id.clone(), binding.workspace.clone()))
            .collect()
    }

    /// 返回当前进程代次内实际绑定到目标目录的会话。worktree 删除门禁用
    /// Host 绑定补住 session/new 成功后 journal 尚未落盘的短窗口。
    pub(crate) fn sessions_within(&self, target: &Path) -> BTreeSet<String> {
        self.lock()
            .sessions
            .iter()
            .filter_map(|(id, binding)| {
                crate::worktree_ownership::path_is_within(&binding.workspace, target)
                    .then_some(id.clone())
            })
            .collect()
    }

    pub(crate) async fn terminal_len(&self) -> usize {
        self.terminals.len().await
    }

    #[cfg(test)]
    pub(crate) fn observe_inbound(&self, generation: u64, line: &str) -> ClientCallbackInbound {
        let Ok(message) = AcpInbound::parse(line) else {
            return ClientCallbackInbound::NotCallback;
        };
        self.observe_decoded_inbound(generation, &message)
    }

    pub(crate) fn observe_decoded_inbound(
        &self,
        generation: u64,
        message: &AcpInbound,
    ) -> ClientCallbackInbound {
        let Some(method) = message.method() else {
            return ClientCallbackInbound::NotCallback;
        };
        let params = message.params();
        let Some(method) = callback_method(method) else {
            return ClientCallbackInbound::NotCallback;
        };
        let Some(rpc_id) = valid_rpc_id(message.id()) else {
            return ClientCallbackInbound::Invalid;
        };
        let rpc_key = rpc_id_key(&rpc_id);
        let Some(params) = params.as_object() else {
            return ClientCallbackInbound::AutoReply(error_line(
                &rpc_id,
                -32602,
                "Client callback params 必须是对象",
            ));
        };
        let session_id = params
            .get("sessionId")
            .or_else(|| params.get("session_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.chars().count() <= MAX_SESSION_ID_CHARS)
            .map(str::to_string);
        let Some(session_id) = session_id else {
            return ClientCallbackInbound::AutoReply(error_line(
                &rpc_id,
                -32602,
                "Client callback 缺少合法 sessionId",
            ));
        };

        let mut state = self.lock();
        if state.generation != generation {
            return ClientCallbackInbound::AutoReply(error_line(
                &rpc_id,
                -32000,
                "Client callback 属于已替换的 Agent 进程",
            ));
        }
        if state.pending_rpc.contains(&rpc_key) {
            // 覆盖仍在处理的同 id 请求会让一次回复解除错误的 RPC。
            return ClientCallbackInbound::Duplicate;
        }
        // session/load 的 opening 必须覆盖同 id 的旧 cwd；session/new 则先
        // 保留其它已绑定会话，只有未知 id 才领取本次临时工作区。
        let loading_workspace = state.opening.as_ref().and_then(|opening| {
            (opening.generation == generation
                && opening.requested_session_id.as_deref() == Some(session_id.as_str()))
            .then(|| (opening.workspace.clone(), Some(opening.token)))
        });
        let binding = loading_workspace
            .or_else(|| {
                state
                    .sessions
                    .get(&session_id)
                    .cloned()
                    .map(|binding| (binding.workspace, Some(binding.token)))
            })
            .or_else(|| {
                state.opening.as_mut().and_then(|opening| {
                    if opening.generation != generation
                        || opening.requested_session_id.is_some()
                        || opening
                            .observed_session_id
                            .as_deref()
                            .is_some_and(|observed| observed != session_id)
                    {
                        return None;
                    }
                    opening.observed_session_id = Some(session_id.clone());
                    Some((opening.workspace.clone(), Some(opening.token)))
                })
            });
        let Some((workspace, owner_token)) = binding else {
            return ClientCallbackInbound::AutoReply(error_line(
                &rpc_id,
                -32000,
                "会话尚未绑定 Host 工作区，已拒绝猜测当前页面目录",
            ));
        };
        state.pending_rpc.insert(rpc_key.clone());
        ClientCallbackInbound::Request(ClientCallbackLease {
            generation,
            rpc_id,
            rpc_key,
            session_id,
            workspace,
            owner_token,
            method,
            params: Value::Object(params.clone()),
        })
    }

    pub(crate) async fn render_response(&self, lease: &ClientCallbackLease) -> String {
        let result = match lease.method {
            CallbackMethod::Terminal(TerminalMethod::Create) => {
                // Create and session unbind/reset share this short critical
                // section, so close cannot miss a child between spawn and insert.
                let _operation_guard = self.lock_operations().await;
                if !self.lease_is_authorized(lease) {
                    Err(CallbackFailure::operation(
                        "终端创建所属的会话或 Agent 代次已失效",
                    ))
                } else {
                    self.execute_terminal(lease).await
                }
            }
            CallbackMethod::Terminal(_) => self.execute_terminal(lease).await,
            _ => {
                // 文件写入与 generation reset 串行，避免旧进程在被替换时
                // 继续修改工作区；异步派发后仍需重新校验 lease。
                let _operation_guard = self.lock_operations().await;
                if !self.lease_is_authorized(lease) {
                    Err(CallbackFailure::operation(
                        "Client callback 所属的会话或 Agent 代次已失效",
                    ))
                } else {
                    execute_file_callback(lease)
                }
            }
        };
        let line = match result {
            Ok(result) => success_line(&lease.rpc_id, result),
            Err(error) => error_line(&lease.rpc_id, error.code, &error.message),
        };
        if line.len() <= MAX_CALLBACK_RESPONSE_BYTES {
            line
        } else {
            error_line(&lease.rpc_id, -32000, "Client callback 响应超过 8 MB 上限")
        }
    }

    async fn execute_terminal(
        &self,
        lease: &ClientCallbackLease,
    ) -> Result<Value, CallbackFailure> {
        let CallbackMethod::Terminal(method) = lease.method else {
            unreachable!("terminal dispatcher only accepts terminal methods");
        };
        let params = lease
            .params
            .as_object()
            .ok_or_else(|| CallbackFailure::params("Client callback params 必须是对象"))?;
        self.terminals
            .execute(
                lease.generation,
                &lease.session_id,
                &lease.workspace,
                lease.owner_token,
                method,
                params,
            )
            .await
            .map_err(|error| CallbackFailure {
                code: error.code,
                message: error.message,
            })
    }

    pub(crate) fn settle(&self, lease: &ClientCallbackLease) -> bool {
        let mut state = self.lock();
        if state.generation != lease.generation {
            return false;
        }
        state.pending_rpc.remove(&lease.rpc_key)
    }

    pub(crate) fn describe(lease: &ClientCallbackLease) -> (&str, &str) {
        let method = match lease.method {
            CallbackMethod::ReadText => "fs/read_text_file",
            CallbackMethod::ReadFile => "x.ai/fs/read_file",
            CallbackMethod::WriteText => "fs/write_text_file",
            CallbackMethod::Terminal(method) => method.name(),
        };
        (&lease.session_id, method)
    }

    pub(crate) fn waits_for_terminal_exit(lease: &ClientCallbackLease) -> bool {
        matches!(
            lease.method,
            CallbackMethod::Terminal(TerminalMethod::WaitForExit)
        )
    }

    fn lease_is_authorized(&self, lease: &ClientCallbackLease) -> bool {
        let state = self.lock();
        if state.generation != lease.generation {
            return false;
        }
        // opening 期间观察到的 lease 可能在 session/new|load 提交后才被调度；
        // binding token 必须一致，失败 load 的新 cwd 不能借旧 sessionId 穿透。
        if state.sessions.get(&lease.session_id).is_some_and(|binding| {
            Some(binding.token) == lease.owner_token
        }) {
            return true;
        }
        state.opening.as_ref().is_some_and(|opening| {
            Some(opening.token) == lease.owner_token
                && opening.generation == lease.generation
                && (opening.requested_session_id.as_deref() == Some(&lease.session_id)
                    || opening.observed_session_id.as_deref() == Some(&lease.session_id))
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct CallbackFailure {
    code: i64,
    message: String,
}

impl CallbackFailure {
    fn params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    fn operation(message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
        }
    }
}

fn execute_file_callback(lease: &ClientCallbackLease) -> Result<Value, CallbackFailure> {
    let params = lease
        .params
        .as_object()
        .ok_or_else(|| CallbackFailure::params("Client callback params 必须是对象"))?;
    let path = params
        .get("path")
        .or_else(|| params.get("filePath"))
        .or_else(|| params.get("file_path"))
        .or_else(|| params.get("target_file"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= MAX_PATH_CHARS)
        .ok_or_else(|| CallbackFailure::params("文件路径不能为空或过长"))?;
    let line = optional_u32(params, &["line", "startLine", "start_line"])?
        .or(optional_u32(params, &["offset"])?);
    let limit = optional_u32(params, &["limit", "maxLines"])?;
    let cwd = path_for_webview(&lease.workspace);

    match lease.method {
        CallbackMethod::ReadText => acp_read_text_file(cwd, path.to_string(), line, limit)
            .map(|content| json!({ "content": content }))
            .map_err(CallbackFailure::operation),
        CallbackMethod::ReadFile => acp_read_file(cwd, path.to_string(), line, limit)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
            .map_err(CallbackFailure::operation),
        CallbackMethod::WriteText => {
            let content = params
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| CallbackFailure::params("写文件请求缺少文本 content"))?;
            acp_write_text_file(cwd, path.to_string(), content.to_string())
                .map(|_| Value::Null)
                .map_err(CallbackFailure::operation)
        }
        CallbackMethod::Terminal(_) => unreachable!("terminal callbacks execute asynchronously"),
    }
}

fn optional_u32(
    params: &serde_json::Map<String, Value>,
    names: &[&str],
) -> Result<Option<u32>, CallbackFailure> {
    let Some(value) = names.iter().find_map(|name| params.get(*name)) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| CallbackFailure::params(format!("{} 必须是非负整数", names[0])))?;
    Ok(Some(value))
}

fn callback_method(method: &str) -> Option<CallbackMethod> {
    match method {
        "fs/read_text_file" => Some(CallbackMethod::ReadText),
        "x.ai/fs/read_file" => Some(CallbackMethod::ReadFile),
        "fs/write_text_file" => Some(CallbackMethod::WriteText),
        "terminal/create" => Some(CallbackMethod::Terminal(TerminalMethod::Create)),
        "terminal/output" => Some(CallbackMethod::Terminal(TerminalMethod::Output)),
        "terminal/wait_for_exit" => {
            Some(CallbackMethod::Terminal(TerminalMethod::WaitForExit))
        }
        "terminal/kill" => Some(CallbackMethod::Terminal(TerminalMethod::Kill)),
        "terminal/release" => Some(CallbackMethod::Terminal(TerminalMethod::Release)),
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

fn success_line(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_line(id: &Value, code: i64, message: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{atomic::AtomicU64, Arc},
        time::Duration,
    };

    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "grox-client-callback-{}-{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    fn request(id: Value, method: &str, session_id: &str, params: Value) -> String {
        let mut params = params.as_object().cloned().unwrap_or_default();
        params.insert("sessionId".into(), Value::String(session_id.into()));
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string()
    }

    fn render(registry: &ClientCallbackRegistry, lease: &ClientCallbackLease) -> String {
        tauri::async_runtime::block_on(registry.render_response(lease))
    }

    fn quick_terminal_params() -> Value {
        #[cfg(unix)]
        return json!({
            "command": "/bin/sh",
            "args": ["-c", "printf callback-terminal"],
        });
        #[cfg(windows)]
        return json!({
            "command": "cmd.exe",
            "args": ["/D", "/S", "/C", "echo callback-terminal"],
        });
    }

    fn long_terminal_params() -> Value {
        #[cfg(unix)]
        return json!({ "command": "/bin/sh", "args": ["-c", "sleep 30"] });
        #[cfg(windows)]
        return json!({
            "command": "cmd.exe",
            "args": ["/C", "ping -n 30 127.0.0.1 >NUL"],
        });
    }

    #[test]
    fn new_session_callbacks_use_provisional_workspace_then_commit() {
        let root = workspace();
        let registry = ClientCallbackRegistry::default();
        tauri::async_runtime::block_on(registry.reset(3));
        let opening = registry.begin_session_open(3, None, &root).unwrap();
        let ClientCallbackInbound::Request(write) = registry.observe_inbound(
            3,
            &request(
                json!(7),
                "fs/write_text_file",
                "created-session",
                json!({ "path": "nested/a.txt", "content": "host-owned" }),
            ),
        ) else {
            panic!("expected callback");
        };
        let response: Value = serde_json::from_str(&render(&registry, &write)).unwrap();
        assert_eq!(response["id"], 7);
        assert!(response["result"].is_null());
        assert_eq!(
            fs::read_to_string(root.join("nested/a.txt")).unwrap(),
            "host-owned"
        );
        assert!(registry.settle(&write));
        registry
            .commit_session_open(&opening, "created-session")
            .unwrap();
        assert_eq!(registry.bound_len(), 1);
        assert_eq!(
            registry.bound_session_workspaces(),
            vec![("created-session".into(), root.clone())]
        );

        let ClientCallbackInbound::Request(read) = registry.observe_inbound(
            3,
            &request(
                json!(8),
                "fs/read_text_file",
                "created-session",
                json!({ "path": "nested/a.txt" }),
            ),
        ) else {
            panic!("expected read callback");
        };
        let response: Value = serde_json::from_str(&render(&registry, &read)).unwrap();
        assert_eq!(response["result"]["content"], "host-owned");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn callback_never_falls_back_to_unbound_current_workspace() {
        let root = workspace();
        let registry = ClientCallbackRegistry::default();
        tauri::async_runtime::block_on(registry.reset(4));
        let ClientCallbackInbound::AutoReply(line) = registry.observe_inbound(
            4,
            &request(
                json!(1),
                "fs/write_text_file",
                "unknown",
                json!({ "path": root.join("leak.txt"), "content": "no" }),
            ),
        ) else {
            panic!("expected rejection");
        };
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["error"]["code"], -32000);
        assert!(!root.join("leak.txt").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn generation_session_and_rpc_identity_are_strict() {
        let root = workspace();
        let registry = ClientCallbackRegistry::default();
        tauri::async_runtime::block_on(registry.reset(9));
        let opening = registry.begin_session_open(9, Some("s1"), &root).unwrap();
        registry.commit_session_open(&opening, "s1").unwrap();
        let numeric = request(
            json!(5),
            "fs/read_text_file",
            "s1",
            json!({ "path": "missing.txt" }),
        );
        let string = request(
            json!("5"),
            "fs/read_text_file",
            "s1",
            json!({ "path": "missing.txt" }),
        );
        assert!(matches!(
            registry.observe_inbound(9, &numeric),
            ClientCallbackInbound::Request(_)
        ));
        assert!(matches!(
            registry.observe_inbound(9, &numeric),
            ClientCallbackInbound::Duplicate
        ));
        assert!(matches!(
            registry.observe_inbound(9, &string),
            ClientCallbackInbound::Request(_)
        ));
        tauri::async_runtime::block_on(registry.reset(10));
        assert!(matches!(
            registry.observe_inbound(9, &numeric),
            ClientCallbackInbound::AutoReply(_)
        ));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn new_session_cannot_switch_callback_session_mid_open() {
        let root = workspace();
        let registry = ClientCallbackRegistry::default();
        tauri::async_runtime::block_on(registry.reset(2));
        let opening = registry.begin_session_open(2, None, &root).unwrap();
        let first = request(
            json!(1),
            "fs/read_text_file",
            "s1",
            json!({ "path": "missing.txt" }),
        );
        let second = request(
            json!(2),
            "fs/read_text_file",
            "s2",
            json!({ "path": "missing.txt" }),
        );
        assert!(matches!(
            registry.observe_inbound(2, &first),
            ClientCallbackInbound::Request(_)
        ));
        assert!(matches!(
            registry.observe_inbound(2, &second),
            ClientCallbackInbound::AutoReply(_)
        ));
        assert!(registry.commit_session_open(&opening, "s2").is_err());
        tauri::async_runtime::block_on(registry.abort_session_open(&opening));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn callback_write_cannot_escape_bound_workspace() {
        let root = workspace();
        let escape_name = format!(
            "{}-escape.txt",
            root.file_name().and_then(|name| name.to_str()).unwrap()
        );
        let escape = root.parent().unwrap().join(&escape_name);
        fs::remove_file(&escape).ok();
        let registry = ClientCallbackRegistry::default();
        tauri::async_runtime::block_on(registry.reset(6));
        let opening = registry.begin_session_open(6, Some("s1"), &root).unwrap();
        registry.commit_session_open(&opening, "s1").unwrap();
        let ClientCallbackInbound::Request(write) = registry.observe_inbound(
            6,
            &request(
                json!(1),
                "fs/write_text_file",
                "s1",
                json!({ "path": format!("../{escape_name}"), "content": "no" }),
            ),
        ) else {
            panic!("expected callback");
        };
        let response: Value = serde_json::from_str(&render(&registry, &write)).unwrap();
        assert_eq!(response["error"]["code"], -32000);
        assert!(!escape.exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn generation_reset_waits_for_inflight_file_operation() {
        let registry = ClientCallbackRegistry::default();
        tauri::async_runtime::block_on(async {
            registry.reset(1).await;
            let operation = registry.lock_operations().await;
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(10), registry.reset(2),)
                    .await
                    .is_err()
            );
            drop(operation);
            registry.reset(2).await;
        });
        assert_eq!(registry.lock().generation, 2);
    }

    #[test]
    fn session_load_callbacks_prefer_new_opening_workspace() {
        let old_root = workspace();
        let new_root = workspace();
        fs::write(old_root.join("value.txt"), "old").unwrap();
        fs::write(new_root.join("value.txt"), "new").unwrap();
        let registry = ClientCallbackRegistry::default();
        tauri::async_runtime::block_on(registry.reset(8));
        let first = registry
            .begin_session_open(8, Some("s1"), &old_root)
            .unwrap();
        registry.commit_session_open(&first, "s1").unwrap();

        let loading = registry
            .begin_session_open(8, Some("s1"), &new_root)
            .unwrap();
        let ClientCallbackInbound::Request(read) = registry.observe_inbound(
            8,
            &request(
                json!(1),
                "fs/read_text_file",
                "s1",
                json!({ "path": "value.txt" }),
            ),
        ) else {
            panic!("expected callback");
        };
        let response: Value = serde_json::from_str(&render(&registry, &read)).unwrap();
        assert_eq!(response["result"]["content"], "new");
        registry.settle(&read);
        registry.commit_session_open(&loading, "s1").unwrap();
        fs::remove_dir_all(old_root).ok();
        fs::remove_dir_all(new_root).ok();
    }

    #[test]
    fn grok_read_file_extension_supports_nested_wire_envelope() {
        let root = workspace();
        fs::write(root.join("note.txt"), "nested extension").unwrap();
        let registry = ClientCallbackRegistry::default();
        tauri::async_runtime::block_on(registry.reset(5));
        let opening = registry.begin_session_open(5, Some("s1"), &root).unwrap();
        registry.commit_session_open(&opening, "s1").unwrap();
        let line = json!({
            "jsonrpc": "2.0",
            "id": "read-1",
            "method": "_x.ai/fs/read_file",
            "params": {
                "method": "x.ai/fs/read_file",
                "params": {
                    "sessionId": "s1",
                    "file_path": "note.txt",
                }
            }
        })
        .to_string();
        let ClientCallbackInbound::Request(read) = registry.observe_inbound(5, &line) else {
            panic!("expected extension callback");
        };
        let response: Value = serde_json::from_str(&render(&registry, &read)).unwrap();
        assert_eq!(response["result"]["content"], "nested extension");
        assert_eq!(response["result"]["type"], "text/plain");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn standard_terminal_callbacks_complete_full_lifecycle() {
        tauri::async_runtime::block_on(async {
            let root = workspace();
            let registry = ClientCallbackRegistry::default();
            registry.reset(11).await;
            let opening = registry.begin_session_open(11, Some("s1"), &root).unwrap();
            registry.commit_session_open(&opening, "s1").unwrap();

            let ClientCallbackInbound::Request(create) = registry.observe_inbound(
                11,
                &request(
                    json!(1),
                    "terminal/create",
                    "s1",
                    quick_terminal_params(),
                ),
            ) else {
                panic!("expected terminal/create callback");
            };
            let response: Value =
                serde_json::from_str(&registry.render_response(&create).await).unwrap();
            let terminal_id = response["result"]["terminalId"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(registry.settle(&create));

            let ClientCallbackInbound::Request(wait) = registry.observe_inbound(
                11,
                &request(
                    json!(2),
                    "terminal/wait_for_exit",
                    "s1",
                    json!({ "terminalId": terminal_id }),
                ),
            ) else {
                panic!("expected terminal/wait_for_exit callback");
            };
            let response: Value =
                serde_json::from_str(&registry.render_response(&wait).await).unwrap();
            assert_eq!(response["result"]["exitCode"], 0);
            assert!(registry.settle(&wait));

            let ClientCallbackInbound::Request(output) = registry.observe_inbound(
                11,
                &request(
                    json!(3),
                    "terminal/output",
                    "s1",
                    json!({ "terminalId": terminal_id }),
                ),
            ) else {
                panic!("expected terminal/output callback");
            };
            let response: Value =
                serde_json::from_str(&registry.render_response(&output).await).unwrap();
            assert!(response["result"]["output"]
                .as_str()
                .unwrap()
                .contains("callback-terminal"));
            assert_eq!(response["result"]["exitStatus"]["exitCode"], 0);
            assert!(registry.settle(&output));

            let ClientCallbackInbound::Request(kill) = registry.observe_inbound(
                11,
                &request(
                    json!(4),
                    "terminal/kill",
                    "s1",
                    json!({ "terminalId": terminal_id }),
                ),
            ) else {
                panic!("expected terminal/kill callback");
            };
            let response: Value =
                serde_json::from_str(&registry.render_response(&kill).await).unwrap();
            assert_eq!(response["result"], json!({}));
            assert!(registry.settle(&kill));

            let ClientCallbackInbound::Request(release) = registry.observe_inbound(
                11,
                &request(
                    json!(5),
                    "terminal/release",
                    "s1",
                    json!({ "terminalId": terminal_id }),
                ),
            ) else {
                panic!("expected terminal/release callback");
            };
            let response: Value =
                serde_json::from_str(&registry.render_response(&release).await).unwrap();
            assert_eq!(response["result"], json!({}));
            assert!(registry.settle(&release));
            assert_eq!(registry.terminal_len().await, 0);
            fs::remove_dir_all(root).ok();
        });
    }

    #[test]
    fn terminal_wait_never_blocks_generation_reset() {
        tauri::async_runtime::block_on(async {
            let root = workspace();
            let registry = Arc::new(ClientCallbackRegistry::default());
            registry.reset(12).await;
            let opening = registry.begin_session_open(12, Some("s1"), &root).unwrap();
            registry.commit_session_open(&opening, "s1").unwrap();
            let ClientCallbackInbound::Request(create) = registry.observe_inbound(
                12,
                &request(
                    json!(1),
                    "terminal/create",
                    "s1",
                    long_terminal_params(),
                ),
            ) else {
                panic!("expected terminal/create callback");
            };
            let response: Value =
                serde_json::from_str(&registry.render_response(&create).await).unwrap();
            let terminal_id = response["result"]["terminalId"]
                .as_str()
                .unwrap()
                .to_string();
            registry.settle(&create);
            let ClientCallbackInbound::Request(wait) = registry.observe_inbound(
                12,
                &request(
                    json!(2),
                    "terminal/wait_for_exit",
                    "s1",
                    json!({ "terminalId": terminal_id }),
                ),
            ) else {
                panic!("expected terminal/wait_for_exit callback");
            };
            let waiter_registry = Arc::clone(&registry);
            let waiter = tokio::spawn(async move { waiter_registry.render_response(&wait).await });
            tokio::task::yield_now().await;
            tokio::time::timeout(Duration::from_secs(1), registry.reset(13))
                .await
                .expect("generation reset must not wait for terminal exit callback");
            assert_eq!(registry.terminal_len().await, 0);
            tokio::time::timeout(Duration::from_secs(2), waiter)
                .await
                .expect("killed terminal waiter should settle")
                .unwrap();
            fs::remove_dir_all(root).ok();
        });
    }

    #[test]
    fn aborting_provisional_session_releases_owned_terminals() {
        tauri::async_runtime::block_on(async {
            let root = workspace();
            let registry = ClientCallbackRegistry::default();
            registry.reset(14).await;
            let opening = registry.begin_session_open(14, None, &root).unwrap();
            let ClientCallbackInbound::Request(create) = registry.observe_inbound(
                14,
                &request(
                    json!(1),
                    "terminal/create",
                    "provisional",
                    long_terminal_params(),
                ),
            ) else {
                panic!("expected provisional terminal/create callback");
            };
            let response: Value =
                serde_json::from_str(&registry.render_response(&create).await).unwrap();
            assert!(response.get("result").is_some());
            registry.settle(&create);
            assert_eq!(registry.terminal_len().await, 1);
            registry.abort_session_open(&opening).await;
            assert_eq!(registry.terminal_len().await, 0);
            fs::remove_dir_all(root).ok();
        });
    }
}
