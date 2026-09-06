//! Grox native shell.
//!
//! The webview speaks JSON-RPC while this process owns the long-lived
//! `grok agent stdio` child. Keeping process management here prevents the
//! privileged webview from spawning arbitrary commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod acp_host;
mod acp_inbound;
mod agent_auth;
mod agent_runtime;
mod automation_runner;
mod automation_store;
mod browser_mcp;
mod client_callbacks;
mod computer_mcp;
mod draft_store;
mod file_commands;
mod foreground_turn;
mod git_confirm;
mod host_error;
mod host_logging;
mod host_prefs;
mod interaction_service;
mod mcp_leases;
mod media_service;
#[cfg(debug_assertions)]
mod mock_acp_fixture;
mod path_sandbox;
mod permission_audit;
mod permission_policy;
#[cfg(windows)]
mod process_job;
mod prompt_queue_store;
mod process_env;
mod provider_overrides;
mod provider_profiles;
mod provider_service;
mod session_coordinator;
mod session_event_journal;
mod session_journal_store;
mod session_runtime;
mod session_storage;
mod secret_store;
mod support_bundle;
mod terminal_host;
mod tray;
mod turn_runtime;
mod worktree_ownership;
mod host_core;
mod runtime_lifecycle;

use host_core::{
    acp_request_inner,
    atomic_create_private, atomic_write, atomic_write_private,
    automations_path,
    configured_grok_command, config_path, default_workspace, ensure_main_acp_owner, grok_home,
    host_prefs_dir_for_app, parse_browser_url, prepare_acp_line, prompt_image_mime,
    read_bounded_text, restrict_private_file, scrub_atomic_write_orphans, spawn_system_browser,
    replace_file_atomic, git_command, git_text, optional_git_text, prompt_queues_path, user_home,
    worktree_bindings_path, write_acp_line, AcpState, AUTOMATIONS_MAX_BYTES,
    CONFIG_WRITE_NONCE, emit_host_session_event, GrokRuntimeInfo, MAX_CONFIG_BYTES,
    MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGE_TOTAL_BYTES, MAX_PROVIDER_MODELS_BODY_BYTES,
    MAX_SESSION_PREVIEW_MESSAGES, MAX_SESSION_PREVIEW_TEXT_CHARS, MAX_SESSION_PREVIEW_TOOL_INPUT_CHARS,
    MAX_SESSION_SEARCH_FILE_BYTES, MAX_SESSION_SEARCH_HITS, MAX_SESSION_SEARCH_IDS,
    MAX_SESSION_SEARCH_TOTAL_BYTES, PROMPT_QUEUES_MAX_BYTES, RuntimePhase,
};
use automation_runner::automation_claim_error;
use provider_overrides::parse_grok_config_document;
use runtime_lifecycle::{
    AcpExitPayload, AppShutdown, ensure_agent_runtime_ready,
    terminate_process,
};

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    io::{Read as _, SeekFrom, Write as _},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::Ordering,
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use acp_host::AcpHostError;
use agent_auth::{
    agent_runtime_auth_cancel, agent_runtime_auth_status, agent_runtime_authenticate,
};
use agent_runtime::AgentRuntimeConnection;
use automation_runner::{storage_error as automation_storage_error, AutomationRunner};
use automation_store::AutomationStore;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use draft_store::{
    DraftAttachment, DraftSnapshot, DraftStore, DraftStoreError, DRAFTS_MAX_BYTES,
};
use file_commands::{open_file_with_default, reveal_in_explorer};
use git_confirm::GitConfirmStore;
use foreground_turn::{
    cancel_foreground_turn, execute_foreground_turn, foreground_turn_status,
};
use host_error::HostError;
use interaction_service::InteractionProjection;
use mcp_leases::McpLeaseStore;
use media_service::{
    cancel_media_generation, is_media_https_host_allowed, media_generation_capabilities,
    media_generation_history, media_generation_status, media_journal_status, open_media_artifact,
    release_media_reference, restore_job_journal, save_media_reference, start_media_generation,
    MediaService,
};
use path_sandbox::{
    checked_workspace, checked_workspace_file, path_for_webview,
};
use percent_encoding::percent_decode_str;
use prompt_queue_store::PromptQueueStore;
use provider_profiles::{
    is_relay_section_id, provider_section_id, ProviderApiBackend, GROK_MODELS_BASE_URL_KEY,
};
use provider_service::{
    checked_api_key, compatible_models_url, is_blocked_service_host, is_loopback_host,
    normalize_provider_endpoint, ConfigureProviderInput, ProviderService,
    ProviderServiceError, ProviderServiceErrorKind, ProviderServiceHostOps,
    ProviderSummary as ProviderProfileSummary, SaveProviderProfileInput,
};
use serde::{Deserialize, Serialize};
use session_coordinator::SessionRuntimeOccupancy;
use session_event_journal::{
    HostSessionEventReplay, HostSessionEventStatus,
};
use session_journal_store::{SessionJournalStore, SessionJournalWriteError};
use session_runtime::{
    browser_shutdown_all_leases, close_agent_session, computer_emergency_stop_session,
    computer_shutdown_all_leases, delete_agent_session, fork_agent_session,
    fork_agent_session_in_worktree, open_agent_session,
    shutdown_all_mcp_resources,
};
use session_storage::SessionStorageState;
use secret_store::SecretBackendKind;
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    sync::Mutex,
};
use toml_edit::{value as toml_value, Document, Item, Table, TableLike};
use worktree_ownership::WorktreeOwnershipStore;

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/dandandujie/Grox/releases/latest";
const RELEASES_URL: &str = "https://api.github.com/repos/dandandujie/Grox/releases";
const GROK_INSTALL_PS1_URL: &str = "https://x.ai/cli/install.ps1";
const GROK_INSTALL_SH_URL: &str = "https://x.ai/cli/install.sh";
// The upstream built-in workflow has early `complete()` branches for empty
// candidate/verdict sets. Grox routes the built-in slash shortcut to this
// user-scoped compatibility workflow so every research run reaches Verify and
// Report, including a useful audit/report for partial evidence.
const GROX_DEEP_RESEARCH_WORKFLOW: &str = include_str!("../resources/grox-deep-research.rhai");







struct PreviewProcess {
    child: Child,
    root: PathBuf,
}

#[derive(Default)]
struct PreviewState {
    process: Mutex<Option<PreviewProcess>>,
}

#[derive(Default)]
struct FilePreviewState {
    port: Mutex<Option<u16>>,
    roots: Arc<Mutex<BTreeMap<String, PathBuf>>>,
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeStatus {
    topology: &'static str,
    process_capacity: u8,
    running: bool,
    ready: bool,
    phase: &'static str,
    generation: Option<u64>,
    pid: Option<u32>,
    pending_requests: usize,
    pending_interactions: usize,
    pending_client_callbacks: usize,
    bound_client_sessions: usize,
    active_terminals: usize,
    automatic_reconnect_active: bool,
    last_connect_configured: bool,
    worktree_session_bindings: usize,
    worktree_ownership_error: Option<String>,
    session_event_stream: HostSessionEventStatus,
    host_logging: host_logging::HostLogStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEnvironment {
    default_workspace: String,
    grok_command: String,
    app_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSessionBinding {
    session_id: String,
    cwd: String,
}

#[tauri::command]
fn replay_session_events(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    stream_id: Option<String>,
    after_sequence: Option<u64>,
    limit: Option<usize>,
) -> Result<HostSessionEventReplay, HostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    Ok(state
        .session_events
        .replay(stream_id.as_deref(), after_sequence.unwrap_or(0), limit))
}

#[tauri::command]
fn host_session_bindings(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<Vec<HostSessionBinding>, HostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    Ok(state
        .client_callbacks
        .bound_session_workspaces()
        .into_iter()
        .map(|(session_id, workspace)| HostSessionBinding {
            session_id,
            cwd: path_for_webview(&workspace),
        })
        .collect())
}


#[tauri::command]
async fn agent_runtime_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
    worktrees: tauri::State<'_, WorktreeOwnershipStore>,
) -> Result<AgentRuntimeStatus, HostError> {
    let (running, generation, pid) = {
        let process = state.process.lock().await;
        (
            process.is_some(),
            process.as_ref().map(|process| process.generation),
            process.as_ref().and_then(|process| process.child.id()),
        )
    };
    let (worktree_session_bindings, worktree_ownership_error) = match worktree_bindings_path(&app)
        .and_then(|path| worktrees.count(&path))
    {
        Ok(count) => (count, None),
        Err(error) => (0, Some(error)),
    };
    Ok(AgentRuntimeStatus {
        topology: "shared_process",
        process_capacity: 1,
        running,
        ready: generation.is_some_and(|generation| {
            state.ready_generation.load(Ordering::Acquire) == generation
        }),
        phase: RuntimePhase::from_raw(state.runtime_phase.load(Ordering::Acquire)).as_str(),
        generation,
        pid,
        pending_requests: state.requests.len().await,
        pending_interactions: state.interactions.snapshots().len(),
        pending_client_callbacks: state.client_callbacks.pending_len(),
        bound_client_sessions: state.client_callbacks.bound_len(),
        active_terminals: state.client_callbacks.terminal_len().await,
        automatic_reconnect_active: state.automatic_reconnect_owner.load(Ordering::Acquire) != 0,
        last_connect_configured: state.last_connect().is_some(),
        worktree_session_bindings,
        worktree_ownership_error,
        session_event_stream: state.session_events.status(),
        host_logging: host_logging::status(),
    })
}

#[tauri::command]
fn session_runtime_status(state: tauri::State<'_, Arc<AcpState>>) -> SessionRuntimeOccupancy {
    state.sessions.snapshot()
}

#[tauri::command]
async fn session_gate_enter_lifecycle(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    generation: u64,
) -> Result<u64, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    state.sessions.enter_lifecycle(generation).await
}

#[tauri::command]
fn session_gate_release(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    token: u64,
    generation: u64,
) -> Result<bool, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    Ok(state.sessions.release(token, generation))
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ConfigOverlayMetadata {
    /// Best-effort configured source. Grok Build performs the authoritative
    /// parse/allowlist pipeline; inline contents never cross the IPC boundary.
    source: &'static str,
    path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigDocument {
    id: &'static str,
    label: &'static str,
    path: String,
    content: String,
    exists: bool,
    language: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    overlay: Option<ConfigOverlayMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewFile {
    path: String,
    name: String,
    kind: &'static str,
    mime: String,
    content: String,
}


/// An image that the operator explicitly referenced in the outgoing prompt.
///
/// This is deliberately separate from ACP's `fs/read_text_file`: ACP only
/// defines a text response there, while this payload becomes a normal prompt
/// image block (the same shape as a pasted image).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptPathImage {
    path: String,
    name: String,
    mime: String,
    size: u64,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntry {
    path: String,
    name: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitSummary {
    is_repository: bool,
    branch: Option<String>,
    branches: Vec<String>,
    added: u64,
    removed: u64,
    changed_files: usize,
    remote_url: Option<String>,
    default_branch: Option<String>,
    ahead: u64,
    behind: u64,
}



#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenApplicationOption {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    launch_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_data_url: Option<String>,
}

#[derive(Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    title: String,
    notes: String,
    release_url: String,
    published_at: Option<String>,
    installable: bool,
    asset_name: Option<String>,
    requires_xattr: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseSummary {
    version: String,
    title: String,
    notes: String,
    release_url: String,
    published_at: Option<String>,
    installable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    current_version: String,
    update_available: bool,
    latest: UpdateInfo,
    history: Vec<ReleaseSummary>,
    rollback: Option<ReleaseSummary>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPreview {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    framework: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone)]
struct FrontendTarget {
    root: PathBuf,
    framework: String,
    manager: &'static str,
    port: u16,
    script: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteConfigDocument {
    id: String,
    cwd: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    kind: String,
    api_key: Option<String>,
    base_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatus {
    kind: &'static str,
    has_api_key: bool,
    base_url: Option<String>,
    secret_backend: SecretBackendKind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfilesResponse {
    active_id: Option<String>,
    profiles: Vec<ProviderProfileSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProviderProfile {
    id: Option<String>,
    name: String,
    api_key: Option<String>,
    base_url: String,
    #[serde(default)]
    allow_insecure_http: bool,
    #[serde(default)]
    api_backend: ProviderApiBackend,
    #[serde(default)]
    resident_models: Vec<String>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES: u64 = 40 * 1024 * 1024;
const MAX_STREAMABLE_PREVIEW_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES: usize = 2_000;



#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SessionPreviewEntry {
    Message {
        role: String,
        text: String,
    },
    Tool {
        id: String,
        name: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        status: SessionPreviewToolStatus,
    },
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SessionPreviewToolStatus {
    Done,
    Cancelled,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDiskPreview {
    entries: Vec<SessionPreviewEntry>,
    truncated: bool,
}

fn capped_session_preview_text(text: &str, limit: usize, truncated: &mut bool) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    *truncated = true;
    let mut output = text.chars().take(limit).collect::<String>();
    output.push_str("\n… [Grox 已截断过长的磁盘预览内容]");
    output
}

fn push_session_preview_entry(
    entries: &mut VecDeque<SessionPreviewEntry>,
    limit: usize,
    entry: SessionPreviewEntry,
    truncated: &mut bool,
) {
    if limit == 0 {
        return;
    }
    if entries.len() == limit {
        entries.pop_front();
        *truncated = true;
    }
    entries.push_back(entry);
}

fn session_preview_tool_call(
    call: &serde_json::Value,
    truncated: &mut bool,
) -> Option<SessionPreviewEntry> {
    let id = call
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    let name = call
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("tool")
        .to_string();
    let input = call
        .get("arguments")
        .and_then(session_history_text)
        .filter(|input| !input.trim().is_empty())
        .map(|input| {
            capped_session_preview_text(
                &input,
                MAX_SESSION_PREVIEW_TOOL_INPUT_CHARS,
                truncated,
            )
        });
    Some(SessionPreviewEntry::Tool {
        id: id.to_string(),
        title: name.clone(),
        name,
        input,
        output: None,
        // No result in durable history means the call was interrupted or is
        // still active; the preview must never imply success.
        status: SessionPreviewToolStatus::Cancelled,
    })
}

fn session_history_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    let part = part.as_object()?;
                    (part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                        .then(|| part.get("text").and_then(serde_json::Value::as_str))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn parse_session_disk_preview(
    reader: impl std::io::BufRead,
    limit: usize,
) -> Result<SessionDiskPreview, String> {
    let limit = limit.min(MAX_SESSION_PREVIEW_MESSAGES);
    let mut entries = VecDeque::with_capacity(limit);
    let mut truncated = false;
    for line in reader.lines() {
        let line = line.map_err(|error| format!("无法读取会话预览：{error}"))?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let role = value.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
        if role == "user"
            && value
                .get("synthetic_reason")
                .and_then(serde_json::Value::as_str)
                .is_some()
        {
            continue;
        }
        if matches!(role, "user" | "assistant") {
            if let Some(text) = value.get("content").and_then(session_history_text) {
                if !text.trim().is_empty() && limit > 0 {
                    let text = capped_session_preview_text(
                        &text,
                        MAX_SESSION_PREVIEW_TEXT_CHARS,
                        &mut truncated,
                    );
                    push_session_preview_entry(
                        &mut entries,
                        limit,
                        SessionPreviewEntry::Message {
                            role: role.to_string(),
                            text,
                        },
                        &mut truncated,
                    );
                }
            }

            // Current Grok Build stores calls on assistant rows, then writes a
            // separate tool_result row. Preserve those public events so an
            // offline restore still explains what the agent executed.
            if role == "assistant" && limit > 0 {
                for call in value
                    .get("tool_calls")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(entry) = session_preview_tool_call(call, &mut truncated) else {
                        continue;
                    };
                    let id = match &entry {
                        SessionPreviewEntry::Tool { id, .. } => id.clone(),
                        SessionPreviewEntry::Message { .. } => unreachable!(),
                    };
                    if let Some(SessionPreviewEntry::Tool {
                        name,
                        title,
                        input,
                        ..
                    }) = entries.iter_mut().find(|known| {
                        matches!(known, SessionPreviewEntry::Tool { id: known_id, .. } if known_id == &id)
                    }) {
                        if let SessionPreviewEntry::Tool {
                            name: new_name,
                            title: new_title,
                            input: new_input,
                            ..
                        } = entry
                        {
                            *name = new_name;
                            *title = new_title;
                            *input = new_input;
                        }
                        continue;
                    }
                    push_session_preview_entry(&mut entries, limit, entry, &mut truncated);
                }
            }
            continue;
        }

        if role != "tool_result" || limit == 0 {
            continue;
        }
        let Some(id) = value
            .get("tool_call_id")
            .or_else(|| value.get("toolCallId"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let output = value
            .get("content")
            .and_then(session_history_text)
            .filter(|output| !output.trim().is_empty())
            .map(|output| {
                capped_session_preview_text(
                    &output,
                    MAX_SESSION_PREVIEW_TEXT_CHARS,
                    &mut truncated,
                )
            });
        if let Some(SessionPreviewEntry::Tool {
            output: known_output,
            status,
            ..
        }) = entries.iter_mut().find(|entry| {
            matches!(entry, SessionPreviewEntry::Tool { id: known_id, .. } if known_id == id)
        }) {
            *known_output = output;
            *status = SessionPreviewToolStatus::Done;
            continue;
        }
        push_session_preview_entry(
            &mut entries,
            limit,
            SessionPreviewEntry::Tool {
                id: id.to_string(),
                name: "tool".into(),
                title: "工具调用".into(),
                input: None,
                output,
                status: SessionPreviewToolStatus::Done,
            },
            &mut truncated,
        );
    }
    Ok(SessionDiskPreview {
        entries: entries.into(),
        truncated,
    })
}

/// History file names used by current and older Grok CLI layouts.
const SESSION_HISTORY_FILENAMES: &[&str] = &[
    "chat_history.jsonl",
    "history.jsonl",
    "session.jsonl",
    "transcript.jsonl",
];

fn session_history_path(grok: &Path, session_id: &str) -> Result<Option<PathBuf>, String> {
    let mut components = Path::new(session_id).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("无效会话 ID".into());
    }
    let sessions = grok.join("sessions");
    if !sessions.is_dir() {
        return Ok(None);
    }
    let sessions = sessions
        .canonicalize()
        .map_err(|error| format!("无法读取 Grok 会话目录：{error}"))?;
    let wanted = session_id.to_ascii_lowercase();

    // Fast path: known layouts.
    for name in SESSION_HISTORY_FILENAMES {
        let direct = sessions.join(session_id).join(name);
        if let Ok(candidate) = direct.canonicalize() {
            if candidate.starts_with(&sessions) && candidate.is_file() {
                return Ok(Some(candidate));
            }
        }
        let Ok(entries) = fs::read_dir(&sessions) else {
            break;
        };
        for entry in entries.filter_map(Result::ok) {
            let candidate = entry.path().join(session_id).join(name);
            if let Ok(candidate) = candidate.canonicalize() {
                if candidate.starts_with(&sessions) && candidate.is_file() {
                    return Ok(Some(candidate));
                }
            }
        }
    }

    // Slow path: case-insensitive id match + one extra nesting level
    // (workspace / batch / session-id / history).
    if let Some(path) = find_session_history_by_scan(&sessions, &wanted)? {
        return Ok(Some(path));
    }
    Ok(None)
}

fn session_directory_path(grok: &Path, session_id: &str) -> Result<Option<PathBuf>, String> {
    if !valid_session_id(session_id) {
        return Err("无效会话 ID".into());
    }
    let sessions = grok.join("sessions");
    if !sessions.is_dir() {
        return Ok(None);
    }
    let root = sessions
        .canonicalize()
        .map_err(|error| format!("无法读取 Grok 会话目录：{error}"))?;
    let wanted = session_id.to_ascii_lowercase();
    let mut pending = vec![(root.clone(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Ok(canonical) = path.canonicalize() else {
                continue;
            };
            if !canonical.starts_with(&root) {
                continue;
            }
            // 工作区目录名也可能碰巧等于会话 ID。必须看到已知历史文件才把
            // 它视为会话目录，宁可留下无数据的空目录，也不能误删父级容器。
            let is_session_directory = history_file_in_session_dir(&canonical).is_some();
            if dir_name_eq_ci(&canonical, &wanted) && is_session_directory {
                return Ok(Some(canonical));
            }
            // 当前和旧版布局最多为 workspace / batch / session-id。
            if depth < 2 {
                pending.push((canonical, depth + 1));
            }
        }
    }
    Ok(None)
}

fn delete_session_history_data(grok: &Path, session_id: &str) -> Result<bool, String> {
    let Some(directory) = session_directory_path(grok, session_id)? else {
        return Ok(false);
    };
    fs::remove_dir_all(&directory)
        .map_err(|error| format!("无法删除会话历史 {}：{error}", directory.display()))?;
    Ok(true)
}

fn workspace_identity(path: &str) -> String {
    let mut value = path.trim().replace('\\', "/");
    if value.starts_with("//?/") {
        value = value[4..].to_string();
    }
    while value.contains("//") {
        value = value.replace("//", "/");
    }
    while value.len() > 1
        && value.ends_with('/')
        && !(value.len() == 3 && value.as_bytes().get(1) == Some(&b':'))
    {
        value.pop();
    }
    value.to_lowercase()
}

fn workspace_paths_match(left: &str, right: &str) -> bool {
    match (
        Path::new(left).canonicalize(),
        Path::new(right).canonicalize(),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => workspace_identity(left) == workspace_identity(right),
    }
}

fn collect_session_directory_ids(
    directory: &Path,
    depth: usize,
    ids: &mut BTreeSet<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("无法枚举 Grok 会话目录 {}：{error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法枚举 Grok 会话目录项：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取 Grok 会话目录项：{error}"))?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if history_file_in_session_dir(&path).is_some() {
            if let Some(id) = entry.file_name().to_str().filter(|id| valid_session_id(id)) {
                ids.insert(id.to_string());
            }
            continue;
        }
        if depth < 2 {
            collect_session_directory_ids(&path, depth + 1, ids)?;
        }
    }
    Ok(())
}

fn project_session_history_data(
    grok: &Path,
    cwd: &str,
) -> Result<(Vec<String>, Vec<PathBuf>), String> {
    let wanted = workspace_identity(cwd);
    if wanted.is_empty() {
        return Err("工作目录不能为空".into());
    }
    let sessions = grok.join("sessions");
    if !sessions.is_dir() {
        return Ok((Vec::new(), Vec::new()));
    }
    let root = sessions
        .canonicalize()
        .map_err(|error| format!("无法读取 Grok 会话目录：{error}"))?;
    let mut ids = BTreeSet::new();
    let mut directories = Vec::new();
    let entries =
        fs::read_dir(&root).map_err(|error| format!("无法枚举 Grok 会话目录：{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法枚举 Grok 会话目录项：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取 Grok 会话目录项：{error}"))?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let Some(encoded) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(decoded) = percent_decode_str(&encoded).decode_utf8() else {
            continue;
        };
        if !workspace_paths_match(&decoded, cwd) {
            continue;
        }
        let directory = entry
            .path()
            .canonicalize()
            .map_err(|error| format!("无法读取项目会话目录：{error}"))?;
        if directory.parent() != Some(root.as_path()) {
            return Err("拒绝删除会话根目录之外的路径".into());
        }
        collect_session_directory_ids(&directory, 0, &mut ids)?;
        directories.push(directory);
    }
    Ok((ids.into_iter().collect(), directories))
}

#[cfg(test)]
fn delete_project_session_history_data(grok: &Path, cwd: &str) -> Result<Vec<String>, String> {
    let (ids, directories) = project_session_history_data(grok, cwd)?;
    for directory in directories {
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("无法删除项目会话历史 {}：{error}", directory.display()))?;
    }
    Ok(ids)
}

fn history_file_in_session_dir(dir: &Path) -> Option<PathBuf> {
    for name in SESSION_HISTORY_FILENAMES {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn dir_name_eq_ci(path: &Path, wanted_lower: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.to_ascii_lowercase() == wanted_lower)
}

/// Depth-limited scan under `~/.grok/sessions` for a folder matching session id.
fn find_session_history_by_scan(sessions: &Path, wanted_lower: &str) -> Result<Option<PathBuf>, String> {
    let Ok(level1) = fs::read_dir(sessions) else {
        return Ok(None);
    };
    for entry in level1.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if dir_name_eq_ci(&path, wanted_lower) {
            if let Some(file) = history_file_in_session_dir(&path) {
                if let Ok(canonical) = file.canonicalize() {
                    if canonical.starts_with(sessions) {
                        return Ok(Some(canonical));
                    }
                }
            }
        }
        // workspace-encoded / nested batch folders
        let Ok(level2) = fs::read_dir(&path) else {
            continue;
        };
        for child in level2.filter_map(Result::ok) {
            let child_path = child.path();
            if !child_path.is_dir() {
                continue;
            }
            if dir_name_eq_ci(&child_path, wanted_lower) {
                if let Some(file) = history_file_in_session_dir(&child_path) {
                    if let Ok(canonical) = file.canonicalize() {
                        if canonical.starts_with(sessions) {
                            return Ok(Some(canonical));
                        }
                    }
                }
            }
            // rare: workspace / group / session-id
            let Ok(level3) = fs::read_dir(&child_path) else {
                continue;
            };
            for grand in level3.filter_map(Result::ok) {
                let grand_path = grand.path();
                if grand_path.is_dir() && dir_name_eq_ci(&grand_path, wanted_lower) {
                    if let Some(file) = history_file_in_session_dir(&grand_path) {
                        if let Ok(canonical) = file.canonicalize() {
                            if canonical.starts_with(sessions) {
                                return Ok(Some(canonical));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(None)
}

#[tauri::command]
fn preview_session_from_disk(id: String) -> Result<Option<SessionDiskPreview>, String> {
    let Some(path) = session_history_path(&grok_home()?, &id)? else {
        return Ok(None);
    };
    let file = fs::File::open(&path)
        .map_err(|error| format!("无法打开会话预览 {}：{error}", path.display()))?;
    parse_session_disk_preview(std::io::BufReader::new(file), MAX_SESSION_PREVIEW_MESSAGES)
        .map(Some)
}

fn valid_session_id(id: &str) -> bool {
    let mut components = Path::new(id).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn session_history_candidates(
    grok: &Path,
    wanted: &BTreeSet<String>,
) -> Result<BTreeMap<String, PathBuf>, String> {
    let sessions = grok.join("sessions");
    if !sessions.is_dir() {
        return Ok(BTreeMap::new());
    }
    let root = sessions
        .canonicalize()
        .map_err(|error| format!("无法读取 Grok 会话目录：{error}"))?;
    let mut found = BTreeMap::new();
    let mut inspect_directory = |directory: &Path| {
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let Some(id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !wanted.contains(&id) || found.contains_key(&id) {
                continue;
            }
            let candidate = entry.path().join("chat_history.jsonl");
            let Ok(candidate) = candidate.canonicalize() else {
                continue;
            };
            if candidate.starts_with(&root) && candidate.is_file() {
                found.insert(id, candidate);
            }
        }
    };
    inspect_directory(&root);
    for workspace in fs::read_dir(&root)
        .map_err(|error| format!("无法扫描 Grok 会话目录：{error}"))?
        .filter_map(Result::ok)
    {
        if workspace.path().is_dir() {
            inspect_directory(&workspace.path());
        }
    }
    Ok(found)
}

fn session_history_content_matches(content: &str, needle: &str) -> bool {
    content.lines().any(|line| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        let Some(role @ ("user" | "assistant")) =
            value.get("type").and_then(serde_json::Value::as_str)
        else {
            return false;
        };
        if role == "user" && value.get("synthetic_reason").is_some() {
            return false;
        }
        value
            .get("content")
            .and_then(session_history_text)
            .is_some_and(|text| text.to_lowercase().contains(needle))
    })
}

#[tauri::command]
fn search_session_history(query: String, session_ids: Vec<String>) -> Result<Vec<String>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().count() > 200 {
        return Err("会话搜索词不能超过 200 个字符".into());
    }
    if session_ids.len() > MAX_SESSION_SEARCH_IDS
        || session_ids.iter().any(|id| !valid_session_id(id))
    {
        return Err("会话搜索范围无效或过大".into());
    }
    let wanted = session_ids.iter().cloned().collect::<BTreeSet<_>>();
    let candidates = session_history_candidates(&grok_home()?, &wanted)?;
    let needle = query.to_lowercase();
    let mut scanned_bytes = 0_u64;
    let mut matches = BTreeSet::new();
    for id in &session_ids {
        if matches.len() >= MAX_SESSION_SEARCH_HITS {
            break;
        }
        let Some(path) = candidates.get(id) else {
            continue;
        };
        let Ok(size) = path.metadata().map(|metadata| metadata.len()) else {
            continue;
        };
        if size > MAX_SESSION_SEARCH_FILE_BYTES
            || scanned_bytes.saturating_add(size) > MAX_SESSION_SEARCH_TOTAL_BYTES
        {
            continue;
        }
        scanned_bytes += size;
        let Ok(content) = read_bounded_text(path, MAX_SESSION_SEARCH_FILE_BYTES) else {
            continue;
        };
        let matched = session_history_content_matches(&content, &needle);
        if matched {
            matches.insert(id.clone());
        }
    }
    Ok(session_ids
        .into_iter()
        .filter(|id| matches.contains(id))
        .collect())
}


fn provision_grox_deep_research_workflow() -> Result<(), String> {
    let path = grok_home()?.join("workflows").join("grox-deep-research.rhai");
    if path.exists() {
        // Upgrade only the exact first managed copy that Grox wrote in the
        // preceding release. Any hand-edited or independently-created file
        // remains entirely under the user's control.
        let current = fs::read(&path)
            .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
        use sha2::{Digest as _, Sha256};
        let digest = format!("{:x}", Sha256::digest(&current));
        // These are released, byte-for-byte managed workflow revisions.  We
        // upgrade them in place, but continue to leave a user-edited copy
        // untouched.  The 0c55 revision contained an unsafe `.reason` getter
        // after a verifier returned a string instead of the requested map.
        if [
            "40fe78048e52316a2c34c743e8584535d01aae8298fd1b5c4390d941a916eb59",
            "0c55a88505109376b6334760bc5bc01d825cc6c2c41a4bdbee46addb095ad49b",
            "9e7b534681e3f6a9051d52baaf09acc4f93a9d0606fd12f3172c49c814e433ea",
        ].contains(&digest.as_str()) {
            return atomic_write(&path, GROX_DEEP_RESEARCH_WORKFLOW);
        }
        return Ok(());
    }
    atomic_write(&path, GROX_DEEP_RESEARCH_WORKFLOW)
}











const SESSION_JOURNAL_MAX_BYTES: u64 = 16 * 1024 * 1024;
const TOOL_IMAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
const TOOL_IMAGES_MAX_BYTES: usize = 16 * 1024 * 1024;

fn safe_session_storage_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("无效的会话 ID".into());
    }
    Ok(id)
}

fn legacy_session_cache_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let safe = safe_session_storage_id(id)?;
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("session-cache").join(format!("{safe}.json")))
        .map_err(|error| format!("无法定位会话缓存目录：{error}"))
}

fn session_journal_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let safe = safe_session_storage_id(id)?;
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("sessions").join(safe))
        .map_err(|error| format!("无法定位应用会话目录：{error}"))
}

fn session_journal_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(session_journal_dir(app, id)?.join("journal.json"))
}

#[derive(Deserialize)]
struct ToolImagePayload {
    mime: String,
    data: String,
}

#[derive(Serialize)]
struct ToolImageReference {
    mime: String,
    path: String,
}

fn checked_tool_image(image: ToolImagePayload) -> Result<(String, Vec<u8>, String), String> {
    if image.data.len() > TOOL_IMAGE_MAX_BYTES.saturating_mul(4) / 3 + 4 {
        return Err("单张工具图片不能超过 8 MB".into());
    }
    let bytes = BASE64
        .decode(image.data.as_bytes())
        .map_err(|error| format!("工具图片不是有效 Base64：{error}"))?;
    if bytes.len() > TOOL_IMAGE_MAX_BYTES {
        return Err("单张工具图片不能超过 8 MB".into());
    }
    let detected = prompt_image_mime(&bytes)
        .ok_or("工具图片只支持 PNG、JPEG、GIF、WebP 或 BMP")?;
    let declared_mime = image.mime.trim().to_ascii_lowercase();
    let declared = match declared_mime.as_str() {
        "image/jpg" => "image/jpeg",
        value => value,
    };
    if declared != detected {
        return Err(format!(
            "工具图片声明类型 {declared} 与实际类型 {detected} 不一致"
        ));
    }
    let extension = match detected {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => return Err("不支持的工具图片类型".into()),
    };
    use sha2::{Digest as _, Sha256};
    let name = format!("{:x}.{extension}", Sha256::digest(&bytes));
    Ok((detected.to_string(), bytes, name))
}

fn write_tool_image(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.is_file() {
        let existing = fs::read(path).map_err(|error| format!("无法校验工具图片：{error}"))?;
        if existing == bytes {
            return Ok(());
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| "工具图片路径缺少父目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建工具图片目录：{error}"))?;
    let nonce = CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".tool-media-{}-{nonce}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|error| format!("无法创建工具图片临时文件：{error}"))?;
    #[cfg(not(unix))]
    restrict_private_file(&temp)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temp);
        return Err(format!("无法写入工具图片：{error}"));
    }
    drop(file);
    if let Err(error) = replace_file_atomic(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    #[cfg(not(unix))]
    restrict_private_file(path)?;
    Ok(())
}

#[tauri::command]
fn persist_session_tool_images(
    app: tauri::AppHandle,
    storage: tauri::State<'_, SessionStorageState>,
    session_id: String,
    images: Vec<ToolImagePayload>,
) -> Result<Vec<ToolImageReference>, String> {
    safe_session_storage_id(&session_id)?;
    let _write = storage.begin_write(&session_id)?;
    if images.len() > 16 {
        return Err("单次最多保存 16 张工具图片".into());
    }
    let media_dir = session_journal_dir(&app, &session_id)?.join("media");
    let mut total = 0usize;
    let mut references = Vec::with_capacity(images.len());
    for image in images {
        let (mime, bytes, name) = checked_tool_image(image)?;
        total = total.saturating_add(bytes.len());
        if total > TOOL_IMAGES_MAX_BYTES {
            return Err("单次工具图片总大小不能超过 16 MB".into());
        }
        let path = media_dir.join(name);
        write_tool_image(&path, &bytes)?;
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| format!("无法授权工具图片预览：{error}"))?;
        references.push(ToolImageReference {
            mime,
            path: path_for_webview(&path),
        });
    }
    Ok(references)
}

#[tauri::command]
fn read_session_journal(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<String>, HostError> {
    safe_session_storage_id(&id)
        .map_err(|error| HostError::operation("SESSION_ID_INVALID", error))?;
    let media_dir = session_journal_dir(&app, &id)
        .map_err(|error| session_persistence_error("SESSION_JOURNAL_READ_FAILED", error))?
        .join("media");
    if media_dir.is_dir() {
        app.asset_protocol_scope()
            .allow_directory(&media_dir, false)
            .map_err(|error| {
                session_persistence_error(
                    "SESSION_MEDIA_SCOPE_FAILED",
                    format!("无法授权会话工具图片预览：{error}"),
                )
            })?;
    }
    let path = session_journal_path(&app, &id)
        .map_err(|error| session_persistence_error("SESSION_JOURNAL_READ_FAILED", error))?;
    let source = if path.is_file() {
        path
    } else {
        let legacy = legacy_session_cache_path(&app, &id)
            .map_err(|error| session_persistence_error("SESSION_JOURNAL_READ_FAILED", error))?;
        if !legacy.is_file() {
            return Ok(None);
        }
        legacy
    };
    SessionJournalStore
        .read(&source, &id, SESSION_JOURNAL_MAX_BYTES)
        .map_err(|error| session_persistence_error("SESSION_JOURNAL_READ_FAILED", error))
}

fn session_persistence_error(code: &'static str, error: String) -> HostError {
    HostError::recoverable_environment(
        code,
        error,
        "检查应用数据目录权限、可用空间和磁盘健康后重试；Host 不会覆盖损坏数据",
    )
}

#[tauri::command]
fn write_session_journal(
    app: tauri::AppHandle,
    storage: tauri::State<'_, SessionStorageState>,
    state: tauri::State<'_, Arc<AcpState>>,
    id: String,
    content: String,
) -> Result<(), HostError> {
    safe_session_storage_id(&id)
        .map_err(|error| HostError::operation("SESSION_ID_INVALID", error))?;
    let _write = storage
        .begin_write(&id)
        .map_err(|error| HostError::operation("SESSION_STORAGE_REJECTED", error))?;
    let path = session_journal_path(&app, &id)
        .map_err(|error| session_persistence_error("SESSION_JOURNAL_WRITE_FAILED", error))?;
    let legacy = legacy_session_cache_path(&app, &id)
        .map_err(|error| session_persistence_error("SESSION_JOURNAL_WRITE_FAILED", error))?;
    let metadata = SessionJournalStore.write(
        &path,
        &legacy,
        &id,
        &content,
        SESSION_JOURNAL_MAX_BYTES,
    )
    .map_err(|error| match error {
        SessionJournalWriteError::InvalidIncoming(message) => {
            HostError::protocol("SESSION_JOURNAL_INVALID", message)
        }
        SessionJournalWriteError::Conflict(message) => {
            HostError::operation("SESSION_JOURNAL_CONFLICT", message)
        }
        SessionJournalWriteError::Storage(message) => {
            session_persistence_error("SESSION_JOURNAL_WRITE_FAILED", message)
        }
    })?;
    if let Some(host_events) = metadata.host_events {
        let acknowledged = state.session_events.acknowledge_session_events(
            &host_events.stream_id,
            &id,
            &host_events.sequences,
        );
        tracing::debug!(
            target: "grox::session_events",
            session_id = %id,
            saved_at = metadata.saved_at,
            requested = host_events.sequences.len(),
            acknowledged,
            "application journal advanced Host event durability"
        );
    }
    Ok(())
}

fn delete_session_journal_files(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let dir = session_journal_dir(app, id)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|error| format!("无法删除应用会话目录：{error}"))?;
    }
    let legacy = legacy_session_cache_path(app, id)?;
    if legacy.is_file() {
        fs::remove_file(&legacy).map_err(|error| format!("无法删除旧版会话缓存：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_session_journal(
    app: tauri::AppHandle,
    storage: tauri::State<'_, SessionStorageState>,
    id: String,
) -> Result<(), HostError> {
    safe_session_storage_id(&id)
        .map_err(|error| HostError::operation("SESSION_ID_INVALID", error))?;
    let _delete = storage
        .begin_delete(&id)
        .map_err(|error| HostError::operation("SESSION_STORAGE_REJECTED", error))?;
    delete_session_journal_files(&app, &id)
        .map_err(|error| session_persistence_error("SESSION_JOURNAL_DELETE_FAILED", error))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionJournalStatus {
    count: u32,
    total_bytes: u64,
    latest_saved_at: Option<u64>,
    migration_pending: u32,
    unreadable_count: u32,
}

fn add_journal_status(path: &Path, status: &mut SessionJournalStatus) {
    if !path.is_file() {
        return;
    }
    status.count += 1;
    if let Ok(metadata) = path.metadata() {
        status.total_bytes = status.total_bytes.saturating_add(metadata.len());
    }
    let saved_at = read_bounded_text(path, SESSION_JOURNAL_MAX_BYTES)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| {
            value
                .get("savedAt")
                .or_else(|| value.get("updatedAt"))
                .and_then(serde_json::Value::as_u64)
        });
    match saved_at {
        Some(saved_at) => {
            status.latest_saved_at = Some(status.latest_saved_at.unwrap_or(0).max(saved_at));
        }
        None => status.unreadable_count += 1,
    }
}

fn session_journal_status_inner(app: tauri::AppHandle) -> Result<SessionJournalStatus, String> {
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用会话目录：{error}"))?;
    let mut status = SessionJournalStatus {
        count: 0,
        total_bytes: 0,
        latest_saved_at: None,
        migration_pending: 0,
        unreadable_count: 0,
    };
    let sessions = config.join("sessions");
    if sessions.is_dir() {
        for entry in fs::read_dir(&sessions)
            .map_err(|error| format!("无法读取应用会话目录 {}：{error}", sessions.display()))?
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.is_dir() {
                add_journal_status(&path.join("journal.json"), &mut status);
            }
        }
    }
    let legacy = config.join("session-cache");
    if legacy.is_dir() {
        for entry in fs::read_dir(&legacy)
            .map_err(|error| format!("无法读取旧版会话缓存目录 {}：{error}", legacy.display()))?
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
                status.migration_pending += 1;
                add_journal_status(&path, &mut status);
            }
        }
    }
    Ok(status)
}

#[tauri::command]
fn session_journal_status(app: tauri::AppHandle) -> Result<SessionJournalStatus, HostError> {
    session_journal_status_inner(app)
        .map_err(|error| session_persistence_error("SESSION_JOURNAL_STATUS_FAILED", error))
}


fn drafts_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("drafts.json"))
        .map_err(|error| format!("无法定位草稿文件：{error}"))
}

