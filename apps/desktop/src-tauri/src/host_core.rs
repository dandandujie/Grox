//! Host 共享内核：ACP 运行时状态、wire 读写、原子文件写入、路径与 CLI 解析。
//!
//! 从 main.rs 下沉（PRODUCT_REVIEW.md A1/P0）。边界规则：
//! - 其他模块依赖内核符号一律 `use crate::host_core::…`，不得引用 main.rs；
//! - 内核不反向依赖命令编排层（唯一已知残留：`apply_grox_provider_environment` 留在 main.rs）；
//! - 行为不变：本轮只做搬移与可见性（pub(crate)）调整。

use crate::acp_host::{AcpHostError, AcpRequestBroker};
use crate::agent_auth::AgentAuthenticationLifecycle;
use crate::agent_runtime::AgentAuthenticationState;
use crate::agent_runtime::AgentRuntimeConnection;
use crate::client_callbacks::ClientCallbackRegistry;
use crate::foreground_turn::ForegroundTurnRegistry;
use crate::host_prefs;
use crate::interaction_service::InteractionRegistry;
use crate::mcp_leases;
use crate::mcp_leases::McpLeaseStore;
use crate::path_sandbox::{checked_workspace, checked_workspace_target, path_for_webview};
#[cfg(windows)]
use crate::process_job::ProcessJob;
use crate::provider_service::{is_blocked_service_host, is_loopback_host};
use crate::session_coordinator::SessionCoordinator;
use crate::session_event_journal::{HostSessionEvent, SessionEventJournal};
use crate::turn_runtime;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt as _;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

// ───────────────────────────── 状态内核 ─────────────────────────────

pub(crate) const GROX_BUILD_COMMIT: &str = env!("GROX_BUILD_COMMIT");

// Grok Build decides OAuth eligibility from the official CLI client mode.
// Grox is an ACP host around that CLI, not a separate xAI desktop client, so
// preserve the identity used by `grok` in a terminal. In particular, never
// advertise the unreleased `grok-desktop` client mode to the upstream service.
pub(crate) const UPSTREAM_CLI_CLIENT_NAME: &str = "grok-shell";

pub(crate) const MAX_PROMPT_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_PROMPT_IMAGE_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_PROVIDER_MODELS_BODY_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_SESSION_PREVIEW_MESSAGES: usize = 200;
pub(crate) const MAX_SESSION_PREVIEW_TEXT_CHARS: usize = 64 * 1024;
pub(crate) const MAX_SESSION_PREVIEW_TOOL_INPUT_CHARS: usize = 16 * 1024;
pub(crate) const MAX_SESSION_SEARCH_IDS: usize = 2_000;
pub(crate) const MAX_SESSION_SEARCH_HITS: usize = 500;
pub(crate) const MAX_SESSION_SEARCH_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_SESSION_SEARCH_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) struct AgentProcess {
    pub(crate) child: Child,
    pub(crate) stdin: ChildStdin,
    pub(crate) generation: u64,
    /// Windows Job Object so cancel kills nested tool trees (cargo test, shells).
    #[cfg(windows)]
    pub(crate) job: Option<process_job::ProcessJob>,
}

#[derive(Default)]
pub(crate) struct AcpState {
    pub(crate) process: Mutex<Option<AgentProcess>>,
    pub(crate) connect_lock: Mutex<()>,
    pub(crate) connection: RwLock<Option<AgentRuntimeConnection>>,
    pub(crate) next_generation: AtomicU64,
    pub(crate) next_host_request_id: AtomicU64,
    pub(crate) ready_generation: AtomicU64,
    pub(crate) paused_generation: AtomicU64,
    pub(crate) runtime_phase: AtomicU8,
    pub(crate) last_connect: RwLock<Option<RuntimeConnectSpec>>,
    pub(crate) automatic_reconnect_owner: AtomicU64,
    pub(crate) next_reconnect_owner: AtomicU64,
    pub(crate) reconnect_epoch: AtomicU64,
    pub(crate) requests: AcpRequestBroker,
    pub(crate) authentication: AgentAuthenticationLifecycle,
    pub(crate) sessions: Arc<SessionCoordinator>,
    pub(crate) foreground_turns: Arc<ForegroundTurnRegistry>,
    pub(crate) interactions: Arc<InteractionRegistry>,
    pub(crate) client_callbacks: Arc<ClientCallbackRegistry>,
    pub(crate) session_events: SessionEventJournal,
}

