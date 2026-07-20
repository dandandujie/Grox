//! Grox native shell.
//!
//! The webview speaks JSON-RPC while this process owns the long-lived
//! `grok agent stdio` child. Keeping process management here prevents the
//! privileged webview from spawning arbitrary commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::BTreeMap,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GROX_BUILD_COMMIT: &str = env!("GROX_BUILD_COMMIT");
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/dandandujie/Grox/releases/latest";
const GROK_INSTALL_PS1_URL: &str = "https://x.ai/cli/install.ps1";
const GROK_INSTALL_SH_URL: &str = "https://x.ai/cli/install.sh";
const GROX_PRIVACY_ENV: [(&str, &str); 13] = [
    ("GROX_PRIVACY_MODE", "1"),
    // Legacy fallbacks also protect users who point GROK_DESKTOP_CLI at an
    // older Grok binary that does not yet understand GROX_PRIVACY_MODE.
    ("DISABLE_TELEMETRY", "1"),
    ("DISABLE_ERROR_REPORTING", "1"),
    ("GROK_TELEMETRY_ENABLED", "0"),
    ("GROK_TELEMETRY_TRACE_UPLOAD", "0"),
    ("GROK_TELEMETRY_MIXPANEL_ENABLED", "0"),
    ("GROK_FEEDBACK_ENABLED", "0"),
    ("GROK_ERROR_REPORTING", "0"),
    ("GROK_EXTERNAL_OTEL", "0"),
    ("OTEL_TRACES_EXPORTER", "none"),
    ("OTEL_METRICS_EXPORTER", "none"),
    ("OTEL_LOGS_EXPORTER", "none"),
    ("GROK_CLIPBOARD_NO_OSC52", "1"),
];

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    generation: u64,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntry {
    path: String,
    name: String,
    is_dir: bool,
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
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    published_at: Option<String>,
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
    fn resolved(self, name: &str, base_url: &str) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::ChatCompletions => "chat_completions",
            Self::Auto => {
                let identity = format!("{name} {base_url}").to_ascii_lowercase();
                if [
                    "grok2api",
                    "chenyme",
                    "cliproxyapi",
                    "cli-proxy-api",
                    "cli proxy",
                    "router-for-me",
                    "newapi",
                    "new-api",
                    "new api",
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfileSummary {
    id: String,
    name: String,
    has_api_key: bool,
    base_url: String,
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
const MAX_WORKSPACE_ENTRIES: usize = 2_000;
static CONFIG_WRITE_NONCE: AtomicU64 = AtomicU64::new(0);

fn path_for_webview(path: &Path) -> String {
    let raw = path.to_string_lossy();
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

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
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "无法定位用户目录，请设置 GROK_HOME".to_string())?;
    Ok(PathBuf::from(home).join(".grok"))
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

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_CONFIG_BYTES {
        return Err("配置文档不能超过 4 MB".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "配置路径缺少父目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建 {}：{error}", parent.display()))?;
    let temp = parent.join(format!(
        ".{}.grox-{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config"),
        std::process::id(),
        CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed),
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
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("无法替换配置 {}：{error}", path.display()))?;
    }
    fs::rename(&temp, path).map_err(|error| format!("无法保存配置 {}：{error}", path.display()))
}

#[cfg(unix)]
fn restrict_private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法限制凭据文件权限 {}：{error}", path.display()))
}

#[cfg(not(unix))]
fn restrict_private_file(_path: &Path) -> Result<(), String> {
    // Windows user profiles inherit a per-user ACL from their parent folder.
    Ok(())
}