fn draft_workspace(cwd: &str, scope: Option<&str>) -> Result<String, HostError> {
    let workspace = checked_workspace(cwd)
        .map(|path| path_for_webview(&path))
        .map_err(|error| HostError::operation("DRAFT_WORKSPACE_INVALID", error))?;
    let Some(scope) = scope.filter(|value| !value.is_empty()) else {
        return Ok(workspace);
    };
    if scope.len() > 32
        || !scope
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(HostError::operation(
            "DRAFT_SCOPE_INVALID",
            "草稿作用域无效",
        ));
    }
    Ok(format!("scope:{scope}:{workspace}"))
}

fn draft_storage_error(error: String) -> HostError {
    HostError::recoverable_environment(
        "DRAFT_STORAGE_FAILED",
        error,
        "检查应用数据目录权限；不要关闭当前页面，以免丢失尚未发送的内容",
    )
}

fn draft_store_error(error: DraftStoreError) -> HostError {
    match error {
        DraftStoreError::Conflict(message) => {
            HostError::operation("DRAFT_WRITE_CONFLICT", message)
        }
        DraftStoreError::Invalid(message) => HostError::operation("DRAFT_INVALID", message),
        DraftStoreError::Storage(message) => draft_storage_error(message),
    }
}

#[tauri::command]
fn read_draft(
    app: tauri::AppHandle,
    drafts: tauri::State<'_, DraftStore>,
    cwd: String,
    scope: Option<String>,
) -> Result<DraftSnapshot, HostError> {
    let workspace = draft_workspace(&cwd, scope.as_deref())?;
    let path = drafts_path(&app).map_err(draft_storage_error)?;
    drafts
        .read(&path, &workspace)
        .map_err(draft_store_error)
}

#[tauri::command]
fn write_draft(
    app: tauri::AppHandle,
    drafts: tauri::State<'_, DraftStore>,
    cwd: String,
    scope: Option<String>,
    expected_revision: u64,
    text: String,
    attachments: Vec<DraftAttachment>,
) -> Result<DraftSnapshot, HostError> {
    let workspace = draft_workspace(&cwd, scope.as_deref())?;
    let path = drafts_path(&app).map_err(draft_storage_error)?;
    drafts
        .write(
            &path,
            &workspace,
            expected_revision,
            text,
            attachments,
        )
        .map_err(draft_store_error)
}

#[tauri::command]
fn delete_draft(
    app: tauri::AppHandle,
    drafts: tauri::State<'_, DraftStore>,
    cwd: String,
    scope: Option<String>,
    expected_revision: u64,
) -> Result<DraftSnapshot, HostError> {
    let workspace = draft_workspace(&cwd, scope.as_deref())?;
    let path = drafts_path(&app).map_err(draft_storage_error)?;
    drafts
        .delete(&path, &workspace, expected_revision)
        .map_err(draft_store_error)
}

#[tauri::command]
fn read_prompt_queues(
    app: tauri::AppHandle,
    queues: tauri::State<'_, PromptQueueStore>,
) -> Result<Option<String>, HostError> {
    let path = prompt_queues_path(&app)
        .map_err(|error| session_persistence_error("PROMPT_QUEUE_READ_FAILED", error))?;
    queues
        .read(&path, PROMPT_QUEUES_MAX_BYTES)
        .map_err(|error| session_persistence_error("PROMPT_QUEUE_READ_FAILED", error))
}

#[tauri::command]
fn patch_prompt_queues(
    app: tauri::AppHandle,
    queues: tauri::State<'_, PromptQueueStore>,
    storage: tauri::State<'_, SessionStorageState>,
    upserts: BTreeMap<String, serde_json::Value>,
    deletes: Vec<String>,
) -> Result<(), HostError> {
    let upsert_ids = upserts.keys().cloned().collect::<Vec<_>>();
    let patch_ids = upsert_ids
        .iter()
        .chain(deletes.iter())
        .cloned()
        .collect::<Vec<_>>();
    for id in &patch_ids {
        safe_session_storage_id(id)
            .map_err(|error| HostError::operation("SESSION_ID_INVALID", error))?;
    }
    // 与删除命令采用相同锁序：先 tombstone，再队列事务，防止延迟 patch 复活。
    let _write = storage
        .begin_write_ids(&patch_ids)
        .map_err(|error| HostError::operation("PROMPT_QUEUE_PATCH_REJECTED", error))?;
    let path = prompt_queues_path(&app)
        .map_err(|error| session_persistence_error("PROMPT_QUEUE_WRITE_FAILED", error))?;
    queues
        .patch(&path, upserts, deletes, PROMPT_QUEUES_MAX_BYTES)
        .map_err(|error| session_persistence_error("PROMPT_QUEUE_WRITE_FAILED", error))
}



#[tauri::command]
fn read_automations(
    app: tauri::AppHandle,
    automations: tauri::State<'_, AutomationStore>,
) -> Result<Option<String>, HostError> {
    let path = automations_path(&app)
        .map_err(|error| session_persistence_error("AUTOMATION_READ_FAILED", error))?;
    automations
        .read(&path, AUTOMATIONS_MAX_BYTES)
        .map_err(|error| session_persistence_error("AUTOMATION_READ_FAILED", error))
}

#[tauri::command]
fn patch_automations(
    app: tauri::AppHandle,
    automations: tauri::State<'_, AutomationStore>,
    worktrees: tauri::State<'_, WorktreeOwnershipStore>,
    upserts: Vec<serde_json::Value>,
    deletes: Vec<String>,
) -> Result<(), HostError> {
    // cwd 变更与 worktree 删除串行；否则删除检查完成后，一个页面 patch
    // 可能把自动化重新指向即将消失的目录。
    let _worktree_lifecycle = worktrees.lock_lifecycle();
    let path = automations_path(&app)
        .map_err(|error| session_persistence_error("AUTOMATION_WRITE_FAILED", error))?;
    automations
        .patch(&path, upserts, deletes, AUTOMATIONS_MAX_BYTES)
        .map_err(|error| session_persistence_error("AUTOMATION_WRITE_FAILED", error))
}


#[tauri::command]
async fn agent_runtime_resume(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    generation: u64,
) -> Result<(), AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    state.resume_runtime(generation).await
}

#[tauri::command]
async fn agent_runtime_pause(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<(), AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    state.pause_runtime().await
}

#[tauri::command]
async fn automation_runner_status(
    state: tauri::State<'_, Arc<AcpState>>,
    runner: tauri::State<'_, AutomationRunner>,
) -> Result<automation_runner::AutomationRunnerStatus, AcpHostError> {
    Ok(runner.status(state.inner()).await)
}

#[tauri::command]
async fn run_automation_now(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    runner: tauri::State<'_, AutomationRunner>,
    automations: tauri::State<'_, AutomationStore>,
    id: String,
) -> Result<(), AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    runner.reserve_dispatch(state.inner()).await?;
    let now_ms = automation_runner::unix_time_ms();
    let path = match automations_path(&app).map_err(automation_storage_error) {
        Ok(path) => path,
        Err(error) => {
            runner.release_dispatch();
            return Err(error);
        }
    };
    let dispatch = match automations
        .claim_now(&path, &id, now_ms, AUTOMATIONS_MAX_BYTES)
        .map_err(automation_claim_error)
    {
        Ok(dispatch) => dispatch,
        Err(error) => {
            runner.release_dispatch();
            return Err(error);
        }
    };
    runner.launch_reserved(app, dispatch);
    Ok(())
}

#[tauri::command]
fn delete_session_data(
    app: tauri::AppHandle,
    storage: tauri::State<'_, SessionStorageState>,
    queues: tauri::State<'_, PromptQueueStore>,
    worktrees: tauri::State<'_, WorktreeOwnershipStore>,
    id: String,
) -> Result<bool, String> {
    if !valid_session_id(&id) {
        return Err("无效会话 ID".into());
    }
    let _delete = storage.begin_delete(&id)?;
    let history = grok_home().and_then(|home| delete_session_history_data(&home, &id));
    let journal = delete_session_journal_files(&app, &id);
    let queue = prompt_queues_path(&app).and_then(|path| {
        queues.delete_sessions(&path, std::slice::from_ref(&id), PROMPT_QUEUES_MAX_BYTES)
    });
    let removed = history.as_ref().copied().unwrap_or(false);
    let mut errors = Vec::new();
    if let Err(error) = history {
        errors.push(error);
    }
    if let Err(error) = journal {
        errors.push(format!("无法删除应用会话 journal：{error}"));
    }
    if let Err(error) = queue {
        errors.push(format!("无法删除会话提示队列：{error}"));
    }
    if errors.is_empty() {
        let binding_path = worktree_bindings_path(&app)?;
        if let Err(error) = worktrees.delete_sessions(&binding_path, std::slice::from_ref(&id)) {
            errors.push(format!("无法解除会话 worktree 关联：{error}"));
        }
    }
    if errors.is_empty() {
        Ok(removed)
    } else {
        Err(errors.join("；"))
    }
}

#[tauri::command]
fn delete_project_session_data(
    app: tauri::AppHandle,
    storage: tauri::State<'_, SessionStorageState>,
    queues: tauri::State<'_, PromptQueueStore>,
    worktrees: tauri::State<'_, WorktreeOwnershipStore>,
    cwd: String,
) -> Result<Vec<String>, String> {
    let (history_ids, directories) = project_session_history_data(&grok_home()?, &cwd)?;
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用会话目录：{error}"))?;
    let mut ids = history_ids.into_iter().collect::<BTreeSet<_>>();
    // CLI 历史可能已被外部清理，但 Grox journal 仍能在冷启动时恢复侧栏。
    // 这些孤儿会话必须和 CLI 会话进入同一 tombstone 事务。
    ids.extend(worktree_ownership::journal_session_references(
        &config,
        Path::new(&cwd),
    )?);
    let ids = ids.into_iter().collect::<Vec<_>>();
    // 先写 tombstone 并等待所有旧 writer 退出，再删任何目录。否则 journal
    // 可在项目目录被删除后、门禁建立前重建会话，导致“删除后复活”。
    let _delete = storage.begin_delete_ids(&ids)?;
    let mut errors = Vec::new();
    for directory in directories {
        if let Err(error) = fs::remove_dir_all(&directory) {
            errors.push(format!("无法删除项目会话历史 {}：{error}", directory.display()));
        }
    }
    for id in &ids {
        if let Err(error) = delete_session_journal_files(&app, id) {
            errors.push(format!("无法删除会话 {id} 的应用 journal：{error}"));
        }
    }
    match prompt_queues_path(&app) {
        Ok(path) => {
            if let Err(error) = queues.delete_sessions(&path, &ids, PROMPT_QUEUES_MAX_BYTES) {
                errors.push(format!("无法删除项目会话提示队列：{error}"));
            }
        }
        Err(error) => errors.push(format!("无法定位项目会话提示队列：{error}")),
    }
    // 任意存储清理失败时保留 worktree 引用，防止用户继续删除可能
    // 仍含会话数据的工作树。
    if errors.is_empty() {
        match worktree_bindings_path(&app) {
            Ok(path) => {
                if let Err(error) = worktrees.delete_sessions(&path, &ids) {
                    errors.push(format!("无法解除项目会话 worktree 关联：{error}"));
                }
            }
            Err(error) => errors.push(format!("无法定位 worktree 会话索引：{error}")),
        }
    }
    if errors.is_empty() {
        Ok(ids)
    } else {
        Err(errors.join("；"))
    }
}

fn scrub_session_journal_dirs(app: &tauri::AppHandle, minimum_age: Duration) -> Result<u32, String> {
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用会话目录：{error}"))?;
    let mut removed = 0;
    let legacy = config.join("session-cache");
    if legacy.is_dir() {
        removed += scrub_atomic_write_orphans(&legacy, minimum_age);
    }
    let sessions = config.join("sessions");
    if sessions.is_dir() {
        for entry in fs::read_dir(&sessions)
            .map_err(|error| format!("无法读取应用会话目录 {}：{error}", sessions.display()))?
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.is_dir() {
                removed += scrub_atomic_write_orphans(&path, minimum_age);
            }
        }
    }
    Ok(removed)
}

#[tauri::command]
fn scrub_session_journal_orphans(app: tauri::AppHandle) -> Result<u32, String> {
    scrub_session_journal_dirs(&app, Duration::from_secs(0))
}



fn env_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}


fn config_overlay_metadata_from(
    inline: Option<std::ffi::OsString>,
    path: Option<std::ffi::OsString>,
) -> ConfigOverlayMetadata {
    if inline
        .as_ref()
        .and_then(|value| value.to_str())
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value.trim()).ok())
        .and_then(|value| value.as_object().cloned())
        .is_some_and(|value| !value.is_empty())
    {
        return ConfigOverlayMetadata {
            source: "inline",
            path: None,
        };
    }
    if let Some(path) = path.filter(|value| !value.is_empty()) {
        return ConfigOverlayMetadata {
            source: "path",
            path: Some(path_for_webview(Path::new(&path))),
        };
    }
    ConfigOverlayMetadata {
        source: "none",
        path: None,
    }
}

fn config_overlay_metadata() -> ConfigOverlayMetadata {
    config_overlay_metadata_from(
        std::env::var_os("GROK_CONFIG"),
        std::env::var_os("GROK_CONFIG_PATH"),
    )
}

/// Start every CLI child from a clean provider environment, then add only the
/// provider explicitly selected in Grox.
///
/// 路由完全由 config.toml 的 `[model.*]` 段和 `[models] default` 表达。
/// `GROK_MODELS_BASE_URL` 是 CLI 的另一套全局路由机制，两套并存意味着同一件
/// 事有两个真相源、会互相矛盾；这里只保留前者，环境里仅注入凭据。





/// Resolve a path the user themselves supplied in the composer. This does not
/// change the agent's filesystem authority: only image files explicitly named
/// in a message become that message's multimodal attachments.
fn checked_explicit_prompt_image(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("图片路径不能为空".into());
    }
    let candidate = if requested == "~" || requested.starts_with("~/") || requested.starts_with("~\\") {
        let home = user_home()?;
        if requested == "~" {
            home
        } else {
            home.join(&requested[2..])
        }
    } else {
        let path = if requested
            .get(..5)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
        {
            url::Url::parse(requested)
                .map_err(|error| format!("无效 file:// 图片路径：{error}"))?
                .to_file_path()
                .map_err(|_| "file:// 图片路径必须指向本地文件".to_string())?
        } else {
            PathBuf::from(requested)
        };
        if path.is_absolute() {
            path
        } else {
            workspace.join(path)
        }
    };
    if !candidate.exists() {
        return Err(format!("图片路径不存在：{}", candidate.display()));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析图片路径 {}：{error}", candidate.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("无法读取图片 {}：{error}", canonical.display()))?;
    if !metadata.is_file() {
        return Err("图片路径必须指向文件".into());
    }
    if metadata.len() > MAX_PROMPT_IMAGE_BYTES {
        return Err("单张图片不能超过 16 MB".into());
    }
    let bytes = fs::read(&canonical)
        .map_err(|error| format!("无法读取图片 {}：{error}", canonical.display()))?;
    if prompt_image_mime(&bytes).is_none() {
        return Err("图片内容不是受支持的 PNG、JPG、GIF、WebP 或 BMP 格式".into());
    }
    Ok(canonical)
}

fn preview_type(path: &Path) -> (&'static str, &'static str) {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" | "mdx" => ("markdown", "text/markdown"),
        "html" | "htm" => ("html", "text/html"),
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "svg" => ("image", "image/svg+xml"),
        "bmp" => ("image", "image/bmp"),
        "mp4" | "m4v" => ("video", "video/mp4"),
        "webm" => ("video", "video/webm"),
        "mov" => ("video", "video/quicktime"),
        "mp3" => ("audio", "audio/mpeg"),
        "m4a" => ("audio", "audio/mp4"),
        "wav" => ("audio", "audio/wav"),
        "ogg" | "oga" => ("audio", "audio/ogg"),
        "flac" => ("audio", "audio/flac"),
        "pdf" => ("pdf", "application/pdf"),
        "txt" | "log" | "json" | "jsonl" | "toml" | "yaml" | "yml" | "xml" | "css" | "js"
        | "jsx" | "ts" | "tsx" | "rs" | "py" | "go" | "java" | "c" | "h" | "cpp" | "hpp" | "sh"
        | "ps1" => ("text", "text/plain"),
        _ => ("unsupported", "application/octet-stream"),
    }
}

fn collect_workspace_entries(root: &Path, dir: &Path, output: &mut Vec<WorkspaceEntry>) {
    if output.len() >= MAX_WORKSPACE_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| (!entry.path().is_dir(), entry.file_name()));
    for entry in entries {
        if output.len() >= MAX_WORKSPACE_ENTRIES {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = file_type.is_dir();
        if is_dir
            && matches!(
                name.as_str(),
                ".git" | "node_modules" | "target" | "dist" | ".pnpm-store"
            )
        {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path);
        output.push(WorkspaceEntry {
            path: relative.to_string_lossy().replace('\\', "/"),
            name,
            is_dir,
        });
        if is_dir {
            collect_workspace_entries(root, &path, output);
        }
    }
}