impl AcpState {
    pub(crate) fn issue_host_request_id(&self) -> u64 {
        // Grok Build 的 ACP 适配器可能由 JavaScript 实现；请求 id 必须保持
        // Number-safe，同时与从 1 递增的 WebView 请求留出不可实际跨越的空间。
        const HOST_REQUEST_NAMESPACE: u64 = 1 << 52;
        const HOST_REQUEST_SEQUENCE_MASK: u64 = HOST_REQUEST_NAMESPACE - 1;
        let sequence = self
            .next_host_request_id
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1)
            & HOST_REQUEST_SEQUENCE_MASK;
        HOST_REQUEST_NAMESPACE | sequence.max(1)
    }

    pub(crate) fn set_runtime_phase(&self, phase: RuntimePhase) {
        self.runtime_phase.store(phase as u8, Ordering::Release);
    }

    pub(crate) fn remember_connect(&self, spec: RuntimeConnectSpec) {
        *self
            .last_connect
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(spec);
    }

    pub(crate) fn last_connect(&self) -> Option<RuntimeConnectSpec> {
        self.last_connect
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub(crate) fn claim_automatic_reconnect(&self) -> Option<RuntimeReconnectClaim> {
        let owner = self.next_reconnect_owner.fetch_add(1, Ordering::Relaxed) + 1;
        let claim = RuntimeReconnectClaim {
            owner,
            epoch: self.reconnect_epoch.load(Ordering::Acquire),
        };
        self.automatic_reconnect_owner
            .compare_exchange(0, owner, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| claim)
    }

    pub(crate) fn automatic_reconnect_cancelled(&self, claim: RuntimeReconnectClaim) -> bool {
        self.reconnect_epoch.load(Ordering::Acquire) != claim.epoch
            || self.automatic_reconnect_owner.load(Ordering::Acquire) != claim.owner
    }

    pub(crate) fn finish_automatic_reconnect(&self, claim: RuntimeReconnectClaim) {
        let _ = self.automatic_reconnect_owner.compare_exchange(
            claim.owner,
            0,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub(crate) fn cancel_automatic_reconnect(&self) {
        self.reconnect_epoch.fetch_add(1, Ordering::AcqRel);
        self.automatic_reconnect_owner.store(0, Ordering::Release);
    }

    pub(crate) fn cached_connection(&self, generation: u64) -> Option<AgentRuntimeConnection> {
        self.connection
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .filter(|connection| connection.generation == generation)
            .cloned()
    }

    pub(crate) fn clear_cached_connection(&self, generation: Option<u64>) {
        let mut connection = self
            .connection
            .write()
            .unwrap_or_else(|error| error.into_inner());
        let should_clear = match generation {
            None => true,
            Some(generation) => connection
                .as_ref()
                .is_some_and(|connection| connection.generation == generation),
        };
        if should_clear {
            *connection = None;
        }
    }

    pub(crate) async fn ready_connection(&self) -> Option<AgentRuntimeConnection> {
        let generation = self.ready_generation.load(Ordering::Acquire);
        if generation == 0
            || !self
                .process
                .lock()
                .await
                .as_ref()
                .is_some_and(|process| process.generation == generation)
        {
            return None;
        }
        self.cached_connection(generation)
    }

    pub(crate) fn set_authentication_state(
        &self,
        generation: u64,
        auth: AgentAuthenticationState,
    ) -> bool {
        let mut cached = self
            .connection
            .write()
            .unwrap_or_else(|error| error.into_inner());
        let Some(connection) = cached
            .as_mut()
            .filter(|connection| connection.generation == generation)
        else {
            return false;
        };
        connection.auth = auth;
        true
    }

    pub(crate) async fn pause_runtime(&self) -> Result<(), AcpHostError> {
        let generation = self.ready_generation.load(Ordering::Acquire);
        let process = self.process.lock().await;
        if generation == 0
            || !process
                .as_ref()
                .is_some_and(|process| process.generation == generation)
        {
            return Err(AcpHostError::operation(
                "ACP_RUNTIME_NOT_READY",
                "只有已完成握手的运行时才能暂停",
            ));
        }
        self.paused_generation.store(generation, Ordering::Release);
        if self
            .ready_generation
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            self.paused_generation.store(0, Ordering::Release);
            return Err(AcpHostError::operation(
                "ACP_RUNTIME_STATE_CHANGED",
                "运行时状态已变化，请重新执行当前操作",
            ));
        }
        self.set_runtime_phase(RuntimePhase::Paused);
        drop(process);
        Ok(())
    }

    pub(crate) async fn mark_runtime_ready(
        &self,
        connection: &AgentRuntimeConnection,
    ) -> Result<(), AcpHostError> {
        let generation = connection.generation;
        let process = self.process.lock().await;
        if !process
            .as_ref()
            .is_some_and(|process| process.generation == generation)
        {
            return Err(AcpHostError::environment(
                "ACP_RUNTIME_GENERATION_STALE",
                "运行时就绪信号属于已替换的 ACP 通道",
                false,
                false,
                "等待 Agent 重连完成后重试",
            ));
        }
        *self
            .connection
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(connection.clone());
        self.paused_generation.store(0, Ordering::Release);
        self.ready_generation.store(generation, Ordering::Release);
        self.set_runtime_phase(RuntimePhase::Ready);
        drop(process);
        Ok(())
    }

    pub(crate) async fn resume_runtime(&self, generation: u64) -> Result<(), AcpHostError> {
        if self.paused_generation.load(Ordering::Acquire) != generation {
            return Err(AcpHostError::operation(
                "ACP_RUNTIME_RESUME_NOT_ALLOWED",
                "运行时没有可恢复的已就绪代次",
            ));
        }
        let process = self.process.lock().await;
        if !process
            .as_ref()
            .is_some_and(|process| process.generation == generation)
        {
            self.paused_generation.store(0, Ordering::Release);
            self.set_runtime_phase(RuntimePhase::Offline);
            return Err(AcpHostError::environment(
                "ACP_RUNTIME_GENERATION_STALE",
                "待恢复的 ACP 通道已退出或被替换",
                false,
                false,
                "等待 Agent 重连完成后重试",
            ));
        }
        if self
            .paused_generation
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(AcpHostError::operation(
                "ACP_RUNTIME_RESUME_NOT_ALLOWED",
                "运行时恢复凭据已被消费",
            ));
        }
        self.ready_generation.store(generation, Ordering::Release);
        self.set_runtime_phase(RuntimePhase::Ready);
        drop(process);
        Ok(())
    }

    pub(crate) fn mark_generation_unready(&self, generation: u64, phase: RuntimePhase) {
        let was_ready = self
            .ready_generation
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        let was_paused = self
            .paused_generation
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        if was_ready
            || was_paused
            || (self.ready_generation.load(Ordering::Acquire) == 0
                && self.paused_generation.load(Ordering::Acquire) == 0)
        {
            self.authentication.reset(AcpHostError::environment(
                "AUTH_RUNTIME_CHANGED",
                "认证期间 Agent 运行时已退出或被替换",
                false,
                false,
                "重新连接 Agent 后再次登录",
            ));
            self.clear_cached_connection(Some(generation));
            self.set_runtime_phase(phase);
        }
    }
}

#[repr(u8)]
#[derive(Clone, Copy)]
pub(crate) enum RuntimePhase {
    Stopped = 0,
    Starting = 1,
    Initializing = 2,
    Authenticating = 3,
    Ready = 4,
    Paused = 5,
    Offline = 6,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrokRuntimeInfo {
    pub(crate) path: String,
    pub(crate) source: &'static str,
    pub(crate) system_path: Option<String>,
    pub(crate) selection_required: bool,
    pub(crate) version: Option<String>,
    pub(crate) grox_commit: &'static str,
}

pub(crate) const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

impl RuntimePhase {
    pub(crate) fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::Starting,
            2 => Self::Initializing,
            3 => Self::Authenticating,
            4 => Self::Ready,
            5 => Self::Paused,
            6 => Self::Offline,
            _ => Self::Stopped,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Initializing => "initializing",
            Self::Authenticating => "authenticating",
            Self::Ready => "ready",
            Self::Paused => "paused",
            Self::Offline => "offline",
        }
    }
}