fn replace_managed_env_block(content: &str, replacement: &str) -> String {
    const START: &str = "# >>> Grox managed provider";
    const END: &str = "# <<< Grox managed provider";
    let preserved = if let Some(start) = content.find(START) {
        let suffix = &content[start..];
        if let Some(relative_end) = suffix.find(END) {
            let after = start + relative_end + END.len();
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
    format!("{prefix}{START}\n{replacement}\n{END}\n")
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

fn parse_env_file(path: &Path) -> BTreeMap<String, String> {
    let Ok(content) = read_bounded_text(path, MAX_CONFIG_BYTES) else {
        return BTreeMap::new();
    };
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

fn checked_workspace_file(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(requested);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        workspace.join(candidate)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析文件 {}：{error}", candidate.display()))?;
    if !canonical.starts_with(workspace) {
        return Err("只能访问当前项目内的文件".into());
    }
    Ok(canonical)
}

fn is_loopback_host(host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn checked_service_url(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(value).map_err(|error| format!("无效{label}：{error}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("{label}不能在 URL 中包含用户名或密码"));
    }
    let secure = parsed.scheme() == "https";
    let local_http = parsed.scheme() == "http" && is_loopback_host(parsed.host_str());
    if !secure && !local_http {
        return Err(format!("{label}必须使用 HTTPS；仅本机回环地址允许 HTTP"));
    }
    // Use url's serialized representation instead of the original input.
    // URL parsers may tolerate ASCII whitespace that would otherwise become a
    // second line in the managed dotenv block.
    Ok(parsed.as_str().trim_end_matches('/').to_string())
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
    let output = command.output().ok().filter(|output| output.status.success())?;
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
fn grok_runtime_info(app: tauri::AppHandle) -> GrokRuntimeInfo {
    configured_grok_command(&app)
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
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("irm '{}' | iex", GROK_INSTALL_PS1_URL),
        ]);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("/bin/bash");
        command.args([
            "-c",
            &format!("curl -fsSL '{}' | bash", GROK_INSTALL_SH_URL),
        ]);
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

fn checked_workspace(cwd: &str) -> Result<PathBuf, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("工作区路径不能为空".into());
    }
    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!("工作区不存在：{}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("工作区不是目录：{}", path.display()));
    }
    path.canonicalize()
        .map_err(|error| format!("无法解析工作区 {}：{error}", path.display()))
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
    let _ = process.child.kill().await;
    let _ = process.child.wait().await;
}

#[tauri::command]
fn desktop_environment(app: tauri::AppHandle) -> DesktopEnvironment {
    let runtime = configured_grok_command(&app);
    DesktopEnvironment {
        default_workspace: path_for_webview(&default_workspace()),
        grok_command: path_for_webview(Path::new(&runtime.path)),
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

#[tauri::command]
fn read_config_documents(cwd: String) -> Result<Vec<ConfigDocument>, String> {
    let cwd = checked_workspace(&cwd)?;
    ["config", "system-prompt", "agents"]
        .into_iter()
        .map(|id| {
            let (path, label, language) = config_path(id, &cwd)?;
            let exists = path.is_file();
            Ok(ConfigDocument {
                id,
                label,
                path: path_for_webview(&path),
                content: read_bounded_text(&path, MAX_CONFIG_BYTES)?,
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
    atomic_write(&path, &request.content)?;
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
        content: request.content,
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

fn provider_profile_summary(profile: &StoredProviderProfile) -> ProviderProfileSummary {
    let mut resident_models = profile.resident_models.clone();
    if resident_models.is_empty() {
        if let Some(model) = profile.model.as_ref().filter(|model| !model.is_empty()) {
            resident_models.push(model.clone());
        }
    }
    ProviderProfileSummary {
        id: profile.id.clone(),
        name: profile.name.clone(),
        has_api_key: !profile.api_key.is_empty(),
        base_url: profile.base_url.clone(),
        api_backend: profile.api_backend,
        available_models: profile.available_models.clone(),
        resident_models,
    }
}

fn compatible_models_url(base_url: &str) -> Result<String, String> {
    let base = checked_service_url(base_url, "服务地址")?;
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
    provider_name: &str,
    api_backend: ProviderApiBackend,
) -> Result<String, String> {
    let key = checked_api_key(api_key.trim())?;
    if key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    let base = checked_service_url(base_url.trim(), "服务地址")?;
    let lines = vec![
        format!("XAI_API_KEY={}", env_value(key)),
        format!("GROK_MODELS_BASE_URL={}", env_value(&base)),
        format!(
            "GROK_MODELS_LIST_URL={}",
            env_value(&compatible_models_url(&base)?)
        ),
        format!(
            "GROK_MODELS_API_BACKEND={}",
            env_value(api_backend.resolved(provider_name, &base))
        ),
    ];
    Ok(lines.join("\n"))
}

#[tauri::command]
fn list_provider_profiles() -> Result<ProviderProfilesResponse, String> {
    let value = read_provider_profiles_file()?;
    Ok(ProviderProfilesResponse {
        active_id: value.active_id,
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
    let current_values = parse_env_file(&grok_home()?.join(".env"));
    let key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .or_else(|| existing.map(|profile| profile.api_key.as_str()))
        .or_else(|| current_values.get("XAI_API_KEY").map(String::as_str))
        .ok_or("API Key 不能为空")?;
    compatible_provider_env(key, &request.base_url, name, request.api_backend)?;
    let resident_models = checked_model_ids(request.resident_models)?;
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
        base_url: checked_service_url(&request.base_url, "服务地址")?,
        api_backend: request.api_backend,
        models_url: None,
        model: resident_models.first().cloned(),
        available_models: existing
            .map(|profile| profile.available_models.clone())
            .unwrap_or_default(),
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

#[tauri::command]
async fn refresh_provider_models(id: String) -> Result<ProviderProfileSummary, String> {
    let profile = read_provider_profiles_file()?
        .profiles
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or("供应商档案不存在")?;
    let endpoint = compatible_models_url(&profile.base_url)?;
    let response = reqwest::Client::builder()
        .user_agent(format!("Grox/{CLIENT_VERSION}"))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("无法创建模型目录客户端：{error}"))?
        .get(endpoint)
        .bearer_auth(&profile.api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("无法获取模型列表：{error}"))?
        .error_for_status()
        .map_err(|error| format!("模型服务返回错误：{error}"))?
        .json::<OpenAiModelsResponse>()
        .await
        .map_err(|error| format!("模型列表不是 OpenAI 兼容格式：{error}"))?;
    let mut models = response
        .data
        .into_iter()
        .map(|model| model.id)
        .collect::<Vec<_>>();
    models.sort_by_key(|model| model.to_ascii_lowercase());
    models.dedup();
    models.truncate(1_000);

    let mut value = read_provider_profiles_file()?;
    let stored = value
        .profiles
        .iter_mut()
        .find(|stored| stored.id == profile.id)
        .ok_or("供应商档案已被删除")?;
    stored.available_models = models;
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
    let replacement = compatible_provider_env(
        &profile.api_key,
        &profile.base_url,
        &profile.name,
        profile.api_backend,
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
    let values = parse_env_file(&grok_home()?.join(".env"));
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
    let current_values = parse_env_file(&path);
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
        "oauth" => String::new(),
        "official" => {
            let key = requested_key.or(saved_key).ok_or("API Key 不能为空")?;
            let key = checked_api_key(key)?;
            format!("XAI_API_KEY={}", env_value(key))
        }
        "compatible" => {
            let key = requested_key.or(saved_key).ok_or("API Key 不能为空")?;
            compatible_provider_env(
                key,
                request.base_url.as_deref().unwrap_or_default(),
                "compatible",
                ProviderApiBackend::ChatCompletions,
            )?
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

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|error| format!("无效链接：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只允许打开 HTTP(S) 链接".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("链接不能包含用户名或密码".into());
    }

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

/// Start a fresh ACP child and stream each stdout JSON-RPC line to the webview.
/// A repeated call intentionally replaces the old child so a webview reload
/// cannot initialize the same agent process twice.
#[tauri::command]
async fn acp_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
    cwd: String,
) -> Result<(), String> {
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
    let command_path = PathBuf::from(&runtime.path);
    let mut command = Command::new(&command_path);
    command
        .args(["agent", "stdio"])
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
    if let Some(version) = runtime
        .version
        .as_deref()
        .and_then(cli_version_number)
    {
        command.env("GROK_CLIENT_VERSION", version.to_string());
    }
    if let Ok(home) = grok_home() {
        for (key, value) in parse_env_file(&home.join(".env")) {
            command.env(key, value);
        }
    }
    // Provider profiles are authoritative at process start. This also migrates
    // profiles saved by older Grox versions whose managed .env block predates
    // GROK_MODELS_API_BACKEND, without exposing or rewriting the stored key.
    if let Ok(profiles) = read_provider_profiles_file() {
        if let Some(profile) = profiles.active_id.as_deref().and_then(|active_id| {
            profiles
                .profiles
                .iter()
                .find(|profile| profile.id == active_id)
        }) {
            // A stored profile that no longer passes validation (written by an
            // older build, hand-edited, ...) must not abort the whole spawn:
            // skip the injection so the agent still starts, and let the user
            // fix the profile in settings instead of facing a dead app.
            let injected = checked_service_url(&profile.base_url, "服务地址")
                .and_then(|base| compatible_models_url(&base).map(|list| (base, list)))
                .map(|(base, list)| {
                    command
                        .env("XAI_API_KEY", &profile.api_key)
                        .env("GROK_MODELS_BASE_URL", &base)
                        .env("GROK_MODELS_LIST_URL", list)
                        .env(
                            "GROK_MODELS_API_BACKEND",
                            profile.api_backend.resolved(&profile.name, &base),
                        );
                });
            if let Err(error) = injected {
                eprintln!(
                    "grox: 跳过无效的供应商档案 {}（{}）：{error}",
                    profile.name, profile.id
                );
            }
        }
    }
    // This is deliberately applied after the user environment so neither a
    // stale config nor a server-controlled flag can re-enable background data
    // collection in the official CLI process launched by Grox.
    for (key, value) in GROX_PRIVACY_ENV {
        command.env(key, value);
    }

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
    *state.process.lock().await = Some(AgentProcess {
        child,
        stdin,
        generation,
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

    Ok(())
}

#[tauri::command]
async fn acp_send(state: tauri::State<'_, Arc<AcpState>>, line: String) -> Result<(), String> {
    if line.contains('\n') || line.contains('\r') {
        return Err("ACP 消息必须是单行 JSON".into());
    }
    let mut guard = state.process.lock().await;
    let process = guard
        .as_mut()
        .ok_or_else(|| "Grok Agent 尚未启动".to_string())?;
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

#[tauri::command]
async fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("Grox/{CLIENT_VERSION}"))
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| format!("无法创建更新检查客户端：{error}"))?;
    let release = client
        .get(LATEST_RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("无法检查更新：{error}"))?
        .error_for_status()
        .map_err(|error| format!("更新服务返回错误：{error}"))?
        .json::<GitHubRelease>()
        .await
        .map_err(|error| format!("无法读取更新信息：{error}"))?;

    if !update_available(CLIENT_VERSION, &release.tag_name)? {
        return Ok(None);
    }

    let latest_version = release.tag_name.trim().trim_start_matches(['v', 'V']);
    let notes = release
        .body
        .unwrap_or_default()
        .chars()
        .take(12_000)
        .collect::<String>();
    Ok(Some(UpdateInfo {
        current_version: CLIENT_VERSION.to_string(),
        latest_version: latest_version.to_string(),
        title: release
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| format!("Grox {latest_version}")),
        notes,
        release_url: release.html_url,
        published_at: release.published_at,
    }))
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(AcpState::default()))
        .manage(Arc::new(PreviewState::default()))
        .setup(|app| {
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(icon)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_environment,
            validate_workspace,
            pick_workspace,
            list_workspace_files,
            read_preview_file,
            open_in_explorer,
            read_config_documents,
            write_config_document,
            read_provider_status,
            configure_provider,
            list_provider_profiles,
            save_provider_profile,
            refresh_provider_models,
            activate_provider_profile,
            delete_provider_profile,
            grok_runtime_info,
            install_official_grok_cli,
            check_for_update,
            open_external,
            start_project_preview,
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
    fn rejects_missing_workspace() {
        let missing = std::env::temp_dir().join("grox-workspace-that-does-not-exist");
        assert!(checked_workspace(&path_for_webview(&missing)).is_err());
    }

    #[test]
    fn accepts_existing_workspace() {
        let workspace = checked_workspace(env!("CARGO_MANIFEST_DIR")).unwrap();
        assert!(workspace.is_dir());
    }

    #[test]
    fn service_urls_require_encryption_except_for_loopback() {
        assert!(checked_service_url("https://api.example.com/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://localhost:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://127.0.0.1:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://[::1]:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://api.example.com/v1", "服务地址").is_err());
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
            "grok2api",
            ProviderApiBackend::Auto,
        )
        .unwrap();
        assert!(env.contains("XAI_API_KEY=\"sk-test\""));
        assert!(env.contains("GROK_MODELS_BASE_URL=\"https://gateway.example.com/v1\""));
        assert!(env.contains("GROK_MODELS_LIST_URL=\"https://gateway.example.com/v1/models\""));
        assert!(env.contains("GROK_MODELS_API_BACKEND=\"responses\""));
        assert!(compatible_provider_env(
            "",
            "https://gateway.example.com/v1",
            "generic",
            ProviderApiBackend::Auto,
        )
        .is_err());
        assert!(compatible_provider_env(
            "sk-test",
            "http://gateway.example.com/v1",
            "generic",
            ProviderApiBackend::Auto,
        )
        .is_err());
    }

    #[test]
    fn official_cli_privacy_environment_is_fail_closed() {
        let values = GROX_PRIVACY_ENV.into_iter().collect::<BTreeMap<_, _>>();
        assert_eq!(values.get("GROX_PRIVACY_MODE"), Some(&"1"));
        assert_eq!(values.get("DISABLE_TELEMETRY"), Some(&"1"));
        assert_eq!(values.get("DISABLE_ERROR_REPORTING"), Some(&"1"));
        assert_eq!(values.get("GROK_TELEMETRY_ENABLED"), Some(&"0"));
        assert_eq!(values.get("GROK_TELEMETRY_TRACE_UPLOAD"), Some(&"0"));
        assert_eq!(values.get("GROK_EXTERNAL_OTEL"), Some(&"0"));
        assert_eq!(values.get("OTEL_LOGS_EXPORTER"), Some(&"none"));
    }

    #[test]
    fn compares_release_versions_without_treating_prefix_as_part_of_version() {
        assert!(update_available("0.1.0", "v0.2.0").unwrap());
        assert!(!update_available("0.2.0", "V0.2.0").unwrap());
        assert!(!update_available("0.3.0", "v0.2.9").unwrap());
        assert!(update_available("0.2.0-beta.1", "v0.2.0").unwrap());
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

}