#[tauri::command]
fn read_prompt_image_paths(cwd: String, paths: Vec<String>) -> Result<Vec<PromptPathImage>, String> {
    if paths.len() > 8 {
        return Err("每次最多附加 8 张路径图片".into());
    }
    let workspace = checked_workspace(&cwd)?;
    let mut images = Vec::with_capacity(paths.len());
    let mut seen = std::collections::BTreeSet::new();
    let mut total_size = 0_u64;
    for requested in paths {
        let file = match checked_explicit_prompt_image(&workspace, &requested) {
            // Paths occurring in normal prose often name an output the model
            // should create. Do not turn a missing file into a send-blocking
            // error; existing, explicit image paths are still attached.
            Err(error) if error.starts_with("图片路径不存在：") => continue,
            result => result?,
        };
        let path = path_for_webview(&file);
        if !seen.insert(path.clone()) {
            continue;
        }
        let bytes = fs::read(&file)
            .map_err(|error| format!("无法读取图片 {}：{error}", file.display()))?;
        let size = bytes.len() as u64;
        if size > MAX_PROMPT_IMAGE_BYTES {
            return Err("单张图片不能超过 16 MB".into());
        }
        total_size = total_size.saturating_add(size);
        if total_size > MAX_PROMPT_IMAGE_TOTAL_BYTES {
            return Err("路径图片总大小不能超过 32 MB".into());
        }
        let mime = prompt_image_mime(&bytes)
            .ok_or_else(|| "图片内容不是受支持的图片格式".to_string())?;
        images.push(PromptPathImage {
            path,
            name: file
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("image")
                .to_string(),
            mime: mime.to_string(),
            size,
            data: BASE64.encode(bytes),
        });
    }
    Ok(images)
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchProviderModels {
    api_key: String,
    base_url: String,
    #[serde(default)]
    allow_insecure_http: bool,
}

#[tauri::command]
fn grok_runtime_info(_app: tauri::AppHandle) -> GrokRuntimeInfo {
    configured_grok_command()
}

#[tauri::command]
async fn export_session_trace(app: tauri::AppHandle, session_id: String) -> Result<String, String> {
    export_official_session_trace(&app, &session_id)
        .await
        .map(|path| path_for_webview(&path))
}

async fn export_official_session_trace(
    _app: &tauri::AppHandle,
    session_id: &str,
) -> Result<PathBuf, String> {
    let session_id = session_id.trim();
    safe_session_storage_id(session_id)?;
    let runtime = configured_grok_command();
    let mut command = Command::new(&runtime.path);
    command.args(["trace", session_id, "--local", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "官方会话 trace 导出超过 30 秒".to_string())?
        .map_err(|error| format!("无法启动会话诊断导出：{error}"))?;
    if !output.status.success() {
        return Err(format!("会话诊断导出失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("无法解析会话诊断导出结果：{error}"))?;
    let path = value.get("path")
        .or_else(|| value.get("outputPath"))
        .or_else(|| value.get("local_path"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "会话诊断已导出，但官方 CLI 未返回文件路径".to_string())?;
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err(format!("官方 CLI 返回的会话诊断不存在：{}", path.display()));
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSupportExport {
    path: String,
    official_trace_included: bool,
    official_trace_error: Option<String>,
}

fn support_path(value: &str) -> String {
    let path = Path::new(value);
    if let Ok(home) = user_home() {
        if let Ok(relative) = path.strip_prefix(home) {
            return format!("$HOME/{}", relative.to_string_lossy().replace('\\', "/"));
        }
    }
    value.replace('\\', "/")
}

fn selected_session_journal_diagnostic(app: &tauri::AppHandle, id: &str) -> serde_json::Value {
    match read_session_journal(app.clone(), id.to_string()) {
        Ok(Some(raw)) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(value) => {
                let session = value.get("session").unwrap_or(&value);
                serde_json::json!({
                    "readable": true,
                    "version": value.get("version").and_then(serde_json::Value::as_u64).unwrap_or(0),
                    "appSessionId": value.get("appSessionId").and_then(serde_json::Value::as_str).unwrap_or(id),
                    "agentSessionId": value.get("agentSessionId").and_then(serde_json::Value::as_str).unwrap_or(id),
                    "savedAt": value.get("savedAt").or_else(|| value.get("updatedAt")),
                    "turnState": value.get("turnState").and_then(serde_json::Value::as_str).unwrap_or("legacy-settled"),
                    "sessionStatus": session.get("status"),
                    "blockCount": session.get("blocks").and_then(serde_json::Value::as_array).map(Vec::len),
                })
            }
            Err(error) => serde_json::json!({ "readable": false, "error": error.to_string() }),
        },
        Ok(None) => serde_json::json!({ "readable": true, "missing": true }),
        Err(error) => serde_json::json!({ "readable": false, "error": error }),
    }
}

#[tauri::command]
async fn export_session_support_bundle(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
    automation_runner: tauri::State<'_, AutomationRunner>,
    drafts: tauri::State<'_, DraftStore>,
    session_id: String,
    client_snapshot: String,
) -> Result<SessionSupportExport, String> {
    let session_id = session_id.trim().to_string();
    safe_session_storage_id(&session_id)?;
    if client_snapshot.len() > 256 * 1024 {
        return Err("客户端诊断快照不能超过 256 KB".into());
    }
    let client = serde_json::from_str::<serde_json::Value>(&client_snapshot)
        .map_err(|error| format!("客户端诊断快照必须是 JSON：{error}"))?;
    if !client.is_object() {
        return Err("客户端诊断快照必须是 JSON 对象".into());
    }

    let runtime_info = configured_grok_command();
    let worktree_ownership = match worktree_bindings_path(&app).and_then(|path| {
        app.state::<WorktreeOwnershipStore>().count(&path)
    }) {
        Ok(count) => serde_json::json!({ "readable": true, "sessionBindings": count }),
        Err(error) => serde_json::json!({ "readable": false, "error": error }),
    };
    let process = {
        let guard = state.process.lock().await;
        guard.as_ref().map(|process| {
            serde_json::json!({
                "running": true,
                "generation": process.generation,
                "pid": process.child.id(),
            })
        })
    };
    let runtime = serde_json::json!({
        "topology": "shared_process",
        "processCapacity": 1,
        "sessionCapacity": "shared_unbounded",
        "process": process.unwrap_or_else(|| serde_json::json!({ "running": false })),
        "nextGeneration": state.next_generation.load(Ordering::Relaxed),
        "pendingRequests": state.requests.len().await,
        "pendingInteractions": state.interactions.snapshots().len(),
        "pendingClientCallbacks": state.client_callbacks.pending_len(),
        "boundClientSessions": state.client_callbacks.bound_len(),
        "activeTerminals": state.client_callbacks.terminal_len().await,
        "automaticReconnectActive": state.automatic_reconnect_owner.load(Ordering::Acquire) != 0,
        "lastConnectConfigured": state.last_connect().is_some(),
        "worktreeOwnership": worktree_ownership,
        "sessionOccupancy": state.sessions.snapshot(),
        "sessionEventStream": state.session_events.status(),
        "hostLogging": host_logging::status(),
        "automationRunner": automation_runner.status(state.inner()).await,
        "cli": {
            "path": support_path(&runtime_info.path),
            "source": runtime_info.source,
            "version": runtime_info.version,
            "selectionRequired": runtime_info.selection_required,
        },
    });
    let journal = serde_json::json!({
        "selected": selected_session_journal_diagnostic(&app, &session_id),
        "summary": session_journal_status_inner(app.clone())?,
    });
    let draft_storage = match drafts_path(&app).and_then(|path| {
        drafts
            .status(&path)
            .map(|(active, tracked, bytes)| (active, tracked, bytes))
            .map_err(DraftStoreError::into_message)
    }) {
        Ok((active, tracked, bytes)) => serde_json::json!({
            "readable": true,
            "activeDrafts": active,
            "trackedWorkspaces": tracked,
            "bytes": bytes,
            "maxBytes": DRAFTS_MAX_BYTES,
        }),
        Err(error) => serde_json::json!({ "readable": false, "error": error }),
    };
    let permission_audit =
        match permission_audit::read_session(&host_prefs_dir_for_app(&app), &session_id) {
            Ok(entries) => serde_json::json!({ "readable": true, "entries": entries }),
            Err(error) => serde_json::json!({ "readable": false, "error": error }),
        };

    let trace = export_official_session_trace(&app, &session_id).await;
    let (trace_path, trace_error) = match trace {
        Ok(path) => (Some(path), None),
        Err(error) => (None, Some(error)),
    };
    let meta = serde_json::json!({
        "kind": "grox_session_support_bundle",
        "appVersion": CLIENT_VERSION,
        "generatedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "sessionId": session_id,
        "draftStorage": draft_storage,
        "mediaJobStorage": media_journal_status(app.state::<Arc<MediaService>>().inner()),
        "officialTraceIncluded": trace_path.is_some(),
        "officialTraceError": trace_error,
    });
    let path = support_bundle::write_session_support_bundle(
        support_bundle::SessionSupportBundle {
            session_id: &session_id,
            meta,
            runtime,
            journal,
            permission_audit,
            client,
            host_log: host_logging::recent_redacted_tail(),
            official_trace: trace_path.as_deref(),
        },
    )?;
    Ok(SessionSupportExport {
        path: path_for_webview(&path),
        official_trace_included: trace_path.is_some(),
        official_trace_error: trace_error,
    })
}

#[tauri::command]
fn reveal_support_bundle(path: String) -> Result<(), String> {
    let file = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("无法定位支持包：{error}"))?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|error| format!("无法定位临时目录：{error}"))?;
    let name = file.file_name().and_then(|value| value.to_str()).unwrap_or_default();
    if !file.starts_with(&temp)
        || !file.is_file()
        || !name.starts_with("Grox-session-support-")
        || file.extension().and_then(|value| value.to_str()) != Some("zip")
    {
        return Err("拒绝显示非 Grox 会话支持包".into());
    }
    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg("/select,")
        .arg(&file)
        .spawn()
        .map_err(|error| format!("无法打开资源管理器：{error}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(&file)
        .spawn()
        .map_err(|error| format!("无法在 Finder 中显示支持包：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(file.parent().unwrap_or(&file))
        .spawn()
        .map_err(|error| format!("无法打开文件管理器：{error}"))?;
    Ok(())
}

fn is_trusted_cli_install_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "x.ai"
        || host == "www.x.ai"
        || host.ends_with(".x.ai")
        || host == "cdn.x.ai"
}

async fn download_official_install_script(script_url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(script_url).map_err(|error| format!("无效安装地址：{error}"))?;
    if parsed.scheme() != "https" || !is_trusted_cli_install_host(parsed.host_str()) {
        return Err("官方安装脚本必须来自受信任的 x.ai HTTPS 地址".into());
    }
    let response = reqwest::Client::builder()
        .user_agent(format!("Grox/{CLIENT_VERSION}"))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https"
                && is_trusted_cli_install_host(attempt.url().host_str())
            {
                attempt.follow()
            } else {
                attempt.error(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "官方安装脚本重定向到了不受信任的主机",
                ))
            }
        }))
        .build()
        .map_err(|error| format!("无法创建安装客户端：{error}"))?
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("无法下载官方安装脚本：{error}"))?
        .error_for_status()
        .map_err(|error| format!("官方安装脚本下载失败：{error}"))?;
    let script_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("无法读取官方安装脚本：{error}"))?;
    if script_bytes.is_empty() || script_bytes.len() > 2 * 1024 * 1024 {
        return Err("官方安装脚本大小异常".into());
    }
    let script_text = String::from_utf8(script_bytes.to_vec())
        .map_err(|_| "官方安装脚本不是合法 UTF-8 文本".to_string())?;
    let looks_like_installer = if cfg!(windows) {
        (script_text.contains("grok") || script_text.contains("Grok"))
            && (script_text.contains("xAI")
                || script_text.contains("x.ai")
                || script_text.contains("Invoke-WebRequest")
                || script_text.contains("iwr"))
    } else {
        script_text.contains("#!/")
            && (script_text.contains("grok") || script_text.contains("Grok"))
            && (script_text.contains("x.ai") || script_text.contains("curl") || script_text.contains("wget"))
    };
    if !looks_like_installer {
        return Err("官方安装脚本内容未通过基本校验，已取消执行".into());
    }
    Ok(script_text)
}

#[tauri::command]
async fn install_official_grok_cli(
    _app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<GrokRuntimeInfo, String> {
    // Windows cannot replace a running executable. Stop the official CLI
    // child before invoking its official updater; the webview reload below
    // starts the freshly installed binary again.
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
    state.authentication.reset(AcpHostError::environment(
        "AUTH_RUNTIME_CHANGED",
        "CLI 更新取消了正在进行的登录",
        false,
        false,
        "CLI 更新完成后重新登录",
    ));
    state.foreground_turns.reset(generation);
    state.interactions.reset(generation);
    state.client_callbacks.reset(generation).await;
    state.sessions.reset(generation);
    state
        .requests
        .reject_all(AcpHostError::environment(
            "ACP_CLI_UPDATING",
            "Grok CLI 正在更新，当前 ACP 请求已停止",
            true,
            true,
            "更新结束后重新连接 Agent，并检查最后一轮结果",
        ))
        .await;
    if let Some(process) = state.process.lock().await.take() {
        terminate_process(process).await;
    }

    let script_url = if cfg!(windows) {
        GROK_INSTALL_PS1_URL
    } else if cfg!(target_os = "macos") {
        GROK_INSTALL_SH_URL
    } else {
        return Err("Grox 当前仅支持在 Windows 和 macOS 上自动安装 CLI".into());
    };
    let script_text = download_official_install_script(script_url).await?;

    let work = std::env::temp_dir().join(format!(
        "grox-cli-install-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::create_dir_all(&work).map_err(|error| format!("无法创建安装临时目录：{error}"))?;
    let script_path = work.join(if cfg!(windows) {
        "install-official-cli.ps1"
    } else {
        "install-official-cli.sh"
    });
    fs::write(&script_path, script_text.as_bytes())
        .map_err(|error| format!("无法保存官方安装脚本：{error}"))?;

    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        command.arg(&script_path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("/bin/bash");
        command.arg(&script_path);
        command
    } else {
        return Err("Grox 当前仅支持在 Windows 和 macOS 上自动安装 CLI".into());
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let status = tokio::time::timeout(Duration::from_secs(300), command.status())
        .await
        .map_err(|_| "官方 Grok CLI 安装超过 5 分钟，已停止等待".to_string())?
        .map_err(|error| format!("无法启动官方 Grok CLI 安装程序：{error}"))?;
    let _ = fs::remove_dir_all(&work);
    if !status.success() {
        return Err(format!(
            "官方 Grok CLI 安装失败（退出码 {}）",
            status
                .code()
                .map_or_else(|| "unknown".into(), |code| code.to_string())
        ));
    }
    let runtime = configured_grok_command();
    if runtime.system_path.is_none() {
        return Err("安装程序已完成，但 Grox 尚未在标准位置检测到 grok；请重启后重试".into());
    }
    Ok(runtime)
}

fn detect_frontend(workspace: &Path) -> Option<FrontendTarget> {
    let candidates = [
        workspace.to_path_buf(),
        workspace.join("frontend"),
        workspace.join("web"),
        workspace.join("client"),
        workspace.join("apps").join("web"),
    ];
    for root in candidates {
        let package_path = root.join("package.json");
        let Ok(raw_package) = fs::read_to_string(package_path) else {
            continue;
        };
        let Ok(package) = serde_json::from_str::<serde_json::Value>(&raw_package) else {
            continue;
        };
        let Some(script) = package
            .get("scripts")
            .and_then(|scripts| scripts.get("dev"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|script| !script.is_empty())
        else {
            continue;
        };
        let script = script.to_string();
        let dependencies = package
            .get("dependencies")
            .and_then(serde_json::Value::as_object)
            .into_iter()
            .flatten()
            .chain(
                package
                    .get("devDependencies")
                    .and_then(serde_json::Value::as_object)
                    .into_iter()
                    .flatten(),
            )
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>();
        let lower = script.to_ascii_lowercase();
        if ["tauri", "electron", "react-native", "capacitor"]
            .iter()
            .any(|runtime| lower.contains(runtime))
        {
            continue;
        }
        let has = |name: &str| dependencies.iter().any(|dependency| *dependency == name);
        let (framework, port) = if lower.contains("next") || has("next") {
            ("Next.js", 3000)
        } else if lower.contains("nuxt") || has("nuxt") {
            ("Nuxt", 3000)
        } else if lower.contains("astro") || has("astro") {
            ("Astro", 4321)
        } else if lower.contains("ng serve") || has("@angular/core") {
            ("Angular", 4200)
        } else if lower.contains("react-scripts") || has("react-scripts") {
            ("Create React App", 3000)
        } else if lower.contains("vue-cli-service") || has("@vue/cli-service") {
            ("Vue CLI", 8080)
        } else if lower.contains("vite") || has("vite") {
            ("Vite", 5173)
        } else {
            continue;
        };
        let manager = if root.join("pnpm-lock.yaml").is_file()
            || workspace.join("pnpm-lock.yaml").is_file()
        {
            "pnpm"
        } else if root.join("yarn.lock").is_file() || workspace.join("yarn.lock").is_file() {
            "yarn"
        } else if root.join("bun.lock").is_file()
            || root.join("bun.lockb").is_file()
            || workspace.join("bun.lock").is_file()
            || workspace.join("bun.lockb").is_file()
        {
            "bun"
        } else {
            "npm"
        };
        return Some(FrontendTarget {
            root,
            framework: framework.to_string(),
            manager,
            port,
            script,
        });
    }
    None
}

fn preview_online(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(120)).is_ok()
}

fn preview_response(
    target: &FrontendTarget,
    status: &'static str,
    error: Option<String>,
) -> ProjectPreview {
    let url = format!("http://127.0.0.1:{}", target.port);
    ProjectPreview {
        status,
        url: Some(url),
        framework: Some(target.framework.clone()),
        command: Some(format!("{} run dev", target.manager)),
        root: Some(path_for_webview(&target.root)),
        error,
    }
}

#[tauri::command]
async fn start_project_preview(
    state: tauri::State<'_, Arc<PreviewState>>,
    cwd: String,
    start: bool,
) -> Result<ProjectPreview, String> {
    let workspace = checked_workspace(&cwd)?;
    let Some(target) = detect_frontend(&workspace) else {
        let mut guard = state.process.lock().await;
        if let Some(mut previous) = guard.take() {
            let _ = previous.child.kill().await;
            let _ = previous.child.wait().await;
        }
        return Ok(ProjectPreview {
            status: "none",
            url: None,
            framework: None,
            command: None,
            root: None,
            error: None,
        });
    };

    let mut guard = state.process.lock().await;
    if guard
        .as_ref()
        .is_some_and(|process| process.root == target.root)
    {
        let exited = guard
            .as_mut()
            .and_then(|process| process.child.try_wait().ok())
            .flatten();
        if let Some(status) = exited {
            guard.take();
            return Ok(preview_response(
                &target,
                "error",
                Some(format!(
                    "开发服务器已退出（{}）",
                    status
                        .code()
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                )),
            ));
        }
        return Ok(preview_response(
            &target,
            if preview_online(target.port) {
                "ready"
            } else {
                "starting"
            },
            None,
        ));
    }

    if let Some(mut previous) = guard.take() {
        let _ = previous.child.kill().await;
        let _ = previous.child.wait().await;
    }

    if preview_online(target.port) {
        return Ok(preview_response(&target, "ready", None));
    }
    if !start {
        return Ok(preview_response(&target, "detected", None));
    }
    if !target.root.join("node_modules").is_dir() && !workspace.join("node_modules").is_dir() {
        return Ok(preview_response(
            &target,
            "error",
            Some("检测到前端项目，但依赖尚未安装".into()),
        ));
    }

    let executable = if cfg!(windows) {
        match target.manager {
            "pnpm" => "pnpm.cmd",
            "yarn" => "yarn.cmd",
            "bun" => "bun.exe",
            _ => "npm.cmd",
        }
    } else {
        target.manager
    };
    let mut command = Command::new(executable);
    match target.manager {
        "yarn" => {
            command.arg("dev");
        }
        _ => {
            command.args(["run", "dev"]);
        }
    }
    let script = target.script.to_ascii_lowercase();
    if script.contains("vite")
        || script.contains("astro")
        || script.contains("ng serve")
        || script.contains("vue-cli-service")
    {
        if target.manager == "npm" {
            command.arg("--");
        }
        command.args(["--host", "127.0.0.1", "--port", &target.port.to_string()]);
    }
    command
        .current_dir(&target.root)
        .env("BROWSER", "none")
        .env("NO_OPEN", "1")
        .env("HOST", "127.0.0.1")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", target.port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(preview_response(
                &target,
                "error",
                Some(format!("无法启动 {}：{error}", target.manager)),
            ));
        }
    };
    let response = preview_response(&target, "starting", None);
    *guard = Some(PreviewProcess {
        child,
        root: target.root,
    });
    Ok(response)
}




#[tauri::command]
fn computer_use_env_enabled() -> bool {
    std::env::var("GROX_COMPUTER_USE")
        .ok()
        .map(|v| {
            let t = v.trim();
            t == "1" || t.eq_ignore_ascii_case("true")
        })
        .unwrap_or(false)
}

#[tauri::command]
fn host_prefs_get(app: tauri::AppHandle) -> Result<host_prefs::HostPrefs, HostError> {
    host_prefs::load_prefs(&host_prefs_dir_for_app(&app)).map_err(host_prefs_storage_error)
}

fn host_prefs_storage_error(error: String) -> HostError {
    HostError::recoverable_environment(
        "HOST_PREFS_STORAGE_FAILED",
        error,
        "检查应用数据目录的文件权限和可用空间后重试；Host 不会采用未保存的设置",
    )
}

#[tauri::command]
fn host_prefs_migrate_computer_use(
    app: tauri::AppHandle,
    fe_enabled: bool,
) -> Result<host_prefs::HostPrefs, HostError> {
    host_prefs::migrate_computer_use_from_fe(&host_prefs_dir_for_app(&app), fe_enabled)
        .map_err(host_prefs_storage_error)
}

#[tauri::command]
fn host_prefs_migrate_browser_use(
    app: tauri::AppHandle,
    fe_enabled: bool,
) -> Result<host_prefs::HostPrefs, HostError> {
    host_prefs::migrate_browser_use_from_fe(&host_prefs_dir_for_app(&app), fe_enabled)
        .map_err(host_prefs_storage_error)
}

#[tauri::command]
fn host_prefs_set_computer_use(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<host_prefs::HostPrefs, HostError> {
    let dir = host_prefs_dir_for_app(&app);
    host_prefs::set_computer_use(&dir, enabled).map_err(host_prefs_storage_error)
}

#[tauri::command]
fn host_prefs_set_browser_use(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<host_prefs::HostPrefs, HostError> {
    let dir = host_prefs_dir_for_app(&app);
    host_prefs::set_browser_use(&dir, enabled).map_err(host_prefs_storage_error)
}

#[tauri::command]
fn host_prefs_set_permission_mode(
    app: tauri::AppHandle,
    mode: String,
) -> Result<host_prefs::HostPrefs, HostError> {
    let mode = permission_policy::PermissionMode::parse(&mode)
        .ok_or_else(|| HostError::operation("PERMISSION_MODE_INVALID", "无效的权限模式"))?;
    let dir = host_prefs_dir_for_app(&app);
    host_prefs::set_permission_mode(&dir, mode, confirm_bypass_permission_mode)
        .map_err(host_prefs_storage_error)
}

fn confirm_bypass_permission_mode() -> bool {
    matches!(
        rfd::MessageDialog::new()
            .set_title("启用 Bypass / YOLO？")
            .set_description(
                "这会跳过工具审批，并同时关闭 Computer Use。仅应在完全可信的项目中启用。",
            )
            .set_level(rfd::MessageLevel::Warning)
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show(),
        rfd::MessageDialogResult::Ok
    )
}

#[tauri::command]
fn desktop_environment(app: tauri::AppHandle) -> DesktopEnvironment {
    let runtime = configured_grok_command();
    // Warm host prefs cache at first environment probe.
    if let Err(error) = host_prefs::load_prefs(&host_prefs_dir_for_app(&app)) {
        tracing::error!(target: "grox::preferences", error = %error, "Host preferences warmup failed");
    }
    DesktopEnvironment {
        default_workspace: path_for_webview(&default_workspace()),
        grok_command: path_for_webview(Path::new(&runtime.path)),
        app_version: CLIENT_VERSION.to_string(),
    }
}

#[tauri::command]
fn validate_workspace(cwd: String) -> Result<String, String> {
    checked_workspace(&cwd).map(|path| path_for_webview(&path))
}

#[tauri::command]
fn pick_workspace() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("选择 Grox 项目")
        .pick_folder()
        .map(|path| path_for_webview(&path))
}

#[tauri::command]
fn list_workspace_files(cwd: String) -> Result<Vec<WorkspaceEntry>, String> {
    let root = checked_workspace(&cwd)?;
    let mut output = Vec::new();
    collect_workspace_entries(&root, &root, &mut output);
    Ok(output)
}




fn text_file_line_count(path: &Path) -> u64 {
    let Ok(mut file) = fs::File::open(path) else {
        return 0;
    };
    let mut buffer = [0_u8; 16 * 1024];
    let mut lines = 0_u64;
    let mut has_content = false;
    let mut ends_with_newline = false;
    loop {
        let Ok(read) = file.read(&mut buffer) else {
            return 0;
        };
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        // 与 Git numstat 一致，二进制文件不计文本增删行。
        if chunk.contains(&0) {
            return 0;
        }
        has_content = true;
        ends_with_newline = chunk.last() == Some(&b'\n');
        lines = lines.saturating_add(chunk.iter().filter(|byte| **byte == b'\n').count() as u64);
    }
    lines + u64::from(has_content && !ends_with_newline)
}

fn untracked_added_lines(root: &Path) -> u64 {
    let Ok(output) = git_command(root, &["ls-files", "--others", "--exclude-standard", "-z"])
    else {
        return 0;
    };
    if !output.status.success() {
        return 0;
    }
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| root.join(String::from_utf8_lossy(path).as_ref()))
        .map(|path| text_file_line_count(&path))
        .fold(0_u64, u64::saturating_add)
}

#[tauri::command]
fn git_summary(cwd: String) -> Result<GitSummary, String> {
    let root = checked_workspace(&cwd)?;
    let is_repository = optional_git_text(&root, &["rev-parse", "--is-inside-work-tree"])
        .is_some_and(|value| value == "true");
    if !is_repository {
        return Ok(GitSummary {
            is_repository: false,
            branch: None,
            branches: Vec::new(),
            added: 0,
            removed: 0,
            changed_files: 0,
            remote_url: None,
            default_branch: None,
            ahead: 0,
            behind: 0,
        });
    }

    let branch = optional_git_text(&root, &["branch", "--show-current"]);
    let branches = optional_git_text(&root, &["branch", "--format=%(refname:short)"])
        .map(|value| value.lines().map(str::to_string).collect())
        .unwrap_or_default();
    let status = optional_git_text(&root, &["status", "--porcelain=v1", "--untracked-files=all"])
        .unwrap_or_default();
    let changed_files = status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let numstat = optional_git_text(&root, &["diff", "--numstat", "HEAD"])
        .or_else(|| optional_git_text(&root, &["diff", "--numstat"]))
        .unwrap_or_default();
    let (tracked_added, removed) = numstat
        .lines()
        .fold((0_u64, 0_u64), |(added, removed), line| {
            let mut columns = line.split('\t');
            let next_added = columns
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            let next_removed = columns
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            (added + next_added, removed + next_removed)
        });
    let added = tracked_added.saturating_add(untracked_added_lines(&root));
    let remote_url = optional_git_text(&root, &["remote", "get-url", "origin"]);
    let default_branch = optional_git_text(
        &root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .and_then(|value| value.split_once('/').map(|(_, branch)| branch.to_string()));
    let (behind, ahead) = optional_git_text(
        &root,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    )
    .and_then(|value| {
        let mut counts = value.split_whitespace();
        Some((counts.next()?.parse().ok()?, counts.next()?.parse().ok()?))
    })
    .unwrap_or((0, 0));

    Ok(GitSummary {
        is_repository,
        branch,
        branches,
        added,
        removed,
        changed_files,
        remote_url,
        default_branch,
        ahead,
        behind,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitWorktree {
    path: String,
    branch: Option<String>,
    bare: bool,
    detached: bool,
    locked: bool,
    prunable: bool,
}

#[tauri::command]
fn git_worktrees(cwd: String) -> Result<Vec<GitWorktree>, String> {
    let root = checked_workspace(&cwd)?;
    let is_repository = optional_git_text(&root, &["rev-parse", "--is-inside-work-tree"])
        .is_some_and(|value| value == "true");
    if !is_repository {
        return Ok(Vec::new());
    }
    // 即使没有附加 worktree，Git 仍会返回主工作树。这里若降级为空数组，
    // 只会把 Git/进程错误伪装成“没有工作树”，让后续操作基于假状态执行。
    let porcelain = git_text(&root, &["worktree", "list", "--porcelain"])?;
    let mut items = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for line in porcelain.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(item) = current.take() {
                items.push(item);
            }
            current = Some(GitWorktree {
                path: path_for_webview(Path::new(path)),
                branch: None,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(item) = current.as_mut() else {
            continue;
        };
        if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            item.branch = Some(branch.to_string());
        } else if line == "bare" {
            item.bare = true;
        } else if line == "detached" {
            item.detached = true;
        } else if line.starts_with("locked") {
            item.locked = true;
        } else if line.starts_with("prunable") {
            item.prunable = true;
        }
    }
    if let Some(item) = current {
        items.push(item);
    }
    Ok(items)
}

#[tauri::command]
fn git_worktree_add(cwd: String, name: String, branch: Option<String>) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let name = name.trim();
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.len() > 64
        || name.chars().any(|character| {
            character.is_control()
                || matches!(character, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
    {
        return Err("Worktree 名称需为 1–64 个安全字符".into());
    }
    let primary = primary_worktree(&root)?;
    let target = managed_worktree_project_dir(&primary)?.join(name);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 worktree 目录：{error}"))?;
    }
    let target_text = target.to_string_lossy().to_string();
    let branch = branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut args = vec!["worktree".to_string(), "add".to_string()];
    if let Some(branch_name) = branch.as_deref() {
        let branches = git_text(&root, &["branch", "--format=%(refname:short)"])?;
        if branches.lines().any(|candidate| candidate == branch_name) {
            args.push(target_text.clone());
            args.push(branch_name.to_string());
        } else {
            args.push("-b".into());
            args.push(branch_name.to_string());
            args.push(target_text.clone());
        }
    } else {
        args.push(target_text.clone());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git_text(&root, &arg_refs)?;
    Ok(path_for_webview(&target))
}

#[tauri::command]
fn git_worktree_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
    confirms: tauri::State<'_, Arc<GitConfirmStore>>,
    automations: tauri::State<'_, AutomationStore>,
    worktrees: tauri::State<'_, WorktreeOwnershipStore>,
    request: GitWorktreeRemoveRequest,
) -> Result<String, String> {
    let root = checked_workspace(&request.cwd)?;
    let root_key = path_for_webview(&root);
    let target = checked_removable_worktree(&root, &request.path)?;
    let target_key = path_for_webview(&target);
    // 与 session/new|load 绑定、会话本机删除和自动化 cwd patch 串行，关闭
    // “确认后新引用出现”的 TOCTOU 窗口。
    let _lifecycle = worktrees.lock_lifecycle();
    ensure_worktree_unreferenced(
        &app,
        state.inner(),
        worktrees.inner(),
        automations.inner(),
        &target,
    )?;
    confirms.consume_worktree_remove(&root_key, &target_key, &request.confirm_token)?;
    let target_text = target.to_string_lossy().to_string();
    git_text(&root, &["worktree", "remove", "--force", &target_text])?;
    Ok("Worktree 已移除".into())
}

#[tauri::command]
fn open_in_app(cwd: String, app: String) -> Result<(), String> {
    let root = checked_workspace(&cwd)?;
    let app = app.trim().to_ascii_lowercase();
    let path = root.to_string_lossy().to_string();

    let mut command = match app.as_str() {
        "cursor" => {
            let mut command = std::process::Command::new(if cfg!(windows) { "cursor.cmd" } else { "cursor" });
            command.arg(&path);
            command
        }
        "code" | "vscode" => {
            let mut command = std::process::Command::new(if cfg!(windows) { "code.cmd" } else { "code" });
            command.arg(&path);
            command
        }
        "zed" => {
            let mut command = std::process::Command::new("zed");
            command.arg(&path);
            command
        }
        "terminal" => {
            #[cfg(windows)]
            {
                let mut command = std::process::Command::new("wt.exe");
                command.args(["-d", &path]);
                command
            }
            #[cfg(target_os = "macos")]
            {
                let mut command = std::process::Command::new("open");
                command.args(["-a", "Terminal", &path]);
                command
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                let mut command = std::process::Command::new("x-terminal-emulator");
                command.arg("--working-directory").arg(&path);
                command
            }
        }
        "explorer" | "finder" => {
            return open_in_explorer(cwd, None);
        }
        _ => return Err(format!("不支持的应用：{app}")),
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }

    match command.spawn() {
        Ok(_) => Ok(()),
        Err(error) => {
            #[cfg(windows)]
            if app == "terminal" {
                // Avoid cmd.exe metacharacter injection: pass the path as a
                // single PowerShell -WorkingDirectory argument, never interpolate
                // into a /K command string.
                use std::os::windows::process::CommandExt as _;
                std::process::Command::new("powershell.exe")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "Start-Process",
                        "-FilePath",
                        "cmd.exe",
                        "-WorkingDirectory",
                        &path,
                    ])
                    .creation_flags(0x0800_0000)
                    .spawn()
                    .map_err(|fallback| format!("无法打开终端：{error} / {fallback}"))?;
                return Ok(());
            }
            Err(format!("无法打开 {app}：{error}。请确认已安装并在 PATH 中。"))
        }
    }
}

#[tauri::command]
fn notify_desktop(title: String, body: String) -> Result<(), String> {
    let title = title.chars().take(120).collect::<String>();
    let body = body.chars().take(280).collect::<String>();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        let script = format!(
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $text = $template.GetElementsByTagName('text'); $text.Item(0).AppendChild($template.CreateTextNode({})); $text.Item(1).AppendChild($template.CreateTextNode({})); $toast = [Windows.UI.Notifications.ToastNotification]::new($template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Grox').Show($toast)",
            powershell_quote(&title),
            powershell_quote(&body),
        );
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x0800_0000)
            .status()
            .map_err(|error| format!("无法发送通知：{error}"))?;
        if !status.success() {
            return Err("系统通知发送失败".into());
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification {} with title {}",
            applescript_quote(&body),
            applescript_quote(&title)
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|error| format!("无法发送通知：{error}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("notify-send")
            .args([&title, &body])
            .spawn()
            .map_err(|error| format!("无法发送通知：{error}"))?;
        Ok(())
    }
}

#[cfg(windows)]
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "macos")]
fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[tauri::command]
fn git_checkout(cwd: String, branch: String) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let branch = branch.trim();
    let branches = git_text(&root, &["branch", "--format=%(refname:short)"])?;
    if branch.is_empty() || !branches.lines().any(|candidate| candidate == branch) {
        return Err("只能切换到当前仓库已有的本地分支".into());
    }
    git_text(&root, &["switch", branch])?;
    Ok(format!("已切换到 {branch}"))
}

fn confirm_destructive_git_action(title: &str, description: &str) -> Result<(), String> {
    let result = rfd::MessageDialog::new()
        .set_title(title)
        .set_description(description)
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::OkCancel)
        .show();
    if matches!(result, rfd::MessageDialogResult::Ok) {
        Ok(())
    } else {
        Err("用户取消了操作".into())
    }
}

#[derive(Debug)]
struct ListedWorktree {
    path: PathBuf,
    branch: Option<String>,
}

fn parse_worktree_list(porcelain: &str) -> Vec<ListedWorktree> {
    let mut entries = Vec::new();
    let mut current: Option<ListedWorktree> = None;
    for line in porcelain.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            current = Some(ListedWorktree {
                path: PathBuf::from(path),
                branch: None,
            });
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some(entry) = current.as_mut() {
                entry.branch = Some(branch.to_string());
            }
        }
    }
    if let Some(entry) = current {
        entries.push(entry);
    }
    entries
}