#[derive(Clone)]
pub(crate) struct RuntimeConnectSpec {
    pub(crate) cwd: String,
    pub(crate) reasoning_effort: Option<String>,
}

#[derive(Clone, Copy)]
pub(crate) struct RuntimeReconnectClaim {
    pub(crate) owner: u64,
    pub(crate) epoch: u64,
}

pub(crate) const MAX_ACP_TEXT_BYTES: u64 = 16 * 1024 * 1024;
/// Binary-safe response used by Grok's TUI-style `x.ai/fs/read_file`
/// extension.  The standard ACP `fs/read_text_file` method is intentionally
/// text-only; the extension adds the same `contentBase64`/`type` fields that
/// the upstream CLI uses for images and other binary files.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpReadFile {
    pub(crate) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) content_base64: Option<String>,
    pub(crate) size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) line_count: Option<u64>,
    #[serde(rename = "type")]
    pub(crate) content_type: String,
}
pub(crate) static CONFIG_WRITE_NONCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn default_workspace() -> PathBuf {
    if let Some(path) = std::env::var_os("GROK_DESKTOP_CWD").filter(|v| !v.is_empty()) {
        return PathBuf::from(path);
    }

    #[cfg(debug_assertions)]
    {
        // `src-tauri` lives at `<repo>/apps/desktop/src-tauri` in development.
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        if let Some(repo) = manifest.ancestors().nth(3) {
            return repo.to_path_buf();
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Resolve the actual user home independently of `GROK_HOME`. The latter may
/// point to a portable or test-specific Grok configuration directory, but
/// `~/…` in a prompt must always mean the operator's home directory.
pub(crate) fn user_home() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "无法定位用户目录，请设置 GROK_HOME".to_string())?;
    Ok(PathBuf::from(home))
}

pub(crate) fn executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        return fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}
pub(crate) fn prompt_queues_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("prompt-queues.json"))
        .map_err(|error| format!("无法定位提示队列文件：{error}"))
}

pub(crate) fn worktree_bindings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("worktree-bindings.json"))
        .map_err(|error| format!("无法定位 worktree 会话索引：{error}"))
}


// ───────────────────────────── 路径与环境 ─────────────────────────────

pub(crate) fn grok_home() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("GROK_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(user_home()?.join(".grok"))
}

pub(crate) fn read_bounded_text(path: &Path, max_bytes: u64) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let metadata =
        fs::metadata(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("不是文件：{}", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!("文件过大：{}", path.display()));
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))
}

/// Platform-aware atomic replace of `to` with `from` (same volume).
/// - Unix: `rename` replaces the destination atomically.
/// - Windows: `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` avoids the
///   final→bak then temp→final crash window of a two-step rename.
pub(crate) fn replace_file_atomic(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        // Wide, NUL-terminated paths kept alive for the duration of the call.
        let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `from_wide` / `to_wide` are valid NUL-terminated UTF-16 for the
        // whole call; `MoveFileExW` only reads those pointers and does not retain
        // them. Same-directory replace keeps the operation on one volume so
        // MOVEFILE_REPLACE_EXISTING is an in-place metadata replace, not a copy.
        unsafe {
            MoveFileExW(
                PCWSTR(from_wide.as_ptr()),
                PCWSTR(to_wide.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|error| {
                format!(
                    "无法原子替换 {} → {}：{error}",
                    from.display(),
                    to.display()
                )
            })
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to).map_err(|error| {
            format!(
                "无法原子替换 {} → {}：{error}",
                from.display(),
                to.display()
            )
        })
    }
}

/// Parse `.name.grox-pid-nonce.bak` / `.tmp` → original final file name.
pub(crate) fn atomic_orphan_final_name(orphan_name: &str) -> Option<&str> {
    if !orphan_name.starts_with('.') || !orphan_name.contains(".grox-") {
        return None;
    }
    let stem = orphan_name
        .strip_suffix(".bak")
        .or_else(|| orphan_name.strip_suffix(".tmp"))?;
    // stem = ".{file}.grox-{pid}-{nonce}"
    let rest = stem.strip_prefix('.')?;
    let marker = rest.rfind(".grox-")?;
    let file_name = &rest[..marker];
    if file_name.is_empty() {
        return None;
    }
    Some(file_name)
}

/// Parse writer pid from `.name.grox-{pid}-{nonce}.tmp|.bak`.
pub(crate) fn atomic_orphan_writer_pid(orphan_name: &str) -> Option<u32> {
    let stem = orphan_name
        .strip_suffix(".bak")
        .or_else(|| orphan_name.strip_suffix(".tmp"))?;
    let rest = stem.strip_prefix('.')?;
    let marker = rest.rfind(".grox-")?;
    let after = &rest[marker + ".grox-".len()..];
    let pid = after.split('-').next()?;
    pid.parse().ok()
}

pub(crate) fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bounded_with_privacy(path, content, MAX_CONFIG_BYTES, false)
}

pub(crate) fn atomic_write_private(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bounded_private(path, content, MAX_CONFIG_BYTES)
}

/// Atomically publish a new private file without replacing an existing path.
/// A same-directory hard link gives the final name all at once and fails with
/// AlreadyExists if another caller won the recovery race.
pub(crate) fn atomic_create_private(path: &Path, content: &str) -> Result<bool, String> {
    if content.len() as u64 > MAX_CONFIG_BYTES {
        return Err(format!(
            "文档不能超过 {} MB",
            MAX_CONFIG_BYTES / 1024 / 1024
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "配置路径缺少父目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建 {}：{error}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let nonce = CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".{}.grox-{}-{}.recovering",
        file_name,
        std::process::id(),
        nonce,
    ));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|error| format!("无法创建临时配置 {}：{error}", temp.display()))?;
        if let Err(error) = file
            .write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&temp);
            return Err(format!("无法写入配置 {}：{error}", temp.display()));
        }
    }
    #[cfg(not(unix))]
    if let Err(error) = restrict_private_file(&temp) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    let result = match fs::hard_link(&temp, path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!("无法恢复私有配置 {}：{error}", path.display())),
    };
    let _ = fs::remove_file(&temp);
    result
}

