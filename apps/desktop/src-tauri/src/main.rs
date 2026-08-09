//! Grox native shell.
//!
//! The webview speaks JSON-RPC while this process owns the long-lived
//! `grok agent stdio` child. Keeping process management here prevents the
//! privileged webview from spawning arbitrary commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser_mcp;
mod computer_mcp;
mod git_confirm;
mod host_prefs;
mod mcp_leases;
mod path_sandbox;
#[cfg(windows)]
mod process_job;

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    io::Write as _,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use git_confirm::GitConfirmStore;
use mcp_leases::McpLeaseStore;
use path_sandbox::{
    checked_workspace, checked_workspace_file, checked_workspace_target, is_workspace_file,
    path_for_webview,
};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use toml_edit::{value as toml_value, Document, Item, Table, TableLike};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GROX_BUILD_COMMIT: &str = env!("GROX_BUILD_COMMIT");
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/dandandujie/Grox/releases/latest";
const RELEASES_URL: &str = "https://api.github.com/repos/dandandujie/Grox/releases";
const GROK_INSTALL_PS1_URL: &str = "https://x.ai/cli/install.ps1";
const GROK_INSTALL_SH_URL: &str = "https://x.ai/cli/install.sh";
// The upstream built-in workflow has early `complete()` branches for empty
// candidate/verdict sets. Grox routes the built-in slash shortcut to this
// user-scoped compatibility workflow so every research run reaches Verify and
// Report, including a useful audit/report for partial evidence.
const GROX_DEEP_RESEARCH_WORKFLOW: &str = include_str!("../resources/grox-deep-research.rhai");
// Grok Build decides OAuth eligibility from the official CLI client mode.
// Grox is an ACP host around that CLI, not a separate xAI desktop client, so
// preserve the identity used by `grok` in a terminal. In particular, never
// advertise the unreleased `grok-desktop` client mode to the upstream service.
const UPSTREAM_CLI_CLIENT_NAME: &str = "grok-shell";
const GROX_MANAGED_PROVIDER_START: &str = "# >>> Grox managed provider";
const GROX_MANAGED_PROVIDER_END: &str = "# <<< Grox managed provider";
const GROX_PROVIDER_AUTH_OVERRIDES_FILE: &str = "grox-provider-auth-overrides.json";
const GROX_PROVIDER_BACKEND_OVERRIDES_FILE: &str = "grox-provider-backend-overrides.json";
// These are the three documented Grok Build custom-endpoint environment
// variables. Protocol selection belongs in `[model.*].api_backend` so it
// survives CLI upgrades instead of depending on an undocumented env var.
const PROVIDER_ENV_KEYS: [&str; 3] = [
    "XAI_API_KEY",
    "GROK_MODELS_BASE_URL",
    "GROK_MODELS_LIST_URL",
];
const MAX_PROMPT_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PROMPT_IMAGE_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PROVIDER_MODELS_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_MEDIA_REFERENCE_BYTES: usize = 24 * 1024 * 1024;
const MEDIA_HTTPS_HOST_ALLOWLIST: &[&str] = &[
    "x.ai",
    "grok.com",
    "grok.x.ai",
    "cdn.x.ai",
    "assets.x.ai",
    "imagine.x.ai",
];
const MAX_SESSION_PREVIEW_MESSAGES: usize = 200;
const MAX_SESSION_SEARCH_IDS: usize = 2_000;
const MAX_SESSION_SEARCH_HITS: usize = 500;
const MAX_SESSION_SEARCH_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SESSION_SEARCH_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    generation: u64,
    /// Windows Job Object so cancel kills nested tool trees (cargo test, shells).
    #[cfg(windows)]
    job: Option<process_job::ProcessJob>,
}