fn primary_worktree(root: &Path) -> Result<PathBuf, String> {
    let listed = git_text(root, &["worktree", "list", "--porcelain"])?;
    parse_worktree_list(&listed)
        .into_iter()
        .next()
        .map(|entry| entry.path)
        .ok_or_else(|| "无法确定仓库主工作树".to_string())?
        .canonicalize()
        .map_err(|error| format!("无法解析仓库主工作树：{error}"))
}

/// 同名仓库不能共享一个 `~/.grok/worktrees/<basename>` 命名空间；否则两个
/// 项目创建同名 worktree 时会互相碰撞。可读项目名后附主工作树身份摘要，
/// 旧目录仍保留在删除允许范围内。
fn managed_worktree_project_dir(primary: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest as _, Sha256};

    let primary = primary
        .canonicalize()
        .map_err(|error| format!("无法解析仓库主工作树：{error}"))?;
    let project = primary
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("grox-project");
    let digest = format!("{:x}", Sha256::digest(path_for_webview(&primary).as_bytes()));
    Ok(grok_home()?
        .join("worktrees")
        .join(format!("{project}-{}", &digest[..12])))
}

fn is_legacy_grox_worktree(primary: &Path, target: &Path, branch: Option<&str>) -> bool {
    let Some(primary_name) = primary.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if primary.parent() != target.parent() {
        return false;
    }
    let Some(target_name) = target.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let base = format!("{primary_name}-worktree");
    let valid_name = target_name == base
        || target_name
            .strip_prefix(&format!("{base}-"))
            .is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
            });
    valid_name && branch.is_some_and(|name| name.starts_with("refs/heads/grox/worktree-"))
}

fn checked_removable_worktree(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("Worktree 路径不能为空".into());
    }
    let canonical = PathBuf::from(requested)
        .canonicalize()
        .map_err(|error| format!("无法解析 Worktree 路径：{error}"))?;
    let current = root
        .canonicalize()
        .map_err(|error| format!("无法解析仓库根目录：{error}"))?;
    if canonical == current {
        return Err("不能移除当前正在使用的工作树".into());
    }
    let listed = git_text(root, &["worktree", "list", "--porcelain"])?;
    let entries = parse_worktree_list(&listed);
    let primary = entries
        .first()
        .and_then(|entry| entry.path.canonicalize().ok())
        .ok_or_else(|| "无法确定仓库主工作树".to_string())?;
    if canonical == primary {
        return Err("不能移除仓库主工作树".into());
    }
    let entry = entries
        .iter()
        .find(|entry| entry.path.canonicalize().ok().as_ref() == Some(&canonical))
        .ok_or_else(|| "只能移除当前仓库已登记的 worktree".to_string())?;
    let managed_ok = grok_home()?
        .join("worktrees")
        .canonicalize()
        .ok()
        .is_some_and(|managed| canonical.starts_with(&managed));
    let legacy_ok = is_legacy_grox_worktree(&primary, &canonical, entry.branch.as_deref());
    if !managed_ok && !legacy_ok {
        return Err("只能移除 Grox 管理目录下的 worktree".into());
    }
    Ok(canonical)
}

struct WorktreeRemovalReferences {
    sessions: BTreeSet<String>,
    automations: BTreeSet<String>,
    opening_sessions: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitWorktreeRemoveRequest {
    cwd: String,
    path: String,
    confirm_token: String,
}

fn worktree_removal_references(
    app: &tauri::AppHandle,
    state: &AcpState,
    worktrees: &WorktreeOwnershipStore,
    automations: &AutomationStore,
    target: &Path,
) -> Result<WorktreeRemovalReferences, String> {
    let binding_path = worktree_bindings_path(app)?;
    let mut sessions = worktrees.session_references(&binding_path, target)?;
    sessions.extend(state.client_callbacks.sessions_within(target));
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用会话目录：{error}"))?;
    sessions.extend(worktree_ownership::journal_session_references(&config, target)?);
    let automations = automations.worktree_references(
        &automations_path(app)?,
        target,
        AUTOMATIONS_MAX_BYTES,
    )?;
    Ok(WorktreeRemovalReferences {
        sessions,
        automations,
        opening_sessions: worktrees.opening_references(target),
    })
}

fn ensure_worktree_unreferenced(
    app: &tauri::AppHandle,
    state: &AcpState,
    worktrees: &WorktreeOwnershipStore,
    automations: &AutomationStore,
    target: &Path,
) -> Result<(), String> {
    let references = worktree_removal_references(app, state, worktrees, automations, target)?;
    let session_count = references
        .sessions
        .len()
        .saturating_add(references.opening_sessions);
    if session_count == 0 && references.automations.is_empty() {
        return Ok(());
    }
    let session_examples = references
        .sessions
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let automation_examples = references
        .automations
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let mut owners = Vec::new();
    if session_count > 0 {
        let suffix = if session_examples.is_empty() {
            "正在创建或恢复".to_string()
        } else {
            session_examples
        };
        owners.push(format!("{session_count} 个会话（{suffix}）"));
    }
    if !references.automations.is_empty() {
        owners.push(format!(
            "{} 个自动化（{}）",
            references.automations.len(),
            automation_examples
        ));
    }
    Err(format!(
        "该 worktree 仍被 {} 引用；请先迁移或删除这些记录",
        owners.join("、")
    ))
}

#[tauri::command]
fn prepare_git_commit(
    confirms: tauri::State<'_, Arc<GitConfirmStore>>,
    cwd: String,
) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    confirm_destructive_git_action(
        "Grox",
        "确认暂存全部变更并创建提交？未提交前可在界面中取消。",
    )?;
    confirms.issue_commit(&path_for_webview(&root))
}

#[tauri::command]
fn prepare_git_push(
    confirms: tauri::State<'_, Arc<GitConfirmStore>>,
    cwd: String,
) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    confirm_destructive_git_action("Grox", "确认将当前分支推送到 origin？")?;
    confirms.issue_push(&path_for_webview(&root))
}

fn worktree_remove_confirmation(target: &Path, dirty: bool) -> String {
    let path = path_for_webview(target);
    if dirty {
        format!(
            "该 worktree 包含未提交变更，强制移除会使这些变更永久丢失。\n确认继续？\n{path}"
        )
    } else {
        format!("确认强制移除 worktree？\n{path}")
    }
}

#[tauri::command]
fn prepare_git_worktree_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
    confirms: tauri::State<'_, Arc<GitConfirmStore>>,
    automations: tauri::State<'_, AutomationStore>,
    worktrees: tauri::State<'_, WorktreeOwnershipStore>,
    cwd: String,
    path: String,
) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let target = checked_removable_worktree(&root, &path)?;
    ensure_worktree_unreferenced(
        &app,
        state.inner(),
        worktrees.inner(),
        automations.inner(),
        &target,
    )?;
    let dirty = !git_text(&target, &["status", "--porcelain"])?.is_empty();
    confirm_destructive_git_action(
        "Grox",
        &worktree_remove_confirmation(&target, dirty),
    )?;
    confirms.issue_worktree_remove(&path_for_webview(&root), &path_for_webview(&target))
}

#[tauri::command]
fn git_commit(
    confirms: tauri::State<'_, Arc<GitConfirmStore>>,
    cwd: String,
    message: String,
    confirm_token: String,
) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let root_key = path_for_webview(&root);
    confirms.consume_commit(&root_key, &confirm_token)?;
    let message = message.trim();
    if message.is_empty() || message.len() > 200 || message.chars().any(char::is_control) {
        return Err("提交说明需为 1–200 个字符，且不能包含控制字符".into());
    }
    git_text(&root, &["add", "--all"])?;
    git_text(&root, &["commit", "-m", message])?;
    Ok("提交已创建".into())
}

#[tauri::command]
fn git_push(
    confirms: tauri::State<'_, Arc<GitConfirmStore>>,
    cwd: String,
    confirm_token: String,
) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let root_key = path_for_webview(&root);
    confirms.consume_push(&root_key, &confirm_token)?;
    let branch = git_text(&root, &["branch", "--show-current"])?;
    if branch.is_empty() {
        return Err("当前处于 detached HEAD，无法直接推送".into());
    }
    // Confirm dialog promises origin; never rely on an arbitrary upstream remote.
    git_text(&root, &["push", "--set-upstream", "origin", &branch])?;
    Ok("推送已完成".into())
}

fn static_preview_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "jsx" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

fn preview_byte_range(request: &str, length: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(value) = request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("range").then(|| value.trim())
    }) else {
        return Ok(None);
    };
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') || length == 0 {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = length.saturating_sub(suffix.min(length));
        return Ok(Some((start, length - 1)));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= length {
        return Err(());
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(length - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn static_preview_csp(mime: &str) -> &'static str {
    // 预览 URL 自带不可猜测的文档令牌；仅允许 Grox 的生产协议和本地开发
    // Origin 嵌入，避免 frame-ancestors 'none' 把 HTML/PDF 自己挡在 iframe 外。
    if mime.starts_with("text/html") {
        "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'none'; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-ancestors tauri: http://tauri.localhost https://tauri.localhost http://localhost:* http://127.0.0.1:*; form-action 'none'; base-uri 'none'; object-src 'none'"
    } else {
        "default-src 'none'; frame-ancestors tauri: http://tauri.localhost https://tauri.localhost http://localhost:* http://127.0.0.1:*"
    }
}

async fn send_static_preview_file(
    stream: &mut TcpStream,
    path: &Path,
    mime: &str,
    length: u64,
    range: Option<(u64, u64)>,
    head_only: bool,
) {
    let (status, start, end) = match range {
        Some((start, end)) => ("206 Partial Content", start, end),
        None => ("200 OK", 0, length.saturating_sub(1)),
    };
    let body_length = if length == 0 { 0 } else { end - start + 1 };
    let csp = static_preview_csp(mime);
    let content_range = range
        .map(|_| format!("Content-Range: bytes {start}-{end}/{length}\r\n"))
        .unwrap_or_default();
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {body_length}\r\nAccept-Ranges: bytes\r\n{content_range}Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {csp}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(header.as_bytes()).await.is_err() || head_only || body_length == 0 {
        let _ = stream.shutdown().await;
        return;
    }
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        let _ = stream.shutdown().await;
        return;
    };
    if file.seek(SeekFrom::Start(start)).await.is_err() {
        let _ = stream.shutdown().await;
        return;
    }
    let mut remaining = body_length;
    let mut buffer = vec![0_u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        let Ok(read) = file.read(&mut buffer[..want]).await else {
            break;
        };
        if read == 0 || stream.write_all(&buffer[..read]).await.is_err() {
            break;
        }
        remaining -= read as u64;
    }
    let _ = stream.shutdown().await;
}

async fn send_static_preview_response(
    stream: &mut TcpStream,
    status: &str,
    mime: &str,
    body: &[u8],
    head_only: bool,
) {
    let csp = static_preview_csp(mime);
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {csp}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(header.as_bytes()).await.is_ok() && !head_only {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.shutdown().await;
}

async fn handle_static_preview_request(
    mut stream: TcpStream,
    roots: Arc<Mutex<BTreeMap<String, PathBuf>>>,
) {
    let mut request = [0_u8; 16 * 1024];
    let Ok(size) = stream.read(&mut request).await else {
        return;
    };
    let request = String::from_utf8_lossy(&request[..size]);
    let Some(line) = request.lines().next() else {
        return;
    };
    let mut request_parts = line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let target = request_parts.next().unwrap_or_default();
    let head_only = method == "HEAD";
    if method != "GET" && !head_only {
        send_static_preview_response(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"Method not allowed",
            false,
        )
        .await;
        return;
    }

    let path = target.split(['?', '#']).next().unwrap_or_default();
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let Some(first_segment) = segments.first() else {
        send_static_preview_response(
            &mut stream,
            "404 Not Found",
            "text/plain",
            b"Not found",
            head_only,
        )
        .await;
        return;
    };
    let (root, path_start) = {
        let roots = roots.lock().await;
        if let Some(root) = roots.get(*first_segment) {
            (root.clone(), 1)
        } else {
            // Always require the unguessable document token. Omitting it would
            // let any local process that discovers the port read the workspace.
            send_static_preview_response(
                &mut stream,
                "404 Not Found",
                "text/plain",
                b"Not found",
                head_only,
            )
            .await;
            return;
        }
    };

    let mut candidate = root.clone();
    for encoded in &segments[path_start..] {
        let Ok(decoded) = percent_decode_str(encoded).decode_utf8() else {
            send_static_preview_response(
                &mut stream,
                "400 Bad Request",
                "text/plain",
                b"Bad path",
                head_only,
            )
            .await;
            return;
        };
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains('/')
            || decoded.contains('\\')
            || decoded.chars().any(char::is_control)
        {
            send_static_preview_response(
                &mut stream,
                "400 Bad Request",
                "text/plain",
                b"Bad path",
                head_only,
            )
            .await;
            return;
        }
        candidate.push(decoded.as_ref());
    }
    if candidate.is_dir() {
        candidate.push("index.html");
    }
    let Ok(candidate) = candidate.canonicalize() else {
        send_static_preview_response(
            &mut stream,
            "404 Not Found",
            "text/plain",
            b"Not found",
            head_only,
        )
        .await;
        return;
    };
    if !candidate.starts_with(&root) || !candidate.is_file() {
        send_static_preview_response(
            &mut stream,
            "403 Forbidden",
            "text/plain",
            b"Forbidden",
            head_only,
        )
        .await;
        return;
    }
    let Ok(metadata) = fs::metadata(&candidate) else {
        send_static_preview_response(
            &mut stream,
            "404 Not Found",
            "text/plain",
            b"Not found",
            head_only,
        )
        .await;
        return;
    };
    let mime = static_preview_mime(&candidate);
    let streamable = mime.starts_with("video/")
        || mime.starts_with("audio/")
        || mime == "application/pdf";
    let max_bytes = if streamable {
        MAX_STREAMABLE_PREVIEW_BYTES
    } else if mime.starts_with("image/") {
        MAX_IMAGE_PREVIEW_BYTES
    } else {
        MAX_PREVIEW_BYTES
    };
    if metadata.len() > max_bytes {
        send_static_preview_response(
            &mut stream,
            "413 Content Too Large",
            "text/plain",
            b"File too large",
            head_only,
        )
        .await;
        return;
    }
    let range = match preview_byte_range(&request, metadata.len()) {
        Ok(range) => range,
        Err(()) => {
            let header = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                metadata.len(),
            );
            let _ = stream.write_all(header.as_bytes()).await;
            let _ = stream.shutdown().await;
            return;
        }
    };
    send_static_preview_file(
        &mut stream,
        &candidate,
        mime,
        metadata.len(),
        range,
        head_only,
    )
    .await;
}

#[tauri::command]
async fn start_file_preview(
    state: tauri::State<'_, Arc<FilePreviewState>>,
    cwd: String,
    path: String,
) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let file = checked_workspace_file(&root, &path)?;
    if !file.is_file()
        || !matches!(
            preview_type(&file).0,
            "html" | "image" | "video" | "audio" | "pdf"
        )
    {
        return Err("只能通过安全回环地址预览 HTML、图片、视频、音频或 PDF 文件".into());
    }
    // Scope the static server to the HTML file's directory so a hostile page
    // cannot read unrelated workspace paths via the preview token.
    let preview_root = file
        .parent()
        .ok_or_else(|| "预览文件缺少父目录".to_string())?
        .to_path_buf();
    let relative = file
        .strip_prefix(&preview_root)
        .map_err(|_| "预览文件不在预览根目录中".to_string())?;

    let port = {
        let mut port = state.port.lock().await;
        if let Some(port) = *port {
            port
        } else {
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|error| format!("无法启动 HTML 预览服务：{error}"))?;
            let listener_port = listener
                .local_addr()
                .map_err(|error| format!("无法读取 HTML 预览地址：{error}"))?
                .port();
            let roots = state.roots.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let roots = roots.clone();
                    tauri::async_runtime::spawn(handle_static_preview_request(stream, roots));
                }
            });
            *port = Some(listener_port);
            listener_port
        }
    };

    let mut token_bytes = [0_u8; 16];
    getrandom::fill(&mut token_bytes)
        .map_err(|error| format!("无法创建 HTML 预览令牌：{error}"))?;
    let token = token_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    {
        let mut roots = state.roots.lock().await;
        roots.clear();
        roots.insert(token.clone(), preview_root);
    }

    let mut url = url::Url::parse(&format!("http://127.0.0.1:{port}/"))
        .map_err(|error| format!("无法创建 HTML 预览地址：{error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "无法创建 HTML 预览路径".to_string())?;
        segments.push(&token);
        for component in relative.components() {
            if let Component::Normal(segment) = component {
                segments.push(&segment.to_string_lossy());
            }
        }
    }
    Ok(url.to_string())
}

#[tauri::command]
fn read_preview_file(cwd: String, path: String) -> Result<PreviewFile, String> {
    let root = checked_workspace(&cwd)?;
    let file = checked_workspace_file(&root, &path)?;
    let metadata =
        fs::metadata(&file).map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
    if !metadata.is_file() {
        return Err("只能预览文件".into());
    }
    let (kind, mime) = preview_type(&file);
    if kind == "unsupported" {
        return Err("暂不支持预览该文件类型".into());
    }
    let delivered_by_url = matches!(kind, "image" | "video" | "audio" | "pdf");
    let max_bytes = if matches!(kind, "video" | "audio" | "pdf") {
        MAX_STREAMABLE_PREVIEW_BYTES
    } else if kind == "image" {
        MAX_IMAGE_PREVIEW_BYTES
    } else {
        MAX_PREVIEW_BYTES
    };
    if metadata.len() > max_bytes {
        return Err(if matches!(kind, "video" | "audio" | "pdf") {
            "媒体预览文件不能超过 4 GB".into()
        } else if kind == "image" {
            "图片预览文件不能超过 40 MB".into()
        } else {
            "预览文件不能超过 16 MB".into()
        });
    }
    let content = if delivered_by_url {
        String::new()
    } else {
        let bytes = fs::read(&file)
            .map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
        String::from_utf8(bytes).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?
    };
    Ok(PreviewFile {
        path: path_for_webview(&file),
        name: file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("preview")
            .to_string(),
        kind,
        mime: mime.to_string(),
        content,
    })
}

#[tauri::command]
fn open_in_explorer(cwd: String, path: Option<String>) -> Result<(), String> {
    let root = checked_workspace(&cwd)?;
    let target = match path {
        Some(path) if !path.trim().is_empty() => checked_workspace_file(&root, &path)?,
        _ => root,
    };
    let target = if target.is_file() {
        target.parent().unwrap_or(&target).to_path_buf()
    } else {
        target
    };

    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg(&target)
        .spawn()
        .map_err(|error| format!("无法打开资源管理器：{error}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&target)
        .spawn()
        .map_err(|error| format!("无法打开 Finder：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map_err(|error| format!("无法打开文件管理器：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn application_search_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Ok(home) = user_home() {
        roots.push(home.join("Applications"));
    }
    roots
}

#[cfg(target_os = "macos")]
fn discovered_application_paths() -> Vec<PathBuf> {
    fn collect_bundles(root: &Path, depth: u8, paths: &mut BTreeSet<PathBuf>) {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().is_some_and(|value| value == "app") && path.is_dir() {
                paths.insert(path);
            } else if depth > 0 && path.is_dir() {
                collect_bundles(&path, depth - 1, paths);
            }
        }
    }

    let mut paths = BTreeSet::new();
    for root in application_search_roots() {
        if !root.is_dir() {
            continue;
        }
        let paths_before_root = paths.len();
        let root_string = root.to_string_lossy().to_string();
        if let Ok(output) = std::process::Command::new("/usr/bin/mdfind")
            .args([
                "-onlyin",
                root_string.as_str(),
                "kMDItemContentType == 'com.apple.application-bundle'",
            ])
            .stderr(Stdio::null())
            .output()
        {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let path = PathBuf::from(line.trim());
                if path.extension().is_some_and(|value| value == "app") {
                    paths.insert(path);
                }
            }
        }
        // Spotlight is normally instant, but a fresh install or a disabled
        // index must not make the selector silently empty. A shallow fallback
        // covers normal top-level and vendor-nested .app bundles without
        // walking an entire home directory.
        if paths.len() == paths_before_root {
            collect_bundles(&root, 2, &mut paths);
        }
    }
    for path in [
        "/System/Library/CoreServices/Finder.app",
        "/System/Applications/Utilities/Terminal.app",
    ] {
        let path = PathBuf::from(path);
        if path.is_dir() {
            paths.insert(path);
        }
    }
    paths.into_iter().collect()
}

#[cfg(target_os = "macos")]
fn plist_string(plist: &serde_json::Value, key: &str) -> Option<String> {
    plist.get(key).and_then(|value| value.as_str()).map(str::to_string)
}

#[cfg(target_os = "macos")]
fn app_icon_resource(app_path: &Path, plist: &serde_json::Value) -> Option<PathBuf> {
    let resources = app_path
        .join("Contents")
        .join("Resources")
        .canonicalize()
        .ok()?;
    let configured = plist_string(plist, "CFBundleIconFile")
        .or_else(|| plist_string(plist, "CFBundleIconName"));
    if let Some(configured) = configured {
        let configured = PathBuf::from(configured);
        let candidate = resources.join(&configured).canonicalize().ok();
        if let Some(candidate) = candidate.filter(|path| path.starts_with(&resources) && path.is_file()) {
            return Some(candidate);
        }
        if configured.extension().is_none() {
            let candidate = resources
                .join(configured)
                .with_extension("icns")
                .canonicalize()
                .ok();
            if let Some(candidate) = candidate.filter(|path| path.starts_with(&resources) && path.is_file()) {
                return Some(candidate);
            }
        }
    }
    fs::read_dir(resources)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path.extension().is_some_and(|extension| {
                    matches!(extension.to_ascii_lowercase().to_str(), Some("icns") | Some("png"))
                })
        })
}

#[cfg(target_os = "macos")]
fn app_icon_data_url(app_path: &Path, plist: &serde_json::Value) -> Option<String> {
    let source = app_icon_resource(app_path, plist)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let target = std::env::temp_dir().join(format!("grox-app-icon-{nonce}.png"));
    let status = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "-z", "32", "32"])
        .arg(&source)
        .arg("--out")
        .arg(&target)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    if !status.success() {
        let _ = fs::remove_file(&target);
        return None;
    }
    let bytes = fs::read(&target).ok();
    let _ = fs::remove_file(&target);
    bytes.map(|bytes| format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

#[cfg(target_os = "macos")]
fn inspect_application(path: &Path) -> Option<OpenApplicationOption> {
    let plist_path = path.join("Contents").join("Info.plist");
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(&plist_path)
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let plist = serde_json::from_slice::<serde_json::Value>(&output.stdout).ok()?;
    let bundle_id = plist_string(&plist, "CFBundleIdentifier")?;
    let name = plist_string(&plist, "CFBundleDisplayName")
        .or_else(|| plist_string(&plist, "CFBundleName"))
        .or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })?;
    let lower = format!("{} {}", bundle_id, name).to_ascii_lowercase();
    let is_finder = bundle_id == "com.apple.finder" || lower.contains("finder");
    let is_terminal = [
        "terminal",
        "ghostty",
        "iterm",
        "warp",
        "alacritty",
        "kitty",
        "wezterm",
        "hyper",
    ]
    .iter()
    .any(|hint| lower.contains(hint));
    let is_editor = [
        "cursor",
        "visual studio",
        "xcode",
        "zed",
        "sublime",
        "textmate",
        "bbedit",
        "nova",
        "intellij",
        "pycharm",
        "webstorm",
        "goland",
        "clion",
        "rustrover",
        "fleet",
        "coteditor",
        "emacs",
        "vim",
    ]
    .iter()
    .any(|hint| lower.contains(hint));
    if !is_finder && !is_terminal && !is_editor {
        return None;
    }
    Some(OpenApplicationOption {
        id: bundle_id,
        name,
        launch_target: Some(path_for_webview(path)),
        icon_data_url: app_icon_data_url(path, &plist),
    })
}

#[cfg(windows)]
fn windows_application_discovery_script() -> &'static str {
    // Keep discovery in the OS registry instead of shipping a fixed list.
    // The same registration is what Windows shows in its own “Open with” UI.
    r#"
$ErrorActionPreference = 'SilentlyContinue'
try { Add-Type -AssemblyName System.Drawing } catch {}