pub(crate) fn atomic_write_bounded_private(
    path: &Path,
    content: &str,
    max_bytes: u64,
) -> Result<(), String> {
    atomic_write_bounded_with_privacy(path, content, max_bytes, true)?;
    #[cfg(not(unix))]
    restrict_private_file(path)?;
    Ok(())
}

pub(crate) fn atomic_write_bounded_with_privacy(
    path: &Path,
    content: &str,
    max_bytes: u64,
    private: bool,
) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = private;
    if content.len() as u64 > max_bytes {
        return Err(format!("文档不能超过 {} MB", max_bytes / 1024 / 1024));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "配置路径缺少父目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建 {}：{error}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let nonce = CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".{}.grox-{}-{}.tmp",
        file_name,
        std::process::id(),
        nonce,
    ));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|error| format!("无法创建临时配置 {}：{error}", temp.display()))?;
        if let Err(error) = file
            .write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&temp);
            return Err(format!("无法写入配置 {}：{error}", temp.display()));
        }
    }
    // Single platform-native replace — never leave a window where `path` is
    // missing while only a `.bak` remains (the previous two-step rename).
    if let Err(error) = replace_file_atomic(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

/// Drop orphan atomic-write temps; restore recovery copies when final is missing.
///
/// Rules:
/// - Never touch `.tmp` still owned by **this** process (may be mid-write).
/// - Final missing + `.bak`/aged foreign `.tmp` → promote to final (do not delete
///   the only copy if promote fails).
/// - Final present + aged leftover → delete.
pub(crate) fn scrub_atomic_write_orphans(dir: &Path, max_age: std::time::Duration) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let now = std::time::SystemTime::now();
    let self_pid = std::process::id();
    let mut removed = 0u32;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let is_orphan = name.starts_with('.')
            && (name.ends_with(".tmp") || name.ends_with(".bak"))
            && name.contains(".grox-");
        if !is_orphan {
            continue;
        }
        // Live writer temps use our pid in the name — age-0 scrub must not
        // steal them between sync_all and replace.
        if name.ends_with(".tmp") {
            if let Some(pid) = atomic_orphan_writer_pid(name) {
                if pid == self_pid {
                    continue;
                }
            }
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let aged = meta
            .modified()
            .ok()
            .map(|modified| now.duration_since(modified).unwrap_or_default() >= max_age)
            .unwrap_or(true);

        if name.ends_with(".bak") {
            if let Some(final_name) = atomic_orphan_final_name(name) {
                let final_path = dir.join(final_name);
                if !final_path.exists() {
                    // Crash mid-replace left only the recovery copy — restore it.
                    if fs::rename(&path, &final_path).is_ok() {
                        removed += 1;
                    }
                    // Rename failed: leave bak (only copy). Never delete.
                    continue;
                }
            }
            // Final exists: only drop aged bak leftovers.
            if aged && fs::remove_file(&path).is_ok() {
                removed += 1;
            }
            continue;
        }

        // .tmp from a dead writer.
        if let Some(final_name) = atomic_orphan_final_name(name) {
            let final_path = dir.join(final_name);
            if !final_path.exists() {
                // First-write crash: promote complete temp instead of deleting
                // the only snapshot.
                if aged && fs::rename(&path, &final_path).is_ok() {
                    removed += 1;
                }
                continue;
            }
        }
        if aged && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub(crate) const PROMPT_QUEUES_MAX_BYTES: u64 = 64 * 1024 * 1024;

pub(crate) const AUTOMATIONS_MAX_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn automations_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("automations.json"))
        .map_err(|error| format!("无法定位自动化文件：{error}"))
}

#[cfg(unix)]
pub(crate) fn restrict_private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法限制凭据文件权限 {}：{error}", path.display()))
}