#[derive(Default)]
struct AcpState {
    process: Mutex<Option<AgentProcess>>,
    next_generation: AtomicU64,
}

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpExitPayload {
    code: Option<i32>,
    reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEnvironment {
    default_workspace: String,
    grok_command: String,
    app_version: String,
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

/// Binary-safe response used by Grok's TUI-style `x.ai/fs/read_file`
/// extension.  The standard ACP `fs/read_text_file` method is intentionally
/// text-only; the extension adds the same `contentBase64`/`type` fields that
/// the upstream CLI uses for images and other binary files.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpReadFile {
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_base64: Option<String>,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    line_count: Option<u64>,
    #[serde(rename = "type")]
    content_type: String,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrokRuntimeInfo {
    path: String,
    source: &'static str,
    system_path: Option<String>,
    selection_required: bool,
    version: Option<String>,
    grox_commit: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaGenerationRequest {
    kind: String,
    prompt: String,
    aspect: String,
    count: u8,
    duration: u16,
    resolution: String,
    reference_path: Option<String>,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaArtifact {
    path: Option<String>,
    url: Option<String>,
    mime: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaGenerationResult {
    artifacts: Vec<MediaArtifact>,
    summary: String,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputerSessionExtensions {
    /// Intentionally empty: bearer tokens stay in native `McpLeaseStore` and
    /// are injected by `acp_send` when `_meta.groxComputerLeaseId` is set.
    mcp_servers: Vec<serde_json::Value>,
    plugin_dirs: Vec<String>,
    lease_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSessionExtensions {
    /// Intentionally empty — see `ComputerSessionExtensions`.
    mcp_servers: Vec<serde_json::Value>,
    lease_id: String,
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    current_version: String,
    update_available: bool,
    latest: UpdateInfo,
    history: Vec<ReleaseSummary>,
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
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderApiBackend {
    #[default]
    Auto,
    Responses,
    ChatCompletions,
}

impl ProviderApiBackend {
    fn config_value(self, provider_name: &str, base_url: &str) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::ChatCompletions => "chat_completions",
            Self::Auto => {
                let identity = format!("{provider_name} {base_url}").to_ascii_lowercase();
                if [
                    "grok2api",
                    "cliproxyapi",
                    "cli-proxy-api",
                    "router-for-me",
                    "newapi",
                ]
                .iter()
                .any(|marker| identity.contains(marker))
                {
                    "responses"
                } else {
                    "chat_completions"
                }
            }
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredProviderProfile {
    id: String,
    name: String,
    api_key: String,
    base_url: String,
    #[serde(default)]
    allow_insecure_http: bool,
    #[serde(default)]
    api_backend: ProviderApiBackend,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    models_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default)]
    available_models: Vec<String>,
    #[serde(default)]
    resident_models: Vec<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfilesFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_id: Option<String>,
    #[serde(default)]
    profiles: Vec<StoredProviderProfile>,
}

/// Grox changes only the endpoint, credential source, and request protocol
/// for an active compatible provider. Keep the exact prior TOML items so
/// switching back to OAuth or the official API restores user configuration.
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAuthOverridesFile {
    #[serde(default)]
    models: BTreeMap<String, ProviderModelAuthBackup>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderModelAuthBackup {
    model_existed: bool,
    /// The original TOML representation (for example `"OPENAI_API_KEY"` or
    /// `["FIRST", "SECOND"]`). It is a variable name, never a secret.
    env_key: Option<String>,
    /// An inline key outranks `env_key` in Grok Build, so it must be restored
    /// after a profile switch rather than left pointing at the old provider.
    #[serde(default)]
    api_key: Option<String>,
    /// Per-model endpoints outrank the global endpoint configuration.
    #[serde(default)]
    base_url: Option<String>,
    /// The original TOML representation (for example `"responses"`).
    #[serde(default)]
    api_backend: Option<String>,
}

/// Grok Build's built-in aliases do not inherit a dynamic endpoint's
/// credential route consistently. For the active gateway, add the documented
/// per-model route (never a literal key), then restore every prior field when
/// the user leaves that provider.
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderBackendOverridesFile {
    models: BTreeMap<String, ProviderBackendBackup>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderBackendBackup {
    model_existed: bool,
    env_key: Option<String>,
    base_url: Option<String>,
    api_backend: Option<String>,
    model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfileSummary {
    id: String,
    name: String,
    api_key: String,
    has_api_key: bool,
    base_url: String,
    allow_insecure_http: bool,
    api_backend: ProviderApiBackend,
    available_models: Vec<String>,
    resident_models: Vec<String>,
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

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ACP_TEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES: usize = 2_000;
static CONFIG_WRITE_NONCE: AtomicU64 = AtomicU64::new(0);

fn default_workspace() -> PathBuf {
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

fn grok_home() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("GROK_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(user_home()?.join(".grok"))
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionPreviewMessage {
    role: String,
    text: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDiskPreview {
    messages: Vec<SessionPreviewMessage>,
    truncated: bool,
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
    let mut messages = VecDeque::with_capacity(limit.min(MAX_SESSION_PREVIEW_MESSAGES));
    let mut truncated = false;
    for line in reader.lines() {
        let line = line.map_err(|error| format!("无法读取会话预览：{error}"))?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(role @ ("user" | "assistant")) =
            value.get("type").and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        if role == "user"
            && value
                .get("synthetic_reason")
                .and_then(serde_json::Value::as_str)
                .is_some()
        {
            continue;
        }
        let Some(text) = value.get("content").and_then(session_history_text) else {
            continue;
        };
        if text.trim().is_empty() || limit == 0 {
            continue;
        }
        if messages.len() == limit {
            messages.pop_front();
            truncated = true;
        }
        messages.push_back(SessionPreviewMessage {
            role: role.to_string(),
            text,
        });
    }
    Ok(SessionDiskPreview {
        messages: messages.into(),
        truncated,
    })
}

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
    let direct = sessions.join(session_id).join("chat_history.jsonl");
    let candidates = std::iter::once(direct).chain(
        fs::read_dir(&sessions)
            .map_err(|error| format!("无法扫描 Grok 会话目录：{error}"))?
            .filter_map(Result::ok)
            .map(|entry| entry.path().join(session_id).join("chat_history.jsonl")),
    );
    for candidate in candidates {
        let Ok(candidate) = candidate.canonicalize() else {
            continue;
        };
        if candidate.starts_with(&sessions) && candidate.is_file() {
            return Ok(Some(candidate));
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

/// Resolve the actual user home independently of `GROK_HOME`. The latter may
/// point to a portable or test-specific Grok configuration directory, but
/// `~/…` in a prompt must always mean the operator's home directory.
fn user_home() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "无法定位用户目录，请设置 GROK_HOME".to_string())?;
    Ok(PathBuf::from(home))
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

fn read_bounded_text(path: &Path, max_bytes: u64) -> Result<String, String> {
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
fn replace_file_atomic(from: &Path, to: &Path) -> Result<(), String> {
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
fn atomic_orphan_final_name(orphan_name: &str) -> Option<&str> {
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
fn atomic_orphan_writer_pid(orphan_name: &str) -> Option<u32> {
    let stem = orphan_name
        .strip_suffix(".bak")
        .or_else(|| orphan_name.strip_suffix(".tmp"))?;
    let rest = stem.strip_prefix('.')?;
    let marker = rest.rfind(".grox-")?;
    let after = &rest[marker + ".grox-".len()..];
    let pid = after.split('-').next()?;
    pid.parse().ok()
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_CONFIG_BYTES {
        return Err("配置文档不能超过 4 MB".into());
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
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
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
fn scrub_atomic_write_orphans(dir: &Path, max_age: std::time::Duration) -> u32 {
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

fn scrub_session_cache_dir(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_config_dir().map(|d| d.join("session-cache")) else {
        return;
    };
    if !dir.is_dir() {
        return;
    }
    // Temps older than 30s are safe leftovers; immediate cleanup of all .tmp
    // is fine because live writers hold exclusive create_new names.
    let removed = scrub_atomic_write_orphans(&dir, std::time::Duration::from_secs(30));
    if removed > 0 {
        eprintln!("grox: scrubbed {removed} orphan session-cache temp/bak files");
    }
}

const SESSION_CACHE_MAX_BYTES: u64 = 4 * 1024 * 1024;

fn session_cache_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let safe = id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(80)
        .collect::<String>();
    if safe.is_empty() {
        return Err("无效的会话 ID".into());
    }
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("session-cache").join(format!("{safe}.json")))
        .map_err(|error| format!("无法定位会话缓存目录：{error}"))
}

#[tauri::command]
fn read_session_cache(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    let path = session_cache_path(&app, &id)?;
    if !path.is_file() {
        return Ok(None);
    }
    read_bounded_text(&path, SESSION_CACHE_MAX_BYTES)
        .map(|content| if content.trim().is_empty() { None } else { Some(content) })
        .or(Ok(None))
}

#[tauri::command]
fn write_session_cache(app: tauri::AppHandle, id: String, content: String) -> Result<(), String> {
    if content.len() as u64 > SESSION_CACHE_MAX_BYTES {
        return Err("会话缓存不能超过 4 MB".into());
    }
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("会话缓存必须是 JSON：{error}"))?;
    if !value.is_object() {
        return Err("会话缓存必须是 JSON 对象".into());
    }
    let path = session_cache_path(&app, &id)?;
    atomic_write(&path, &content)?;
    restrict_private_file(&path)
}

#[tauri::command]
fn delete_session_cache(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = session_cache_path(&app, &id)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|error| format!("无法删除会话缓存：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn scrub_session_cache_orphans(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map(|directory| directory.join("session-cache"))
        .map_err(|error| format!("无法定位会话缓存目录：{error}"))?;
    if !dir.is_dir() {
        return Ok(0);
    }
    Ok(scrub_atomic_write_orphans(
        &dir,
        std::time::Duration::from_secs(0),
    ))
}

#[cfg(unix)]
fn restrict_private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法限制凭据文件权限 {}：{error}", path.display()))
}

#[cfg(not(unix))]
fn restrict_private_file(path: &Path) -> Result<(), String> {
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

fn replace_managed_env_block(content: &str, replacement: &str) -> String {
    let preserved = if let Some(start) = content.find(GROX_MANAGED_PROVIDER_START) {
        let suffix = &content[start..];
        if let Some(relative_end) = suffix.find(GROX_MANAGED_PROVIDER_END) {
            let after = start + relative_end + GROX_MANAGED_PROVIDER_END.len();
            format!(
                "{}{}",
                content[..start].trim_end(),
                content[after..].trim_start()
            )
        } else {
            content[..start].trim_end().to_string()
        }
    } else {
        content.trim_end().to_string()
    };
    if replacement.is_empty() {
        return if preserved.is_empty() {
            preserved
        } else {
            format!("{preserved}\n")
        };
    }
    let prefix = if preserved.is_empty() {
        String::new()
    } else {
        format!("{preserved}\n\n")
    };
    format!("{prefix}{GROX_MANAGED_PROVIDER_START}\n{replacement}\n{GROX_MANAGED_PROVIDER_END}\n")
}

fn env_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn config_path(id: &str, cwd: &Path) -> Result<(PathBuf, &'static str, &'static str), String> {
    let home = grok_home()?;
    match id {
        "config" => Ok((home.join("config.toml"), "Grok config.toml", "toml")),
        "system-prompt" => Ok((home.join("system-prompt.md"), "系统提示词", "markdown")),
        "agents" => Ok((cwd.join("AGENTS.md"), "项目 AGENTS.md", "markdown")),
        _ => Err("未知配置文档".into()),
    }
}

fn parse_env_text(content: &str) -> BTreeMap<String, String> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, raw_value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty()
                || !key
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_')
            {
                return None;
            }
            let value = raw_value.trim();
            let value = if value.len() >= 2
                && ((value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\'')))
            {
                &value[1..value.len() - 1]
            } else {
                value
            };
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

/// Only variables explicitly written between Grox's markers belong to the
/// desktop app. `~/.grok/.env` is not an official Grok Build config file, so
/// inheriting arbitrary entries from it makes an OAuth CLI run behave like a
/// stale third-party provider configuration.
fn parse_grox_managed_provider_env(path: &Path) -> BTreeMap<String, String> {
    let Ok(content) = read_bounded_text(path, MAX_CONFIG_BYTES) else {
        return BTreeMap::new();
    };
    let Some((_, after_start)) = content.split_once(GROX_MANAGED_PROVIDER_START) else {
        return BTreeMap::new();
    };
    let Some((block, _)) = after_start.split_once(GROX_MANAGED_PROVIDER_END) else {
        return BTreeMap::new();
    };
    parse_env_text(block)
}

/// Start every CLI child from a clean provider environment, then add only the
/// provider explicitly selected in Grox. This prevents an OAuth login from
/// inheriting API gateway variables from the desktop app, a parent shell, or
/// unmarked lines in `~/.grok/.env`.
fn apply_grox_provider_environment(command: &mut Command) {
    for key in PROVIDER_ENV_KEYS {
        command.env_remove(key);
    }
    let Ok(home) = grok_home() else {
        return;
    };
    let values = parse_grox_managed_provider_env(&home.join(".env"));
    for key in PROVIDER_ENV_KEYS {
        if let Some(value) = values.get(key) {
            command.env(key, value);
        }
    }
}

/// ACP has a text-only filesystem contract. Keep writes in the workspace, but
/// let the CLI read its own built-in and user-installed Skill definitions.
/// Canonical paths are compared after resolution so a workspace symlink cannot
/// be used to escape the intended boundary.
fn checked_acp_readable_file(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
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

fn checked_read_file_with_roots(
    workspace: &Path,
    requested: &str,
    readonly_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let candidate = if requested == "~"
        || requested.starts_with("~/")
        || requested.starts_with("~\\")
    {
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
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
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

fn prompt_image_mime(bytes: &[u8]) -> Option<&'static str> {
    match image_mime(bytes) {
        // SVG 是带主动内容能力的文本，也不是通用多模态输入格式。文件预览仍可
        // 支持 SVG，但不能把它作为图片附件发送给供应商。
        Some("image/svg+xml") | None => None,
        mime => mime,
    }
}

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

fn is_loopback_host(host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>().is_ok_and(|address| {
        address.is_loopback()
            || matches!(address, std::net::IpAddr::V6(v6) if v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()))
    })
}

fn is_blocked_service_host(host: Option<&str>) -> bool {
    let Some(host) = host.map(|value| {
        value
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase()
    }) else {
        return true;
    };
    if host.is_empty()
        || host == "metadata"
        || host == "metadata.google.internal"
        || host.ends_with(".metadata.google.internal")
        || host == "instance-data"
        || host == "instance-data.ec2.internal"
        || host == "metadata.azure.com"
        || host.ends_with(".metadata.azure.com")
        || host == "kubernetes.default"
        || host == "kubernetes.default.svc"
        || host.ends_with(".kubernetes.default.svc")
    {
        return true;
    }
    let Ok(address) = host.parse::<std::net::IpAddr>() else {
        return false;
    };
    match address {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_unspecified()
                || v4.is_broadcast()
                || (octets[0] == 169 && octets[1] == 254)
                || octets == [100, 100, 100, 200]
        }
        std::net::IpAddr::V6(v6) => {
            if v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80 {
                return true;
            }
            v6.to_ipv4_mapped().is_some_and(|v4| {
                let octets = v4.octets();
                (octets[0] == 169 && octets[1] == 254)
                    || octets == [100, 100, 100, 200]
            })
        }
    }
}

fn checked_service_url_with_policy(
    value: &str,
    label: &str,
    allow_insecure_http: bool,
) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(value).map_err(|error| format!("无效{label}：{error}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("{label}不能在 URL 中包含用户名或密码"));
    }
    if is_blocked_service_host(parsed.host_str()) {
        return Err(format!("{label}不能指向云元数据或链路本地地址"));
    }
    let secure = parsed.scheme() == "https";
    let allowed_http = parsed.scheme() == "http"
        && (is_loopback_host(parsed.host_str()) || allow_insecure_http);
    if !secure && !allowed_http {
        return Err(format!(
            "{label}必须使用 HTTPS；远程 HTTP 需要显式启用不安全连接"
        ));
    }
    // Use url's serialized representation instead of the original input.
    // URL parsers may tolerate ASCII whitespace that would otherwise become a
    // second line in the managed dotenv block.
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn checked_service_url(value: &str, label: &str) -> Result<String, String> {
    checked_service_url_with_policy(value, label, false)
}

fn checked_api_key(value: &str) -> Result<&str, String> {
    if value.chars().any(char::is_control) {
        return Err("API Key 不能包含换行符或控制字符".into());
    }
    if value.len() > 16 * 1024 {
        return Err("API Key 过长".into());
    }
    Ok(value)
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

fn executable_file(path: &Path) -> bool {
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

fn system_grok_candidates(executable: &str) -> Vec<PathBuf> {
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

fn normalized_existing_path(path: &Path) -> Option<PathBuf> {
    if !executable_file(path) {
        return None;
    }
    path.canonicalize()
        .ok()
        .or_else(|| Some(path.to_path_buf()))
}

/// Extract the semver token from a `grok --version` line such as
/// "grok 0.2.106 (abc1234) [stable]".
fn cli_version_number(raw: &str) -> Option<semver::Version> {
    raw.split_whitespace()
        .find_map(|token| semver::Version::parse(token.trim_start_matches(['v', 'V'])).ok())
}

fn grok_binary_version(path: &str) -> Option<String> {
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

fn runtime_info(
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

fn configured_grok_command(_app: &tauri::AppHandle) -> GrokRuntimeInfo {
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

#[tauri::command]
fn acp_read_text_file(
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

fn build_acp_read_file(bytes: Vec<u8>, line: Option<u32>, limit: Option<u32>) -> AcpReadFile {
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

/// Read the TUI-compatible, binary-safe file response.  Unlike
/// `acp_read_text_file`, this command deliberately never calls
/// `read_to_string` for an image: PNG/JPEG/etc. are returned as base64 bytes
/// so the model can receive them as a multimodal tool result.
#[tauri::command]
fn acp_read_file(
    cwd: String,
    path: String,
    line: Option<u32>,
    limit: Option<u32>,
) -> Result<AcpReadFile, String> {
    let workspace = checked_workspace(&cwd)?;
    let file = checked_acp_readable_file(&workspace, &path)?;
    let metadata = fs::metadata(&file)
        .map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
    if !metadata.is_file() {
        return Err("只能读取文件".into());
    }
    if metadata.len() > MAX_ACP_TEXT_BYTES {
        return Err("文件不能超过 16 MB".into());
    }
    let bytes = fs::read(&file).map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
    Ok(build_acp_read_file(bytes, line, limit))
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

#[tauri::command]
fn acp_write_text_file(cwd: String, path: String, content: String) -> Result<(), String> {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchProviderModels {
    api_key: String,
    base_url: String,
    #[serde(default)]
    allow_insecure_http: bool,
}

#[tauri::command]
fn grok_runtime_info(app: tauri::AppHandle) -> GrokRuntimeInfo {
    configured_grok_command(&app)
}

#[tauri::command]
async fn export_session_trace(app: tauri::AppHandle, session_id: String) -> Result<String, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > 128 || !session_id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return Err("会话 ID 格式无效".into());
    }
    let runtime = configured_grok_command(&app);
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
    let output = command.output().await.map_err(|error| format!("无法启动会话诊断导出：{error}"))?;
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
    Ok(path.to_string())
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
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<GrokRuntimeInfo, String> {
    // Windows cannot replace a running executable. Stop the official CLI
    // child before invoking its official updater; the webview reload below
    // starts the freshly installed binary again.
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
    let runtime = configured_grok_command(&app);
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

async fn terminate_process(mut process: AgentProcess) {
    drop(process.stdin);
    // Job Object first: kills grandchildren that child.kill() alone orphans on Windows.
    #[cfg(windows)]
    if let Some(job) = process.job.take() {
        job.terminate_tree();
        drop(job);
    }
    let _ = process.child.kill().await;
    let _ = process.child.wait().await;
}

fn host_prefs_dir_for_app(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| default_workspace().join(".grox-host-prefs-fallback"))
}

/// Product gate: env OR host_prefs only (ignore FE for actual attach).
fn computer_use_gate_open() -> bool {
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
fn host_prefs_get(app: tauri::AppHandle) -> host_prefs::HostPrefs {
    host_prefs::load_prefs(&host_prefs_dir_for_app(&app))
}

#[tauri::command]
fn host_prefs_migrate_computer_use(
    app: tauri::AppHandle,
    fe_enabled: bool,
) -> Result<host_prefs::HostPrefs, String> {
    host_prefs::migrate_computer_use_from_fe(&host_prefs_dir_for_app(&app), fe_enabled)
}

#[tauri::command]
fn host_prefs_set_computer_use(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<host_prefs::HostPrefs, String> {
    let dir = host_prefs_dir_for_app(&app);
    let mut prefs = host_prefs::load_prefs(&dir);
    prefs.computer_use_enabled = enabled;
    prefs.computer_use_fe_migrated = true;
    host_prefs::save_prefs(&dir, &prefs)?;
    Ok(prefs)
}

#[tauri::command]
fn host_prefs_set_permission_mode(
    app: tauri::AppHandle,
    mode: String,
) -> Result<host_prefs::HostPrefs, String> {
    let mode = host_prefs::normalize_permission_mode(&mode)
        .ok_or_else(|| "无效的权限模式".to_string())?;
    let dir = host_prefs_dir_for_app(&app);
    let mut prefs = host_prefs::load_prefs(&dir);
    prefs.permission_mode = mode.to_string();
    host_prefs::save_prefs(&dir, &prefs)?;
    Ok(prefs)
}

#[tauri::command]
fn desktop_environment(app: tauri::AppHandle) -> DesktopEnvironment {
    let runtime = configured_grok_command(&app);
    // Warm host prefs cache at first environment probe.
    let _ = host_prefs::load_prefs(&host_prefs_dir_for_app(&app));
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

fn git_command(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
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

fn git_text(root: &Path, args: &[&str]) -> Result<String, String> {
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

fn optional_git_text(root: &Path, args: &[&str]) -> Option<String> {
    git_text(root, args).ok().filter(|value| !value.is_empty())
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
    let status = optional_git_text(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
    let changed_files = status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let numstat = optional_git_text(&root, &["diff", "--numstat", "HEAD"])
        .or_else(|| optional_git_text(&root, &["diff", "--numstat"]))
        .unwrap_or_default();
    let (added, removed) = numstat
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
    let porcelain = optional_git_text(&root, &["worktree", "list", "--porcelain"]).unwrap_or_default();
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
        let Some(item) = current.as_mut() else { continue };
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
        || name.len() > 64
        || name.chars().any(|character| {
            character.is_control()
                || matches!(character, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
    {
        return Err("Worktree 名称需为 1–64 个安全字符".into());
    }
    let home = grok_home()?;
    let project = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project");
    let target = home.join("worktrees").join(project).join(name);
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
    confirms: tauri::State<'_, Arc<GitConfirmStore>>,
    cwd: String,
    path: String,
    confirm_token: String,
) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let root_key = path_for_webview(&root);
    confirms.consume_worktree_remove(&root_key, &confirm_token)?;
    let target = checked_removable_worktree(&root, &path)?;
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

/// Media generation must never widen beyond this closed allowlist without a
/// real permission path — `--always-approve` is intentional only for these tools.
const MEDIA_GENERATION_TOOLS: &str = "image_gen,video_gen,image_to_video,reference_to_video";

fn checked_removable_worktree(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("Worktree 路径不能为空".into());
    }
    let canonical = PathBuf::from(requested)
        .canonicalize()
        .map_err(|error| format!("无法解析 Worktree 路径：{error}"))?;
    let primary = root
        .canonicalize()
        .map_err(|error| format!("无法解析仓库根目录：{error}"))?;
    if canonical == primary {
        return Err("不能移除仓库主工作树".into());
    }
    let managed_ok = grok_home()?
        .join("worktrees")
        .canonicalize()
        .ok()
        .is_some_and(|managed| canonical.starts_with(&managed));
    let listed = git_text(root, &["worktree", "list", "--porcelain"])?;
    let mut known = false;
    for line in listed.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            let Ok(entry) = PathBuf::from(path).canonicalize() else {
                continue;
            };
            if entry == canonical {
                known = true;
                break;
            }
        }
    }
    if !known {
        return Err("只能移除当前仓库已登记的 worktree".into());
    }
    if !managed_ok {
        return Err("只能移除 Grox 管理目录下的 worktree".into());
    }
    Ok(canonical)
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

#[tauri::command]
fn prepare_git_worktree_remove(
    confirms: tauri::State<'_, Arc<GitConfirmStore>>,
    cwd: String,
    path: String,
) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    let target = checked_removable_worktree(&root, &path)?;
    confirm_destructive_git_action(
        "Grox",
        &format!("确认强制移除 worktree？\n{}", path_for_webview(&target)),
    )?;
    confirms.issue_worktree_remove(&path_for_webview(&root))
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
        _ => "application/octet-stream",
    }
}

async fn send_static_preview_response(
    stream: &mut TcpStream,
    status: &str,
    mime: &str,
    body: &[u8],
    head_only: bool,
) {
    let csp = if mime.starts_with("text/html") {
        "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'none'; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"
    } else {
        "default-src 'none'; frame-ancestors 'none'"
    };
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
    if metadata.len() > MAX_PREVIEW_BYTES {
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
    let Ok(body) = fs::read(&candidate) else {
        send_static_preview_response(
            &mut stream,
            "500 Internal Server Error",
            "text/plain",
            b"Read failed",
            head_only,
        )
        .await;
        return;
    };
    send_static_preview_response(
        &mut stream,
        "200 OK",
        static_preview_mime(&candidate),
        &body,
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
    if !file.is_file() || !matches!(preview_type(&file).0, "html") {
        return Err("只能在浏览器预览 HTML 文件".into());
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
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("预览文件不能超过 16 MB".into());
    }
    let (kind, mime) = preview_type(&file);
    if kind == "unsupported" {
        return Err("暂不支持预览该文件类型".into());
    }
    let bytes = fs::read(&file).map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
    let content = if kind == "image" {
        BASE64.encode(bytes)
    } else {
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

/// Reveal one workspace file in the platform file manager. This is distinct
/// from `open_in_explorer`, which intentionally opens the project root.
#[tauri::command]
fn reveal_in_explorer(cwd: String, path: String) -> Result<(), String> {
    let root = checked_workspace(&cwd)?;
    let file = checked_workspace_file(&root, &path)?;
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
        .map_err(|error| format!("无法在 Finder 中显示文件：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(file.parent().unwrap_or(&file))
        .spawn()
        .map_err(|error| format!("无法打开文件管理器：{error}"))?;
    Ok(())
}

/// Ask the platform to open a workspace file with its default application.
#[tauri::command]
fn open_file_with_default(cwd: String, path: String) -> Result<(), String> {
    let root = checked_workspace(&cwd)?;
    let file = checked_workspace_file(&root, &path)?;
    if !file.is_file() {
        return Err("只能使用默认应用打开文件".into());
    }
    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg(&file)
        .spawn()
        .map_err(|error| format!("无法打开默认应用：{error}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&file)
        .spawn()
        .map_err(|error| format!("无法打开默认应用：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&file)
        .spawn()
        .map_err(|error| format!("无法打开默认应用：{error}"))?;
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
        let Ok(entries) = fs::read_dir(root) else { return };
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
        .or_else(|| path.file_stem().and_then(|value| value.to_str()).map(str::to_string))?;
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
        .filter(|item| item.launch_target.as_deref().is_some_and(|target| Path::new(target).is_absolute()))
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
        .map(|value| value.split(';').any(|mime| mime.starts_with("text/x-") || mime.contains("javascript") || mime.contains("json")))
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
        let Ok(entries) = fs::read_dir(root) else { continue };
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

/// Create a sibling Git worktree for the Codex-style “permanent worktree”
/// actions. The target is never inside the current project, and an available
/// suffix is chosen instead of overwriting an existing directory.
#[tauri::command]
fn create_permanent_worktree(cwd: String) -> Result<String, String> {
    let root = checked_workspace(&cwd)?;
    if !root.join(".git").exists() {
        return Err("当前项目不是 Git 仓库，无法创建永久工作树".into());
    }
    let parent = root
        .parent()
        .ok_or_else(|| "无法确定工作树所在目录".to_string())?;
    let base = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("grox-project");
    let mut target = parent.join(format!("{base}-worktree"));
    let mut suffix = 2u32;
    while target.exists() {
        target = parent.join(format!("{base}-worktree-{suffix}"));
        suffix = suffix.saturating_add(1);
        if suffix > 10_000 {
            return Err("可用的工作树目录过多".into());
        }
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let branch = format!("grox/worktree-{timestamp}");
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
            "创建永久工作树失败".into()
        } else {
            format!("创建永久工作树失败：{message}")
        });
    }
    Ok(path_for_webview(&target))
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
    atomic_write(&path, &content)?;
    if matches!(request.id.as_str(), "config" | "system-prompt") {
        restrict_private_file(&path)?;
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
    })
}

fn provider_profiles_path() -> Result<PathBuf, String> {
    Ok(grok_home()?.join("grox-providers.json"))
}

fn read_provider_profiles_file() -> Result<ProviderProfilesFile, String> {
    let path = provider_profiles_path()?;
    if !path.exists() {
        return Ok(ProviderProfilesFile::default());
    }
    let content = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    match serde_json::from_str(&content) {
        Ok(value) => Ok(value),
        Err(error) => {
            // A corrupt profiles file must not brick every profile command
            // (it survives app reinstalls because it lives in ~/.grok).
            // Quarantine it and start from an empty file so the user can
            // re-save their profiles instead of hitting a dead end.
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let backup = path.with_extension(format!("corrupt-{millis}.bak"));
            if let Err(rename_error) = fs::rename(&path, &backup) {
                return Err(format!(
                    "无法解析供应商档案 {}：{error}；备份失败：{rename_error}",
                    path.display()
                ));
            }
            Ok(ProviderProfilesFile::default())
        }
    }
}

fn write_provider_profiles_file(value: &ProviderProfilesFile) -> Result<(), String> {
    let path = provider_profiles_path()?;
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化供应商档案：{error}"))?;
    atomic_write(&path, &content)?;
    restrict_private_file(&path)
}

fn provider_auth_overrides_path() -> Result<PathBuf, String> {
    Ok(grok_home()?.join(GROX_PROVIDER_AUTH_OVERRIDES_FILE))
}

fn read_provider_auth_overrides() -> Result<ProviderAuthOverridesFile, String> {
    let path = provider_auth_overrides_path()?;
    if !path.exists() {
        return Ok(ProviderAuthOverridesFile::default());
    }
    let content = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "无法读取 Grox 兼容服务认证还原信息 {}：{error}",
            path.display()
        )
    })
}

fn write_provider_auth_overrides(value: &ProviderAuthOverridesFile) -> Result<(), String> {
    let path = provider_auth_overrides_path()?;
    if value.models.is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法移除 Grox 兼容服务认证还原信息：{error}"))?;
        }
        return Ok(());
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化 Grox 兼容服务认证还原信息：{error}"))?;
    atomic_write(&path, &content)?;
    restrict_private_file(&path)
}

fn parse_grok_config_document(content: &str) -> Result<Document, String> {
    content.parse::<Document>().map_err(|error| {
        format!(
            "Grok config.toml 格式无效，无法安全切换兼容服务认证：{error}。请先修复该文件后重试。"
        )
    })
}

fn config_value_item(raw: &str) -> Result<Item, String> {
    let document = format!("value = {raw}\n")
        .parse::<Document>()
        .map_err(|error| format!("无法还原原有模型认证配置：{error}"))?;
    document
        .get("value")
        .cloned()
        .ok_or_else(|| "无法还原原有模型认证配置".to_string())
}

fn model_table_mut<'a>(document: &'a mut Document, model_id: &str) -> Result<(&'a mut dyn TableLike, bool), String> {
    let root = document.as_table_mut();
    if !root.contains_key("model") {
        root.insert("model", Item::Table(Table::new()));
    }
    let models = root
        .get_mut("model")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "Grok config.toml 中的 [model] 不是 TOML 表，无法安全写入兼容服务认证".to_string())?;
    let existed = models.contains_key(model_id);
    if !existed {
        models.insert(model_id, Item::Table(Table::new()));
    }
    let model = models
        .get_mut(model_id)
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| format!("模型 {model_id} 的配置不是 TOML 表，无法安全写入兼容服务认证"))?;
    Ok((model, existed))
}

fn restore_grox_provider_auth_overrides() -> Result<(), String> {
    let overrides = read_provider_auth_overrides()?;
    if overrides.models.is_empty() {
        return Ok(());
    }
    let home = grok_home()?;
    let path = home.join("config.toml");
    let content = if path.exists() {
        read_bounded_text(&path, MAX_CONFIG_BYTES)?
    } else {
        String::new()
    };
    let mut document = parse_grok_config_document(&content)?;
    let root = document.as_table_mut();
    let Some(models) = root.get_mut("model").and_then(Item::as_table_like_mut) else {
        // A user might have deleted the whole table while Grox was closed;
        // that already removes every override, so do not recreate it.
        write_provider_auth_overrides(&ProviderAuthOverridesFile::default())?;
        return Ok(());
    };

    for (model_id, backup) in &overrides.models {
        let Some(item) = models.get_mut(model_id) else {
            continue;
        };
        let Some(model) = item.as_table_like_mut() else {
            continue;
        };
        match backup.env_key.as_deref() {
            Some(raw) => {
                model.insert("env_key", config_value_item(raw)?);
            }
            None => {
                model.remove("env_key");
            }
        }
        match backup.api_key.as_deref() {
            Some(raw) => {
                model.insert("api_key", config_value_item(raw)?);
            }
            None => {
                model.remove("api_key");
            }
        }
        match backup.base_url.as_deref() {
            Some(raw) => {
                model.insert("base_url", config_value_item(raw)?);
            }
            None => {
                model.remove("base_url");
            }
        }
        match backup.api_backend.as_deref() {
            Some(raw) => {
                model.insert("api_backend", config_value_item(raw)?);
            }
            None => {
                model.remove("api_backend");
            }
        }
    }

    // Remove model tables that Grox itself created only when they have not
    // gained any user settings in the meantime.
    let created: Vec<String> = overrides
        .models
        .iter()
        .filter_map(|(id, backup)| (!backup.model_existed).then_some(id.clone()))
        .collect();
    for model_id in created {
        let remove = models
            .get(&model_id)
            .and_then(Item::as_table_like)
            .is_some_and(|model| model.is_empty());
        if remove {
            models.remove(&model_id);
        }
    }
    let remove_models_root = models.is_empty();
    if remove_models_root {
        root.remove("model");
    }

    atomic_write(&path, &document.to_string())?;
    restrict_private_file(&path)?;
    write_provider_auth_overrides(&ProviderAuthOverridesFile::default())
}

fn provider_backend_overrides_path() -> Result<PathBuf, String> {
    Ok(grok_home()?.join(GROX_PROVIDER_BACKEND_OVERRIDES_FILE))
}

fn read_provider_backend_overrides() -> Result<ProviderBackendOverridesFile, String> {
    let path = provider_backend_overrides_path()?;
    if !path.exists() {
        return Ok(ProviderBackendOverridesFile::default());
    }
    let content = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "无法读取 Grox 兼容服务协议还原信息 {}：{error}",
            path.display()
        )
    })
}

fn write_provider_backend_overrides(value: &ProviderBackendOverridesFile) -> Result<(), String> {
    let path = provider_backend_overrides_path()?;
    if value.models.is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法移除 Grox 兼容服务协议还原信息：{error}"))?;
        }
        return Ok(());
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化 Grox 兼容服务协议还原信息：{error}"))?;
    atomic_write(&path, &content)?;
    restrict_private_file(&path)
}

fn restore_grox_provider_backend_overrides() -> Result<(), String> {
    let overrides = read_provider_backend_overrides()?;
    if overrides.models.is_empty() {
        return Ok(());
    }
    let home = grok_home()?;
    let path = home.join("config.toml");
    let content = if path.exists() {
        read_bounded_text(&path, MAX_CONFIG_BYTES)?
    } else {
        String::new()
    };
    let mut document = parse_grok_config_document(&content)?;
    let root = document.as_table_mut();
    let Some(models) = root.get_mut("model").and_then(Item::as_table_like_mut) else {
        write_provider_backend_overrides(&ProviderBackendOverridesFile::default())?;
        return Ok(());
    };

    for (model_id, backup) in &overrides.models {
        let Some(model) = models.get_mut(model_id).and_then(Item::as_table_like_mut) else {
            continue;
        };
        match backup.env_key.as_deref() {
            Some(raw) => {
                model.insert("env_key", config_value_item(raw)?);
            }
            None => {
                model.remove("env_key");
            }
        }
        match backup.base_url.as_deref() {
            Some(raw) => {
                model.insert("base_url", config_value_item(raw)?);
            }
            None => {
                model.remove("base_url");
            }
        }
        match backup.api_backend.as_deref() {
            Some(raw) => {
                model.insert("api_backend", config_value_item(raw)?);
            }
            None => {
                model.remove("api_backend");
            }
        }
        match backup.model.as_deref() {
            Some(raw) => {
                model.insert("model", config_value_item(raw)?);
            }
            None => {
                model.remove("model");
            }
        }
    }

    let created = overrides
        .models
        .iter()
        .filter_map(|(id, backup)| (!backup.model_existed).then_some(id.clone()))
        .collect::<Vec<_>>();
    for model_id in created {
        let remove = models
            .get(&model_id)
            .and_then(Item::as_table_like)
            .is_some_and(|model| model.is_empty());
        if remove {
            models.remove(&model_id);
        }
    }
    if models.is_empty() {
        root.remove("model");
    }
    atomic_write(&path, &document.to_string())?;
    restrict_private_file(&path)?;
    write_provider_backend_overrides(&ProviderBackendOverridesFile::default())
}

fn apply_grox_provider_backend_overrides(
    model_ids: &[String],
    base_url: &str,
    primary_model: &str,
    api_backend: &str,
) -> Result<(), String> {
    // Switches are transactional at the config level: first restore the
    // previous profile's exact values, then add Chat Completions only for the
    // selected models advertised by the new profile.
    restore_grox_provider_backend_overrides()?;
    let mut ids = model_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }

    let home = grok_home()?;
    let path = home.join("config.toml");
    let content = if path.exists() {
        read_bounded_text(&path, MAX_CONFIG_BYTES)?
    } else {
        String::new()
    };
    let mut document = parse_grok_config_document(&content)?;
    let mut backups = BTreeMap::new();
    for model_id in ids {
        let is_title_alias = model_id == "grok-4.5";
        let (model, model_existed) = model_table_mut(&mut document, &model_id)?;
        backups.insert(
            model_id,
            ProviderBackendBackup {
                model_existed,
                env_key: model.get("env_key").map(ToString::to_string),
                base_url: model.get("base_url").map(ToString::to_string),
                api_backend: model.get("api_backend").map(ToString::to_string),
                model: model.get("model").map(ToString::to_string),
            },
        );
        // A named env key is the documented credential selector; the actual
        // secret remains solely in the ACP child's managed environment.
        model.insert("env_key", toml_value("XAI_API_KEY"));
        model.insert("base_url", toml_value(base_url));
        model.insert("api_backend", toml_value(api_backend));
        if is_title_alias && primary_model != "grok-4.5" {
            // Grok Build uses this alias to generate a title before the first
            // reply. Route that internal request to the profile's actual
            // model so a gateway that exposes only the selected model does
            // not abort the whole prompt during title generation.
            model.insert("model", toml_value(primary_model));
        } else {
            model.remove("model");
        }
    }
    atomic_write(&path, &document.to_string())?;
    restrict_private_file(&path)?;
    write_provider_backend_overrides(&ProviderBackendOverridesFile { models: backups })
}

fn canonical_model_id(model: &str, available_models: &[String]) -> String {
    available_models
        .iter()
        .find(|available| available.eq_ignore_ascii_case(model))
        .cloned()
        .unwrap_or_else(|| model.to_string())
}

fn canonicalize_resident_models(resident_models: &mut Vec<String>, available_models: &[String]) {
    let mut canonical = Vec::new();
    for model in resident_models.drain(..) {
        let model = canonical_model_id(model.trim(), available_models);
        if !model.is_empty() && !canonical.iter().any(|existing: &String| existing == &model) {
            canonical.push(model);
        }
    }
    *resident_models = canonical;
}

fn compatible_profile_backend_model_ids(profile: &StoredProviderProfile) -> Vec<String> {
    let mut models = profile.resident_models.clone();
    if models.is_empty() {
        if let Some(model) = profile.model.as_ref() {
            models.push(model.clone());
        } else if let Some(model) = profile.available_models.first() {
            models.push(model.clone());
        }
    }
    canonicalize_resident_models(&mut models, &profile.available_models);
    // Grok Build 0.2.x still uses grok-4.5 for session-title generation even
    // when a dynamic provider selected another model. It inherits the active
    // endpoint, so it needs the same transport declaration; otherwise a failed
    // title request triggers auth recovery before the selected model can answer.
    if !models.iter().any(|model| model == "grok-4.5") {
        models.push("grok-4.5".to_string());
    }
    models
}

fn provider_profile_summary(profile: &StoredProviderProfile) -> ProviderProfileSummary {
    let mut resident_models = profile.resident_models.clone();
    if resident_models.is_empty() {
        if let Some(model) = profile.model.as_ref().filter(|model| !model.is_empty()) {
            resident_models.push(model.clone());
        }
    }
    // The `/models` catalog is the source of truth for the spelling sent to a
    // gateway. A case-only mismatch is enough for many gateways to return a
    // misleading 503 "model unavailable" response.
    canonicalize_resident_models(&mut resident_models, &profile.available_models);
    ProviderProfileSummary {
        id: profile.id.clone(),
        name: profile.name.clone(),
        // Never return the raw key to the WebView. The renderer only needs a
        // presence bit; updates use empty-key-means-keep semantics.
        api_key: String::new(),
        has_api_key: !profile.api_key.is_empty(),
        base_url: profile.base_url.clone(),
        allow_insecure_http: profile.allow_insecure_http,
        api_backend: profile.api_backend,
        available_models: profile.available_models.clone(),
        resident_models,
    }
}

fn compatible_models_url(base_url: &str, allow_insecure_http: bool) -> Result<String, String> {
    let base = checked_service_url_with_policy(
        base_url,
        "服务地址",
        allow_insecure_http,
    )?;
    let mut parsed = url::Url::parse(&base).map_err(|error| format!("无效服务地址：{error}"))?;
    let path = parsed.path().trim_end_matches('/');
    if !path.ends_with("/models") {
        parsed.set_path(&format!("{path}/models"));
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string().trim_end_matches('/').to_owned())
}

fn checked_model_ids(models: Vec<String>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for model in models {
        let model = model.trim();
        if model.is_empty() {
            continue;
        }
        if model.chars().count() > 200 || model.chars().any(char::is_control) {
            return Err("模型 ID 不能超过 200 个字符或包含控制字符".into());
        }
        if !result.iter().any(|existing| existing == model) {
            result.push(model.to_owned());
        }
        if result.len() > 200 {
            return Err("常驻模型不能超过 200 个".into());
        }
    }
    Ok(result)
}

fn compatible_provider_env(
    api_key: &str,
    base_url: &str,
    allow_insecure_http: bool,
) -> Result<String, String> {
    let key = checked_api_key(api_key.trim())?;
    if key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    let base = checked_service_url_with_policy(
        base_url.trim(),
        "服务地址",
        allow_insecure_http,
    )?;
    let lines = vec![
        format!("XAI_API_KEY={}", env_value(key)),
        format!("GROK_MODELS_BASE_URL={}", env_value(&base)),
        format!(
            "GROK_MODELS_LIST_URL={}",
            env_value(&compatible_models_url(&base, allow_insecure_http)?)
        ),
    ];
    Ok(lines.join("\n"))
}

fn active_profile_for_managed_environment(value: &ProviderProfilesFile) -> Option<StoredProviderProfile> {
    let managed = parse_grox_managed_provider_env(&grok_home().ok()?.join(".env"));
    let base = managed.get("GROK_MODELS_BASE_URL")?.trim_end_matches('/');
    let id = value.active_id.as_deref()?;
    value
        .profiles
        .iter()
        .find(|profile| profile.id == id && profile.base_url.trim_end_matches('/') == base)
        .cloned()
}

fn synchronize_active_provider_backend() -> Result<(), String> {
    let profiles = read_provider_profiles_file()?;
    if let Some(profile) = active_profile_for_managed_environment(&profiles) {
        let model_ids = compatible_profile_backend_model_ids(&profile);
        let primary_model = model_ids
            .first()
            .ok_or("当前供应商没有可用模型，无法配置请求协议")?;
        let backend = profile.api_backend.config_value(&profile.name, &profile.base_url);
        apply_grox_provider_backend_overrides(&model_ids, &profile.base_url, primary_model, backend)
    } else {
        // OAuth and official API mode should never retain a custom endpoint's
        // Chat Completions override after a process restart.
        restore_grox_provider_backend_overrides()
    }
}

#[tauri::command]
fn list_provider_profiles() -> Result<ProviderProfilesResponse, String> {
    let value = read_provider_profiles_file()?;
    // A profile is active only when the process environment actually points
    // at it. This avoids a stale persisted id briefly labelling OAuth as an
    // OpenAI-compatible provider while the ACP child is being replaced.
    let active_id = active_profile_for_managed_environment(&value).map(|profile| profile.id);
    Ok(ProviderProfilesResponse {
        active_id,
        profiles: value
            .profiles
            .iter()
            .map(provider_profile_summary)
            .collect(),
    })
}

#[tauri::command]
fn save_provider_profile(request: SaveProviderProfile) -> Result<ProviderProfileSummary, String> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("供应商名称必须为 1–80 个可见字符".into());
    }
    let mut value = read_provider_profiles_file()?;
    let existing = request
        .id
        .as_deref()
        .and_then(|id| value.profiles.iter().find(|profile| profile.id == id));
    let key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .or_else(|| existing.map(|profile| profile.api_key.as_str()))
        .ok_or("API Key 不能为空")?;
    compatible_provider_env(key, &request.base_url, request.allow_insecure_http)?;
    let mut resident_models = checked_model_ids(request.resident_models)?;
    let base_url = checked_service_url_with_policy(
        &request.base_url,
        "服务地址",
        request.allow_insecure_http,
    )?;
    let available_models = existing
        .filter(|profile| profile.base_url == base_url && profile.api_key == key)
        .map(|profile| profile.available_models.clone())
        .unwrap_or_default();
    canonicalize_resident_models(&mut resident_models, &available_models);
    let id = request.id.unwrap_or_else(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("provider-{}-{nanos}", std::process::id())
    });
    if id.len() > 96
        || id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("无效的供应商档案 ID".into());
    }
    let profile = StoredProviderProfile {
        id: id.clone(),
        name: name.to_owned(),
        api_key: checked_api_key(key)?.to_owned(),
        base_url: base_url.clone(),
        allow_insecure_http: request.allow_insecure_http,
        api_backend: request.api_backend,
        models_url: None,
        model: resident_models.first().cloned(),
        available_models,
        resident_models,
    };
    if let Some(index) = value.profiles.iter().position(|entry| entry.id == id) {
        value.profiles[index] = profile.clone();
    } else {
        value.profiles.push(profile.clone());
    }
    write_provider_profiles_file(&value)?;
    Ok(provider_profile_summary(&profile))
}

async fn fetch_compatible_models(
    api_key: &str,
    base_url: &str,
    allow_insecure_http: bool,
) -> Result<Vec<String>, String> {
    let key = checked_api_key(api_key.trim())?;
    if key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    let endpoint = compatible_models_url(base_url, allow_insecure_http)?;
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
        .map_err(|error| format!("无法创建模型目录客户端：{error}"))?
        .get(endpoint)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("无法获取模型列表：{error}"))?
        .error_for_status()
        .map_err(|error| format!("模型服务返回错误：{error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_MODELS_BODY_BYTES as u64)
    {
        return Err(format!(
            "模型列表响应超过 {} MB 上限",
            MAX_PROVIDER_MODELS_BODY_BYTES / 1024 / 1024
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("无法读取模型列表：{error}"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_MODELS_BODY_BYTES {
            return Err(format!(
                "模型列表响应超过 {} MB 上限",
                MAX_PROVIDER_MODELS_BODY_BYTES / 1024 / 1024
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let response: OpenAiModelsResponse = serde_json::from_slice(&body)
        .map_err(|error| format!("模型列表不是 OpenAI 兼容格式：{error}"))?;
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
async fn fetch_provider_models(request: FetchProviderModels) -> Result<Vec<String>, String> {
    fetch_compatible_models(
        &request.api_key,
        &request.base_url,
        request.allow_insecure_http,
    )
    .await
}

#[tauri::command]
async fn refresh_provider_models(id: String) -> Result<ProviderProfileSummary, String> {
    let profile = read_provider_profiles_file()?
        .profiles
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or("供应商档案不存在")?;
    let models = fetch_compatible_models(
        &profile.api_key,
        &profile.base_url,
        profile.allow_insecure_http,
    )
    .await?;

    let mut value = read_provider_profiles_file()?;
    let stored = value
        .profiles
        .iter_mut()
        .find(|stored| stored.id == profile.id)
        .ok_or("供应商档案已被删除")?;
    stored.available_models = models;
    canonicalize_resident_models(&mut stored.resident_models, &stored.available_models);
    if stored.resident_models.is_empty() {
        if let Some(model) = stored.available_models.first() {
            stored.resident_models.push(model.clone());
        }
    }
    stored.model = stored.resident_models.first().cloned();
    let summary = provider_profile_summary(stored);
    write_provider_profiles_file(&value)?;
    Ok(summary)
}

#[tauri::command]
fn activate_provider_profile(id: String) -> Result<(), String> {
    let mut value = read_provider_profiles_file()?;
    let profile = value
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .cloned()
        .ok_or("供应商档案不存在")?;
    // Custom-model endpoints are configured exclusively through Grok Build's
    // documented process environment. Older Grox versions wrote a generated
    // `[model.*]` block for every built-in model; restore those tracked edits
    // once, then leave the user's config.toml entirely under their control.
    restore_grox_provider_auth_overrides()?;
    let model_ids = compatible_profile_backend_model_ids(&profile);
    let primary_model = model_ids
        .first()
        .ok_or("供应商没有可用模型；请先获取模型目录并选择一个模型")?;
    let backend = profile.api_backend.config_value(&profile.name, &profile.base_url);
    apply_grox_provider_backend_overrides(&model_ids, &profile.base_url, primary_model, backend)?;
    let replacement = compatible_provider_env(
        &profile.api_key,
        &profile.base_url,
        profile.allow_insecure_http,
    )?;
    let path = grok_home()?.join(".env");
    let current = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    atomic_write(&path, &replace_managed_env_block(&current, &replacement))?;
    restrict_private_file(&path)?;
    value.active_id = Some(profile.id);
    write_provider_profiles_file(&value)
}

#[tauri::command]
fn delete_provider_profile(id: String) -> Result<(), String> {
    let mut value = read_provider_profiles_file()?;
    let before = value.profiles.len();
    value.profiles.retain(|profile| profile.id != id);
    if before == value.profiles.len() {
        return Err("供应商档案不存在".into());
    }
    if value.active_id.as_deref() == Some(id.as_str()) {
        restore_grox_provider_auth_overrides()?;
        restore_grox_provider_backend_overrides()?;
        let path = grok_home()?.join(".env");
        let current = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
        atomic_write(&path, &replace_managed_env_block(&current, ""))?;
        restrict_private_file(&path)?;
        value.active_id = None;
    }
    write_provider_profiles_file(&value)
}

#[tauri::command]
fn read_provider_status() -> Result<ProviderStatus, String> {
    let values = parse_grox_managed_provider_env(&grok_home()?.join(".env"));
    let api_key = values
        .get("XAI_API_KEY")
        .filter(|value| !value.trim().is_empty());
    let base_url = values
        .get("GROK_MODELS_BASE_URL")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let kind = if base_url.is_some() {
        "compatible"
    } else if api_key.is_some() {
        "official"
    } else {
        "oauth"
    };
    Ok(ProviderStatus {
        kind,
        has_api_key: api_key.is_some(),
        base_url,
    })
}

#[tauri::command]
fn configure_provider(request: ProviderConfig) -> Result<(), String> {
    let home = grok_home()?;
    let path = home.join(".env");
    let current = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    let current_values = parse_grox_managed_provider_env(&path);
    let requested_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let saved_key = current_values
        .get("XAI_API_KEY")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let replacement = match request.kind.as_str() {
        "oauth" => {
            restore_grox_provider_auth_overrides()?;
            restore_grox_provider_backend_overrides()?;
            String::new()
        }
        "official" => {
            restore_grox_provider_auth_overrides()?;
            restore_grox_provider_backend_overrides()?;
            let key = requested_key.or(saved_key).ok_or("API Key 不能为空")?;
            let key = checked_api_key(key)?;
            format!("XAI_API_KEY={}", env_value(key))
        }
        "compatible" => {
            let base_url = request.base_url.as_deref().unwrap_or_default();
            let key = requested_key.or(saved_key).ok_or("API Key 不能为空")?;
            let replacement = compatible_provider_env(key, base_url, false)?;
            restore_grox_provider_auth_overrides()?;
            restore_grox_provider_backend_overrides()?;
            replacement
        }
        _ => return Err("未知账户接入类型".into()),
    };
    atomic_write(&path, &replace_managed_env_block(&current, &replacement))?;
    restrict_private_file(&path)?;
    let mut profiles = read_provider_profiles_file()?;
    if profiles.active_id.take().is_some() {
        write_provider_profiles_file(&profiles)?;
    }
    Ok(())
}

/// Parse + gate a user/markdown open URL (credentials, remote HTTP, IMDS/SSRF).
fn parse_browser_url(url: &str) -> Result<url::Url, String> {
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

fn spawn_system_browser(parsed: &url::Url) -> Result<(), String> {
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

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = parse_browser_url(&url)?;
    spawn_system_browser(&parsed)
}

fn is_media_https_host_allowed(host: Option<&str>) -> bool {
    let Some(host) = host.map(|value| value.trim().trim_end_matches('.').to_ascii_lowercase()) else {
        return false;
    };
    MEDIA_HTTPS_HOST_ALLOWLIST
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

#[tauri::command]
fn open_media_external(url: String) -> Result<(), String> {
    let parsed = parse_browser_url(&url).map_err(|error| format!("无效媒体链接：{error}"))?;
    if parsed.scheme() == "https" && !is_media_https_host_allowed(parsed.host_str()) {
        return Err("媒体链接域名不在允许列表中".into());
    }
    spawn_system_browser(&parsed)
}

fn ensure_computer_plugin() -> Result<PathBuf, String> {
    let root = grok_home()?.join("plugins").join("grox-computer-use");
    let skill = root.join("skills").join("computer");
    fs::create_dir_all(&skill).map_err(|error| format!("无法创建 Computer Use Skill：{error}"))?;
    fs::write(
        root.join("plugin.json"),
        r#"{"name":"grox-desktop-computer-use","version":"0.3.2","description":"Grox desktop Computer Use harness (Windows full control; macOS/Linux observation-first)"}"#,
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

#[tauri::command]
fn computer_session_extensions(
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
) -> Result<ComputerSessionExtensions, String> {
    // Soft-fail when host gate closed: empty lists, no lease (FE must not cache control).
    if !computer_use_gate_open() {
        return Ok(ComputerSessionExtensions {
            mcp_servers: Vec::new(),
            plugin_dirs: Vec::new(),
            lease_id: String::new(),
        });
    }
    let mut lease_bytes = [0_u8; 16];
    getrandom::fill(&mut lease_bytes)
        .map_err(|error| format!("无法创建 Computer Use 租约：{error}"))?;
    let lease_id = lease_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    computer_mcp::clear_emergency_stop(&lease_id)?;
    // Prefer a real desktop harness wherever we can observe the screen.
    // Windows keeps the full UIA controller; macOS/Linux expose the same MCP
    // surface with platform-limited executors so agents degrade gracefully.
    let plugin = ensure_computer_plugin()?;
    let endpoint = computer_mcp::serve_http(lease_id.clone())?;
    leases.put_computer(
        lease_id.clone(),
        mcp_leases::computer_server_config(&endpoint.url, &endpoint.token),
    )?;
    Ok(ComputerSessionExtensions {
        mcp_servers: Vec::new(),
        plugin_dirs: vec![path_for_webview(&plugin)],
        lease_id,
    })
}

#[tauri::command]
fn computer_shutdown_lease(
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    lease_id: String,
) -> Result<(), String> {
    leases.remove_computer(&lease_id);
    computer_mcp::shutdown_http(&lease_id);
    Ok(())
}

#[tauri::command]
fn computer_emergency_stop(lease_id: String) -> Result<(), String> {
    computer_mcp::mark_emergency_stop(&lease_id)
}

#[tauri::command]
fn computer_clear_emergency_stop(lease_id: String) -> Result<(), String> {
    computer_mcp::clear_emergency_stop(&lease_id)
}

#[tauri::command]
fn browser_session_extensions(
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
) -> Result<BrowserSessionExtensions, String> {
    let mut lease_bytes = [0_u8; 16];
    getrandom::fill(&mut lease_bytes)
        .map_err(|error| format!("无法创建 Browser Use 租约：{error}"))?;
    let lease_id = lease_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let endpoint = browser_mcp::serve_http(lease_id.clone())?;
    leases.put_browser(
        lease_id.clone(),
        mcp_leases::browser_server_config(&endpoint.url, &endpoint.token),
    )?;
    Ok(BrowserSessionExtensions {
        mcp_servers: Vec::new(),
        lease_id,
    })
}

#[tauri::command]
fn browser_shutdown_lease(
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    lease_id: String,
) -> Result<(), String> {
    leases.remove_browser(&lease_id);
    browser_mcp::shutdown_http(&lease_id);
    Ok(())
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
fn save_media_reference(cwd: String, name: String, data: String) -> Result<String, String> {
    let cwd = checked_workspace(&cwd)?;
    let extension = Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or("参考图片缺少扩展名")?;
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("参考图片仅支持 PNG、JPEG 或 WebP".into());
    }
    // Base64 约为原文件的 4/3；同时限制编码前后大小，不能只信任 WebView 字符数。
    if data.len() > MAX_MEDIA_REFERENCE_BYTES.saturating_mul(4) / 3 + 1024 {
        return Err("参考图片不能超过 24 MB".into());
    }
    let payload = data
        .rsplit_once(',')
        .map(|(_, value)| value)
        .unwrap_or(&data);
    let bytes = BASE64
        .decode(payload)
        .map_err(|error| format!("参考图片编码无效：{error}"))?;
    if bytes.len() > MAX_MEDIA_REFERENCE_BYTES {
        return Err("参考图片不能超过 24 MB".into());
    }
    let detected = prompt_image_mime(&bytes).ok_or("参考图片内容不是有效的 PNG、JPEG 或 WebP")?;
    let expected = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => unreachable!(),
    };
    if detected != expected {
        return Err(format!(
            "参考图片内容与扩展名不符（内容 {detected}，扩展名 .{extension}）"
        ));
    }
    let directory = cwd.join(".grox").join("media-input");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建媒体输入目录：{error}"))?;
    let path = directory.join(format!(
        "reference-{}-{}.{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        extension
    ));
    fs::write(&path, bytes).map_err(|error| format!("无法保存参考图片：{error}"))?;
    Ok(path_for_webview(&path))
}

#[tauri::command]
async fn generate_media(
    app: tauri::AppHandle,
    request: MediaGenerationRequest,
) -> Result<MediaGenerationResult, String> {
    let cwd = checked_workspace(&request.cwd)?;
    let prompt = checked_media_prompt(&request)?;
    let runtime = configured_grok_command(&app);
    let mut command = Command::new(&runtime.path);
    command
        .arg("--single")
        .arg(&prompt)
        .args(["--output-format", "streaming-json", "--always-approve"])
        .args(["--tools", MEDIA_GENERATION_TOOLS])
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Keep media generation on the same authentication path as a terminal
    // invocation. API variables are added only for the provider explicitly
    // managed by Grox; OAuth gets a clean official CLI environment.
    command.env("GROK_CLIENT_NAME", UPSTREAM_CLI_CLIENT_NAME);
    apply_grox_provider_environment(&mut command);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(Duration::from_secs(600), command.output())
        .await
        .map_err(|_| "媒体生成超过 10 分钟，任务已终止".to_string())?
        .map_err(|error| format!("无法启动 Grok Build 媒体生成：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = if stderr.trim().is_empty() {
            stdout.as_ref()
        } else {
            stderr.as_ref()
        };
        return Err(format!(
            "Grok Build 媒体生成失败：{}",
            detail.trim().chars().take(4_000).collect::<String>()
        ));
    }
    let artifacts = extract_media_artifacts(&stdout, &cwd)?;
    if artifacts.is_empty() {
        return Err(format!(
            "Grok Build 已结束，但未返回媒体产物：{}",
            stdout
                .trim()
                .chars()
                .rev()
                .take(2_000)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    for artifact in &artifacts {
        if let Some(path) = artifact.path.as_deref() {
            app.asset_protocol_scope()
                .allow_file(PathBuf::from(path))
                .map_err(|error| format!("无法授权媒体预览：{error}"))?;
        }
    }
    Ok(MediaGenerationResult {
        artifacts,
        summary: format!("Grok Build 已生成 {} 个媒体产物", request.count),
    })
}

fn checked_media_prompt(request: &MediaGenerationRequest) -> Result<String, String> {
    let cwd = checked_workspace(&request.cwd)?;
    let prompt = request.prompt.trim();
    if prompt.is_empty() || prompt.chars().count() > 4_000 {
        return Err("媒体提示词必须为 1–4000 个字符".into());
    }
    let aspect = match request.aspect.as_str() {
        "1:1" | "16:9" | "9:16" | "4:3" => request.aspect.as_str(),
        _ => return Err("不支持的画面比例".into()),
    };
    let instruction = match request.kind.as_str() {
        "image" => format!(
            "必须调用内置 image_gen 工具真实生成 {count} 张图片。画面比例 {aspect}。生成完成后仅列出每个实际输出文件的绝对路径或 URL。用户提示：{prompt}",
            count = request.count.clamp(1, 4)
        ),
        "video" => {
            let reference = if let Some(path) = request.reference_path.as_deref() {
                let file = checked_workspace_file(&cwd, path)?;
                if !file.is_file() {
                    return Err("参考图片不存在".into());
                }
                format!(
                    "参考图片绝对路径：{}。必须使用 image_to_video 或 reference_to_video。",
                    path_for_webview(&file)
                )
            } else {
                "必须使用 video_gen。".to_string()
            };
            format!(
                "{reference}真实生成视频，画面比例 {aspect}，时长 {duration} 秒，分辨率 {resolution}。生成完成后仅列出实际输出文件的绝对路径或 URL。用户提示：{prompt}",
                duration = request.duration.clamp(1, 30),
                resolution = request.resolution
            )
        }
        _ => return Err("不支持的媒体类型".into()),
    };
    Ok(instruction)
}

fn extract_media_artifacts(output: &str, cwd: &Path) -> Result<Vec<MediaArtifact>, String> {
    let mut candidates = Vec::new();
    for line in output.lines() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            collect_media_strings(&value, &mut candidates);
        } else {
            candidates.extend(line.split_whitespace().map(|value| {
                value
                    .trim_matches(|c| matches!(c, '"' | '\'' | ',' | ')' | '('))
                    .to_string()
            }));
        }
    }
    let mut artifacts = Vec::new();
    for candidate in candidates {
        let clean = candidate.trim().trim_matches('"');
        let lower = clean.to_ascii_lowercase();
        let mime = if lower.contains(".png") {
            "image/png"
        } else if lower.contains(".jpg") || lower.contains(".jpeg") {
            "image/jpeg"
        } else if lower.contains(".webp") {
            "image/webp"
        } else if lower.contains(".mp4") {
            "video/mp4"
        } else if lower.contains(".webm") {
            "video/webm"
        } else {
            continue;
        };
        if let Ok(parsed) = url::Url::parse(clean) {
            let allowed = match parsed.scheme() {
                "https" => is_media_https_host_allowed(parsed.host_str()),
                "http" => is_loopback_host(parsed.host_str()),
                _ => false,
            };
            if allowed && parsed.username().is_empty() && parsed.password().is_none() {
                artifacts.push(MediaArtifact {
                    path: None,
                    url: Some(parsed.to_string()),
                    mime: mime.into(),
                });
                continue;
            }
        }
        let path = PathBuf::from(clean);
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        if !is_workspace_file(cwd, &path) {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let display = path_for_webview(&canonical);
        if !artifacts
            .iter()
            .any(|item| item.path.as_deref() == Some(&display))
        {
            artifacts.push(MediaArtifact {
                path: Some(display),
                url: None,
                mime: mime.into(),
            });
        }
    }
    Ok(artifacts)
}

fn collect_media_strings(value: &serde_json::Value, output: &mut Vec<String>) {
    match value {
        serde_json::Value::String(value) => output.push(value.clone()),
        serde_json::Value::Array(values) => values
            .iter()
            .for_each(|value| collect_media_strings(value, output)),
        serde_json::Value::Object(values) => values
            .values()
            .for_each(|value| collect_media_strings(value, output)),
        _ => {}
    }
}

fn checked_reasoning_effort(effort: Option<String>) -> Result<Option<String>, String> {
    match effort {
        Some(value) if matches!(value.as_str(), "low" | "medium" | "high" | "xhigh" | "max") => {
            Ok(Some(value))
        }
        Some(_) => Err("无效思考强度".into()),
        None => Ok(None),
    }
}

/// Start a fresh ACP child and stream each stdout JSON-RPC line to the webview.
/// A repeated call intentionally replaces the old child so a webview reload
/// cannot initialize the same agent process twice.
#[tauri::command]
async fn acp_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
    cwd: String,
    computer_use_enabled: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<u64, String> {
    let cwd = checked_workspace(&cwd)?;

    // Invalidate the previous readers before terminating their process. On a
    // fast development reload Windows can still deliver a few buffered stdout
    // or stderr lines after `kill`; those lines must not reach the new ACP
    // connection.
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;

    if let Some(old) = state.process.lock().await.take() {
        terminate_process(old).await;
    }

    let runtime = configured_grok_command(&app);
    // Host gate only (env | host_prefs). FE `computer_use_enabled` is not authority.
    let _ = computer_use_enabled;
    let computer_plugin = if computer_use_gate_open() {
        Some(
            ensure_computer_plugin()
                .map_err(|error| format!("Computer Use Plugin 初始化失败：{error}"))?,
        )
    } else {
        None
    };
    let command_path = PathBuf::from(&runtime.path);
    let mut command = Command::new(&command_path);
    command.arg("agent");
    if let Some(effort) = checked_reasoning_effort(reasoning_effort)? {
        command.arg("--reasoning-effort").arg(effort);
    }
    if let Some(plugin) = computer_plugin.as_ref() {
        command.arg("--plugin-dir").arg(plugin);
    }
    command
        .arg("stdio")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Identify the launching client with the spawned CLI's own version, never
    // the Grox app version. The value is written into the agent's diagnostic
    // logs and may be read by newer upstream builds; a stale "0.2.0" there
    // both misleads auth diagnostics and can trip the server-side version
    // gate that answers inference with 403 "Grok Build is coming soon".
    if let Some(version) = runtime.version.as_deref().and_then(cli_version_number) {
        command.env("GROK_CLIENT_VERSION", version.to_string());
    }
    // The terminal CLI identifies itself as `grok-shell`; passing a desktop
    // client marker here causes OAuth requests to hit a different upstream
    // eligibility gate. Preserve official CLI identity end to end.
    command.env("GROK_CLIENT_NAME", UPSTREAM_CLI_CLIENT_NAME);
    apply_grox_provider_environment(&mut command);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动 Grok CLI（{}）：{error}。可通过 GROK_DESKTOP_CLI 指定可执行文件。",
            command_path.display()
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准输入".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准错误".to_string())?;
    // Windows: put ACP child in a Job Object so cancel kills nested tool trees.
    #[cfg(windows)]
    let job = {
        match process_job::ProcessJob::create_kill_on_close() {
            Ok(job) => {
                if let Some(pid) = child.id() {
                    if let Err(error) = job.assign_pid(pid) {
                        eprintln!("grox: AssignProcessToJobObject failed: {error}");
                    }
                }
                Some(job)
            }
            Err(error) => {
                eprintln!("grox: CreateJobObject failed (orphan risk on cancel): {error}");
                None
            }
        }
    };
    *state.process.lock().await = Some(AgentProcess {
        child,
        stdin,
        generation,
        #[cfg(windows)]
        job,
    });

    let stdout_app = app.clone();
    let stdout_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if stdout_state.next_generation.load(Ordering::Relaxed) != generation {
                        break;
                    }
                    if !line.trim().is_empty() {
                        let _ = stdout_app.emit("acp-event", line);
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = stdout_app.emit("acp-stderr", format!("读取 ACP 输出失败：{error}"));
                    break;
                }
            }
        }

        let process = {
            let mut guard = stdout_state.process.lock().await;
            if guard
                .as_ref()
                .is_some_and(|process| process.generation == generation)
            {
                guard.take()
            } else {
                None
            }
        };
        if let Some(mut process) = process {
            drop(process.stdin);
            let code = process
                .child
                .wait()
                .await
                .ok()
                .and_then(|status| status.code());
            let _ = stdout_app.emit(
                "acp-exit",
                AcpExitPayload {
                    code,
                    reason: "exited",
                },
            );
        }
    });

    let stderr_app = app.clone();
    let stderr_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stderr_state.next_generation.load(Ordering::Relaxed) != generation {
                break;
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                // Bound diagnostics before they cross into the webview.
                let safe = trimmed.chars().take(16_384).collect::<String>();
                let _ = stderr_app.emit("acp-stderr", safe);
            }
        }
    });

    Ok(generation)
}

/// Methods the desktop shell may write on the ACP stdin channel.
/// Unknown methods from a compromised WebView are rejected.
///
/// Wire note: FE may prefix extension notifies as `_x.ai/...`.
fn acp_method_allowed(method: &str) -> bool {
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
    let m = method.strip_prefix("_x.ai/").map(|suffix| format!("x.ai/{suffix}"));
    let m = m.as_deref().unwrap_or(method);
    matches!(
        m,
        "session/new"
            | "session/load"
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
            | "terminal/create"
            | "terminal/output"
            | "terminal/release"
            | "terminal/wait_for_exit"
            | "terminal/kill"
            | "fs/read_text_file"
            | "fs/write_text_file"
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

#[tauri::command]
async fn acp_send(
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
    line: String,
    generation: u64,
) -> Result<(), String> {
    if line.contains('\n') || line.contains('\r') {
        return Err("ACP 消息必须是单行 JSON".into());
    }
    // Bound stdin payload size (multimodal base64 still fits under 8 MiB).
    const MAX_ACP_LINE_BYTES: usize = 8 * 1024 * 1024;
    if line.len() > MAX_ACP_LINE_BYTES {
        return Err(format!(
            "ACP 消息过大（{} bytes，上限 {}）",
            line.len(),
            MAX_ACP_LINE_BYTES
        ));
    }
    // Method allowlist before lease inject / stdin write.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
        if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
            if !acp_method_allowed(method) {
                return Err(format!("不允许的 ACP 方法：{method}"));
            }
        }
    }
    let line = mcp_leases::inject_mcp_servers(&line, leases.inner())?;
    if line.contains('\n') || line.contains('\r') {
        return Err("ACP 消息必须是单行 JSON".into());
    }
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

#[tauri::command]
async fn acp_kill(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<(), String> {
    state.next_generation.fetch_add(1, Ordering::Relaxed);
    if let Some(process) = state.process.lock().await.take() {
        terminate_process(process).await;
        let _ = app.emit(
            "acp-exit",
            AcpExitPayload {
                code: None,
                reason: "killed",
            },
        );
    }
    Ok(())
}

fn release_version(value: &str) -> Result<semver::Version, String> {
    semver::Version::parse(value.trim().trim_start_matches(['v', 'V']))
        .map_err(|error| format!("无法解析版本号 {value:?}：{error}"))
}

fn update_available(current: &str, latest: &str) -> Result<bool, String> {
    Ok(release_version(latest)? > release_version(current)?)
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
        .query(&[("per_page", "8")])
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
        .take(8)
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
    let history = release_history().await?;
    let mut history = history
        .iter()
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

#[tauri::command]
async fn install_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let expected = release_version(&version)?;
    let release = latest_release().await?;
    if release_version(&release.tag_name)? != expected
        || expected <= release_version(CLIENT_VERSION)?
    {
        return Err("更新版本已变化，请重新检查更新".into());
    }
    let asset =
        update_asset(&release).ok_or_else(|| "此版本没有适用于当前系统的安装包".to_string())?;
    let work = update_temp_dir(&version)?;
    let installer = work.join(&asset.name);
    if let Err(error) = download_update_asset(asset, &installer).await {
        let _ = fs::remove_dir_all(&work);
        return Err(error);
    }
    launch_update_helper(&app, &installer, &work)
}

fn main() {
    let process_args = std::env::args().collect::<Vec<_>>();
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
    // The backup contains only fields Grox touched, so this restores an
    // existing user table exactly or removes a table Grox created from scratch.
    if let Err(error) = restore_grox_provider_auth_overrides() {
        eprintln!("grox: 无法迁移旧版供应商模型覆盖：{error}");
    }
    if let Err(error) = synchronize_active_provider_backend() {
        eprintln!("grox: 无法同步当前供应商的协议覆盖：{error}");
    }
    tauri::Builder::default()
        .manage(Arc::new(AcpState::default()))
        .manage(Arc::new(PreviewState::default()))
        .manage(Arc::new(FilePreviewState::default()))
        .manage(Arc::new(McpLeaseStore::default()))
        .manage(Arc::new(GitConfirmStore::default()))
        .setup(|app| {
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(icon)?;
            }
            register_computer_emergency_shortcut(app.handle().clone());
            // Never block setup (window interactivity) on disk / provisioning.
            // These can take seconds with large session-cache dirs and freeze
            // the first 2–3s of operator input.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = provision_grox_deep_research_workflow() {
                    eprintln!("grox: 无法安装完整 deep-research 工作流：{error}");
                }
                // Crash / BSOD leftovers: orphan .tmp/.bak under session-cache.
                scrub_session_cache_dir(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_environment,
            preview_session_from_disk,
            search_session_history,
            read_session_cache,
            write_session_cache,
            delete_session_cache,
            scrub_session_cache_orphans,
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
            acp_read_text_file,
            acp_read_file,
            read_prompt_image_paths,
            acp_write_text_file,
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
            install_official_grok_cli,
            check_for_update,
            get_update_status,
            install_update,
            open_external,
            open_media_external,
            start_project_preview,
            computer_use_env_enabled,
            host_prefs_get,
            host_prefs_migrate_computer_use,
            host_prefs_set_computer_use,
            host_prefs_set_permission_mode,
            computer_session_extensions,
            computer_shutdown_lease,
            computer_emergency_stop,
            computer_clear_emergency_stop,
            browser_session_extensions,
            browser_shutdown_lease,
            save_media_reference,
            generate_media,
            acp_spawn,
            acp_send,
            acp_kill,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<Arc<AcpState>>().inner().clone();
                let preview_state = window.state::<Arc<PreviewState>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(process) = state.process.lock().await.take() {
                        terminate_process(process).await;
                    }
                    if let Some(mut process) = preview_state.process.lock().await.take() {
                        let _ = process.child.kill().await;
                        let _ = process.child.wait().await;
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Grox Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_disk_preview_keeps_recent_visible_conversation() {
        let history = concat!(
            "{\"type\":\"system\",\"content\":\"hidden\"}\n",
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first\"}]}\n",
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"reminder\"}],\"synthetic_reason\":\"system_reminder\"}\n",
            "{\"type\":\"tool_result\",\"content\":\"hidden tool output\"}\n",
            "{\"type\":\"assistant\",\"content\":\"answer\"}\n",
            "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"latest\"}]}\n",
        );
        let preview = parse_session_disk_preview(std::io::Cursor::new(history), 2).unwrap();
        assert_eq!(
            preview,
            SessionDiskPreview {
                messages: vec![
                    SessionPreviewMessage {
                        role: "assistant".into(),
                        text: "answer".into(),
                    },
                    SessionPreviewMessage {
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
    fn service_urls_reject_metadata_but_keep_private_https_gateways_available() {
        assert!(checked_service_url("https://169.254.169.254/latest", "服务地址").is_err());
        assert!(checked_service_url("https://[::ffff:169.254.169.254]/latest", "服务地址").is_err());
        assert!(checked_service_url("https://metadata.google.internal/", "服务地址").is_err());
        assert!(checked_service_url("https://192.168.1.20/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://127.0.0.1:8000/v1", "服务地址").is_ok());
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
    fn service_urls_require_encryption_except_for_loopback() {
        assert!(checked_service_url("https://api.example.com/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://localhost:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://127.0.0.1:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://[::1]:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://api.example.com/v1", "服务地址").is_err());
        assert!(checked_service_url_with_policy(
            "http://api.example.com/v1",
            "服务地址",
            true,
        )
        .is_ok());
        assert!(checked_service_url_with_policy(
            "http://169.254.169.254/latest",
            "服务地址",
            true,
        )
        .is_err());
        assert!(checked_service_url("https://user:secret@example.com/v1", "服务地址").is_err());
        let normalized =
            checked_service_url("https://api.example.com/v1\n?model=grok", "服务地址").unwrap();
        assert!(!normalized.contains('\r') && !normalized.contains('\n'));
        assert!(checked_api_key("secret\nINJECTED=1").is_err());
    }

    #[test]
    fn compatible_provider_environment_is_validated_and_complete() {
        let env = compatible_provider_env(
            "sk-test",
            "https://gateway.example.com/v1",
            false,
        )
        .unwrap();
        assert!(env.contains("XAI_API_KEY=\"sk-test\""));
        assert!(env.contains("GROK_MODELS_BASE_URL=\"https://gateway.example.com/v1\""));
        assert!(env.contains("GROK_MODELS_LIST_URL=\"https://gateway.example.com/v1/models\""));
        assert!(!env.contains("GROK_MODELS_API_BACKEND"));
        assert!(compatible_provider_env(
            "",
            "https://gateway.example.com/v1",
            false,
        )
        .is_err());
        assert!(compatible_provider_env(
            "sk-test",
            "http://gateway.example.com/v1",
            false,
        )
        .is_err());
        let insecure = compatible_provider_env(
            "sk-test",
            "http://gateway.example.com/v1",
            true,
        )
        .unwrap();
        assert!(insecure.contains("GROK_MODELS_BASE_URL=\"http://gateway.example.com/v1\""));
    }

    #[test]
    fn provider_models_use_the_exact_catalogue_id() {
        let available = vec!["grok-4.3-fast".to_string(), "grok-4.5".to_string()];
        let mut resident = vec!["Grok-4.3-fast".to_string(), "GROK-4.5".to_string()];
        canonicalize_resident_models(&mut resident, &available);
        assert_eq!(resident, available);
    }

    #[test]
    fn provider_backend_choice_is_honored_and_auto_is_conservative() {
        assert_eq!(
            ProviderApiBackend::Responses.config_value("custom", "https://api.example/v1"),
            "responses"
        );
        assert_eq!(
            ProviderApiBackend::ChatCompletions
                .config_value("custom", "https://api.example/v1"),
            "chat_completions"
        );
        assert_eq!(
            ProviderApiBackend::Auto.config_value("DeepSeek", "https://api.deepseek.com/v1"),
            "chat_completions"
        );
        assert_eq!(
            ProviderApiBackend::Auto.config_value("CLIProxyAPI", "https://gateway.example/v1"),
            "responses"
        );
    }

    #[test]
    fn compatible_model_auth_override_wins_without_damaging_existing_toml() {
        let mut document = parse_grok_config_document(
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
    fn managed_provider_environment_does_not_inherit_unmarked_values() {
        let env = r#"
XAI_API_KEY=terminal-key
GROK_MODELS_BASE_URL=https://terminal.example/v1

# >>> Grox managed provider
XAI_API_KEY="grox-key"
GROK_MODELS_BASE_URL="https://gateway.example/v1"
GROK_MODELS_LIST_URL="https://gateway.example/v1/models"
# <<< Grox managed provider

UNRELATED=value
"#;
        let path = std::env::temp_dir().join(format!(
            "grox-managed-provider-env-{}-{}.env",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, env).unwrap();
        let values = parse_grox_managed_provider_env(&path);
        fs::remove_file(&path).unwrap();
        assert_eq!(values.get("XAI_API_KEY"), Some(&"grox-key".to_string()));
        assert_eq!(
            values.get("GROK_MODELS_BASE_URL"),
            Some(&"https://gateway.example/v1".to_string())
        );
        assert!(!values.contains_key("UNRELATED"));
    }

    #[test]
    fn provider_login_modes_keep_their_environment_boundaries() {
        let path = std::env::temp_dir().join(format!(
            "grox-provider-mode-{}-{}.env",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        // OAuth has no managed provider block, so an official subscription
        // never receives API-key or gateway configuration from Grox.
        fs::write(&path, "XAI_API_KEY=inherited-shell-key\n").unwrap();
        assert!(parse_grox_managed_provider_env(&path).is_empty());

        // Official API-key mode gets its key only; it must not become a
        // custom OpenAI-compatible endpoint.
        fs::write(
            &path,
            replace_managed_env_block("", "XAI_API_KEY=official-key"),
        )
        .unwrap();
        let official = parse_grox_managed_provider_env(&path);
        assert_eq!(official.get("XAI_API_KEY"), Some(&"official-key".to_string()));
        assert!(!official.contains_key("GROK_MODELS_BASE_URL"));

        // Compatible mode intentionally carries the full endpoint contract.
        let compatible = compatible_provider_env(
            "gateway-key",
            "https://gateway.example/v1",
            false,
        )
        .unwrap();
        fs::write(&path, replace_managed_env_block("", &compatible)).unwrap();
        let gateway = parse_grox_managed_provider_env(&path);
        assert_eq!(gateway.get("XAI_API_KEY"), Some(&"gateway-key".to_string()));
        assert_eq!(
            gateway.get("GROK_MODELS_BASE_URL"),
            Some(&"https://gateway.example/v1".to_string())
        );
        assert!(!gateway.contains_key("GROK_MODELS_API_BACKEND"));
        fs::remove_file(&path).unwrap();
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
    fn media_generation_tools_allowlist_stays_closed() {
        assert_eq!(
            MEDIA_GENERATION_TOOLS,
            "image_gen,video_gen,image_to_video,reference_to_video"
        );
        assert!(!MEDIA_GENERATION_TOOLS.contains("bash"));
        assert!(!MEDIA_GENERATION_TOOLS.contains("shell"));
        assert!(!MEDIA_GENERATION_TOOLS.contains("computer"));
    }

    #[test]
    fn media_prompt_selects_native_grok_tools() {
        let cwd = env!("CARGO_MANIFEST_DIR");
        let image = MediaGenerationRequest {
            kind: "image".into(),
            prompt: "黑洞边缘的空间站".into(),
            aspect: "16:9".into(),
            count: 2,
            duration: 5,
            resolution: "1080p".into(),
            reference_path: None,
            cwd: cwd.into(),
        };
        let prompt = checked_media_prompt(&image).unwrap();
        assert!(prompt.contains("image_gen"));
        assert!(prompt.contains("2 张"));

        let reference = PathBuf::from(cwd).join("icons").join("icon.png");
        let video = MediaGenerationRequest {
            kind: "video".into(),
            reference_path: Some(path_for_webview(&reference)),
            ..image
        };
        let prompt = checked_media_prompt(&video).unwrap();
        assert!(prompt.contains("image_to_video"));
        assert!(prompt.contains("1080p"));
        assert!(checked_media_prompt(&MediaGenerationRequest {
            reference_path: Some("/tmp/outside-reference.png".into()),
            ..video
        })
        .is_err());
    }

    #[test]
    fn media_artifacts_are_limited_to_workspace_files_or_safe_urls() {
        let root = std::env::temp_dir().join(format!(
            "grox-media-test-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let image = root.join("result.png");
        fs::write(&image, b"png").unwrap();
        let outside = std::env::temp_dir().join(format!(
            "grox-media-outside-{}.png",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&outside, b"png").unwrap();
        let output = format!(
            "{{\"path\":{}}}\n{{\"path\":{}}}\n{{\"url\":\"https://cdn.x.ai/result.mp4\"}}\n{{\"url\":\"https://evil.example/result.mp4\"}}",
            serde_json::to_string(&path_for_webview(&image)).unwrap(),
            serde_json::to_string(&path_for_webview(&outside)).unwrap()
        );
        let artifacts = extract_media_artifacts(&output, &root).unwrap();
        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0].mime, "image/png");
        assert!(artifacts[0].path.is_some());
        assert_eq!(artifacts[1].mime, "video/mp4");
        assert!(artifacts[1].url.is_some());
        assert!(artifacts.iter().all(|artifact| {
            artifact
                .url
                .as_deref()
                .is_none_or(|url| !url.contains("evil.example"))
        }));
        let _ = fs::remove_file(&outside);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn media_reference_rejects_extension_content_mismatch() {
        let root = std::env::temp_dir().join(format!(
            "grox-media-reference-{}",
            CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let jpeg = BASE64.encode(b"\xff\xd8\xffpayload");
        assert!(save_media_reference(path_for_webview(&root), "fake.png".into(), jpeg).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn media_url_allowlist_uses_domain_boundaries() {
        assert!(is_media_https_host_allowed(Some("cdn.x.ai")));
        assert!(is_media_https_host_allowed(Some("images.cdn.x.ai")));
        assert!(!is_media_https_host_allowed(Some("x.ai.evil.example")));
        assert!(!is_media_https_host_allowed(Some("evil.example")));
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
        assert!(!acp_method_allowed("fs/unknown"));
        assert!(acp_method_allowed("x.ai/future_extension"));
        assert!(acp_method_allowed("_x.ai/future_extension"));
        assert!(!acp_method_allowed("session/../../evil"));
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
}