function Resolve-Executable([string]$command) {
  if ([string]::IsNullOrWhiteSpace($command)) { return $null }
  $match = [regex]::Match($command, '^\s*"([^"]+)"|^\s*([^\s]+)')
  if (-not $match.Success) { return $null }
  $candidate = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
  if ($candidate -match '%') { return $null }
  try { return (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path } catch {}
  try { return (Get-Command $candidate -ErrorAction Stop).Source } catch { return $null }
}

function Icon-Data([string]$path) {
  try {
    if (-not ('System.Drawing.Icon' -as [type])) { return $null }
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
    if ($null -eq $icon) { return $null }
    $bitmap = $icon.ToBitmap()
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $value = [Convert]::ToBase64String($stream.ToArray())
    $bitmap.Dispose(); $icon.Dispose(); $stream.Dispose()
    return "data:image/png;base64,$value"
  } catch { return $null }
}

$apps = @{}
function Add-App([string]$id, [string]$name, [string]$target) {
  if ([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) { return }
  $resolved = (Resolve-Path -LiteralPath $target).Path
  $extension = [IO.Path]::GetExtension($resolved).ToLowerInvariant()
  if ($extension -notin @('.exe','.com','.bat','.cmd','.ps1')) { return }
  if ($apps.ContainsKey($resolved.ToLowerInvariant())) { return }
  $description = $null
  try { $description = (Get-Item $resolved).VersionInfo.FileDescription } catch {}
  if ([string]::IsNullOrWhiteSpace($description)) { $description = [IO.Path]::GetFileNameWithoutExtension($resolved) }
  $apps[$resolved.ToLowerInvariant()] = [ordered]@{
    id = if ([string]::IsNullOrWhiteSpace($id)) { "windows:$resolved" } else { "windows:$id" }
    name = $description
    launchTarget = $resolved
    iconDataUrl = (Icon-Data $resolved)
  }
}

$hints = '(?i)(cursor|visual studio|vs code|code\.exe|xcode|zed|sublime|textmate|notepad\+\+|notepad|vim|neovim|emacs|idea|pycharm|webstorm|goland|clion|rustrover|fleet|terminal|powershell|alacritty|wezterm|kitty|ghostty|warp|conemu|mintty)'
$sourceExtensions = '(?i)\.(txt|md|markdown|json|jsonl|js|jsx|ts|tsx|rs|py|go|java|c|h|cpp|hpp|swift|toml|yaml|yml|xml|css|html|htm)$'
$registryRoots = @(
  'Registry::HKEY_CLASSES_ROOT\Applications',
  'Registry::HKEY_CURRENT_USER\Software\Classes\Applications',
  'Registry::HKEY_LOCAL_MACHINE\Software\Classes\Applications'
)
foreach ($registryRoot in $registryRoots) {
  foreach ($app in @(Get-ChildItem -LiteralPath $registryRoot)) {
    $commandKey = Join-Path $app.PSPath 'shell\open\command'
    $commandItem = Get-Item -LiteralPath $commandKey
    if ($null -eq $commandItem) { continue }
    $target = Resolve-Executable ([string]$commandItem.GetValue(''))
    if ($null -eq $target) { continue }
    $descriptor = "$($app.PSChildName) $target"
    $sourceAssociation = $false
    $associationKey = Get-Item -LiteralPath (Join-Path $app.PSPath 'Capabilities\FileAssociations')
    if ($null -ne $associationKey) {
      $sourceAssociation = @($associationKey.GetValueNames()) -match $sourceExtensions
    }
    if ($descriptor -match $hints -or $sourceAssociation) {
      Add-App $app.PSChildName $app.PSChildName $target
    }
  }
}

# File Explorer and installed terminal shells are OS applications, not always
# present below HKCR\Applications. Add them only when the command actually
# exists on this machine.
foreach ($entry in @(
  @{ id = 'file-explorer'; name = 'File Explorer'; command = 'explorer.exe' },
  @{ id = 'windows-terminal'; name = 'Windows Terminal'; command = 'wt.exe' },
  @{ id = 'powershell'; name = 'PowerShell'; command = 'powershell.exe' }
)) {
  $command = Get-Command $entry.command
  if ($null -ne $command) { Add-App $entry.id $entry.name $command.Source }
}
$apps.Values | Sort-Object name | ConvertTo-Json -Compress
"#
}

#[cfg(windows)]
fn list_windows_open_applications() -> Result<Vec<OpenApplicationOption>, String> {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            windows_application_discovery_script(),
        ])
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("无法读取 Windows 应用注册表：{error}"))?;
    if !output.status.success() {
        return Err("Windows 应用注册表查询失败".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value = serde_json::from_str::<serde_json::Value>(stdout.trim())
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    let values = match value {
        serde_json::Value::Array(values) => values,
        serde_json::Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    let mut applications = values
        .into_iter()
        .filter_map(|value| serde_json::from_value::<OpenApplicationOption>(value).ok())
        .filter(|item| {
            item.launch_target
                .as_deref()
                .is_some_and(|target| Path::new(target).is_absolute())
        })
        .collect::<Vec<_>>();
    applications.sort_by_cached_key(|item| item.name.to_ascii_lowercase());
    let mut seen = BTreeSet::new();
    applications.retain(|item| seen.insert(item.id.clone()));
    Ok(applications)
}

#[cfg(windows)]
fn checked_windows_application(requested: &str) -> Result<PathBuf, String> {
    let path = Path::new(requested);
    if !path.is_absolute() {
        return Err("打开应用必须是 Windows 的绝对路径".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析打开应用：{error}"))?;
    if !canonical.is_file() {
        return Err("打开应用必须是可执行文件".into());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "exe" | "com" | "bat" | "cmd" | "ps1") {
        return Err("打开应用必须是 Windows 可执行文件".into());
    }
    let discovered = list_windows_open_applications()?;
    if !discovered.iter().any(|item| {
        item.launch_target
            .as_deref()
            .and_then(|target| Path::new(target).canonicalize().ok())
            .is_some_and(|target| target == canonical)
    }) {
        return Err("打开应用不是 Windows 已发现的可用应用".into());
    }
    Ok(canonical)
}

#[cfg(target_os = "linux")]
fn linux_application_dirs() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home).join(".local").join("share"));
        roots.push(data_home.join("applications"));
    }
    let data_dirs = std::env::var_os("XDG_DATA_DIRS")
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    for directory in data_dirs.split(':').filter(|value| !value.is_empty()) {
        roots.push(PathBuf::from(directory).join("applications"));
    }
    roots
}

#[cfg(target_os = "linux")]
fn desktop_entry_fields(content: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let mut in_desktop_entry = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            fields.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    fields
}

#[cfg(target_os = "linux")]
fn split_desktop_exec(value: &str) -> Option<Vec<String>> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            } else {
                current.push(character);
            }
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped || quote.is_some() {
        return None;
    }
    if !current.is_empty() {
        args.push(current);
    }
    (!args.is_empty()).then_some(args)
}

#[cfg(target_os = "linux")]
fn linux_icon_file(name: &str) -> Option<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let direct = PathBuf::from(name);
    if direct.is_absolute() && direct.is_file() {
        return Some(direct);
    }
    let mut roots = linux_application_dirs()
        .into_iter()
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    roots.extend([
        PathBuf::from("/usr/share/pixmaps"),
        PathBuf::from("/usr/local/share/pixmaps"),
    ]);
    let names = if Path::new(name).extension().is_some() {
        vec![name.to_string()]
    } else {
        ["png", "svg", "jpg", "jpeg"]
            .into_iter()
            .map(|extension| format!("{name}.{extension}"))
            .collect()
    };
    for root in roots {
        for candidate_name in &names {
            let direct_candidate = root.join("pixmaps").join(candidate_name);
            if direct_candidate.is_file() {
                return Some(direct_candidate);
            }
            for theme in ["hicolor", "Adwaita", "breeze", "default"] {
                for size in ["scalable/apps", "64x64/apps", "48x48/apps", "32x32/apps"] {
                    let candidate = root.join("icons").join(theme).join(size).join(candidate_name);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_icon_data_url(name: Option<&str>) -> Option<String> {
    let path = linux_icon_file(name?)?;
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
        return None;
    }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", BASE64.encode(fs::read(path).ok()?)))
}

#[cfg(target_os = "linux")]
fn inspect_desktop_application(path: &Path) -> Option<OpenApplicationOption> {
    let content = read_bounded_text(path, 1024 * 1024).ok()?;
    let fields = desktop_entry_fields(&content);
    if fields.get("Type").map(String::as_str) != Some("Application")
        || fields.get("NoDisplay").is_some_and(|value| value.eq_ignore_ascii_case("true"))
        || fields.get("Hidden").is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return None;
    }
    let name = fields.get("Name")?.trim();
    let exec = fields.get("Exec")?;
    let lower = format!("{} {} {}", name, exec, fields.get("Categories").map(String::as_str).unwrap_or_default()).to_ascii_lowercase();
    let terminal = lower.contains("terminal")
        || lower.contains("ghostty")
        || lower.contains("alacritty")
        || lower.contains("wezterm")
        || lower.contains("kitty")
        || lower.contains("terminalemulator");
    let editor = lower.contains("development")
        || lower.contains("ide")
        || lower.contains("editor")
        || lower.contains("cursor")
        || lower.contains("code")
        || lower.contains("vim")
        || lower.contains("emacs")
        || lower.contains("sublime")
        || lower.contains("notepad")
        || lower.contains("textmate");
    let file_manager = lower.contains("filemanager")
        || lower.contains("file manager")
        || lower.contains("nautilus")
        || lower.contains("dolphin")
        || lower.contains("thunar")
        || lower.contains("pcmanfm");
    let source_mime = fields
        .get("MimeType")
        .map(|value| {
            value.split(';').any(|mime| {
                mime.starts_with("text/x-") || mime.contains("javascript") || mime.contains("json")
            })
        })
        .unwrap_or(false);
    if !terminal && !editor && !file_manager && !source_mime {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    Some(OpenApplicationOption {
        id: format!("linux:{}", canonical.to_string_lossy()),
        name: name.to_string(),
        launch_target: Some(path_for_webview(&canonical)),
        icon_data_url: linux_icon_data_url(fields.get("Icon").map(String::as_str)),
    })
}

#[cfg(target_os = "linux")]
fn list_linux_open_applications() -> Vec<OpenApplicationOption> {
    let mut applications = Vec::new();
    for root in linux_application_dirs() {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("desktop") {
                if let Some(application) = inspect_desktop_application(&path) {
                    applications.push(application);
                }
            }
        }
    }
    applications.sort_by_cached_key(|item| item.name.to_ascii_lowercase());
    let mut seen = BTreeSet::new();
    applications.retain(|item| seen.insert(item.id.clone()));
    applications
}

#[cfg(target_os = "linux")]
fn checked_desktop_application(requested: &str) -> Result<PathBuf, String> {
    let path = Path::new(requested);
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("desktop") {
        return Err("打开应用必须是 Linux 的 .desktop 文件".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析打开应用：{error}"))?;
    if !linux_application_dirs().into_iter().any(|root| canonical.starts_with(root)) {
        return Err("打开应用必须来自系统应用目录".into());
    }
    Ok(canonical)
}

#[cfg(target_os = "linux")]
fn desktop_command_for_file(path: &Path, file: &Path) -> Result<(String, Vec<String>), String> {
    let fields = desktop_entry_fields(&read_bounded_text(path, 1024 * 1024)?);
    let exec = fields.get("Exec").ok_or_else(|| "Linux 应用缺少 Exec 配置".to_string())?;
    let raw_args = split_desktop_exec(exec).ok_or_else(|| "无法解析 Linux 应用的 Exec 配置".to_string())?;
    let mut args = Vec::new();
    let mut inserted_file = false;
    for argument in raw_args {
        if matches!(argument.as_str(), "%f" | "%F" | "%u" | "%U") {
            args.push(path_for_webview(file));
            inserted_file = true;
        } else if matches!(argument.as_str(), "%i" | "%c" | "%k" | "%d" | "%D" | "%n" | "%N" | "%v" | "%m") {
            continue;
        } else if argument.contains('%') {
            args.push(argument.replace("%f", &path_for_webview(file)).replace("%u", &path_for_webview(file)));
            inserted_file = true;
        } else {
            args.push(argument);
        }
    }
    let command = args.first().cloned().ok_or_else(|| "Linux 应用的 Exec 配置为空".to_string())?;
    let mut command_args = args.into_iter().skip(1).collect::<Vec<_>>();
    if !inserted_file {
        command_args.push(path_for_webview(file));
    }
    Ok((command, command_args))
}

/// Enumerate installed editor and terminal applications on the host.
#[tauri::command]
fn list_open_applications_sync() -> Result<Vec<OpenApplicationOption>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut applications = discovered_application_paths()
            .iter()
            .filter_map(|path| inspect_application(path))
            .collect::<Vec<_>>();
        applications.sort_by_cached_key(|item| item.name.to_ascii_lowercase());
        let mut seen = BTreeSet::new();
        applications.retain(|item| seen.insert(item.id.clone()));
        return Ok(applications);
    }
    #[cfg(windows)]
    {
        return list_windows_open_applications();
    }
    #[cfg(target_os = "linux")]
    {
        return Ok(list_linux_open_applications());
    }
    #[cfg(all(not(target_os = "macos"), not(windows), not(target_os = "linux")))]
    {
        Ok(Vec::new())
    }
}

/// Enumerate installable "Open with" targets. Must be async: on Windows this
/// shells out to PowerShell and extracts icons — a sync command freezes the
/// WebView for 2–3s on cold open (UI painted, clicks dead).
#[tauri::command]
async fn list_open_applications() -> Result<Vec<OpenApplicationOption>, String> {
    tauri::async_runtime::spawn_blocking(list_open_applications_sync)
        .await
        .map_err(|error| format!("应用发现任务失败：{error}"))?
}

#[cfg(target_os = "macos")]
fn checked_application_bundle(requested: &str) -> Result<Option<PathBuf>, String> {
    let path = Path::new(requested);
    if !path.is_absolute() {
        if matches!(requested, "Cursor" | "Finder" | "Terminal" | "Ghostty" | "Xcode") {
            return Ok(None);
        }
        return Err("不支持的打开应用".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析打开应用：{error}"))?;
    if !canonical.is_dir() || canonical.extension().map_or(true, |value| value != "app") {
        return Err("打开应用必须是 macOS .app".into());
    }
    let mut allowed_roots = application_search_roots();
    allowed_roots.extend([
        PathBuf::from("/System/Library/CoreServices"),
        PathBuf::from("/Library/CoreServices"),
    ]);
    if !allowed_roots
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Err("打开应用必须来自系统应用目录".into());
    }
    Ok(Some(canonical))
}

/// Open a workspace file with one application discovered by the desktop
/// selector. The launch target is validated again in the native process;
/// localStorage is not treated as an authority boundary.
#[tauri::command]
fn open_file_with_application(cwd: String, path: String, application: String) -> Result<(), String> {
    let root = checked_workspace(&cwd)?;
    let file = checked_workspace_file(&root, &path)?;
    if !file.is_file() {
        return Err("只能使用应用打开文件".into());
    }
    #[cfg(target_os = "macos")]
    {
        let application_path = checked_application_bundle(&application)?;
        let application_name = application_path
            .as_deref()
            .and_then(|path| path.file_stem())
            .and_then(|value| value.to_str())
            .unwrap_or(&application);
        let status = if application_name.eq_ignore_ascii_case("Finder") {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&file)
                .status()
        } else {
            std::process::Command::new("open")
                .arg("-a")
                .arg(application_path.as_deref().unwrap_or(Path::new(&application)))
                .arg(&file)
                .status()
        }
        .map_err(|error| format!("无法启动 {application}：{error}"))?;
        if !status.success() {
            return Err(format!("系统中未找到可用的 {application} 应用"));
        }
        return Ok(());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let target = checked_windows_application(&application)?;
        let extension = target
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut command = if matches!(extension.as_str(), "bat" | "cmd") {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/D", "/C"]).arg(&target);
            command
        } else if extension == "ps1" {
            let mut command = std::process::Command::new("powershell.exe");
            command.args(["-NoProfile", "-File"]).arg(&target);
            command
        } else {
            std::process::Command::new(&target)
        };
        command
            .arg(&file)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法启动 {}：{error}", target.display()))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let target = checked_desktop_application(&application)?;
        let (command_name, args) = desktop_command_for_file(&target, &file)?;
        std::process::Command::new(&command_name)
            .args(args)
            .spawn()
            .map_err(|error| format!("无法启动 {}：{error}", target.display()))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "linux")))]
    {
        let _ = application;
        return Err("当前平台请使用系统默认应用或“打开方式…”".into());
    }
}

#[derive(Clone, Debug)]
struct CreatedManagedWorktree {
    source_root: PathBuf,
    path: PathBuf,
    branch: String,
}

fn ensure_clean_worktree(root: &Path) -> Result<(), String> {
    let status = git_text(
        root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    if status.is_empty() {
        Ok(())
    } else {
        Err("源工作树存在未提交改动；请先提交或暂存处理后再分叉，避免新 worktree 与当前代码状态不一致".into())
    }
}

fn create_managed_worktree(
    cwd: &str,
    directory_prefix: &str,
    require_clean: bool,
) -> Result<CreatedManagedWorktree, String> {
    let requested = checked_workspace(cwd)?;
    let top_level = git_text(&requested, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "当前项目不是 Git 仓库，无法创建 worktree".to_string())?;
    let root = PathBuf::from(top_level)
        .canonicalize()
        .map_err(|error| format!("无法解析 Git 仓库根目录：{error}"))?;
    let listed = git_text(&root, &["worktree", "list", "--porcelain"])?;
    let primary = parse_worktree_list(&listed)
        .into_iter()
        .next()
        .map(|entry| entry.path)
        .unwrap_or_else(|| root.clone());
    if require_clean {
        ensure_clean_worktree(&root)?;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let nonce = CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed);
    let unique = format!("{timestamp}-{nonce}");
    let target = managed_worktree_project_dir(&primary)?
        .join(format!("{directory_prefix}-{unique}"));
    let parent = target
        .parent()
        .ok_or_else(|| "无法确定工作树管理目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建 worktree 目录：{error}"))?;
    let branch = format!("grox/worktree-{unique}");
    let mut command = std::process::Command::new("git");
    command
        .current_dir(&root)
        .args(["worktree", "add", "-b", &branch])
        .arg(&target);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法执行 git worktree：{error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "创建 worktree 失败".into()
        } else {
            format!("创建 worktree 失败：{message}")
        });
    }
    Ok(CreatedManagedWorktree {
        source_root: root,
        path: target,
        branch,
    })
}

fn rollback_managed_worktree(created: &CreatedManagedWorktree) -> Result<(), String> {
    let target = created.path.to_string_lossy().to_string();
    let mut errors = Vec::new();
    if let Err(error) = git_text(
        &created.source_root,
        &["worktree", "remove", "--force", &target],
    ) {
        errors.push(format!("无法移除 worktree：{error}"));
    }
    if let Err(error) = git_text(
        &created.source_root,
        &["branch", "-D", &created.branch],
    ) {
        errors.push(format!("无法删除分叉分支：{error}"));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

/// 永久工作树与手动工作树共用同一管理目录和删除边界。
#[tauri::command]
fn create_permanent_worktree(cwd: String) -> Result<String, String> {
    create_managed_worktree(&cwd, "permanent", false)
        .map(|created| path_for_webview(&created.path))
}

/// Let the operating system present its application chooser for a workspace
/// file.  macOS has no `open` flag for this, so use LaunchServices through a
/// short, escaped AppleScript; Windows exposes the same chooser via
/// `OpenAs_RunDLL`.  Linux desktops fall back to their file-manager opener.
#[tauri::command]
fn open_file_with_dialog(cwd: String, path: String) -> Result<(), String> {
    let root = checked_workspace(&cwd)?;
    let file = checked_workspace_file(&root, &path)?;
    if !file.is_file() {
        return Err("只能选择文件的打开方式".into());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32.exe")
            .arg("shell32.dll,OpenAs_RunDLL")
            .arg(path_for_webview(&file))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法打开“打开方式”对话框：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        fn apple_script_string(value: &str) -> String {
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
        }
        let path = apple_script_string(&path_for_webview(&file));
        let script = format!(
            "set targetPath to \"{path}\"\nset chosenApp to choose application with prompt \"选择用于打开文件的应用\"\nset appPath to POSIX path of (chosenApp as alias)\ndo shell script \"open -a \" & quoted form of appPath & \" \" & quoted form of targetPath"
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|error| format!("无法打开应用选择器：{error}"))?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !message.to_ascii_lowercase().contains("user canceled")
                && !message.to_ascii_lowercase().contains("用户取消")
            {
                return Err(if message.is_empty() {
                    "无法打开应用选择器".into()
                } else {
                    format!("无法打开应用选择器：{message}")
                });
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&file)
        .spawn()
        .map_err(|error| format!("无法打开系统文件选择器：{error}"))?;
    Ok(())
}

/// Resolve a workspace-relative entry to the actual path that the user can
/// paste into a shell, editor, or another task. It intentionally shares the
/// workspace boundary used by the file-tree actions.
#[tauri::command]
fn workspace_file_path(cwd: String, path: String) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let file = checked_workspace_file(&root, &path)?;
    Ok(path_for_webview(&file))
}

const CONFIG_SECRET_REDACTED: &str = "********";

fn is_redacted_config_secret(value: &str) -> bool {
    let value = value.trim().trim_matches('"').trim_matches('\'');
    value == CONFIG_SECRET_REDACTED || value == "[REDACTED]" || value.contains('…')
}

fn config_secret_key(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_uppercase().as_str(),
        "XAI_API_KEY" | "OPENAI_API_KEY" | "ANTHROPIC_API_KEY"
    )
}

fn redact_config_document_secrets(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            if let Some((indent, key, _, suffix)) = config_assignment_parts(line) {
                if key.eq_ignore_ascii_case("api_key") {
                    return format!("{indent}{key} = \"{CONFIG_SECRET_REDACTED}\"{suffix}");
                }
                if config_secret_key(key) {
                    return format!("{indent}{key}={CONFIG_SECRET_REDACTED}{suffix}");
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn toml_line_without_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if in_double => escaped = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => return line[..index].trim_end(),
            _ => {}
        }
    }
    line.trim_end()
}

fn config_assignment_parts(line: &str) -> Option<(&str, &str, &str, &str)> {
    let body = toml_line_without_comment(line);
    let suffix = &line[body.len()..];
    let (left, value) = body.split_once('=')?;
    let key = left.trim();
    let indent = &left[..left.len() - left.trim_start().len()];
    (!key.is_empty()).then_some((indent, key, value.trim(), suffix))
}

fn toml_table_header_key(line: &str) -> Option<String> {
    let line = toml_line_without_comment(line).trim();
    (line.starts_with('[') && line.ends_with(']') && !line.starts_with("[["))
        .then(|| line.to_string())
}

fn parse_toml_api_key_value(line: &str) -> Option<&str> {
    let line = toml_line_without_comment(line);
    let rest = line
        .strip_prefix("api_key")
        .or_else(|| line.strip_prefix("API_KEY"))?
        .trim_start();
    Some(
        rest.strip_prefix('=')?
            .trim()
            .trim_matches('"')
            .trim_matches('\''),
    )
}

fn collect_config_api_keys(content: &str) -> BTreeMap<String, String> {
    let mut table = String::new();
    let mut keys = BTreeMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(header) = toml_table_header_key(trimmed) {
            table = header;
        } else if let Some(value) = parse_toml_api_key_value(trimmed) {
            if !is_redacted_config_secret(value) {
                keys.insert(table.clone(), value.to_string());
            }
        }
    }
    keys
}

fn collect_config_env_keys(content: &str) -> BTreeMap<String, String> {
    content
        .lines()
        .filter_map(|line| {
            let (_, key, value, _) = config_assignment_parts(line)?;
            config_secret_key(key).then(|| {
                (
                    key.to_ascii_uppercase(),
                    value.trim_matches('"').trim_matches('\'').to_string(),
                )
            })
        })
        .filter(|(_, value)| !is_redacted_config_secret(value))
        .collect()
}

fn config_contains_redacted_secret(content: &str) -> bool {
    content.lines().any(|line| {
        let trimmed = line.trim();
        parse_toml_api_key_value(trimmed).is_some_and(is_redacted_config_secret)
            || config_assignment_parts(line).is_some_and(|(_, key, value, _)| {
                config_secret_key(key) && is_redacted_config_secret(value)
            })
    })
}

/// 设置页只持有脱敏草稿；保存时按 TOML 表名恢复原密钥，绝不按行号猜测。
fn merge_config_secrets_from_existing(existing: &str, incoming: &str) -> Result<String, String> {
    let prior_api = collect_config_api_keys(existing);
    let prior_env = collect_config_env_keys(existing);
    let mut table = String::new();
    let mut output = Vec::new();
    for line in incoming.lines() {
        let trimmed = line.trim();
        if let Some(header) = toml_table_header_key(trimmed) {
            table = header;
            output.push(line.to_string());
            continue;
        }
        if let Some(value) = parse_toml_api_key_value(trimmed) {
            if is_redacted_config_secret(value) {
                let real = prior_api.get(&table).ok_or_else(|| {
                    format!("无法安全恢复 {table} 的 api_key，请重新输入该段密钥")
                })?;
                let (indent, key, _, suffix) = config_assignment_parts(line)
                    .ok_or_else(|| "无法解析 api_key 配置行".to_string())?;
                let quoted = serde_json::to_string(real)
                    .map_err(|error| format!("无法编码配置密钥：{error}"))?;
                output.push(format!("{indent}{key} = {quoted}{suffix}"));
                continue;
            }
        }
        if let Some((indent, key, raw, suffix)) = config_assignment_parts(line) {
            if config_secret_key(key) && is_redacted_config_secret(raw) {
                let real = prior_env
                    .get(&key.to_ascii_uppercase())
                    .ok_or_else(|| format!("无法安全恢复环境变量密钥 {key}，请重新输入"))?;
                output.push(format!("{indent}{key}={}{suffix}", env_value(real)));
                continue;
            }
        }
        output.push(line.to_string());
    }
    Ok(output.join("\n"))
}

#[tauri::command]
fn read_config_documents(cwd: String) -> Result<Vec<ConfigDocument>, String> {
    let cwd = checked_workspace(&cwd)?;
    ["config", "system-prompt", "agents"]
        .into_iter()
        .map(|id| {
            let (path, label, language) = config_path(id, &cwd)?;
            let exists = path.is_file();
            let content = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
            Ok(ConfigDocument {
                id,
                label,
                path: path_for_webview(&path),
                content: if id == "config" {
                    redact_config_document_secrets(&content)
                } else {
                    content
                },
                exists,
                language,
                overlay: (id == "config").then(config_overlay_metadata),
            })
        })
        .collect()
}

#[tauri::command]
fn write_config_document(request: WriteConfigDocument) -> Result<ConfigDocument, String> {
    let cwd = checked_workspace(&request.cwd)?;
    let (path, label, language) = config_path(&request.id, &cwd)?;
    let content = if request.id == "config" && path.is_file() {
        let existing = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
        merge_config_secrets_from_existing(&existing, &request.content)?
    } else if request.id == "config" && config_contains_redacted_secret(&request.content) {
        return Err("新配置不能只含脱敏占位符，请填写真实 API Key".into());
    } else {
        request.content.clone()
    };
    if request.id == "config" {
        // This is the same TOML parser used before Grox mutates provider
        // settings. Reject malformed TOML at the editor boundary so a save can
        // never silently leave the CLI with an unreadable global config.
        parse_grok_config_document(&content)?;
    }
    if matches!(request.id.as_str(), "config" | "system-prompt") {
        atomic_write_private(&path, &content)?;
    } else {
        atomic_write(&path, &content)?;
    }
    let id: &'static str = match request.id.as_str() {
        "config" => "config",
        "system-prompt" => "system-prompt",
        "agents" => "agents",
        _ => return Err("未知配置文档".into()),
    };
    Ok(ConfigDocument {
        id,
        label,
        path: path_for_webview(&path),
        content: if id == "config" {
            redact_config_document_secrets(&content)
        } else {
            content
        },
        exists: true,
        language,
        overlay: (id == "config").then(config_overlay_metadata),
    })
}

fn provider_service_raw() -> Result<ProviderService, String> {
    provider_service::open_current(grok_home()?)
}

fn map_provider_service_error(error: ProviderServiceError) -> HostError {
    match error.kind {
        ProviderServiceErrorKind::Operation => HostError::operation(error.code, error.message),
        ProviderServiceErrorKind::Protocol => HostError::protocol_with_action(
            error.code,
            error.message,
            error.action.unwrap_or("重新选择供应商后重试"),
        ),
        ProviderServiceErrorKind::Storage => HostError::recoverable_environment(
            error.code,
            error.message,
            error
                .action
                .unwrap_or("检查系统凭据库和 ~/.grok 的访问权限后重试"),
        ),
    }
}

fn provider_service() -> Result<ProviderService, HostError> {
    provider_service_raw().map_err(|error| {
        HostError::recoverable_environment(
            "PROVIDER_HOME_UNAVAILABLE",
            error,
            "检查 ~/.grok 的访问权限后重试",
        )
    })
}

#[tauri::command]
fn list_provider_profiles() -> Result<ProviderProfilesResponse, HostError> {
    let snapshot = provider_service()?
        .list()
        .map_err(map_provider_service_error)?;
    Ok(ProviderProfilesResponse {
        active_id: snapshot.active_id,
        profiles: snapshot.profiles,
    })
}

#[tauri::command]
fn save_provider_profile(
    request: SaveProviderProfile,
) -> Result<ProviderProfileSummary, HostError> {
    provider_service()?
        .save(SaveProviderProfileInput {
            id: request.id,
            name: request.name,
            api_key: request.api_key,
            base_url: request.base_url,
            allow_insecure_http: request.allow_insecure_http,
            api_backend: request.api_backend,
            resident_models: request.resident_models,
        })
        .map_err(map_provider_service_error)
}