#[cfg(not(unix))]
pub(crate) fn restrict_private_file(path: &Path) -> Result<(), String> {
    // Restrict the credential file to the current Windows user when possible.
    // Inheritance from the profile directory is usually enough; this is defense
    // in depth for shared or relocated config folders.
    let path_text = path.to_string_lossy();
    let user = std::env::var("USERNAME").unwrap_or_else(|_| String::from("%USERNAME%"));
    let mut command = std::process::Command::new("icacls");
    command
        .args([
            path_text.as_ref(),
            "/inheritance:r",
            "/grant:r",
            &format!("{user}:(R,W)"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    let status = command.status();
    match status {
        Ok(code) if code.success() => Ok(()),
        Ok(code) => {
            eprintln!(
                "grox: 无法限制凭据文件权限 {}（icacls 退出码 {:?}）；将继续依赖用户配置目录 ACL",
                path.display(),
                code.code()
            );
            Ok(())
        }
        Err(error) => {
            eprintln!(
                "grox: 无法启动 icacls 限制凭据文件权限 {}：{error}；将继续依赖用户配置目录 ACL",
                path.display()
            );
            Ok(())
        }
    }
}

pub(crate) fn config_path(
    id: &str,
    cwd: &Path,
) -> Result<(PathBuf, &'static str, &'static str), String> {
    let home = grok_home()?;
    match id {
        "config" => Ok((home.join("config.toml"), "Grok config.toml", "toml")),
        "system-prompt" => Ok((home.join("system-prompt.md"), "系统提示词", "markdown")),
        "agents" => Ok((cwd.join("AGENTS.md"), "项目 AGENTS.md", "markdown")),
        _ => Err("未知配置文档".into()),
    }
}

/// ACP has a text-only filesystem contract. Keep writes in the workspace, but
/// let the CLI read its own built-in and user-installed Skill definitions.
/// Canonical paths are compared after resolution so a workspace symlink cannot
/// be used to escape the intended boundary.
pub(crate) fn checked_acp_readable_file(
    workspace: &Path,
    requested: &str,
) -> Result<PathBuf, String> {
    let grok = grok_home()?;
    let roots = [
        grok.join("skills"),
        // Bundled skills can reference sibling templates/assets under this
        // read-only tree, so allow the whole bundled root rather than only
        // its `skills` child.
        grok.join("bundled"),
        // The official CLI persists session checkpoints here. These remain
        // read-only; only ACP text writes inside the active workspace are
        // permitted.
        grok.join("sessions"),
    ]
    .into_iter()
    .filter_map(|root| root.canonicalize().ok())
    .collect::<Vec<_>>();
    checked_read_file_with_roots(workspace, requested, &roots)
}

pub(crate) fn checked_read_file_with_roots(
    workspace: &Path,
    requested: &str,
    readonly_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let candidate =
        if requested == "~" || requested.starts_with("~/") || requested.starts_with("~\\") {
            let home = user_home()?;
            if requested == "~" {
                home
            } else {
                home.join(&requested[2..])
            }
        } else {
            PathBuf::from(requested)
        };
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        workspace.join(candidate)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析文件 {}：{error}", candidate.display()))?;
    if canonical.starts_with(workspace)
        || readonly_roots
            .iter()
            .any(|root| canonical.starts_with(root))
    {
        return Ok(canonical);
    }
    Err("只能读取当前项目或 Grok 的 Skills、Bundled、Sessions 目录下的文件".into())
}

/// Identify accepted image formats from their contents rather than a mutable
/// filename extension. This rejects a text file renamed to `.png` before it
/// can be sent to the provider as a broken multimodal attachment.
pub(crate) fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    let svg_prefix = std::str::from_utf8(&bytes[..bytes.len().min(4 * 1024)]).ok()?;
    let svg_start = svg_prefix.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
    let svg_start = svg_start.to_ascii_lowercase();
    if svg_start.starts_with("<svg")
        || (svg_start.starts_with("<?xml") && svg_start.contains("<svg"))
    {
        return Some("image/svg+xml");
    }
    None
}

pub(crate) fn prompt_image_mime(bytes: &[u8]) -> Option<&'static str> {
    match image_mime(bytes) {
        // SVG 是带主动内容能力的文本，也不是通用多模态输入格式。文件预览仍可
        // 支持 SVG，但不能把它作为图片附件发送给供应商。
        Some("image/svg+xml") | None => None,
        mime => mime,
    }
}

pub(crate) fn git_command(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = std::process::Command::new("git");
    command.current_dir(root).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    command
        .output()
        .map_err(|error| format!("无法运行 Git：{error}"))
}

pub(crate) fn git_text(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(root, args)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("Git 命令失败：git {}", args.join(" "))
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn optional_git_text(root: &Path, args: &[&str]) -> Option<String> {
    git_text(root, args).ok().filter(|value| !value.is_empty())
}

// ─────────────────────────── CLI 解析 ───────────────────────────

pub(crate) fn system_grok_candidates(executable: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .map(|directory| directory.join(executable)),
    );
    if let Some(home) = std::env::var_os("GROK_HOME").filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(home).join("bin").join(executable));
    }
    if let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
    {
        let home = PathBuf::from(home);
        candidates.push(home.join(".grok").join("bin").join(executable));
        candidates.push(home.join(".cargo").join("bin").join(executable));
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Grok")
                .join(executable),
        );
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(executable));
        candidates.push(PathBuf::from("/usr/local/bin").join(executable));
    }
    candidates
}

pub(crate) fn normalized_existing_path(path: &Path) -> Option<PathBuf> {
    if !executable_file(path) {
        return None;
    }
    path.canonicalize()
        .ok()
        .or_else(|| Some(path.to_path_buf()))
}

pub(crate) fn grok_binary_version(path: &str) -> Option<String> {
    let mut command = std::process::Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
}

pub(crate) fn runtime_info(
    path: String,
    source: &'static str,
    system_path: Option<String>,
    selection_required: bool,
) -> GrokRuntimeInfo {
    GrokRuntimeInfo {
        version: grok_binary_version(&path),
        path,
        source,
        system_path,
        selection_required,
        grox_commit: GROX_BUILD_COMMIT,
    }
}

pub(crate) fn configured_grok_command() -> GrokRuntimeInfo {
    let executable = if cfg!(windows) { "grok.exe" } else { "grok" };
    let system = system_grok_candidates(executable)
        .into_iter()
        .filter_map(|candidate| normalized_existing_path(&candidate))
        .next();

    if let Some(path) = std::env::var_os("GROK_DESKTOP_CLI").filter(|value| !value.is_empty()) {
        return runtime_info(
            PathBuf::from(path).to_string_lossy().into_owned(),
            "override",
            system.as_deref().map(path_for_webview),
            false,
        );
    }

    if let Some(path) = system.as_deref() {
        return runtime_info(
            path.to_string_lossy().into_owned(),
            "system",
            Some(path_for_webview(path)),
            false,
        );
    }

    runtime_info(executable.to_string(), "missing", None, true)
}

pub(crate) fn acp_read_text_file(
    cwd: String,
    path: String,
    line: Option<u32>,
    limit: Option<u32>,
) -> Result<String, String> {
    let workspace = checked_workspace(&cwd)?;
    let file = checked_acp_readable_file(&workspace, &path)?;
    let content = read_bounded_text(&file, MAX_ACP_TEXT_BYTES)?;
    if line.is_none() && limit.is_none() {
        return Ok(content);
    }
    let start = line.unwrap_or(1).max(1).saturating_sub(1) as usize;
    let take = limit.map(|value| value as usize).unwrap_or(usize::MAX);
    Ok(content
        .split_inclusive('\n')
        .skip(start)
        .take(take)
        .collect())
}

pub(crate) fn build_acp_read_file(
    bytes: Vec<u8>,
    line: Option<u32>,
    limit: Option<u32>,
) -> AcpReadFile {
    let size = bytes.len() as u64;
    if let Some(mime) = image_mime(&bytes) {
        return AcpReadFile {
            content: String::new(),
            content_base64: Some(BASE64.encode(bytes)),
            size,
            line_count: None,
            content_type: mime.to_string(),
        };
    }

    match String::from_utf8(bytes) {
        Ok(full_text) => {
            let line_count = Some(full_text.lines().count() as u64);
            let content = if line.is_none() && limit.is_none() {
                full_text
            } else {
                let start = line.unwrap_or(1).max(1).saturating_sub(1) as usize;
                let take = limit.map(|value| value as usize).unwrap_or(usize::MAX);
                full_text
                    .split_inclusive('\n')
                    .skip(start)
                    .take(take)
                    .collect()
            };
            AcpReadFile {
                content,
                content_base64: None,
                size,
                line_count,
                content_type: "text/plain".into(),
            }
        }
        Err(error) => AcpReadFile {
            content: String::new(),
            content_base64: Some(BASE64.encode(error.into_bytes())),
            size,
            line_count: None,
            content_type: "application/octet-stream".into(),
        },
    }
}