async fn fetch_compatible_models(
    api_key: &str,
    base_url: &str,
    allow_insecure_http: bool,
) -> Result<Vec<String>, HostError> {
    let key = checked_api_key(api_key.trim())
        .map_err(|error| HostError::operation("PROVIDER_API_KEY_INVALID", error))?;
    if key.is_empty() {
        return Err(HostError::operation(
            "PROVIDER_API_KEY_REQUIRED",
            "API Key 不能为空",
        ));
    }
    let endpoint = compatible_models_url(
        base_url,
        allow_insecure_http,
        normalize_provider_endpoint,
    )
    .map_err(|error| HostError::operation("PROVIDER_URL_INVALID", error))?;
    let mut response = reqwest::Client::builder()
        .user_agent(format!("Grox/{CLIENT_VERSION}"))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.error("provider redirect limit exceeded");
            }
            let url = attempt.url();
            let allowed = match url.scheme() {
                "https" => !is_blocked_service_host(url.host_str()),
                "http" => {
                    !is_blocked_service_host(url.host_str())
                        && (is_loopback_host(url.host_str()) || allow_insecure_http)
                }
                _ => false,
            };
            if allowed {
                attempt.follow()
            } else {
                attempt.error("provider redirect refused")
            }
        }))
        .build()
        .map_err(|error| {
            HostError::recoverable_environment(
                "PROVIDER_HTTP_CLIENT_FAILED",
                format!("无法创建模型目录客户端：{error}"),
                "检查系统网络与 TLS 配置后重试",
            )
        })?
        .get(endpoint)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            HostError::recoverable_environment(
                "PROVIDER_MODELS_REQUEST_FAILED",
                format!("无法获取模型列表：{error}"),
                "检查服务地址、网络与代理配置后重试",
            )
        })?
        .error_for_status()
        .map_err(|error| {
            HostError::protocol_with_action(
                "PROVIDER_MODELS_HTTP_ERROR",
                format!("模型服务返回错误：{error}"),
                "检查 API Key、服务地址和网关的 /models 路由",
            )
        })?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_MODELS_BODY_BYTES as u64)
    {
        return Err(HostError::protocol(
            "PROVIDER_MODELS_RESPONSE_TOO_LARGE",
            format!(
                "模型列表响应超过 {} MB 上限",
                MAX_PROVIDER_MODELS_BODY_BYTES / 1024 / 1024
            ),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| {
            HostError::recoverable_environment(
                "PROVIDER_MODELS_READ_FAILED",
                format!("无法读取模型列表：{error}"),
                "检查网络稳定性后重试",
            )
        })?
    {
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_MODELS_BODY_BYTES {
            return Err(HostError::protocol(
                "PROVIDER_MODELS_RESPONSE_TOO_LARGE",
                format!(
                    "模型列表响应超过 {} MB 上限",
                    MAX_PROVIDER_MODELS_BODY_BYTES / 1024 / 1024
                ),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let response: OpenAiModelsResponse = serde_json::from_slice(&body).map_err(|error| {
        HostError::protocol_with_action(
            "PROVIDER_MODELS_INVALID_RESPONSE",
            format!("模型列表不是 OpenAI 兼容格式：{error}"),
            "确认网关的 /models 返回 OpenAI 兼容 JSON",
        )
    })?;
    let mut models = response
        .data
        .into_iter()
        .map(|model| model.id)
        .filter(|id| {
            !id.is_empty() && id.chars().count() <= 200 && !id.chars().any(char::is_control)
        })
        .collect::<Vec<_>>();
    models.sort_by_key(|model| model.to_ascii_lowercase());
    models.dedup();
    models.truncate(1_000);
    Ok(models)
}

#[tauri::command]
async fn fetch_provider_models(request: FetchProviderModels) -> Result<Vec<String>, HostError> {
    fetch_compatible_models(
        &request.api_key,
        &request.base_url,
        request.allow_insecure_http,
    )
    .await
}

#[tauri::command]
async fn refresh_provider_models(id: String) -> Result<ProviderProfileSummary, HostError> {
    let service = provider_service()?;
    let target = service
        .prepare_refresh(&id)
        .map_err(map_provider_service_error)?;
    let models = fetch_compatible_models(
        target.api_key(),
        target.base_url(),
        target.allow_insecure_http(),
    )
    .await?;
    service
        .commit_refresh(target, models)
        .map_err(map_provider_service_error)
}

#[tauri::command]
fn activate_provider_profile(id: String) -> Result<(), HostError> {
    provider_service()?
        .activate(&id)
        .map_err(map_provider_service_error)
}

#[tauri::command]
fn delete_provider_profile(id: String) -> Result<(), HostError> {
    provider_service()?
        .delete(&id)
        .map_err(map_provider_service_error)
}

#[tauri::command]
fn read_provider_status() -> Result<ProviderStatus, HostError> {
    let status = provider_service()?
        .status()
        .map_err(map_provider_service_error)?;
    Ok(ProviderStatus {
        kind: status.kind,
        has_api_key: status.has_api_key,
        base_url: status.base_url,
        secret_backend: status.secret_backend,
    })
}

#[tauri::command]
fn configure_provider(request: ProviderConfig) -> Result<(), HostError> {
    provider_service()?
        .configure(ConfigureProviderInput {
            kind: request.kind,
            api_key: request.api_key,
            base_url: request.base_url,
        })
        .map_err(map_provider_service_error)
}



#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = parse_browser_url(&url)?;
    spawn_system_browser(&parsed)
}

#[tauri::command]
fn open_media_external(url: String) -> Result<(), String> {
    let parsed = parse_browser_url(&url).map_err(|error| format!("无效媒体链接：{error}"))?;
    if parsed.scheme() == "https" && !is_media_https_host_allowed(parsed.host_str()) {
        return Err("媒体链接域名不在允许列表中".into());
    }
    spawn_system_browser(&parsed)
}



#[cfg(windows)]
fn register_computer_emergency_shortcut(app: tauri::AppHandle) {
    std::thread::spawn(move || unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::{
            Input::KeyboardAndMouse::{
                RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL,
                MOD_NOREPEAT, VK_ESCAPE,
            },
            WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY},
        };

        const HOTKEY_ID: i32 = 0x4752;
        let modifiers = HOT_KEY_MODIFIERS(MOD_ALT.0 | MOD_CONTROL.0 | MOD_NOREPEAT.0);
        if RegisterHotKey(HWND::default(), HOTKEY_ID, modifiers, VK_ESCAPE.0 as u32).is_err() {
            let _ = app.emit("computer-emergency-shortcut-status", false);
            return;
        }
        let _ = app.emit("computer-emergency-shortcut-status", true);
        let mut message = MSG::default();
        while GetMessageW(&mut message, HWND::default(), 0, 0).0 > 0 {
            if message.message == WM_HOTKEY && message.wParam.0 == HOTKEY_ID as usize {
                let _ = app.emit("computer-emergency-shortcut", ());
            }
        }
        let _ = UnregisterHotKey(HWND::default(), HOTKEY_ID);
    });
}

#[cfg(not(windows))]
fn register_computer_emergency_shortcut(app: tauri::AppHandle) {
    let _ = app.emit("computer-emergency-shortcut-status", false);
}



#[tauri::command]
async fn agent_runtime_connect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    cwd: String,
    reasoning_effort: Option<String>,
    force_reconnect: Option<bool>,
) -> Result<AgentRuntimeConnection, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    let force_reconnect = force_reconnect.unwrap_or(false);
    if force_reconnect {
        state.cancel_automatic_reconnect();
    }
    ensure_agent_runtime_ready(
        &app,
        state.inner(),
        leases.inner(),
        cwd,
        reasoning_effort,
        force_reconnect,
    )
    .await
}










/// 返回当前 Host 代次仍待用户处理的交互门控。WebView 重载后用它恢复
/// 界面投影，但拿不到 rpc id，因此旧页面状态不能伪造协议回复。
#[tauri::command]
fn interaction_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<Vec<InteractionProjection>, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    Ok(state.interactions.snapshots())
}

/// 原子领取并回复一个 Host 持有的交互门控。调用方只能提供不透明 block id
/// 和用户决定；session、rpc id、wire option 与代次都从 Host 状态取回。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveInteractionResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    audit_warning: Option<AcpHostError>,
}

#[tauri::command]
async fn resolve_interaction(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    session_id: String,
    block_id: String,
    decision: serde_json::Value,
) -> Result<ResolveInteractionResult, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    let _write_guard = state.interactions.lock_writes().await;
    let lease = state
        .interactions
        .claim_resolution(&session_id, &block_id, &decision)?;
    let line = match prepare_acp_line(lease.line.clone(), leases.inner()) {
        Ok(line) => line,
        Err(error) => {
            state.interactions.release_claim(&lease);
            return Err(AcpHostError::protocol(
                "INTERACTION_RESPONSE_INVALID",
                error,
            ));
        }
    };
    state
        .foreground_turns
        .observe_outbound(lease.generation, &line);
    if let Err(error) = write_acp_line(state.inner(), &line, lease.generation).await {
        // stdin 写失败后无法证明回复是否到达，绝不自动重发批准决定。
        state.interactions.settle(&lease);
        if let Some(audit) = lease.permission_audit.as_ref() {
            if let Err(audit_error) = permission_audit::append(
                &host_prefs_dir_for_app(window.app_handle()),
                audit,
                "delivery_unknown",
            ) {
                tracing::error!(
                    target: "grox::permission",
                    session_id = %lease.session_id,
                    block_id = %lease.block_id,
                    error = %audit_error,
                    "interaction delivery and audit both uncertain"
                );
            }
        }
        let _ = window.emit(
            "interaction-closed",
            serde_json::json!({
                "sessionId": lease.session_id,
                "blockId": lease.block_id,
                "kind": lease.kind,
                "reason": "write_failed",
            }),
        );
        return Err(AcpHostError::environment(
            "INTERACTION_RESPONSE_FAILED",
            error,
            false,
            true,
            "重新连接 Agent；等待它发出新的权限或提问请求",
        ));
    }
    if !state.interactions.settle(&lease) {
        return Err(AcpHostError::operation(
            "INTERACTION_EXPIRED",
            "交互请求在回复期间已失效",
        ));
    }
    let audit_warning = lease.permission_audit.as_ref().and_then(|audit| {
        permission_audit::append(
            &host_prefs_dir_for_app(window.app_handle()),
            audit,
            "delivered",
        )
        .err()
        .map(|error| {
            AcpHostError::environment(
                "PERMISSION_AUDIT_WRITE_FAILED",
                error,
                false,
                false,
                "权限决定已送达；请检查应用数据目录的空间和权限",
            )
        })
    });
    tracing::info!(
        target: "grox::permission",
        session_id = %lease.session_id,
        block_id = %lease.block_id,
        generation = lease.generation,
        kind = lease.kind,
        audit_warning = audit_warning.is_some(),
        "Host interaction resolved"
    );
    Ok(ResolveInteractionResult { audit_warning })
}

/// 发送 ACP 请求并在原生 Host 内等待其响应。响应不再广播给所有 WebView。
#[tauri::command]
async fn acp_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    line: String,
    request_id: u64,
    generation: u64,
    timeout_ms: u64,
    gate_token: Option<u64>,
) -> Result<String, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    acp_request_inner(
        state.inner(),
        leases.inner(),
        line,
        request_id,
        generation,
        timeout_ms,
        gate_token,
    )
    .await
}







#[tauri::command]
async fn acp_kill(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
) -> Result<(), AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    state.cancel_automatic_reconnect();
    let _connect_guard = state.connect_lock.lock().await;
    state.ready_generation.store(0, Ordering::Release);
    state.paused_generation.store(0, Ordering::Release);
    state.clear_cached_connection(None);
    state.set_runtime_phase(RuntimePhase::Stopped);
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
    state.authentication.reset(AcpHostError::operation(
        "AUTH_CANCELLED",
        "Agent 已停止，登录同步取消",
    ));
    state.foreground_turns.reset(generation);
    state.interactions.reset(generation);
    state.client_callbacks.reset(generation).await;
    state.sessions.reset(generation);
    state
        .requests
        .reject_all(AcpHostError::operation(
            "ACP_REQUEST_CANCELLED",
            "Grok Agent 已停止",
        ))
        .await;
    shutdown_all_mcp_resources(leases.inner());
    if let Some(process) = state.process.lock().await.take() {
        terminate_process(process).await;
        let _ = app.emit(
            "acp-exit",
            AcpExitPayload {
                code: None,
                reason: "killed",
                affected_session_ids: Vec::new(),
                interrupted_session_ids: Vec::new(),
            },
        );
    }
    state.set_runtime_phase(RuntimePhase::Stopped);
    Ok(())
}

fn release_version(value: &str) -> Result<semver::Version, String> {
    semver::Version::parse(value.trim().trim_start_matches(['v', 'V']))
        .map_err(|error| format!("无法解析版本号 {value:?}：{error}"))
}

fn update_available(current: &str, latest: &str) -> Result<bool, String> {
    Ok(release_version(latest)? > release_version(current)?)
}

fn previous_release<'a>(current: &str, releases: &'a [GitHubRelease]) -> Option<&'a GitHubRelease> {
    let current = release_version(current).ok()?;
    releases
        .iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let version = release_version(&release.tag_name).ok()?;
            (version < current && version.pre.is_empty()).then_some((version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, release)| release)
}

fn update_asset_matches(name: &str, platform: &str, architecture: &str) -> bool {
    let name = name.to_ascii_lowercase();
    match platform {
        "windows" => {
            let architecture = if architecture == "aarch64" {
                "arm64"
            } else {
                "x64"
            };
            name.ends_with("-setup.exe") && name.contains(architecture)
        }
        "macos" => {
            let architecture_matches = if architecture == "aarch64" {
                name.contains("aarch64") || name.contains("arm64")
            } else {
                name.contains("x64") || name.contains("x86_64")
            };
            name.ends_with(".dmg") && architecture_matches
        }
        _ => false,
    }
}

fn update_asset(release: &GitHubRelease) -> Option<&GitHubAsset> {
    release.assets.iter().find(|asset| {
        update_asset_matches(&asset.name, std::env::consts::OS, std::env::consts::ARCH)
    })
}

async fn latest_release() -> Result<GitHubRelease, String> {
    reqwest::Client::builder()
        .user_agent(format!("Grox/{CLIENT_VERSION}"))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法创建更新客户端：{error}"))?
        .get(LATEST_RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("无法检查更新：{error}"))?
        .error_for_status()
        .map_err(|error| format!("更新服务返回错误：{error}"))?
        .json::<GitHubRelease>()
        .await
        .map_err(|error| format!("无法读取更新信息：{error}"))
}

async fn release_history() -> Result<Vec<GitHubRelease>, String> {
    let releases = reqwest::Client::builder()
        .user_agent(format!("Grox/{CLIENT_VERSION}"))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法创建更新客户端：{error}"))?
        .get(RELEASES_URL)
        .query(&[("per_page", "30")])
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("无法检查更新历史：{error}"))?
        .error_for_status()
        .map_err(|error| format!("更新历史服务返回错误：{error}"))?
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|error| format!("无法读取更新历史：{error}"))?;
    Ok(releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .collect())
}

fn update_info(release: &GitHubRelease) -> UpdateInfo {
    let asset_name = update_asset(release).map(|asset| asset.name.clone());
    let latest_version = release.tag_name.trim().trim_start_matches(['v', 'V']);
    let notes = release
        .body
        .as_deref()
        .unwrap_or_default()
        .chars()
        .take(12_000)
        .collect::<String>();
    UpdateInfo {
        current_version: CLIENT_VERSION.to_string(),
        latest_version: latest_version.to_string(),
        title: release
            .name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| latest_version)
            .to_string(),
        notes,
        release_url: release.html_url.clone(),
        published_at: release.published_at.clone(),
        installable: asset_name.is_some(),
        asset_name,
        requires_xattr: cfg!(target_os = "macos"),
    }
}

fn release_summary(release: &GitHubRelease) -> ReleaseSummary {
    let version = release.tag_name.trim().trim_start_matches(['v', 'V']);
    ReleaseSummary {
        version: version.to_string(),
        title: release
            .name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| version)
            .to_string(),
        notes: release
            .body
            .as_deref()
            .unwrap_or_default()
            .chars()
            .take(3_000)
            .collect(),
        release_url: release.html_url.clone(),
        published_at: release.published_at.clone(),
        installable: update_asset(release).is_some(),
    }
}

#[tauri::command]
async fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    let release = latest_release().await?;

    if !update_available(CLIENT_VERSION, &release.tag_name)? {
        return Ok(None);
    }
    Ok(Some(update_info(&release)))
}

#[tauri::command]
async fn get_update_status() -> Result<UpdateStatus, String> {
    // This desktop target intentionally uses a minimal Tokio feature set, so
    // keep the two lightweight GitHub requests sequential instead of relying
    // on `tokio::try_join!` (which is not compiled into this build).
    let latest = latest_release().await?;
    let releases = release_history().await?;
    let rollback = previous_release(CLIENT_VERSION, &releases).map(release_summary);
    let mut history = releases
        .iter()
        .take(8)
        .map(release_summary)
        .collect::<Vec<_>>();
    if !history.iter().any(|release| release.version == latest.tag_name.trim().trim_start_matches(['v', 'V'])) {
        history.insert(0, release_summary(&latest));
    }
    Ok(UpdateStatus {
        current_version: CLIENT_VERSION.to_string(),
        update_available: update_available(CLIENT_VERSION, &latest.tag_name)?,
        latest: update_info(&latest),
        history,
        rollback,
    })
}

fn update_temp_dir(version: &str) -> Result<PathBuf, String> {
    let safe_version = release_version(version)?.to_string();
    let directory = std::env::temp_dir().join(format!(
        "grox-update-{safe_version}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建更新临时目录：{error}"))?;
    Ok(directory)
}

fn is_trusted_github_download_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "github.com"
        || host == "objects.githubusercontent.com"
        || host == "release-assets.githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

async fn download_update_asset(asset: &GitHubAsset, target: &Path) -> Result<(), String> {
    use sha2::{Digest as _, Sha256};

    if asset.size == 0 || asset.size > 250 * 1024 * 1024 {
        return Err("更新安装包大小异常".into());
    }
    let url = url::Url::parse(&asset.browser_download_url)
        .map_err(|error| format!("无效的更新下载地址：{error}"))?;
    if url.scheme() != "https" || !is_trusted_github_download_host(url.host_str()) {
        return Err("更新安装包不是来自受信任的 GitHub 发布地址".into());
    }
    let response = reqwest::Client::builder()
        .user_agent(format!("Grox/{CLIENT_VERSION}"))
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https"
                && is_trusted_github_download_host(attempt.url().host_str())
            {
                attempt.follow()
            } else {
                attempt.error(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "更新下载重定向到了不受信任的主机",
                ))
            }
        }))
        .build()
        .map_err(|error| format!("无法创建更新下载客户端：{error}"))?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("无法下载更新：{error}"))?
        .error_for_status()
        .map_err(|error| format!("更新下载失败：{error}"))?;
    if response
        .content_length()
        .is_some_and(|size| size > 250 * 1024 * 1024)
    {
        return Err("更新安装包超过 250 MB".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("无法读取更新安装包：{error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > 250 * 1024 * 1024 {
        return Err("下载到的更新安装包大小异常".into());
    }
    let expected_digest = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .ok_or_else(|| "GitHub Release 未提供安装包 SHA-256，已拒绝自动安装".to_string())?;
    let actual_digest = format!("{:x}", Sha256::digest(&bytes));
    if !actual_digest.eq_ignore_ascii_case(expected_digest) {
        return Err("更新安装包 SHA-256 校验失败，已取消安装".into());
    }
    fs::write(target, bytes).map_err(|error| format!("无法保存更新安装包：{error}"))
}

#[cfg(target_os = "windows")]
fn launch_update_helper(
    app: &tauri::AppHandle,
    installer: &Path,
    work: &Path,
) -> Result<(), String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位当前 Grox：{error}"))?;
    let script = work.join("install-update.ps1");
    fs::write(
        &script,
        r#"param([int]$GroxPid, [string]$Installer, [string]$AppPath, [string]$WorkDir)
Wait-Process -Id $GroxPid -ErrorAction SilentlyContinue
$process = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
if ($process.ExitCode -eq 0 -and (Test-Path -LiteralPath $AppPath)) {
  Start-Process -FilePath $AppPath
}
Start-Sleep -Seconds 2
Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
"#,
    )
    .map_err(|error| format!("无法创建更新辅助脚本：{error}"))?;
    use std::os::windows::process::CommandExt as _;
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(&script)
        .arg("-GroxPid")
        .arg(std::process::id().to_string())
        .arg("-Installer")
        .arg(installer)
        .arg("-AppPath")
        .arg(executable)
        .arg("-WorkDir")
        .arg(work)
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|error| format!("无法启动更新安装程序：{error}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn current_app_bundle() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位当前 Grox：{error}"))?;
    executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(Path::to_path_buf)
        .ok_or_else(|| "当前 Grox 不是从 .app 应用包运行，无法自动替换".into())
}

#[cfg(target_os = "macos")]
fn launch_update_helper(
    app: &tauri::AppHandle,
    installer: &Path,
    work: &Path,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    let target = current_app_bundle()?;
    let script = work.join("install-update.sh");
    fs::write(
        &script,
        r#"#!/bin/sh
set -u
GROX_PID="$1"
DMG="$2"
TARGET="$3"
WORK="$4"
while kill -0 "$GROX_PID" 2>/dev/null; do sleep 0.25; done
MOUNT="$WORK/mount"
BACKUP="$WORK/Grox-backup.app"
mkdir -p "$MOUNT"
cleanup() {
  /usr/bin/hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT
/usr/bin/hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet || exit 20
SOURCE="$(/usr/bin/find "$MOUNT" -maxdepth 1 -type d -name '*.app' -print -quit)"
[ -n "$SOURCE" ] || exit 21
PARENT="$(/usr/bin/dirname "$TARGET")"
if [ -w "$PARENT" ]; then
  [ ! -e "$TARGET" ] || /usr/bin/ditto "$TARGET" "$BACKUP"
  /bin/rm -rf "$TARGET"
  if ! /usr/bin/ditto "$SOURCE" "$TARGET"; then
    [ ! -e "$BACKUP" ] || /usr/bin/ditto "$BACKUP" "$TARGET"
    exit 22
  fi
  /usr/bin/xattr -dr com.apple.quarantine "$TARGET" || exit 23
else
  export GROX_UPDATE_SOURCE="$SOURCE" GROX_UPDATE_TARGET="$TARGET" GROX_UPDATE_BACKUP="$BACKUP"
  /usr/bin/osascript <<'APPLESCRIPT' || exit 24
set sourcePath to system attribute "GROX_UPDATE_SOURCE"
set targetPath to system attribute "GROX_UPDATE_TARGET"
set backupPath to system attribute "GROX_UPDATE_BACKUP"
set commandText to "/usr/bin/ditto " & quoted form of targetPath & " " & quoted form of backupPath & " 2>/dev/null || true; /bin/rm -rf " & quoted form of targetPath & "; if /usr/bin/ditto " & quoted form of sourcePath & " " & quoted form of targetPath & "; then /usr/bin/xattr -dr com.apple.quarantine " & quoted form of targetPath & "; else /usr/bin/ditto " & quoted form of backupPath & " " & quoted form of targetPath & "; exit 1; fi"
do shell script commandText with administrator privileges
APPLESCRIPT
fi
/usr/bin/open "$TARGET"
sleep 2
/bin/rm -rf "$WORK"
"#,
    )
    .map_err(|error| format!("无法创建 macOS 更新辅助脚本：{error}"))?;
    let mut permissions = fs::metadata(&script)
        .map_err(|error| format!("无法读取更新脚本权限：{error}"))?
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&script, permissions)
        .map_err(|error| format!("无法设置更新脚本权限：{error}"))?;
    std::process::Command::new("/bin/sh")
        .arg(&script)
        .arg(std::process::id().to_string())
        .arg(installer)
        .arg(target)
        .arg(work)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动 macOS 更新安装程序：{error}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn launch_update_helper(
    _app: &tauri::AppHandle,
    _installer: &Path,
    _work: &Path,
) -> Result<(), String> {
    Err("当前平台暂不支持一键更新".into())
}

async fn install_release(
    app: &tauri::AppHandle,
    version: &str,
    release: &GitHubRelease,
) -> Result<(), String> {
    let asset =
        update_asset(release).ok_or_else(|| "此版本没有适用于当前系统的安装包".to_string())?;
    let work = update_temp_dir(version)?;
    let installer = work.join(&asset.name);
    if let Err(error) = download_update_asset(asset, &installer).await {
        let _ = fs::remove_dir_all(&work);
        return Err(error);
    }
    launch_update_helper(app, &installer, &work)
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let expected = release_version(&version)?;
    let release = latest_release().await?;
    if release_version(&release.tag_name)? != expected
        || expected <= release_version(CLIENT_VERSION)?
    {
        return Err("更新版本已变化，请重新检查更新".into());
    }
    install_release(&app, &version, &release).await
}

#[tauri::command]
async fn rollback_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let expected = release_version(&version)?;
    let releases = release_history().await?;
    let release = previous_release(CLIENT_VERSION, &releases)
        .ok_or_else(|| "没有可回退的正式版本".to_string())?;
    if release_version(&release.tag_name)? != expected {
        return Err("可回退版本已变化，请重新检查更新日志".into());
    }
    install_release(&app, &version, release).await
}

fn main_window_close_keeps_host_alive(app: &tauri::AppHandle) -> bool {
    let any_enabled_automation = match automations_path(app).and_then(|path| {
        app.state::<AutomationStore>()
            .any_enabled(&path, AUTOMATIONS_MAX_BYTES)
    }) {
        Ok(enabled) => enabled,
        Err(error) => {
            // 读不到权威排程时不能通过关闭窗口冒险杀掉可能存在的任务。
            tracing::error!(target: "grox::automation", error = %error, "automation state unreadable; keeping Host alive");
            true
        }
    };
    let state = app.state::<Arc<AcpState>>();
    let occupancy = state.sessions.snapshot();
    let host_busy = !occupancy.active_turn_session_ids.is_empty()
        || occupancy.lifecycle_active
        || occupancy.pending_lifecycle > 0
        || state.authentication.is_active()
        || app.state::<AutomationRunner>().is_dispatching();
    automation_runner::should_keep_process_alive_on_close(any_enabled_automation, host_busy)
}

async fn shutdown_host(app: &tauri::AppHandle) {
    let state = app.state::<Arc<AcpState>>().inner().clone();
    state.cancel_automatic_reconnect();
    let _connect_guard = state.connect_lock.lock().await;
    state.authentication.reset(AcpHostError::operation(
        "AUTH_CANCELLED",
        "Grox 正在退出，登录已取消",
    ));
    state.ready_generation.store(0, Ordering::Release);
    state.paused_generation.store(0, Ordering::Release);
    state.clear_cached_connection(None);
    state.set_runtime_phase(RuntimePhase::Stopped);
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
    state.foreground_turns.reset(generation);
    state.interactions.reset(generation);
    state.client_callbacks.reset(generation).await;
    state.sessions.reset(generation);
    state
        .requests
        .reject_all(AcpHostError::environment(
            "ACP_HOST_EXITING",
            "Grox 正在退出，ACP 请求已停止",
            true,
            true,
            "重新打开 Grox 后检查最后一轮结果",
        ))
        .await;
    shutdown_all_mcp_resources(app.state::<Arc<McpLeaseStore>>().inner());
    if let Some(process) = state.process.lock().await.take() {
        terminate_process(process).await;
    }
    let preview_state = app.state::<Arc<PreviewState>>();
    if let Some(mut process) = preview_state.process.lock().await.take() {
        let _ = process.child.kill().await;
        let _ = process.child.wait().await;
    };
}

pub(crate) fn request_host_exit(app: tauri::AppHandle) {
    let shutdown = app.state::<AppShutdown>();
    if shutdown.started.swap(true, Ordering::AcqRel) {
        return;
    }
    app.state::<Arc<AcpState>>().cancel_automatic_reconnect();
    tauri::async_runtime::spawn(async move {
        if tokio::time::timeout(Duration::from_secs(5), shutdown_host(&app))
            .await
            .is_err()
        {
            // 显式退出不能因为损坏的子进程或 callback 永久卡住；所有 child
            // 都启用了 kill_on_drop，进程退出仍会完成最后的操作系统级回收。
            tracing::warn!(target: "grox::host", "Host shutdown cleanup exceeded five seconds");
        }
        app.exit(0);
    });
}