/// Build the TUI-compatible, binary-safe Host callback response. Unlike
/// `acp_read_text_file`, this helper deliberately never calls
/// `read_to_string` for an image: PNG/JPEG/etc. are returned as base64 bytes
/// so the model can receive them as a multimodal tool result.
pub(crate) fn acp_read_file(
    cwd: String,
    path: String,
    line: Option<u32>,
    limit: Option<u32>,
) -> Result<AcpReadFile, String> {
    let workspace = checked_workspace(&cwd)?;
    let file = checked_acp_readable_file(&workspace, &path)?;
    let metadata =
        fs::metadata(&file).map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
    if !metadata.is_file() {
        return Err("只能读取文件".into());
    }
    if metadata.len() > MAX_ACP_TEXT_BYTES {
        return Err("文件不能超过 16 MB".into());
    }
    let bytes = fs::read(&file).map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
    Ok(build_acp_read_file(bytes, line, limit))
}

pub(crate) fn acp_write_text_file(
    cwd: String,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() as u64 > MAX_ACP_TEXT_BYTES {
        return Err("单个文本文件不能超过 16 MB".into());
    }
    let workspace = checked_workspace(&cwd)?;
    let file = checked_workspace_target(&workspace, &path)?;
    if file.exists() && !file.is_file() {
        return Err(format!("目标不是文件：{}", file.display()));
    }
    let parent = file.parent().ok_or("文件路径缺少父目录")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建目录 {}：{error}", parent.display()))?;
    fs::write(&file, content.as_bytes())
        .map_err(|error| format!("无法写入 {}：{error}", file.display()))
}

pub(crate) fn host_prefs_dir_for_app(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| default_workspace().join(".grox-host-prefs-fallback"))
}

/// Product gate: env OR host_prefs only (ignore FE for actual attach).
pub(crate) fn computer_use_gate_open() -> bool {
    if let Ok(v) = std::env::var("GROX_COMPUTER_USE") {
        let t = v.trim();
        if t == "1" || t.eq_ignore_ascii_case("true") {
            return true;
        }
        if t == "0" || t.eq_ignore_ascii_case("false") {
            return false;
        }
    }
    host_prefs::is_computer_use_enabled()
}

// ─────────────────────── 浏览器与 Computer Use 门禁 ───────────────────────

/// Parse + gate a user/markdown open URL (credentials, remote HTTP, IMDS/SSRF).
pub(crate) fn parse_browser_url(url: &str) -> Result<url::Url, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.len() > 8_192 {
        return Err("链接长度无效".into());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("链接包含非法控制字符".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|error| format!("无效链接：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只允许打开 HTTP(S) 链接".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("链接不能包含用户名或密码".into());
    }
    if parsed.host_str().is_none() {
        return Err("链接缺少主机名".into());
    }
    // Cleartext HTTP only for loopback; remote must be HTTPS.
    if parsed.scheme() == "http" && !is_loopback_host(parsed.host_str()) {
        return Err("远程链接必须使用 HTTPS；仅本机回环地址允许 HTTP".into());
    }
    // Never open cloud metadata / link-local targets.
    if is_blocked_service_host(parsed.host_str()) {
        return Err("不允许打开链路本地或云元数据地址".into());
    }
    Ok(parsed)
}

pub(crate) fn spawn_system_browser(parsed: &url::Url) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", parsed.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法打开浏览器：{error}"))?;
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|error| format!("无法打开浏览器：{error}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|error| format!("无法打开浏览器：{error}"))?;

    Ok(())
}

pub(crate) fn ensure_computer_plugin() -> Result<PathBuf, String> {
    let root = grok_home()?.join("plugins").join("grox-computer-use");
    let skill = root.join("skills").join("computer");
    fs::create_dir_all(&skill).map_err(|error| format!("无法创建 Computer Use Skill：{error}"))?;
    fs::write(
        root.join("plugin.json"),
        r#"{"name":"grox-desktop-computer-use","version":"0.3.4","description":"Grox desktop Computer Use harness (Windows full control; macOS/Linux observation-first)"}"#,
    )
    .map_err(|error| format!("无法写入 Computer Use Plugin：{error}"))?;
    fs::write(
        skill.join("SKILL.md"),
        r#"---
name: computer
description: Use Grox's Computer Use harness when the user asks for visual desktop control or uses @Computer. Full mouse/keyboard automation is strongest on Windows; macOS and Linux expose observation and limited control that may require Accessibility / input permissions.
---

# Grox Computer Use

Use only the grox_desktop_computer MCP tools for an explicit `/computer` or `@Computer` request (or when the user clearly asks for desktop control). Start with `list_apps`/`list_windows`, select an exact controllable window with `start`, then repeat observation → exactly one action → observation. Every state-changing action must use the latest `stateId`; stale state must be rejected. Prefer UI Automation `elementId` and `set_value` when available. Never send Win/Meta keys or system chords such as Alt+Tab, Alt+F4, or Ctrl+Esc. Never control Grox itself, installers, UAC, elevated windows, or the secure desktop. Use `stop` immediately when the user asks. Emergency stop is sticky.
"#,
    )
    .map_err(|error| format!("无法写入 Computer Use Skill：{error}"))?;
    Ok(root)
}

pub(crate) fn checked_reasoning_effort(effort: Option<String>) -> Result<Option<String>, String> {
    match effort {
        Some(value) if matches!(value.as_str(), "low" | "medium" | "high" | "xhigh" | "max") => {
            Ok(Some(value))
        }
        Some(_) => Err("无效思考强度".into()),
        None => Ok(None),
    }
}