fn main() {
    let process_args = std::env::args().collect::<Vec<_>>();
    #[cfg(debug_assertions)]
    if mock_acp_fixture::try_run(&process_args) {
        return;
    }
    if process_args
        .iter()
        .any(|argument| argument == "--computer-mcp")
    {
        let lease_id = process_args
            .windows(2)
            .find(|pair| pair[0] == "--computer-lease")
            .map(|pair| pair[1].clone());
        if let Err(error) = computer_mcp::run(lease_id) {
            eprintln!("grox-computer-mcp: {error}");
            std::process::exit(1);
        }
        return;
    }
    // One-time repair for builds that generated per-model provider overrides.
    // Restore only the provider fields Grox previously touched, then align
    // transport overrides with the managed environment.
    match provider_service_raw() {
        Ok(service) => {
            if let Err(error) = service.restore_legacy_auth_overrides() {
                eprintln!("grox: 无法迁移旧版供应商模型覆盖：{error}");
            }
            if let Err(error) = service.synchronize_active_backend() {
                eprintln!("grox: 无法同步当前供应商的协议覆盖：{error}");
            }
        }
        Err(error) => eprintln!("grox: 无法初始化供应商服务：{error}"),
    }
    let window_state_flags = tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::MAXIMIZED;
    tauri::Builder::default()
        // 必须最先注册：第二次启动只唤醒主窗口，不能再创建一套会话、
        // 自动化 runner 和进程内持久化锁去覆盖同一批 Host 文件。
        .plugin(tauri_plugin_single_instance::init(|app, _arguments, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .build(),
        )
        .manage(Arc::new(AcpState::default()))
        .manage(Arc::new(PreviewState::default()))
        .manage(Arc::new(FilePreviewState::default()))
        .manage(Arc::new(McpLeaseStore::default()))
        .manage(Arc::new(GitConfirmStore::default()))
        .manage(SessionStorageState::default())
        .manage(DraftStore::default())
        .manage(PromptQueueStore::default())
        .manage(AutomationStore::default())
        .manage(WorktreeOwnershipStore::default())
        .manage(AutomationRunner::default())
        .manage(Arc::new(MediaService::default()))
        .manage(AppShutdown::default())
        .setup(|app| {
            match app.path().app_log_dir() {
                Ok(path) => {
                    if let Err(error) = host_logging::init(path) {
                        eprintln!("grox: {error}");
                    }
                }
                Err(error) => eprintln!("grox: 无法定位 Host 日志目录：{error}"),
            }
            tracing::info!(
                target: "grox::host",
                version = CLIENT_VERSION,
                pid = std::process::id(),
                "Grox Host starting"
            );
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(icon)?;
            }
            tray::setup(app.handle()).map_err(std::io::Error::other)?;
            register_computer_emergency_shortcut(app.handle().clone());
            app.state::<AutomationRunner>().start(app.handle().clone());
            if let Err(error) = restore_job_journal(
                app.handle(),
                app.state::<Arc<MediaService>>().inner(),
            ) {
                tracing::error!(target: "grox::media", error = %error, "media journal restore failed");
            }
            if let Err(error) = media_service::scrub_reference_cache(app.handle()) {
                tracing::warn!(target: "grox::media", error = %error, "media reference cache scrub failed");
            }
            let coordinator = app.state::<Arc<AcpState>>().sessions.clone();
            let mut occupancy = coordinator.subscribe();
            let occupancy_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while occupancy.changed().await.is_ok() {
                    let payload = occupancy.borrow_and_update().clone();
                    let _ = occupancy_app.emit("session-runtime-occupancy", payload);
                }
            });
            // Never block setup (window interactivity) on disk / provisioning.
            // These can take seconds with large session-cache dirs and freeze
            // the first 2–3s of operator input.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = provision_grox_deep_research_workflow() {
                    tracing::warn!(target: "grox::workflow", error = %error, "workflow provisioning failed");
                }
                // Crash leftovers may live in either the v1 journal tree or the
                // legacy flat cache while migration is still pending.
                match scrub_session_journal_dirs(&handle, Duration::from_secs(30)) {
                    Ok(removed) if removed > 0 => {
                        tracing::info!(target: "grox::persistence", removed, "orphan session journals scrubbed");
                    }
                    Err(error) => tracing::warn!(target: "grox::persistence", error = %error, "session journal scrub failed"),
                    _ => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_environment,
            agent_runtime_status,
            replay_session_events,
            host_session_bindings,
            session_runtime_status,
            foreground_turn_status,
            session_gate_enter_lifecycle,
            session_gate_release,
            preview_session_from_disk,
            search_session_history,
            read_session_journal,
            write_session_journal,
            persist_session_tool_images,
            delete_session_journal,
            session_journal_status,
            read_draft,
            write_draft,
            delete_draft,
            read_prompt_queues,
            patch_prompt_queues,
            read_automations,
            patch_automations,
            agent_runtime_resume,
            agent_runtime_pause,
            automation_runner_status,
            run_automation_now,
            open_agent_session,
            fork_agent_session,
            fork_agent_session_in_worktree,
            close_agent_session,
            delete_agent_session,
            delete_session_data,
            delete_project_session_data,
            scrub_session_journal_orphans,
            validate_workspace,
            pick_workspace,
            list_workspace_files,
            git_summary,
            git_worktrees,
            git_worktree_add,
            git_worktree_remove,
            git_checkout,
            prepare_git_commit,
            prepare_git_push,
            prepare_git_worktree_remove,
            git_commit,
            git_push,
            read_preview_file,
            start_file_preview,
            read_prompt_image_paths,
            open_in_explorer,
            open_in_app,
            notify_desktop,
            reveal_in_explorer,
            create_permanent_worktree,
            open_file_with_default,
            open_file_with_application,
            list_open_applications,
            open_file_with_dialog,
            workspace_file_path,
            read_config_documents,
            write_config_document,
            read_provider_status,
            configure_provider,
            list_provider_profiles,
            save_provider_profile,
            fetch_provider_models,
            refresh_provider_models,
            activate_provider_profile,
            delete_provider_profile,
            grok_runtime_info,
            export_session_trace,
            export_session_support_bundle,
            reveal_support_bundle,
            install_official_grok_cli,
            check_for_update,
            get_update_status,
            install_update,
            rollback_update,
            open_external,
            open_media_external,
            start_project_preview,
            computer_use_env_enabled,
            host_prefs_get,
            host_prefs_migrate_computer_use,
            host_prefs_migrate_browser_use,
            host_prefs_set_computer_use,
            host_prefs_set_browser_use,
            host_prefs_set_permission_mode,
            computer_shutdown_all_leases,
            computer_emergency_stop_session,
            browser_shutdown_all_leases,
            save_media_reference,
            release_media_reference,
            start_media_generation,
            media_generation_capabilities,
            media_generation_status,
            media_generation_history,
            cancel_media_generation,
            open_media_artifact,
            agent_runtime_connect,
            agent_runtime_auth_status,
            agent_runtime_authenticate,
            agent_runtime_auth_cancel,
            execute_foreground_turn,
            cancel_foreground_turn,
            interaction_status,
            resolve_interaction,
            acp_request,
            acp_kill,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                if main_window_close_keeps_host_alive(window.app_handle()) {
                    tray::hide_main_window(window.app_handle());
                } else {
                    request_host_exit(window.app_handle().clone());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Grox Desktop")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !app.state::<AppShutdown>().started.load(Ordering::Acquire) {
                    api.prevent_exit();
                    request_host_exit(app.clone());
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } if !has_visible_windows => tray::show_main_window(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_sandbox::checked_workspace_target;
    use crate::provider_overrides::{
        apply_grox_provider_sections, clear_legacy_grox_metadata, config_value_item,
        legacy_grox_account_mode, model_table_mut, parse_grok_config_document,
        resolve_agent_model_id, restore_grox_provider_backend_overrides, set_models_default_model,
    };
    use crate::host_core::{
        acp_method_allowed, acp_read_file, acp_read_text_file, acp_wire_method,
        acp_write_text_file, atomic_orphan_final_name, atomic_orphan_writer_pid,
        build_acp_read_file, checked_read_file_with_roots, checked_reasoning_effort,
        cli_version_number, decode_host_acp_response, image_mime,
        RuntimeConnectSpec, UPSTREAM_CLI_CLIENT_NAME,
    };

    fn runtime_connection(generation: u64, auth_required: bool) -> AgentRuntimeConnection {
        AgentRuntimeConnection {
            generation,
            initialize: serde_json::json!({ "protocolVersion": 1 }),
            auth: agent_runtime::AgentAuthenticationState {
                required: auth_required,
                in_progress: false,
                method_id: auth_required.then(|| "grok.com".to_string()),
                label: auth_required.then(|| "Sign in to Grok".to_string()),
                error: None,
            },
        }
    }

    #[test]
    #[ignore = "set GROK_DESKTOP_CLI to an official binary for opt-in integration"]
    fn configured_grok_command_launches_opt_in_official_binary() {
        let configured = std::env::var_os("GROK_DESKTOP_CLI")
            .filter(|value| !value.is_empty())
            .expect("GROK_DESKTOP_CLI must point to the official test binary");
        let expected_path = PathBuf::from(configured).canonicalize().unwrap();
        let runtime = configured_grok_command();
        assert_eq!(runtime.source, "override");
        assert_eq!(PathBuf::from(&runtime.path).canonicalize().unwrap(), expected_path);
        let version = runtime.version.expect("configured binary must answer --version");
        let expected_version = std::env::var("GROK_EXPECTED_VERSION").unwrap_or_else(|_| "1.0.5".into());
        assert!(
            version.contains(&format!("grok {expected_version}")),
            "unexpected official CLI version: {version}"
        );
    }

    #[test]
    fn config_overlay_metadata_reports_likely_configured_source_without_inline_contents() {
        let inline = config_overlay_metadata_from(
            Some(std::ffi::OsString::from("{\"models\":{\"default\":\"secret-model-id\"}}")),
            Some(std::ffi::OsString::from("/fallback/config.toml")),
        );
        assert_eq!(inline.source, "inline");
        assert_eq!(inline.path, None);
        assert!(!serde_json::to_string(&inline).unwrap().contains("secret-model-id"));

        let path = config_overlay_metadata_from(
            Some(std::ffi::OsString::from("   ")),
            Some(std::ffi::OsString::from("/launcher/overlay.toml")),
        );
        assert_eq!(path.source, "path");
        assert!(path.path.as_deref().unwrap().ends_with("overlay.toml"));

        let path = config_overlay_metadata_from(
            Some(std::ffi::OsString::new()),
            Some(std::ffi::OsString::from("/launcher/overlay.toml")),
        );
        assert_eq!(path.source, "path");
        assert!(path.path.as_deref().unwrap().ends_with("overlay.toml"));

        assert_eq!(config_overlay_metadata_from(None, None).source, "none");
    }

    #[test]
    fn runtime_connection_cache_is_generation_scoped_and_tracks_authentication() {
        let state = AcpState::default();
        *state
            .connection
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(runtime_connection(7, true));

        assert!(state.cached_connection(6).is_none());
        assert!(state.cached_connection(7).unwrap().auth.required);
        let authenticated = agent_runtime::AgentAuthenticationState {
            required: false,
            in_progress: false,
            method_id: Some("grok.com".into()),
            label: Some("Sign in to Grok".into()),
            error: None,
        };
        assert!(!state.set_authentication_state(6, authenticated.clone()));
        assert!(state.cached_connection(7).unwrap().auth.required);
        assert!(state.set_authentication_state(7, authenticated));
        assert!(!state.cached_connection(7).unwrap().auth.required);

        state.clear_cached_connection(Some(6));
        assert!(state.cached_connection(7).is_some());
        state.clear_cached_connection(Some(7));
        assert!(state.cached_connection(7).is_none());
    }

    #[test]
    fn host_acp_request_ids_use_a_disjoint_javascript_safe_namespace() {
        let state = AcpState::default();
        let first = state.issue_host_request_id();
        let second = state.issue_host_request_id();
        assert!(first > (1_u64 << 52));
        assert!(second <= (1_u64 << 53) - 1);
        assert_eq!(second, first + 1);
    }

    #[test]
    fn runtime_pause_cannot_manufacture_a_ready_generation() {
        let state = AcpState::default();
        let error = tauri::async_runtime::block_on(state.pause_runtime()).unwrap_err();
        assert_eq!(error.code, "ACP_RUNTIME_NOT_READY");
        let error = tauri::async_runtime::block_on(state.resume_runtime(7)).unwrap_err();
        assert_eq!(error.code, "ACP_RUNTIME_RESUME_NOT_ALLOWED");
        assert_eq!(state.ready_generation.load(Ordering::Acquire), 0);
        assert_eq!(state.paused_generation.load(Ordering::Acquire), 0);
        assert_eq!(
            RuntimePhase::from_raw(state.runtime_phase.load(Ordering::Acquire)).as_str(),
            "stopped"
        );
    }

    #[test]
    fn runtime_supervisor_keeps_one_reconnect_owner_and_last_successful_spec() {
        let state = AcpState::default();
        state.remember_connect(RuntimeConnectSpec {
            cwd: "/workspace".into(),
            reasoning_effort: Some("high".into()),
        });
        let first = state.claim_automatic_reconnect().unwrap();
        assert!(state.claim_automatic_reconnect().is_none());
        let spec = state.last_connect().unwrap();
        assert_eq!(spec.cwd, "/workspace");
        assert_eq!(spec.reasoning_effort.as_deref(), Some("high"));
        state.cancel_automatic_reconnect();
        assert!(state.automatic_reconnect_cancelled(first));
        let second = state.claim_automatic_reconnect().unwrap();
        state.finish_automatic_reconnect(first);
        assert!(!state.automatic_reconnect_cancelled(second));
        state.finish_automatic_reconnect(second);
        assert!(state.claim_automatic_reconnect().is_some());
    }

    #[test]
    fn host_acp_response_decoder_preserves_protocol_failure_kind() {
        let error = decode_host_acp_response(
            r#"{"jsonrpc":"2.0","id":9,"error":{"code":-32602,"message":"invalid params"}}"#,
            9,
            "session/set_model",
        )
        .unwrap_err();
        assert_eq!(error.domain, "protocol");
        assert_eq!(error.code, "ACP_RPC_INVALID_PARAMS");
        assert!(error.message.contains("session/set_model"));
        assert_eq!(
            decode_host_acp_response(
                r#"{"jsonrpc":"2.0","id":10,"result":{"ok":true}}"#,
                10,
                "session/prompt",
            )
            .unwrap()["ok"],
            true
        );
    }

    fn test_release(tag_name: &str, draft: bool, prerelease: bool) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag_name.to_string(),
            name: None,
            body: None,
            html_url: format!("https://github.com/dandandujie/Grox/releases/tag/{tag_name}"),
            published_at: None,
            draft,
            prerelease,
            assets: Vec::new(),
        }
    }

    #[test]
    fn git_summary_includes_untracked_text_in_diff_stats() {
        let root = std::env::temp_dir().join(format!(
            "grox-git-summary-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        git_text(&root, &["init", "-b", "main"]).unwrap();
        git_text(&root, &["config", "user.name", "Grox Test"]).unwrap();
        git_text(&root, &["config", "user.email", "test@grox.local"]).unwrap();
        fs::write(root.join("README.md"), "old\n").unwrap();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        git_text(&root, &["add", "README.md", ".gitignore"]).unwrap();
        git_text(&root, &["commit", "-m", "init"]).unwrap();

        fs::write(root.join("README.md"), "new\nsecond\n").unwrap();
        fs::write(root.join("new.txt"), "one\ntwo\nthree").unwrap();
        fs::write(root.join("binary.dat"), [0_u8, 1, 2]).unwrap();
        fs::write(root.join("ignored.txt"), "hidden\n").unwrap();

        let summary = git_summary(path_for_webview(&root)).unwrap();
        assert_eq!(summary.changed_files, 3);
        assert_eq!(summary.added, 5);
        assert_eq!(summary.removed, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_disk_preview_keeps_recent_public_events() {
        let history = concat!(
            "{\"type\":\"system\",\"content\":\"hidden\"}\n",
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first\"}]}\n",
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"reminder\"}],\"synthetic_reason\":\"system_reminder\"}\n",
            "{\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"hidden reasoning\"}]}\n",
            "{\"type\":\"assistant\",\"content\":\"answer\",\"tool_calls\":[{\"id\":\"call-1\",\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}]}\n",
            "{\"type\":\"tool_result\",\"tool_call_id\":\"call-1\",\"content\":\"file body\"}\n",
            "{\"type\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call-1\",\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}]}\n",
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"latest\"}]}\n",
        );
        let preview = parse_session_disk_preview(std::io::Cursor::new(history), 3).unwrap();
        assert_eq!(
            preview,
            SessionDiskPreview {
                entries: vec![
                    SessionPreviewEntry::Message {
                        role: "assistant".into(),
                        text: "answer".into(),
                    },
                    SessionPreviewEntry::Tool {
                        id: "call-1".into(),
                        name: "read_file".into(),
                        title: "read_file".into(),
                        input: Some("{\"path\":\"README.md\"}".into()),
                        output: Some("file body".into()),
                        status: SessionPreviewToolStatus::Done,
                    },
                    SessionPreviewEntry::Message {
                        role: "user".into(),
                        text: "latest".into(),
                    },
                ],
                truncated: true,
            }
        );
    }
    #[test]
    fn atomic_write_replaces_without_delete_first_gap() {
        let root = std::env::temp_dir().join(format!(
            "grox-atomic-write-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("payload.json");
        atomic_write(&path, "{\"v\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"v\":1}");
        atomic_write(&path, "{\"v\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"v\":2}");
        // No lingering temps/baks for a clean replace.
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".grox-"))
            .collect();
        assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_journal_validation_binds_version_and_app_identity() {
        let valid = serde_json::json!({
            "version": 1,
            "appSessionId": "session-1",
            "agentSessionId": "session-1",
            "savedAt": 42,
            "turnState": "active",
            "session": { "id": "session-1", "blocks": [] }
        });
        assert!(
            session_journal_store::validate_current_journal(&valid.to_string(), "session-1")
                .is_ok()
        );

        let mut wrong_identity = valid.clone();
        wrong_identity["session"]["id"] = serde_json::json!("session-2");
        assert!(session_journal_store::validate_current_journal(
            &wrong_identity.to_string(),
            "session-1"
        )
        .is_err());

        let mut unknown_version = valid;
        unknown_version["version"] = serde_json::json!(2);
        assert!(session_journal_store::validate_current_journal(
            &unknown_version.to_string(),
            "session-1"
        )
        .is_err());
    }

    #[test]
    fn session_journal_storage_id_is_collision_free() {
        assert_eq!(safe_session_storage_id("019f-ab_cd"), Ok("019f-ab_cd"));
        assert!(safe_session_storage_id("../session").is_err());
        assert!(safe_session_storage_id("会话").is_err());
        assert!(safe_session_storage_id(&"x".repeat(81)).is_err());
    }

    #[test]
    fn tool_image_storage_uses_detected_mime_and_content_hash() {
        let png = b"\x89PNG\r\n\x1a\nminimal";
        let checked = checked_tool_image(ToolImagePayload {
            mime: "image/png".into(),
            data: BASE64.encode(png),
        })
        .unwrap();
        assert_eq!(checked.0, "image/png");
        assert!(checked.2.ends_with(".png"));
        assert!(checked_tool_image(ToolImagePayload {
            mime: "image/jpeg".into(),
            data: BASE64.encode(png),
        })
        .is_err());
    }

    #[test]
    fn deleted_session_storage_rejects_late_writes() {
        let storage = SessionStorageState::default();
        drop(storage.begin_write("session-1").unwrap());
        drop(storage.begin_delete("session-1").unwrap());
        assert!(storage.begin_write("session-1").is_err());
        assert!(storage
            .begin_write_ids(&["session-1".into(), "session-2".into()])
            .is_err());
        assert!(storage.begin_write("session-2").is_ok());
    }

    #[test]
    fn scrub_atomic_write_orphans_removes_tmp_and_aged_bak_when_final_exists() {
        let root = std::env::temp_dir().join(format!(
            "grox-scrub-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        // Foreign pid so age-0 scrub is allowed to touch the temp.
        let tmp = root.join(".x.json.grox-1-2.tmp");
        let bak = root.join(".x.json.grox-1-3.bak");
        let keep = root.join("x.json");
        fs::write(&tmp, b"tmp").unwrap();
        fs::write(&bak, b"bak").unwrap();
        fs::write(&keep, b"keep").unwrap();
        let removed = scrub_atomic_write_orphans(&root, std::time::Duration::from_secs(0));
        assert!(removed >= 2);
        assert!(!tmp.exists());
        assert!(!bak.exists());
        assert!(keep.exists());
        assert_eq!(fs::read_to_string(&keep).unwrap(), "keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scrub_restores_bak_when_final_missing_crash_mid_replace() {
        let root = std::env::temp_dir().join(format!(
            "grox-scrub-restore-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("session.json");
        let bak = root.join(".session.json.grox-9-9.bak");
        // Simulate crash after final → bak, before temp → final.
        fs::write(&bak, b"{\"recovered\":true}").unwrap();
        assert!(!final_path.exists());
        let touched = scrub_atomic_write_orphans(&root, std::time::Duration::from_secs(0));
        assert!(touched >= 1);
        assert!(final_path.exists(), "final must be restored from bak");
        assert!(!bak.exists(), "bak consumed by restore");
        assert_eq!(fs::read_to_string(&final_path).unwrap(), "{\"recovered\":true}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scrub_promotes_foreign_tmp_when_final_missing_first_write_crash() {
        let root = std::env::temp_dir().join(format!(
            "grox-scrub-promote-tmp-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("session.json");
        // Dead writer pid (not this process).
        let tmp = root.join(".session.json.grox-4242-7.tmp");
        fs::write(&tmp, b"{\"first\":true}").unwrap();
        assert!(!final_path.exists());
        let touched = scrub_atomic_write_orphans(&root, std::time::Duration::from_secs(0));
        assert!(touched >= 1);
        assert!(final_path.exists());
        assert!(!tmp.exists());
        assert_eq!(fs::read_to_string(&final_path).unwrap(), "{\"first\":true}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scrub_skips_live_process_tmp_even_with_max_age_zero() {
        let root = std::env::temp_dir().join(format!(
            "grox-scrub-live-tmp-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let pid = std::process::id();
        let tmp = root.join(format!(".session.json.grox-{pid}-99.tmp"));
        fs::write(&tmp, b"in-flight").unwrap();
        let removed = scrub_atomic_write_orphans(&root, std::time::Duration::from_secs(0));
        assert_eq!(removed, 0);
        assert!(tmp.exists(), "live writer temp must survive concurrent scrub");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scrub_keeps_fresh_bak_when_final_present_until_aged() {
        let root = std::env::temp_dir().join(format!(
            "grox-scrub-keep-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("payload.json");
        fs::write(&final_path, b"live").unwrap();
        let bak2 = root.join(".payload.json.grox-1-2.bak");
        fs::write(&bak2, b"stale-but-fresh").unwrap();
        let removed = scrub_atomic_write_orphans(&root, std::time::Duration::from_secs(3600));
        assert_eq!(removed, 0, "fresh bak with final present must not be scrubbed");
        assert!(bak2.exists());
        assert_eq!(fs::read_to_string(&final_path).unwrap(), "live");
        // Concurrent-style second scrub with age=0 should drop aged bak only.
        let removed2 = scrub_atomic_write_orphans(&root, std::time::Duration::from_secs(0));
        assert!(removed2 >= 1);
        assert!(!bak2.exists());
        assert!(final_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_orphan_final_name_parses_bak_and_tmp() {
        assert_eq!(
            atomic_orphan_final_name(".payload.json.grox-12-3.bak"),
            Some("payload.json")
        );
        assert_eq!(
            atomic_orphan_final_name(".x.json.grox-1-2.tmp"),
            Some("x.json")
        );
        assert_eq!(atomic_orphan_final_name("payload.json"), None);
        assert_eq!(atomic_orphan_final_name(".nope.bak"), None);
        assert_eq!(atomic_orphan_writer_pid(".x.json.grox-42-9.tmp"), Some(42));
    }

    #[test]
    fn session_history_path_rejects_traversal() {
        assert!(session_history_path(Path::new("unused"), "../session").is_err());
        assert!(session_history_path(Path::new("unused"), "folder/session").is_err());
    }

    #[test]
    fn session_history_path_finds_workspace_session_layout() {
        let root = std::env::temp_dir().join(format!(
            "grox-session-preview-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let history = root
            .join("sessions")
            .join("encoded-workspace")
            .join("session-id")
            .join("chat_history.jsonl");
        fs::create_dir_all(history.parent().unwrap()).unwrap();
        fs::write(&history, "").unwrap();
        assert_eq!(
            session_history_path(&root, "session-id").unwrap(),
            Some(history.canonicalize().unwrap())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_history_path_finds_nested_and_alternate_filenames() {
        let root = std::env::temp_dir().join(format!(
            "grox-session-scan-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let history = root
            .join("sessions")
            .join("ws-a")
            .join("batch")
            .join("019fdc55-nested-id")
            .join("history.jsonl");
        fs::create_dir_all(history.parent().unwrap()).unwrap();
        fs::write(&history, "{\"type\":\"user\",\"content\":\"hello\"}\n").unwrap();
        assert_eq!(
            session_history_path(&root, "019fdc55-nested-id").unwrap(),
            Some(history.canonicalize().unwrap())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_session_history_data_removes_only_the_requested_session_directory() {
        let root = std::env::temp_dir().join(format!(
            "grox-session-delete-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let target = root.join("sessions").join("workspace").join("session-a");
        let sibling = root.join("sessions").join("workspace").join("session-b");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(target.join("chat_history.jsonl"), "").unwrap();
        fs::write(sibling.join("chat_history.jsonl"), "").unwrap();

        assert!(delete_session_history_data(&root, "session-a").unwrap());
        assert!(!target.exists());
        assert!(sibling.exists());
        assert!(!delete_session_history_data(&root, "session-a").unwrap());
        assert!(delete_session_history_data(&root, "../workspace").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_session_history_data_never_treats_workspace_container_as_session() {
        let root = std::env::temp_dir().join(format!(
            "grox-session-delete-container-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = root.join("sessions").join("session-a");
        let nested_session = workspace.join("actual-session");
        fs::create_dir_all(&nested_session).unwrap();
        fs::write(nested_session.join("chat_history.jsonl"), "").unwrap();

        assert!(!delete_session_history_data(&root, "session-a").unwrap());
        assert!(workspace.exists());
        assert!(nested_session.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_project_session_history_data_removes_only_matching_workspace() {
        let root = std::env::temp_dir().join(format!(
            "grox-project-session-delete-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let target = root
            .join("sessions")
            .join("%2FUsers%2Fdemo%2Ftarget")
            .join("session-a");
        let sibling = root
            .join("sessions")
            .join("%2FUsers%2Fdemo%2Fsibling")
            .join("session-b");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(target.join("chat_history.jsonl"), "").unwrap();
        fs::write(sibling.join("chat_history.jsonl"), "").unwrap();

        assert_eq!(
            delete_project_session_history_data(&root, "/Users/demo/target/").unwrap(),
            vec!["session-a"]
        );
        assert!(!target.exists());
        assert!(sibling.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_session_discovery_does_not_delete_before_storage_gate() {
        let root = std::env::temp_dir().join(format!(
            "grox-project-session-discover-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = root
            .join("sessions")
            .join("%2FUsers%2Fdemo%2Ftarget");
        let target = workspace.join("session-a");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("chat_history.jsonl"), "").unwrap();

        let (ids, directories) =
            project_session_history_data(&root, "/Users/demo/target").unwrap();

        assert_eq!(ids, vec!["session-a"]);
        assert_eq!(directories, vec![workspace.canonicalize().unwrap()]);
        assert!(target.exists(), "枚举阶段不能抢在 tombstone 之前删除磁盘数据");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_history_search_matches_only_visible_user_and_assistant_text() {
        let history = concat!(
            "{\"type\":\"user\",\"content\":\"修复登录问题\"}\n",
            "{\"type\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"已经完成 OAuth 修复\"}]}\n",
            "{\"type\":\"tool\",\"content\":\"secret token\"}\n",
            "{\"type\":\"user\",\"synthetic_reason\":\"workflow\",\"content\":\"hidden marker\"}\n",
        );
        assert!(session_history_content_matches(history, "oauth"));
        assert!(session_history_content_matches(history, "登录"));
        assert!(!session_history_content_matches(history, "secret"));
        assert!(!session_history_content_matches(history, "hidden"));
    }

    #[test]
    fn reasoning_effort_accepts_max_and_rejects_unknown_values() {
        assert_eq!(
            checked_reasoning_effort(Some("max".into())).unwrap(),
            Some("max".into())
        );
        assert!(checked_reasoning_effort(Some("ultra".into())).is_err());
    }

    #[test]
    fn only_main_window_can_own_acp_runtime() {
        assert!(ensure_main_acp_owner("main").is_ok());
        assert!(ensure_main_acp_owner("session-secondary").is_err());
    }

    #[test]
    fn legacy_grox_worktrees_require_sibling_name_and_owned_branch() {
        let primary = Path::new("/repo/project");
        assert!(is_legacy_grox_worktree(
            primary,
            Path::new("/repo/project-worktree"),
            Some("refs/heads/grox/worktree-123")
        ));
        assert!(is_legacy_grox_worktree(
            primary,
            Path::new("/repo/project-worktree-2"),
            Some("refs/heads/grox/worktree-456")
        ));
        assert!(!is_legacy_grox_worktree(
            primary,
            Path::new("/repo/project-backup"),
            Some("refs/heads/grox/worktree-123")
        ));
        assert!(!is_legacy_grox_worktree(
            primary,
            Path::new("/repo/project-worktree"),
            Some("refs/heads/feature/user-owned")
        ));
    }

    #[test]
    fn dirty_worktree_confirmation_names_irrecoverable_changes() {
        let message = worktree_remove_confirmation(Path::new("/repo/worktree"), true);
        assert!(message.contains("未提交变更"));
        assert!(message.contains("永久丢失"));
        assert!(message.contains("/repo/worktree"));

        let clean = worktree_remove_confirmation(Path::new("/repo/worktree"), false);
        assert!(!clean.contains("未提交变更"));
    }

    #[test]
    fn worktree_name_rejects_current_and_parent_directory_components() {
        let root = std::env::temp_dir().join(format!(
            "grox-worktree-name-gate-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let cwd = path_for_webview(&root);

        assert!(git_worktree_add(cwd.clone(), ".".into(), None).is_err());
        assert!(git_worktree_add(cwd, "..".into(), None).is_err());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn parses_worktree_branch_ownership_from_porcelain() {
        let entries = parse_worktree_list(concat!(
            "worktree /repo/project\n",
            "HEAD abc\n",
            "branch refs/heads/main\n\n",
            "worktree /repo/project-worktree\n",
            "HEAD def\n",
            "branch refs/heads/grox/worktree-123\n",
        ));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].path, PathBuf::from("/repo/project-worktree"));
        assert_eq!(
            entries[1].branch.as_deref(),
            Some("refs/heads/grox/worktree-123")
        );
    }

    #[test]
    fn managed_worktree_namespaces_distinguish_same_named_repositories() {
        let base = std::env::temp_dir().join(format!(
            "grox-worktree-namespace-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let first = base.join("one").join("project");
        let second = base.join("two").join("project");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let first_namespace = managed_worktree_project_dir(&first).unwrap();
        let second_namespace = managed_worktree_project_dir(&second).unwrap();
        assert_ne!(first_namespace, second_namespace);
        assert!(first_namespace
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("project-")));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn session_worktree_fork_refuses_a_dirty_source_checkout() {
        let root = std::env::temp_dir().join(format!(
            "grox-worktree-clean-gate-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        git_text(&root, &["init"]).unwrap();
        git_text(&root, &["config", "user.email", "grox@example.invalid"]).unwrap();
        git_text(&root, &["config", "user.name", "Grox Test"]).unwrap();
        fs::write(root.join("README.md"), "clean\n").unwrap();
        assert!(ensure_clean_worktree(&root).is_err());
        git_text(&root, &["add", "README.md"]).unwrap();
        git_text(&root, &["commit", "-m", "init"]).unwrap();
        assert!(ensure_clean_worktree(&root).is_ok());
        fs::write(root.join("README.md"), "dirty\n").unwrap();
        assert!(ensure_clean_worktree(&root).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn failed_session_fork_rolls_back_only_its_worktree_and_branch() {
        let base = std::env::temp_dir().join(format!(
            "grox-worktree-rollback-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let root = base.join("source");
        let target = base.join("fork");
        fs::create_dir_all(&root).unwrap();
        git_text(&root, &["init"]).unwrap();
        git_text(&root, &["config", "user.email", "grox@example.invalid"]).unwrap();
        git_text(&root, &["config", "user.name", "Grox Test"]).unwrap();
        fs::write(root.join("README.md"), "clean\n").unwrap();
        git_text(&root, &["add", "README.md"]).unwrap();
        git_text(&root, &["commit", "-m", "init"]).unwrap();
        let target_text = target.to_string_lossy().to_string();
        let branch = "grox/worktree-rollback-test";
        git_text(
            &root,
            &["worktree", "add", "-b", branch, &target_text],
        )
        .unwrap();
        rollback_managed_worktree(&CreatedManagedWorktree {
            source_root: root.clone(),
            path: target.clone(),
            branch: branch.to_string(),
        })
        .unwrap();
        assert!(!target.exists());
        assert!(git_text(&root, &["branch", "--list", branch])
            .unwrap()
            .is_empty());
        assert!(root.join("README.md").is_file());
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn rejects_missing_workspace() {
        let missing = std::env::temp_dir().join("grox-workspace-that-does-not-exist");
        assert!(checked_workspace(&path_for_webview(&missing)).is_err());
    }

    #[test]
    fn accepts_existing_workspace() {
        let workspace = checked_workspace(env!("CARGO_MANIFEST_DIR")).unwrap();
        assert!(workspace.is_dir());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn discovers_installed_open_applications_from_host() {
        let applications = list_open_applications_sync().unwrap();
        assert!(applications.iter().any(|item| item.id == "com.apple.finder"));
        assert!(applications.iter().all(|item| {
            !item.id.trim().is_empty()
                && !item.name.trim().is_empty()
                && item
                    .launch_target
                    .as_deref()
                    .map_or(true, |path| Path::new(path).is_absolute())
        }));
        assert!(applications.iter().any(|item| {
            item.icon_data_url
                .as_deref()
                .map_or(false, |value| value.starts_with("data:image/png;base64,"))
        }));
    }

    #[test]
    fn acp_text_files_round_trip_inside_workspace() {
        let root = std::env::temp_dir().join(format!(
            "grox-acp-fs-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("nested").join("sample.txt");
        acp_write_text_file(
            path_for_webview(&root),
            path_for_webview(&file),
            "one\ntwo\nthree\n".into(),
        )
        .unwrap();
        assert_eq!(
            acp_read_text_file(
                path_for_webview(&root),
                path_for_webview(&file),
                Some(2),
                Some(1),
            )
            .unwrap(),
            "two\n"
        );
        let escape = PathBuf::from("..").join("escape.txt");
        assert!(checked_workspace_target(
            &root.canonicalize().unwrap(),
            &path_for_webview(&escape)
        )
        .is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn acp_read_file_returns_multimodal_payload_for_images() {
        let root = std::env::temp_dir().join(format!(
            "grox-acp-image-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("diagram.png");
        let bytes = BASE64
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLqXQAAAABJRU5ErkJggg==")
            .unwrap();
        fs::write(&file, &bytes).unwrap();
        let payload = acp_read_file(
            path_for_webview(&root),
            path_for_webview(&file),
            None,
            None,
        )
        .unwrap();
        assert!(payload.content.is_empty());
        assert_eq!(payload.content_type, "image/png");
        assert_eq!(payload.size, bytes.len() as u64);
        assert_eq!(payload.content_base64, Some(BASE64.encode(bytes)));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn acp_read_file_keeps_text_ranges_and_full_size() {
        let payload = build_acp_read_file(b"one\ntwo\nthree\n".to_vec(), Some(2), Some(1));
        assert_eq!(payload.content, "two\n");
        assert_eq!(payload.content_type, "text/plain");
        assert_eq!(payload.size, 14);
        assert_eq!(payload.line_count, Some(3));
        assert!(payload.content_base64.is_none());
    }

    #[test]
    fn acp_read_scope_allows_only_workspace_and_grok_readonly_roots() {
        let base = std::env::temp_dir().join(format!(
            "grox-acp-read-scope-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = base.join("workspace");
        let skills = base.join("grok").join("skills");
        let sessions = base.join("grok").join("sessions");
        let outside = base.join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&skills).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let project_file = workspace.join("README.md");
        let skill_file = skills.join("imagine").join("SKILL.md");
        let outside_file = outside.join("private.md");
        let session_file = sessions.join("session.jsonl");
        fs::create_dir_all(skill_file.parent().unwrap()).unwrap();
        fs::write(&project_file, "project").unwrap();
        fs::write(&skill_file, "skill").unwrap();
        fs::write(&session_file, "session").unwrap();
        fs::write(&outside_file, "outside").unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let skills = skills.canonicalize().unwrap();
        let sessions = sessions.canonicalize().unwrap();
        assert!(checked_read_file_with_roots(
            &workspace,
            &path_for_webview(&project_file),
            &[skills.clone()],
        )
        .is_ok());
        assert!(checked_read_file_with_roots(
            &workspace,
            &path_for_webview(&skill_file),
            &[skills, sessions.clone()],
        )
        .is_ok());
        assert!(checked_read_file_with_roots(
            &workspace,
            &path_for_webview(&session_file),
            &[sessions],
        )
        .is_ok());
        assert!(checked_read_file_with_roots(
            &workspace,
            &path_for_webview(&outside_file),
            &[],
        )
        .is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn explicit_prompt_image_can_be_outside_workspace_without_granting_acp_access() {
        let base = std::env::temp_dir().join(format!(
            "grox-prompt-image-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = base.join("workspace");
        let external = base.join("external image.png");
        fs::create_dir_all(&workspace).unwrap();
        // A complete, valid 1 × 1 PNG. Content validation must not rely on
        // the `.png` suffix alone.
        fs::write(
            &external,
            BASE64
                .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLqXQAAAABJRU5ErkJggg==")
                .unwrap(),
        )
        .unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let resolved = checked_explicit_prompt_image(&workspace, &path_for_webview(&external)).unwrap();
        assert_eq!(resolved, external.canonicalize().unwrap());
        let file_url = url::Url::from_file_path(&external).unwrap().to_string();
        assert_eq!(
            checked_explicit_prompt_image(&workspace, &file_url).unwrap(),
            external.canonicalize().unwrap()
        );
        assert!(checked_read_file_with_roots(&workspace, &path_for_webview(&external), &[]).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn explicit_prompt_image_rejects_a_renamed_text_file() {
        let base = std::env::temp_dir().join(format!(
            "grox-invalid-image-{}-{}",
            std::process::id(),
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&base).unwrap();
        let bad_image = base.join("not-an-image.png");
        fs::write(&bad_image, b"this is ordinary text").unwrap();
        let workspace = base.canonicalize().unwrap();
        assert!(checked_explicit_prompt_image(&workspace, &path_for_webview(&bad_image)).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn prompt_images_reject_svg_but_regular_file_preview_can_detect_it() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
        assert_eq!(image_mime(svg), Some("image/svg+xml"));
        assert_eq!(prompt_image_mime(svg), None);
    }

    #[test]
    fn config_secrets_are_redacted_and_restored_by_table_name() {
        let existing = r#"
[model.local]
api_key = "local-secret"
[model.prod] # primary
API_KEY = "prod-secret" # keep this key
base_url = "https://api.example.com/v1"
OPENAI_API_KEY="env-secret" # keep env comment
"#;
        let redacted = redact_config_document_secrets(existing);
        assert!(!redacted.contains("local-secret"));
        assert!(!redacted.contains("prod-secret"));
        assert!(redacted.contains("API_KEY = \"********\" # keep this key"));
        assert!(redacted.contains("OPENAI_API_KEY=******** # keep env comment"));
        let incoming = r#"
[model.prod] # primary
API_KEY = "********" # keep this key
base_url = "https://api.example.com/v2"
OPENAI_API_KEY=******** # keep env comment
"#;
        let merged = merge_config_secrets_from_existing(existing, incoming).unwrap();
        assert!(merged.contains("API_KEY = \"prod-secret\" # keep this key"));
        assert!(merged.contains("OPENAI_API_KEY=\"env-secret\" # keep env comment"));
        assert!(!merged.contains("local-secret"));
        assert!(merged.contains("/v2"));
    }

    #[test]
    fn empty_config_secret_explicitly_clears_the_existing_value() {
        let existing = "[model.local]\napi_key = \"old-secret\"\n";
        let incoming = "[model.local]\napi_key = \"\"\n";
        let merged = merge_config_secrets_from_existing(existing, incoming).unwrap();
        assert_eq!(merged, incoming.trim_end());
        assert!(!config_contains_redacted_secret(incoming));
    }

    #[test]
    fn config_secret_restore_fails_closed_for_a_new_table() {
        let error = merge_config_secrets_from_existing(
            "[model.one]\napi_key = \"real\"\n",
            "[model.two]\napi_key = \"********\"\n",
        )
        .unwrap_err();
        assert!(error.contains("model.two"));
        assert!(config_contains_redacted_secret("api_key = \"********\""));
    }

    #[test]
    fn static_preview_serves_project_assets_and_rejects_parent_paths() {
        tauri::async_runtime::block_on(async {
            let root = std::env::temp_dir().join(format!(
                "grox-html-preview-{}-{}",
                std::process::id(),
                CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
            ));
            let assets = root.join("assets");
            fs::create_dir_all(&assets).unwrap();
            fs::write(assets.join("app.css"), b"body{color:green}").unwrap();
            let root = root.canonicalize().unwrap();
            let roots = Arc::new(Mutex::new(BTreeMap::from([(
                "preview-token".to_string(),
                root.clone(),
            )])));
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let server_roots = roots.clone();
            let server = tauri::async_runtime::spawn(async move {
                for _ in 0..3 {
                    let (stream, _) = listener.accept().await.unwrap();
                    handle_static_preview_request(stream, server_roots.clone()).await;
                }
            });

            async fn request(address: std::net::SocketAddr, path: &str) -> String {
                let mut client = TcpStream::connect(address).await.unwrap();
                client
                    .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
                    .await
                    .unwrap();
                let mut response = Vec::new();
                client.read_to_end(&mut response).await.unwrap();
                String::from_utf8(response).unwrap()
            }

            let relative = request(address, "/preview-token/assets/app.css").await;
            assert!(relative.starts_with("HTTP/1.1 200 OK"));
            assert!(relative.contains("Content-Type: text/css; charset=utf-8"));
            assert!(relative.contains("Content-Security-Policy:"));
            assert!(relative.ends_with("body{color:green}"));

            // Tokenless absolute paths must not expose the workspace.
            let root_relative = request(address, "/assets/app.css").await;
            assert!(root_relative.starts_with("HTTP/1.1 404 Not Found"));

            let traversal = request(address, "/preview-token/%2e%2e/secret.txt").await;
            assert!(traversal.starts_with("HTTP/1.1 400 Bad Request"));

            server.await.unwrap();
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn relay_may_expose_official_model_names_without_taking_the_official_route() {
        // 第三方 Grok 反代本来就会暴露 grok-4.5/4.6 —— 这是最常见的配置，
        // 必须能用。段名与上游模型名解耦后，两条链路各走各的。
        let home = std::env::temp_dir().join(format!(
            "grox-provider-relay-coexist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let config = home.join("config.toml");
        // 用户自有的官方模型配置，必须原样幸存。
        std::fs::write(
            &config,
            "[model.\"grok-4.5\"]\nname = \"Personal official label\"\n",
        )
        .unwrap();

        apply_grox_provider_sections(
            &home,
            &["grok-4.5".into(), "gpt-5.4".into()],
            "https://relay.example/v1",
            "grok-4.5",
            "chat_completions",
        )
        .expect("中转暴露官方模型名必须是合法配置");

        let written = std::fs::read_to_string(&config).unwrap();
        // 官方段没有被改写。
        assert!(written.contains("name = \"Personal official label\""), "{written}");
        assert!(!written.contains("relay.example/v1\"\nname ="), "{written}");
        // 中转落在 Grox 自有命名空间里，上游真名写在段内。
        // 含点号的段名必须带引号，否则 TOML 会解析成嵌套表而整段失效。
        assert!(written.contains("[model.\"grox-relay-grok-4.5\"]"), "{written}");
        assert!(written.contains("model = \"grok-4.5\""), "{written}");
        assert!(written.contains("[model.\"grox-relay-gpt-5.4\"]"), "{written}");
        assert!(written.contains("default = \"grox-relay-grok-4.5\""), "{written}");

        // set_model 必须收到段名，否则请求会落到官方段上。
        assert_eq!(
            resolve_agent_model_id(&home, "grok-4.5").unwrap(),
            "grox-relay-grok-4.5"
        );

        restore_grox_provider_backend_overrides(&home).unwrap();
        let restored = std::fs::read_to_string(&config).unwrap();
        assert!(!restored.contains("grox-relay-"), "{restored}");
        assert!(!restored.contains("relay.example"), "{restored}");
        assert!(
            restored.contains("name = \"Personal official label\""),
            "用户自有的官方段必须完好：{restored}"
        );
        // 切回官方后，同一个模型名解析回官方段。
        assert_eq!(resolve_agent_model_id(&home, "grok-4.5").unwrap(), "grok-4.5");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn provider_route_contains_only_cli_fields() {
        let home = std::env::temp_dir().join(format!(
            "grox-provider-identity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();

        apply_grox_provider_sections(
            &home,
            &["deepseek-v4-flash".into()],
            "https://api.deepseek.com/v1",
            "deepseek-v4-flash",
            "chat_completions",
        )
        .unwrap();

        let written = std::fs::read_to_string(home.join("config.toml")).unwrap();
        // 段名是内部路由名，界面显示用 name。
        assert!(written.contains("name = \"deepseek-v4-flash\""), "{written}");
        assert!(written.contains("env_key = \"OPENAI_API_KEY\""), "{written}");
        assert!(!written.contains("env_key = \"XAI_API_KEY\""), "{written}");
        assert!(!written.contains("app_provider_id"), "{written}");
        assert!(!written.contains("[grox]"), "{written}");

        restore_grox_provider_backend_overrides(&home).unwrap();
        assert!(!std::fs::read_to_string(home.join("config.toml")).unwrap().contains("[grox]"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn stale_relay_sections_do_not_override_a_user_selected_default() {
        let home = std::env::temp_dir().join(format!(
            "grox-provider-user-default-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        apply_grox_provider_sections(
            &home,
            &["grok-4.5".into()],
            "https://relay.example/v1",
            "grok-4.5",
            "chat_completions",
        )
        .unwrap();

        let path = home.join("config.toml");
        let mut document = parse_grok_config_document(&std::fs::read_to_string(&path).unwrap()).unwrap();
        set_models_default_model(&mut document, Some("grok-4.5")).unwrap();
        std::fs::write(&path, document.to_string()).unwrap();

        assert_eq!(resolve_agent_model_id(&home, "grok-4.5").unwrap(), "grok-4.5");
        restore_grox_provider_backend_overrides(&home).unwrap();
        let restored = std::fs::read_to_string(&path).unwrap();
        assert!(restored.contains("default = \"grok-4.5\""), "{restored}");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn legacy_borrowed_sections_are_migrated_to_owned_ones() {
        // v0.3.3 的布局：中转配置借用了官方段，并且有一份备份文件。升级后
        // 必须迁移成 Grox 自有段，且把借用的官方段完整还回去。
        let home = std::env::temp_dir().join(format!(
            "grox-provider-migrate-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let config = home.join("config.toml");
        std::fs::write(
            &config,
            concat!(
                "[model.\"grok-4.5\"]\n",
                "env_key = \"XAI_API_KEY\"\n",
                "base_url = \"https://old-relay.example/v1\"\n",
                "api_backend = \"chat_completions\"\n",
                "model = \"relay-model\"\n",
            ),
        )
        .unwrap();
        // 旧备份说明 grok-4.5 段本来不存在，是 Grox 创建的。
        std::fs::write(
            home.join("grox-provider-backend-overrides.json"),
            r#"{"models":{"grok-4.5":{"modelExisted":false,"envKey":null,"baseUrl":null,"apiBackend":null,"model":null}}}"#,
        )
        .unwrap();

        apply_grox_provider_sections(
            &home,
            &["relay-model".into()],
            "https://new-relay.example/v1",
            "relay-model",
            "chat_completions",
        )
        .unwrap();

        let written = std::fs::read_to_string(&config).unwrap();
        assert!(
            !written.contains("old-relay.example"),
            "借用官方段的旧写法必须被清除：{written}"
        );
        assert!(!written.contains("[model.\"grok-4.5\"]"), "{written}");
        // 段名不含点号时 TOML 不需要引号，两种写法都接受。
        assert!(
            written.contains("[model.grox-relay-relay-model]")
                || written.contains("[model.\"grox-relay-relay-model\"]"),
            "{written}"
        );
        assert!(!written.contains("[grox]"), "{written}");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn legacy_grox_metadata_is_removed_from_cli_config() {
        let home = std::env::temp_dir().join(format!(
            "grox-account-mode-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let config = home.join("config.toml");

        std::fs::write(
            &config,
            "[grox]\naccount_mode = \"official\"\nactive_provider_id = \"provider-1\"\n",
        )
        .unwrap();
        assert_eq!(legacy_grox_account_mode(&home).unwrap().as_deref(), Some("official"));
        clear_legacy_grox_metadata(&home).unwrap();
        assert!(!std::fs::read_to_string(&config).unwrap().contains("[grox]"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn provider_backend_never_touches_a_user_owned_model_section() {
        // Grox 只写带前缀的自有段，从不借用用户已有的 `[model.*]`。没有借用
        // 就不需要备份文件 —— 这正是备份/还原那条影子数据源可以删掉的原因。
        let home = std::env::temp_dir().join(format!(
            "grox-provider-no-borrow-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let config = home.join("config.toml");
        // 用户自己配的同名模型，带私有密钥。
        let user_owned = "[model.\"gpt-5.4\"]\napi_key = \"user-private-key\"\nbase_url = \"https://user-own.example/v1\"\n";
        std::fs::write(&config, user_owned).unwrap();

        apply_grox_provider_sections(
            &home,
            &["gpt-5.4".into()],
            "https://relay.example/v1",
            "gpt-5.4",
            "chat_completions",
        )
        .unwrap();

        let written = std::fs::read_to_string(&config).unwrap();
        assert!(
            written.contains("api_key = \"user-private-key\"")
                && written.contains("https://user-own.example/v1"),
            "用户自有段必须原样保留：{written}"
        );
        assert!(written.contains("[model.\"grox-relay-gpt-5.4\"]"), "{written}");

        restore_grox_provider_backend_overrides(&home).unwrap();
        let restored = std::fs::read_to_string(&config).unwrap();
        assert_eq!(
            restored.trim(),
            user_owned.trim(),
            "还原后 config.toml 必须逐字回到原样"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn provider_backend_writes_reasoning_gate_and_default_route() {
        let home = std::env::temp_dir().join(format!(
            "grox-provider-route-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let config = home.join("config.toml");
        std::fs::write(&config, "[ui]\nmax_thoughts_width = 120\n").unwrap();

        apply_grox_provider_sections(
            &home,
            &["deepseek-v4-flash".into(), "deepseek-v4-pro".into()],
            "https://api.deepseek.com/v1",
            "deepseek-v4-flash",
            "chat_completions",
        )
        .unwrap();

        let written = std::fs::read_to_string(&config).unwrap();
        // 没有这个开关，CLI 不会转发 reasoning effort，会话里就看不到思考内容。
        assert_eq!(
            written.matches("supports_reasoning_effort = true").count(),
            2,
            "每个中转模型都要带推理开关：{written}"
        );
        // 官方文档的切换方式：默认模型指向自己的段，而不是改写官方段。
        assert!(written.contains("default = \"grox-relay-deepseek-v4-flash\""), "{written}");
        assert!(!written.contains("[model.\"grok-4.5\"]"), "{written}");
        assert!(!written.contains("[model.\"grok-4.6\"]"), "{written}");
        assert!(written.contains("max_thoughts_width = 120"), "用户原有配置必须保留");

        restore_grox_provider_backend_overrides(&home).unwrap();
        let restored = std::fs::read_to_string(&config).unwrap();
        assert!(!restored.contains("deepseek"), "还原后不能残留中转配置：{restored}");
        assert!(!restored.contains("supports_reasoning_effort"), "{restored}");
        assert!(
            !restored.contains("default ="),
            "还原后必须清掉指向已删除段的默认路由：{restored}"
        );
        assert!(restored.contains("max_thoughts_width = 120"), "用户原有配置必须保留");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn compatible_model_auth_override_wins_without_damaging_existing_toml() {        let mut document = parse_grok_config_document(
            r#"
[cli]
default_model = "grok-4.5"

[model."grok-4.5"]
name = "Personal model label"
api_key = "personal-inline-key"
base_url = "https://old-provider.example/v1"
env_key = ["PERSONAL_GATEWAY_KEY", "FALLBACK_KEY"]
api_backend = "responses"
"#,
        )
        .unwrap();
        let (model, existed) = model_table_mut(&mut document, "grok-4.5").unwrap();
        assert!(existed);
        let original = model.get("env_key").map(ToString::to_string);
        let original_key = model.get("api_key").map(ToString::to_string);
        let original_base = model.get("base_url").map(ToString::to_string);
        let original_backend = model.get("api_backend").map(ToString::to_string);
        model.remove("api_key");
        model.insert("env_key", toml_value("XAI_API_KEY"));
        model.insert("base_url", toml_value("https://new-provider.example/v1"));
        model.insert("api_backend", toml_value("chat_completions"));

        let rendered = document.to_string();
        assert!(rendered.contains("name = \"Personal model label\""));
        assert!(rendered.contains("env_key = \"XAI_API_KEY\""));
        assert!(rendered.contains("base_url = \"https://new-provider.example/v1\""));
        assert!(!rendered.contains("personal-inline-key"));
        assert!(rendered.contains("api_backend = \"chat_completions\""));

        let mut restored = parse_grok_config_document(&rendered).unwrap();
        let (model, _) = model_table_mut(&mut restored, "grok-4.5").unwrap();
        model.insert("env_key", config_value_item(&original.unwrap()).unwrap());
        model.insert("api_key", config_value_item(&original_key.unwrap()).unwrap());
        model.insert("base_url", config_value_item(&original_base.unwrap()).unwrap());
        model.insert("api_backend", config_value_item(&original_backend.unwrap()).unwrap());
        let restored = restored.to_string();
        assert!(restored.contains("PERSONAL_GATEWAY_KEY"));
        assert!(restored.contains("FALLBACK_KEY"));
        assert!(restored.contains("personal-inline-key"));
        assert!(restored.contains("https://old-provider.example/v1"));
        assert!(restored.contains("api_backend"));
        assert!(restored.contains("\"responses\""));
        assert!(restored.parse::<Document>().is_ok());
    }

    #[test]
    fn upstream_cli_identity_is_not_the_unreleased_desktop_client() {
        assert_eq!(UPSTREAM_CLI_CLIENT_NAME, "grok-shell");
        assert_ne!(UPSTREAM_CLI_CLIENT_NAME, "grok-desktop");
    }

    #[test]
    fn compares_release_versions_without_treating_prefix_as_part_of_version() {
        assert!(update_available("0.1.0", "v0.2.0").unwrap());
        assert!(!update_available("0.2.0", "V0.2.0").unwrap());
        assert!(!update_available("0.3.0", "v0.2.9").unwrap());
        assert!(update_available("0.2.0-beta.1", "v0.2.0").unwrap());
    }

    #[test]
    fn selects_highest_stable_release_below_current_for_rollback() {
        let releases = vec![
            test_release("v0.2.9", false, false),
            test_release("v0.2.12", false, false),
            test_release("not-semver", false, false),
            test_release("v0.2.10", false, false),
            test_release("v0.2.10-beta.1", false, false),
            test_release("v0.2.10-hotfix.1", true, false),
        ];

        let selected = previous_release("0.2.11", &releases).unwrap();
        assert_eq!(selected.tag_name, "v0.2.10");
        assert!(previous_release("0.2.9", &[test_release("v0.2.9", false, false)]).is_none());
    }

    #[test]
    fn selects_installers_for_every_release_target() {
        assert!(update_asset_matches(
            "Grox_0.2.1_x64-setup.exe",
            "windows",
            "x86_64"
        ));
        assert!(update_asset_matches(
            "Grox_0.2.1_aarch64.dmg",
            "macos",
            "aarch64"
        ));
        assert!(update_asset_matches(
            "Grox_0.2.1_x64.dmg",
            "macos",
            "x86_64"
        ));
        assert!(!update_asset_matches(
            "Grox_0.2.1_x64_en-US.msi",
            "windows",
            "x86_64"
        ));
    }

    #[test]
    fn cli_version_number_extracts_semver_from_version_output() {
        assert_eq!(
            cli_version_number("grok 0.2.106 (abc1234) [stable]"),
            Some(semver::Version::new(0, 2, 106))
        );
        assert_eq!(
            cli_version_number("0.2.102"),
            Some(semver::Version::new(0, 2, 102))
        );
        assert_eq!(cli_version_number("grok"), None);
        assert_eq!(cli_version_number(""), None);
    }

    #[test]
    fn media_url_allowlist_uses_domain_boundaries() {
        assert!(is_media_https_host_allowed(Some("cdn.x.ai")));
        assert!(is_media_https_host_allowed(Some("images.cdn.x.ai")));
        assert!(!is_media_https_host_allowed(Some("x.ai.evil.example")));
        assert!(!is_media_https_host_allowed(Some("evil.example")));
    }

    #[test]
    fn preview_ranges_support_seek_suffix_and_reject_invalid_ranges() {
        assert_eq!(
            preview_byte_range("GET / HTTP/1.1\r\nRange: bytes=10-19\r\n", 100),
            Ok(Some((10, 19)))
        );
        assert_eq!(
            preview_byte_range("GET / HTTP/1.1\r\nrange: bytes=90-\r\n", 100),
            Ok(Some((90, 99)))
        );
        assert_eq!(
            preview_byte_range("GET / HTTP/1.1\r\nRange: bytes=-10\r\n", 100),
            Ok(Some((90, 99)))
        );
        assert!(preview_byte_range("Range: bytes=100-101\r\n", 100).is_err());
        assert!(preview_byte_range("Range: bytes=0-1,3-4\r\n", 100).is_err());
    }

    #[test]
    fn trusted_cli_install_hosts_reject_cross_origin() {
        assert!(is_trusted_cli_install_host(Some("x.ai")));
        assert!(is_trusted_cli_install_host(Some("cdn.x.ai")));
        assert!(!is_trusted_cli_install_host(Some("evil.example")));
        assert!(!is_trusted_cli_install_host(Some("github.com")));
    }

    #[test]
    fn acp_method_allows_wire_xai_notify_and_rejects_traversal() {
        assert!(acp_method_allowed("_x.ai/yolo_mode_changed"));
        assert!(acp_method_allowed("x.ai/yolo_mode_changed"));
        assert!(acp_method_allowed("session/prompt"));
        assert!(acp_method_allowed("session/set_model"));
        assert!(!acp_method_allowed("shell/exec"));
        assert!(!acp_method_allowed("eval"));
        assert!(!acp_method_allowed("_evil/hack"));
        assert!(!acp_method_allowed("_session/prompt"));
        assert!(!acp_method_allowed("session/unknown"));
        assert!(!acp_method_allowed("terminal/unknown"));
        assert!(!acp_method_allowed("terminal/create"));
        assert!(!acp_method_allowed("fs/unknown"));
        assert!(!acp_method_allowed("fs/read_text_file"));
        assert!(!acp_method_allowed("fs/write_text_file"));
        assert!(acp_method_allowed("x.ai/future_extension"));
        assert!(acp_method_allowed("_x.ai/future_extension"));
        assert!(!acp_method_allowed("session/../../evil"));
    }

    #[test]
    fn host_requests_encode_extension_methods_for_the_acp_wire() {
        assert_eq!(acp_wire_method("x.ai/session/fork"), "_x.ai/session/fork");
        assert_eq!(acp_wire_method("session/load"), "session/load");
        assert_eq!(acp_wire_method("_x.ai/session/fork"), "_x.ai/session/fork");
    }

    #[test]
    fn acp_line_gate_requires_json_rpc_and_rejects_privileged_methods() {
        let leases = McpLeaseStore::default();
        assert!(prepare_acp_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{}}"#.into(),
            &leases,
        )
        .is_ok());
        assert!(prepare_acp_line(
            r#"{"id":1,"method":"session/prompt","params":{}}"#.into(),
            &leases,
        )
        .is_err());
        assert!(prepare_acp_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"shell/exec","params":{}}"#.into(),
            &leases,
        )
        .is_err());
    }

    #[test]
    fn parse_browser_url_rejects_remote_http_credentials_and_imds() {
        assert!(parse_browser_url("https://github.com/x").is_ok());
        assert!(parse_browser_url("http://127.0.0.1:5173/").is_ok());
        assert!(parse_browser_url("http://evil.example/phish").is_err());
        assert!(parse_browser_url("https://user:pass@evil.com/").is_err());
        assert!(parse_browser_url("https://169.254.169.254/latest/meta-data/").is_err());
        assert!(parse_browser_url("https://metadata.google.internal/").is_err());
        assert!(parse_browser_url("https://100.100.100.200/").is_err());
    }

    #[test]
    fn draft_workspace_scopes_are_isolated_and_validated() {
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_string_lossy();
        let unscoped = draft_workspace(&cwd, None).expect("temp directory is a valid workspace");
        let scoped = draft_workspace(&cwd, Some("home")).expect("home is a valid draft scope");
        assert_ne!(scoped, unscoped);
        assert!(scoped.ends_with(&unscoped));
        assert!(draft_workspace(&cwd, Some("../escape")).is_err());
    }
}