pub(crate) fn ensure_main_acp_owner(window_label: &str) -> Result<(), String> {
    if window_label == "main" {
        Ok(())
    } else {
        Err("当前窗口不是 ACP 运行时所有者，请回到主窗口继续会话".into())
    }
}

pub(crate) fn emit_host_session_event(app: &tauri::AppHandle, event: HostSessionEvent) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("host-session-event", event);
    }
}

/// Extract the semver token from a `grok --version` line such as
/// "grok 0.2.106 (abc1234) [stable]".
pub(crate) fn cli_version_number(raw: &str) -> Option<semver::Version> {
    raw.split_whitespace()
        .find_map(|token| semver::Version::parse(token.trim_start_matches(['v', 'V'])).ok())
}

pub(crate) fn acp_rpc_error(method: &str, error: &serde_json::Value) -> AcpHostError {
    let code = error.get("code").and_then(serde_json::Value::as_i64);
    let detail = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string());
    let detail = detail.chars().take(3_500).collect::<String>();
    let stable_code = match code {
        Some(-32601) => "ACP_RPC_METHOD_NOT_FOUND",
        Some(-32602) => "ACP_RPC_INVALID_PARAMS",
        _ => "ACP_RPC_FAILED",
    };
    AcpHostError::protocol(stable_code, format!("{detail} · {method}"))
}

// ─────────────────────────── ACP wire 读写 ───────────────────────────

/// Methods the desktop shell may write on the ACP stdin channel.
/// Unknown methods from a compromised WebView are rejected.
///
/// Wire note: FE may prefix extension notifies as `_x.ai/...`.
pub(crate) fn acp_method_allowed(method: &str) -> bool {
    if method.is_empty()
        || method.contains("..")
        || method.contains('\\')
        || method.bytes().any(|b| b < 0x20 || b == 0x7f)
    {
        return false;
    }
    if !method
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'.' | b'-'))
    {
        return false;
    }
    // Only x.ai extension notifications use the optional wire-level `_` prefix.
    // Do not let the prefix turn arbitrary standard namespaces into aliases.
    let m = method
        .strip_prefix("_x.ai/")
        .map(|suffix| format!("x.ai/{suffix}"));
    let m = m.as_deref().unwrap_or(method);
    matches!(
        m,
        "session/new"
            | "session/load"
            | "session/close"
            | "session/prompt"
            | "session/cancel"
            | "session/delete"
            | "session/set_config_option"
            | "session/set_model"
            | "session/setMode"
            | "session/set_mode"
            | "session/info"
            | "session/list"
            | "session/resume"
            | "session/fork"
            | "session/update"
            | "initialize"
            | "authenticate"
            | "x.ai/interject"
            | "x.ai/session/list"
            | "x.ai/session/delete"
            | "x.ai/session/update"
            | "x.ai/session/prompt_queue"
            | "x.ai/session/prompt_queue/list"
            | "x.ai/session/prompt_queue/cancel"
            | "x.ai/set_permission_mode"
            | "x.ai/permission/respond"
            | "x.ai/question/respond"
            | "x.ai/model/list"
            | "x.ai/model/set"
            | "x.ai/account"
            | "x.ai/billing"
            | "x.ai/config"
            | "x.ai/mcp/status"
            | "x.ai/yolo_mode_changed"
            | "x.ai/queue/changed"
    ) || m.starts_with("x.ai/")
}

pub(crate) fn prepare_acp_line(line: String, leases: &McpLeaseStore) -> Result<String, String> {
    if line.contains('\n') || line.contains('\r') {
        return Err("ACP 消息必须是单行 JSON".into());
    }
    // 多模态 base64 需要较大上限，但不能允许 WebView 无界占用 Host 内存。
    const MAX_ACP_LINE_BYTES: usize = 8 * 1024 * 1024;
    if line.len() > MAX_ACP_LINE_BYTES {
        return Err(format!(
            "ACP 消息过大（{} bytes，上限 {}）",
            line.len(),
            MAX_ACP_LINE_BYTES
        ));
    }
    let message = serde_json::from_str::<serde_json::Value>(&line)
        .map_err(|error| format!("ACP 消息不是合法 JSON：{error}"))?;
    if !message.is_object() {
        return Err("ACP 消息必须是 JSON 对象".into());
    }
    if message.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0") {
        return Err("ACP 消息必须声明 jsonrpc 2.0".into());
    }
    if let Some(method) = message.get("method").and_then(serde_json::Value::as_str) {
        if !acp_method_allowed(method) {
            return Err(format!("不允许的 ACP 方法：{method}"));
        }
    }
    let line = mcp_leases::inject_mcp_servers(&line, leases)?;
    if line.contains('\n') || line.contains('\r') {
        return Err("ACP 消息必须是单行 JSON".into());
    }
    Ok(line)
}

pub(crate) async fn write_acp_line(
    state: &AcpState,
    line: &str,
    generation: u64,
) -> Result<(), String> {
    let mut guard = state.process.lock().await;
    let process = guard
        .as_mut()
        .ok_or_else(|| "Grok Agent 尚未启动".to_string())?;
    if process.generation != generation {
        return Err("ACP 通道已切换，请在新通道上重试".into());
    }
    process
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| format!("写入 Grok Agent 失败：{error}"))?;
    process
        .stdin
        .write_all(b"\n")
        .await
        .map_err(|error| format!("写入 Grok Agent 失败：{error}"))?;
    process
        .stdin
        .flush()
        .await
        .map_err(|error| format!("刷新 Grok Agent 输入失败：{error}"))
}

pub(crate) async fn acp_request_inner(
    state: &AcpState,
    leases: &McpLeaseStore,
    line: String,
    request_id: u64,
    generation: u64,
    timeout_ms: u64,
    gate_token: Option<u64>,
) -> Result<String, AcpHostError> {
    let line = prepare_acp_line(line, leases)
        .map_err(|error| AcpHostError::protocol("ACP_INVALID_REQUEST", error))?;
    let message = serde_json::from_str::<serde_json::Value>(&line).map_err(|error| {
        AcpHostError::protocol(
            "ACP_INVALID_REQUEST",
            format!("ACP 消息不是合法 JSON：{error}"),
        )
    })?;
    let wire_id = message
        .get("id")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| AcpHostError::protocol("ACP_INVALID_REQUEST", "ACP 请求缺少数字 id"))?;
    if wire_id != request_id {
        return Err(AcpHostError::protocol(
            "ACP_REQUEST_ID_MISMATCH",
            "ACP 请求 id 与 Host 参数不一致",
        ));
    }
    let method = message
        .get("method")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AcpHostError::protocol("ACP_INVALID_REQUEST", "ACP 请求缺少 method"))?
        .to_string();
    state.sessions.verify_request(
        &method,
        message.get("params").unwrap_or(&serde_json::Value::Null),
        gate_token,
        generation,
    )?;
    let receiver = state
        .requests
        .register(request_id, generation, method.clone())
        .await?;
    if let Err(error) = write_acp_line(state, &line, generation).await {
        let failure = AcpHostError::environment(
            "ACP_WRITE_FAILED",
            error,
            true,
            true,
            "检查 Grok Build CLI 是否仍在运行，然后重新连接",
        );
        state
            .requests
            .reject(request_id, generation, failure.clone())
            .await;
        return Err(failure);
    }

    let response = if timeout_ms == 0 {
        receiver.await.map_err(|_| {
            AcpHostError::environment(
                "ACP_REQUEST_CHANNEL_CLOSED",
                "ACP 请求通道已关闭",
                true,
                true,
                "重新连接 Agent 后重试",
            )
        })?
    } else {
        // 普通 RPC 最多允许等待一天；长回合使用 0 并由会话 watchdog 明确取消。
        let timeout = Duration::from_millis(timeout_ms.min(24 * 60 * 60 * 1_000));
        match tokio::time::timeout(timeout, receiver).await {
            Ok(result) => result.map_err(|_| {
                AcpHostError::environment(
                    "ACP_REQUEST_CHANNEL_CLOSED",
                    "ACP 请求通道已关闭",
                    true,
                    true,
                    "重新连接 Agent 后重试",
                )
            })?,
            Err(_) => {
                let failure = AcpHostError::environment(
                    "ACP_REQUEST_TIMEOUT",
                    format!("Grok Agent 请求超时：{method}"),
                    true,
                    true,
                    "检查网络和 Grok Build CLI 状态后重试",
                );
                state
                    .requests
                    .reject(request_id, generation, failure.clone())
                    .await;
                return Err(failure);
            }
        }
    };
    response
}

/// Host 服务使用与 WebView 完全相同的请求表、代次校验和 stdio 写通道。
/// JavaScript 安全整数的高位命名空间避免与 WebView 递增请求 id 相撞。
pub(crate) async fn request_acp_json(
    state: &AcpState,
    leases: &McpLeaseStore,
    method: &str,
    params: serde_json::Value,
    generation: u64,
    timeout_ms: u64,
    gate_token: Option<u64>,
) -> Result<serde_json::Value, AcpHostError> {
    request_acp_json_tracked(
        state, leases, method, params, generation, timeout_ms, gate_token, None,
    )
    .await
}

pub(crate) fn acp_wire_method(method: &str) -> String {
    method
        .strip_prefix("x.ai/")
        .map(|suffix| format!("_x.ai/{suffix}"))
        .unwrap_or_else(|| method.to_string())
}

/// 与普通 Host 请求共用同一 broker；tracker 只记录当前事务可定向取消的 id。
pub(crate) async fn request_acp_json_tracked(
    state: &AcpState,
    leases: &McpLeaseStore,
    method: &str,
    params: serde_json::Value,
    generation: u64,
    timeout_ms: u64,
    gate_token: Option<u64>,
    tracker: Option<&dyn turn_runtime::AcpRequestTracker>,
) -> Result<serde_json::Value, AcpHostError> {
    let request_id = state.issue_host_request_id();
    if let Some(tracker) = tracker {
        tracker.request_started(request_id, method)?;
    }
    struct TrackingGuard<'a> {
        tracker: Option<&'a dyn turn_runtime::AcpRequestTracker>,
        request_id: u64,
    }
    impl Drop for TrackingGuard<'_> {
        fn drop(&mut self) {
            if let Some(tracker) = self.tracker {
                tracker.request_finished(self.request_id);
            }
        }
    }
    let _tracking = TrackingGuard {
        tracker,
        request_id,
    };
    // ACP 扩展在 wire 上使用前导下划线；Host 内部始终使用规范化的
    // `x.ai/...` 名称做门禁、诊断和错误分类。此前只有 WebView 做了这层
    // 编码，迁到 Host 的自动化/删除/fork 请求会在真实 CLI 上找不到方法。
    let wire_method = acp_wire_method(method);
    let line = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": wire_method,
        "params": params,
    })
    .to_string();
    let response = acp_request_inner(
        state, leases, line, request_id, generation, timeout_ms, gate_token,
    )
    .await?;
    decode_host_acp_response(&response, request_id, method)
}

pub(crate) fn decode_host_acp_response(
    line: &str,
    request_id: u64,
    method: &str,
) -> Result<serde_json::Value, AcpHostError> {
    let response = serde_json::from_str::<serde_json::Value>(line).map_err(|error| {
        AcpHostError::protocol(
            "ACP_INVALID_RESPONSE",
            format!("Grok Build 返回了无法解析的 ACP 响应：{error}"),
        )
    })?;
    let object = response.as_object().ok_or_else(|| {
        AcpHostError::protocol("ACP_INVALID_RESPONSE", "Grok Build 的 ACP 响应不是对象")
    })?;
    if object.get("id").and_then(serde_json::Value::as_u64) != Some(request_id)
        || object.get("method").is_some()
    {
        return Err(AcpHostError::protocol(
            "ACP_INVALID_RESPONSE",
            format!("Grok Build 返回了无法归属的 ACP 响应 · {method}"),
        ));
    }
    if let Some(error) = object.get("error") {
        return Err(acp_rpc_error(method, error));
    }
    let result = object
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    if method.starts_with("x.ai/") {
        if let Some(error) = result.get("error").filter(|error| !error.is_null()) {
            return Err(acp_rpc_error(method, error));
        }
        if let Some(nested) = result.get("result") {
            return Ok(nested.clone());
        }
    }
    Ok(result)
}
