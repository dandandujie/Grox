//! Host 托管的媒体生成生命周期。
//!
//! WebView 只提交声明式参数并投影任务快照；工具白名单、Grok Build 参数契约、
//! 参考图能力、进程树取消和产物授权都由 Host 统一决定。

use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::oneshot,
};

use crate::provider_service::{apply_provider_environment, open_current};
use crate::{
    host_core::atomic_write_bounded_private,
    host_core::configured_grok_command,
    host_core::grok_home,
    host_error::HostError,
    is_blocked_service_host,
    path_sandbox::{checked_workspace, path_for_webview},
    host_core::prompt_image_mime,
    host_core::restrict_private_file,
    support_bundle::redact_token_markers,
    host_core::UPSTREAM_CLI_CLIENT_NAME,
};

const MEDIA_GENERATION_EVENT: &str = "media-generation-changed";
const MEDIA_DIAGNOSTIC_EVENT: &str = "media-generation-diagnostic";
const MEDIA_GENERATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
const MAX_MEDIA_REFERENCE_BYTES: usize = 24 * 1024 * 1024;
const MAX_RETAINED_JOBS: usize = 40;
const DEFAULT_HISTORY_LIMIT: usize = 12;
const MAX_ACTIVE_JOBS: usize = 4;
pub(crate) const MEDIA_JOBS_MAX_BYTES: u64 = 2 * 1024 * 1024;
const MEDIA_JOURNAL_VERSION: u8 = 1;
const MEDIA_GENERATION_TOOLS: &str = "image_gen,image_to_video";
const VIDEO_DURATIONS: &[u16] = &[6, 10];
const VIDEO_RESOLUTIONS: &[&str] = &["480p", "720p"];
const MEDIA_ASPECTS: &[&str] = &["1:1", "16:9", "9:16", "4:3"];
const MEDIA_HTTPS_HOST_ALLOWLIST: &[&str] = &[
    "x.ai",
    "grok.com",
    "grok.x.ai",
    "cdn.x.ai",
    "assets.x.ai",
    "imagine.x.ai",
];

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaKind {
    Image,
    Video,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaArtifactAction {
    Open,
    Reveal,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaGenerationRequest {
    kind: MediaKind,
    prompt: String,
    aspect: String,
    count: u8,
    duration: u16,
    resolution: String,
    reference_id: Option<String>,
    cwd: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaArtifact {
    path: Option<String>,
    url: Option<String>,
    mime: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum MediaJobPhase {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl MediaJobPhase {
    fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Cancelling)
    }

    fn is_terminal(self) -> bool {
        !self.is_active()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
struct MediaFailure(HostError);

impl MediaFailure {
    fn environment(code: &'static str, message: impl Into<String>, action: &'static str) -> Self {
        Self(HostError::recoverable_environment(code, message, action))
    }

    fn protocol(code: &'static str, message: impl Into<String>, action: &'static str) -> Self {
        Self(HostError::protocol_with_action(code, message, action))
    }
}

impl std::ops::Deref for MediaFailure {
    type Target = HostError;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl From<HostError> for MediaFailure {
    fn from(error: HostError) -> Self {
        Self(error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaJobSnapshot {
    id: String,
    workspace: String,
    kind: MediaKind,
    prompt: String,
    aspect: String,
    count: u8,
    duration: u16,
    resolution: String,
    phase: MediaJobPhase,
    started_at: u64,
    completed_at: Option<u64>,
    artifacts: Vec<MediaArtifact>,
    error: Option<MediaFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaReferenceResponse {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaGenerationCapabilities {
    aspects: &'static [&'static str],
    image_counts: &'static [u8],
    video_durations: &'static [u16],
    video_resolutions: &'static [&'static str],
    max_active_jobs: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaDiagnostic {
    job_id: String,
    workspace: String,
    kind: MediaKind,
    error: HostError,
}

#[derive(Clone)]
struct MediaDiagnosticScope {
    job_id: String,
    workspace: String,
    kind: MediaKind,
}

struct MediaJob {
    snapshot: MediaJobSnapshot,
    cancel: Option<oneshot::Sender<()>>,
}

struct StoredReference {
    workspace: PathBuf,
    path: PathBuf,
    in_use: usize,
    released: bool,
}

#[derive(Default)]
struct MediaState {
    jobs: BTreeMap<String, MediaJob>,
    order: VecDeque<String>,
    references: BTreeMap<String, StoredReference>,
    journal_path: Option<PathBuf>,
    journal_blocked: Option<String>,
    journal_last_error: Option<String>,
}

#[derive(Default)]
pub(crate) struct MediaService {
    state: Mutex<MediaState>,
}

struct MediaReferenceLease {
    service: Arc<MediaService>,
    id: String,
    path: PathBuf,
}

impl Drop for MediaReferenceLease {
    fn drop(&mut self) {
        self.service.release_reference_use(&self.id);
    }
}

struct PreparedMediaRequest {
    request: MediaGenerationRequest,
    workspace: PathBuf,
    prompt: String,
    reference: Option<MediaReferenceLease>,
}

enum MediaRunError {
    Cancelled,
    Failed(MediaFailure),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaJournal {
    version: u8,
    jobs: Vec<MediaJobSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaJournalStatus {
    readable: bool,
    jobs: usize,
    active_jobs: usize,
    bytes: u64,
    max_bytes: u64,
    error: Option<String>,
}

struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
}

impl MediaService {
    fn initialize(&self, path: PathBuf, home: &Path) -> Result<(), String> {
        let mut state = self.lock();
        state.journal_path = Some(path.clone());
        state.journal_blocked = None;
        state.journal_last_error = None;
        if !path.exists() {
            return Ok(());
        }
        let load = (|| {
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("无法读取媒体任务记录 {}：{error}", path.display()))?;
            if metadata.len() == 0 {
                return Err("媒体任务记录为空，已拒绝覆盖；请先导出或移走损坏文件".into());
            }
            if metadata.len() > MEDIA_JOBS_MAX_BYTES {
                return Err(format!(
                    "媒体任务记录超过 {} MB 上限，已拒绝加载",
                    MEDIA_JOBS_MAX_BYTES / 1024 / 1024
                ));
            }
            let raw = fs::read_to_string(&path)
                .map_err(|error| format!("无法读取媒体任务记录 {}：{error}", path.display()))?;
            let journal: MediaJournal = serde_json::from_str(&raw)
                .map_err(|error| format!("媒体任务记录损坏，已拒绝覆盖：{error}"))?;
            if journal.version != MEDIA_JOURNAL_VERSION {
                return Err(format!("不支持的媒体任务记录版本：{}", journal.version));
            }
            if journal.jobs.len() > MAX_RETAINED_JOBS {
                return Err(format!(
                    "媒体任务记录超过 {MAX_RETAINED_JOBS} 条上限，已拒绝加载"
                ));
            }
            let mut jobs = BTreeMap::new();
            let mut order = VecDeque::new();
            let mut interrupted = false;
            for mut snapshot in journal.jobs {
                validate_persisted_snapshot(&snapshot, home)?;
                if jobs.contains_key(&snapshot.id) {
                    return Err(format!("媒体任务记录包含重复 ID：{}", snapshot.id));
                }
                if snapshot.phase.is_active() {
                    snapshot.phase = MediaJobPhase::Failed;
                    snapshot.completed_at = Some(unix_time_ms());
                    snapshot.artifacts.clear();
                    snapshot.error = Some(MediaFailure::environment(
                        "MEDIA_JOB_INTERRUPTED",
                        "Grox 上次退出时媒体任务仍在运行，Host 已将其结算为中断",
                        "重新发起该媒体任务",
                    ));
                    interrupted = true;
                }
                order.push_back(snapshot.id.clone());
                jobs.insert(
                    snapshot.id.clone(),
                    MediaJob {
                        snapshot,
                        cancel: None,
                    },
                );
            }
            Ok((jobs, order, interrupted))
        })();
        let (jobs, order, interrupted) = match load {
            Ok(result) => result,
            Err(error) => {
                state.journal_blocked = Some(error.clone());
                return Err(error);
            }
        };
        state.jobs = jobs;
        state.order = order;
        if interrupted {
            persist_jobs_locked(&mut state)?;
        }
        Ok(())
    }

    fn journal_status(&self) -> MediaJournalStatus {
        let state = self.lock();
        let bytes = state
            .journal_path
            .as_ref()
            .and_then(|path| fs::metadata(path).ok())
            .map_or(0, |metadata| metadata.len());
        MediaJournalStatus {
            readable: state.journal_blocked.is_none(),
            jobs: state.jobs.len(),
            active_jobs: state
                .jobs
                .values()
                .filter(|job| job.snapshot.phase.is_active())
                .count(),
            bytes,
            max_bytes: MEDIA_JOBS_MAX_BYTES,
            error: state
                .journal_blocked
                .clone()
                .or_else(|| state.journal_last_error.clone()),
        }
    }

    fn create_job(
        &self,
        workspace: &Path,
        request: &MediaGenerationRequest,
    ) -> Result<(MediaJobSnapshot, oneshot::Receiver<()>), HostError> {
        let mut state = self.lock();
        let workspace_text = path_for_webview(workspace);
        if let Some(active) = state.jobs.values().find(|job| {
            job.snapshot.workspace == workspace_text
                && job.snapshot.kind == request.kind
                && job.snapshot.phase.is_active()
        }) {
            return Err(HostError::operation(
                "MEDIA_JOB_ACTIVE",
                format!("当前工作区已有媒体任务正在运行：{}", active.snapshot.id),
            ));
        }
        if state
            .jobs
            .values()
            .filter(|job| job.snapshot.phase.is_active())
            .count()
            >= MAX_ACTIVE_JOBS
        {
            return Err(HostError::operation(
                "MEDIA_CAPACITY_REACHED",
                format!("媒体任务并发数已达到上限（{MAX_ACTIVE_JOBS}），请等待或停止一个任务"),
            ));
        }
        let mut removed = Vec::new();
        while state.jobs.len() >= MAX_RETAINED_JOBS {
            let Some(index) = state.order.iter().position(|id| {
                state
                    .jobs
                    .get(id)
                    .is_some_and(|job| job.snapshot.phase.is_terminal())
            }) else {
                break;
            };
            let oldest = state.order.remove(index).expect("已定位的任务必须存在");
            if let Some(job) = state.jobs.remove(&oldest) {
                removed.push((index, oldest, job));
            }
        }
        let id = random_id("media").map_err(media_storage_error)?;
        let (cancel, receiver) = oneshot::channel();
        let snapshot = MediaJobSnapshot {
            id: id.clone(),
            workspace: workspace_text,
            kind: request.kind,
            prompt: request.prompt.trim().to_string(),
            aspect: request.aspect.clone(),
            count: request.count,
            duration: request.duration,
            resolution: request.resolution.clone(),
            phase: MediaJobPhase::Queued,
            started_at: unix_time_ms(),
            completed_at: None,
            artifacts: Vec::new(),
            error: None,
        };
        state.order.push_back(id.clone());
        state.jobs.insert(
            id.clone(),
            MediaJob {
                snapshot: snapshot.clone(),
                cancel: Some(cancel),
            },
        );
        if let Err(error) = persist_jobs_locked(&mut state) {
            state.jobs.remove(&id);
            state.order.retain(|queued| queued != &id);
            for (index, removed_id, job) in removed.into_iter().rev() {
                state.order.insert(index, removed_id.clone());
                state.jobs.insert(removed_id, job);
            }
            return Err(media_storage_error(error));
        }
        Ok((snapshot, receiver))
    }

    fn mark_running(&self, id: &str) -> Result<Option<MediaJobSnapshot>, HostError> {
        let mut state = self.lock();
        let queued = state
            .jobs
            .get(id)
            .is_some_and(|job| job.snapshot.phase == MediaJobPhase::Queued);
        if queued {
            state.jobs.get_mut(id).expect("已检查媒体任务存在").snapshot.phase =
                MediaJobPhase::Running;
            if let Err(error) = persist_jobs_locked(&mut state) {
                state.jobs.get_mut(id).expect("持久化期间媒体任务不会移除").snapshot.phase =
                    MediaJobPhase::Queued;
                return Err(media_storage_error(error));
            }
        }
        Ok(state.jobs.get(id).map(|job| job.snapshot.clone()))
    }

    fn finish(
        &self,
        id: &str,
        phase: MediaJobPhase,
        artifacts: Vec<MediaArtifact>,
        error: Option<MediaFailure>,
    ) -> Result<Option<MediaJobSnapshot>, HostError> {
        let mut state = self.lock();
        let Some(job) = state.jobs.get_mut(id) else {
            return Ok(None);
        };
        job.snapshot.phase = phase;
        job.snapshot.completed_at = Some(unix_time_ms());
        job.snapshot.artifacts = artifacts;
        job.snapshot.error = error;
        job.cancel = None;
        let snapshot = job.snapshot.clone();
        persist_jobs_locked(&mut state).map_err(media_storage_error)?;
        Ok(Some(snapshot))
    }

    fn cancel(
        &self,
        id: &str,
        workspace: &Path,
    ) -> Result<(MediaJobSnapshot, bool), HostError> {
        let mut state = self.lock();
        let workspace = path_for_webview(workspace);
        let job = state.jobs.get(id).ok_or_else(|| {
            HostError::operation("MEDIA_JOB_NOT_FOUND", "媒体任务不存在或已被清理")
        })?;
        if job.snapshot.workspace != workspace {
            return Err(HostError::operation(
                "MEDIA_JOB_WORKSPACE_MISMATCH",
                "媒体任务不属于当前工作区",
            ));
        }
        if job.snapshot.phase.is_terminal() || job.snapshot.phase == MediaJobPhase::Cancelling {
            return Ok((job.snapshot.clone(), false));
        }
        let previous_phase = job.snapshot.phase;
        state.jobs.get_mut(id).expect("已检查媒体任务存在").snapshot.phase =
            MediaJobPhase::Cancelling;
        if let Err(error) = persist_jobs_locked(&mut state) {
            state.jobs.get_mut(id).expect("持久化期间媒体任务不会移除").snapshot.phase =
                previous_phase;
            return Err(media_storage_error(error));
        }
        let job = state.jobs.get_mut(id).expect("持久化后媒体任务必须存在");
        let sent = job
            .cancel
            .take()
            .is_some_and(|cancel| cancel.send(()).is_ok());
        Ok((job.snapshot.clone(), sent))
    }

    fn latest(&self, workspace: &Path, kind: MediaKind) -> Option<MediaJobSnapshot> {
        let state = self.lock();
        let workspace = path_for_webview(workspace);
        state
            .order
            .iter()
            .rev()
            .filter_map(|id| state.jobs.get(id))
            .find(|job| job.snapshot.workspace == workspace && job.snapshot.kind == kind)
            .map(|job| job.snapshot.clone())
    }

    fn history(
        &self,
        workspace: &Path,
        kind: Option<MediaKind>,
        limit: usize,
    ) -> Vec<MediaJobSnapshot> {
        let state = self.lock();
        let workspace = path_for_webview(workspace);
        state
            .order
            .iter()
            .rev()
            .filter_map(|id| state.jobs.get(id))
            .filter(|job| {
                job.snapshot.workspace == workspace
                    && kind.map_or(true, |kind| job.snapshot.kind == kind)
            })
            .take(limit.clamp(1, MAX_RETAINED_JOBS))
            .map(|job| job.snapshot.clone())
            .collect()
    }

    fn artifact(
        &self,
        id: &str,
        workspace: &Path,
        artifact_index: usize,
    ) -> Result<(MediaJobSnapshot, MediaArtifact), HostError> {
        let state = self.lock();
        let job = state.jobs.get(id).ok_or_else(|| {
            HostError::operation("MEDIA_JOB_NOT_FOUND", "媒体任务不存在或已被清理")
        })?;
        if job.snapshot.workspace != path_for_webview(workspace) {
            return Err(HostError::operation(
                "MEDIA_JOB_WORKSPACE_MISMATCH",
                "媒体任务不属于当前工作区",
            ));
        }
        if job.snapshot.phase != MediaJobPhase::Completed {
            return Err(HostError::operation(
                "MEDIA_ARTIFACT_NOT_READY",
                "媒体任务尚未成功完成，不能操作产物",
            ));
        }
        let artifact = job
            .snapshot
            .artifacts
            .get(artifact_index)
            .cloned()
            .ok_or_else(|| {
                HostError::operation("MEDIA_ARTIFACT_NOT_FOUND", "媒体产物不存在或已被清理")
            })?;
        Ok((job.snapshot.clone(), artifact))
    }

    fn snapshot(&self, id: &str) -> Option<MediaJobSnapshot> {
        self.lock().jobs.get(id).map(|job| job.snapshot.clone())
    }

    fn snapshots(&self) -> Vec<MediaJobSnapshot> {
        let state = self.lock();
        state
            .order
            .iter()
            .filter_map(|id| state.jobs.get(id))
            .map(|job| job.snapshot.clone())
            .collect()
    }

    fn register_reference(&self, id: String, workspace: PathBuf, path: PathBuf) {
        self.lock().references.insert(
            id,
            StoredReference {
                workspace,
                path,
                in_use: 0,
                released: false,
            },
        );
    }

    fn acquire_reference(
        self: &Arc<Self>,
        id: &str,
        workspace: &Path,
    ) -> Result<MediaReferenceLease, String> {
        let mut state = self.lock();
        let reference = state
            .references
            .get_mut(id)
            .ok_or_else(|| "参考图片已失效，请重新选择".to_string())?;
        if reference.released || reference.workspace != workspace {
            return Err("参考图片不属于当前工作区，请重新选择".into());
        }
        if !reference.path.is_file() {
            return Err("参考图片文件已丢失，请重新选择".into());
        }
        reference.in_use += 1;
        Ok(MediaReferenceLease {
            service: Arc::clone(self),
            id: id.to_string(),
            path: reference.path.clone(),
        })
    }

    fn release_reference(&self, id: &str, workspace: &Path) -> Result<bool, String> {
        let delete = {
            let mut state = self.lock();
            let Some(reference) = state.references.get_mut(id) else {
                return Ok(false);
            };
            if reference.workspace != workspace {
                return Err("参考图片不属于当前工作区".into());
            }
            reference.released = true;
            (reference.in_use == 0).then(|| reference.path.clone())
        };
        if let Some(path) = delete {
            self.delete_reference(id, &path);
        }
        Ok(true)
    }

    fn release_reference_use(&self, id: &str) {
        let delete = {
            let mut state = self.lock();
            let Some(reference) = state.references.get_mut(id) else {
                return;
            };
            reference.in_use = reference.in_use.saturating_sub(1);
            (reference.released && reference.in_use == 0).then(|| reference.path.clone())
        };
        if let Some(path) = delete {
            self.delete_reference(id, &path);
        }
    }

    fn delete_reference(&self, id: &str, path: &Path) {
        self.lock().references.remove(id);
        if let Some(directory) = path.parent() {
            let _ = fs::remove_dir_all(directory);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MediaState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn media_storage_error(message: String) -> HostError {
    HostError::recoverable_environment(
        "MEDIA_JOURNAL_FAILED",
        message,
        "检查应用数据目录的磁盘空间和文件权限；不要退出当前页面",
    )
}

fn media_jobs_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("media-jobs.json"))
        .map_err(|error| format!("无法定位媒体任务记录：{error}"))
}

fn validate_persisted_snapshot(snapshot: &MediaJobSnapshot, home: &Path) -> Result<(), String> {
    if !snapshot.id.starts_with("media-") || snapshot.id.len() > 80 {
        return Err("媒体任务记录包含无效任务 ID".into());
    }
    if !Path::new(&snapshot.workspace).is_absolute() {
        return Err(format!("媒体任务 {} 的工作区不是绝对路径", snapshot.id));
    }
    let prompt_len = snapshot.prompt.chars().count();
    if !(1..=4_000).contains(&prompt_len) {
        return Err(format!("媒体任务 {} 的提示词长度无效", snapshot.id));
    }
    if !MEDIA_ASPECTS.contains(&snapshot.aspect.as_str()) {
        return Err(format!("媒体任务 {} 的画面比例无效", snapshot.id));
    }
    if snapshot.phase.is_terminal() != snapshot.completed_at.is_some() {
        return Err(format!("媒体任务 {} 的生命周期时间戳不一致", snapshot.id));
    }
    if snapshot.artifacts.len() > 4 {
        return Err(format!("媒体任务 {} 的产物数量无效", snapshot.id));
    }
    if snapshot.phase == MediaJobPhase::Failed && snapshot.error.is_none() {
        return Err(format!("媒体任务 {} 缺少失败原因", snapshot.id));
    }
    if snapshot.phase != MediaJobPhase::Failed && snapshot.error.is_some() {
        return Err(format!("媒体任务 {} 在非失败状态携带错误", snapshot.id));
    }
    if let Some(error) = snapshot.error.as_ref() {
        if !matches!(error.domain.as_str(), "protocol" | "environment")
            || error.code.is_empty()
            || error.code.len() > 128
            || !error
                .code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            || error.message.len() > 8 * 1024
            || error.action.as_ref().is_some_and(|action| action.len() > 2 * 1024)
        {
            return Err(format!("媒体任务 {} 的错误契约无效", snapshot.id));
        }
    }
    for artifact in &snapshot.artifacts {
        validate_persisted_artifact(snapshot, artifact, home)?;
    }
    Ok(())
}

fn validate_persisted_artifact(
    snapshot: &MediaJobSnapshot,
    artifact: &MediaArtifact,
    home: &Path,
) -> Result<(), String> {
    match (artifact.path.as_deref(), artifact.url.as_deref()) {
        (Some(value), None) => {
            let requested = PathBuf::from(value);
            if !requested.is_absolute() {
                return Err(format!("媒体任务 {} 的产物路径不是绝对路径", snapshot.id));
            }
            let tool = match snapshot.kind {
                MediaKind::Image => "image_gen",
                MediaKind::Video => "image_to_video",
            };
            if media_mime(&requested, tool) != Some(artifact.mime.as_str()) {
                return Err(format!("媒体任务 {} 的产物类型与路径不匹配", snapshot.id));
            }
            let workspace = PathBuf::from(&snapshot.workspace);
            let sessions = home.join("sessions");
            let in_scope = if requested.exists() {
                let canonical = requested.canonicalize().map_err(|error| {
                    format!("无法验证媒体任务 {} 的产物路径：{error}", snapshot.id)
                })?;
                workspace
                    .canonicalize()
                    .ok()
                    .is_some_and(|root| canonical.starts_with(root))
                    || sessions
                        .canonicalize()
                        .ok()
                        .is_some_and(|root| canonical.starts_with(root))
            } else {
                requested.starts_with(&workspace) || requested.starts_with(&sessions)
            };
            if !in_scope {
                return Err(format!("媒体任务 {} 的产物路径越过授权边界", snapshot.id));
            }
            Ok(())
        }
        (None, Some(value)) => {
            let tool = match snapshot.kind {
                MediaKind::Image => "image_gen",
                MediaKind::Video => "image_to_video",
            };
            let checked = checked_remote_artifact(value, tool)
                .map_err(|error| format!("媒体任务 {} 的远程产物无效：{}", snapshot.id, error.message))?;
            if checked.url != artifact.url || checked.mime != artifact.mime {
                return Err(format!("媒体任务 {} 的远程产物契约不匹配", snapshot.id));
            }
            Ok(())
        }
        _ => Err(format!("媒体任务 {} 的产物引用无效", snapshot.id)),
    }
}

fn persist_jobs_locked(state: &mut MediaState) -> Result<(), String> {
    if let Some(error) = state.journal_blocked.as_ref() {
        return Err(format!("媒体任务记录处于只读保护状态：{error}"));
    }
    let Some(path) = state.journal_path.clone() else {
        return Ok(());
    };
    let jobs = state
        .order
        .iter()
        .map(|id| {
            state
                .jobs
                .get(id)
                .map(|job| job.snapshot.clone())
                .ok_or_else(|| format!("媒体任务顺序索引缺少任务：{id}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let content = serde_json::to_string_pretty(&MediaJournal {
        version: MEDIA_JOURNAL_VERSION,
        jobs,
    })
    .map_err(|error| format!("无法序列化媒体任务记录：{error}"))?;
    match atomic_write_bounded_private(&path, &content, MEDIA_JOBS_MAX_BYTES) {
        Ok(()) => {
            state.journal_last_error = None;
            Ok(())
        }
        Err(error) => {
            state.journal_last_error = Some(error.clone());
            Err(error)
        }
    }
}

pub(crate) fn restore_job_journal(
    app: &tauri::AppHandle,
    service: &Arc<MediaService>,
) -> Result<(), String> {
    let home = grok_home()?;
    service.initialize(media_jobs_path(app)?, &home)?;
    for snapshot in service.snapshots() {
        for artifact in snapshot.artifacts {
            if let Some(path) = artifact.path.filter(|path| Path::new(path).is_file()) {
                app.asset_protocol_scope()
                    .allow_file(PathBuf::from(path))
                    .map_err(|error| format!("无法恢复媒体产物预览授权：{error}"))?;
            }
        }
    }
    Ok(())
}

pub(crate) fn media_journal_status(service: &Arc<MediaService>) -> MediaJournalStatus {
    service.journal_status()
}

#[tauri::command]
pub(crate) fn save_media_reference(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<MediaService>>,
    cwd: String,
    name: String,
    data: String,
) -> Result<MediaReferenceResponse, HostError> {
    crate::host_core::ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("MEDIA_WINDOW_NOT_OWNER", error))?;
    let workspace = checked_workspace(&cwd)
        .map_err(|error| HostError::operation("MEDIA_WORKSPACE_INVALID", error))?;
    let (bytes, extension) = checked_reference_payload(&name, &data)
        .map_err(|error| HostError::operation("MEDIA_REFERENCE_INVALID", error))?;
    let root = reference_cache_root(&app).map_err(media_storage_error)?;
    create_private_directory(&root).map_err(media_storage_error)?;

    for _ in 0..4 {
        let id = random_id("ref").map_err(media_storage_error)?;
        let directory = root.join(&id);
        match create_exclusive_private_directory(&directory) {
            Ok(()) => {}
            Err(error) if directory.exists() => continue,
            Err(error) => return Err(media_storage_error(error)),
        }
        let path = directory.join(format!("reference.{extension}"));
        let written = write_private_file(&path, &bytes);
        if let Err(error) = written {
            let _ = fs::remove_dir_all(&directory);
            return Err(media_storage_error(error));
        }
        service.register_reference(id.clone(), workspace, path);
        return Ok(MediaReferenceResponse { id });
    }
    Err(media_storage_error("无法分配参考图片存储 ID，请重试".into()))
}

#[tauri::command]
pub(crate) fn release_media_reference(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<MediaService>>,
    cwd: String,
    id: String,
) -> Result<bool, HostError> {
    crate::host_core::ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("MEDIA_WINDOW_NOT_OWNER", error))?;
    let workspace = checked_workspace(&cwd)
        .map_err(|error| HostError::operation("MEDIA_WORKSPACE_INVALID", error))?;
    service
        .release_reference(id.trim(), &workspace)
        .map_err(|error| HostError::operation("MEDIA_REFERENCE_RELEASE_FAILED", error))
}

#[tauri::command]
pub(crate) fn start_media_generation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<MediaService>>,
    request: MediaGenerationRequest,
) -> Result<MediaJobSnapshot, HostError> {
    crate::host_core::ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("MEDIA_WINDOW_NOT_OWNER", error))?;
    let service = Arc::clone(service.inner());
    let prepared = prepare_request(Arc::clone(&service), request)
        .map_err(|error| HostError::operation("MEDIA_REQUEST_INVALID", error))?;
    let (snapshot, cancel) = service.create_job(&prepared.workspace, &prepared.request)?;
    emit_snapshot(&app, &snapshot);
    let job_id = snapshot.id.clone();
    let diagnostic_scope = MediaDiagnosticScope {
        job_id: snapshot.id.clone(),
        workspace: snapshot.workspace.clone(),
        kind: snapshot.kind,
    };
    tauri::async_runtime::spawn(async move {
        let result = run_media_generation(&app, &service, &job_id, prepared, cancel).await;
        let settled = match result {
            Ok(artifacts) => service.finish(&job_id, MediaJobPhase::Completed, artifacts, None),
            Err(MediaRunError::Cancelled) => {
                service.finish(&job_id, MediaJobPhase::Cancelled, Vec::new(), None)
            }
            Err(MediaRunError::Failed(error)) => {
                service.finish(&job_id, MediaJobPhase::Failed, Vec::new(), Some(error))
            }
        };
        match settled {
            Ok(Some(snapshot)) => emit_snapshot(&app, &snapshot),
            Ok(None) => emit_diagnostic(
                &app,
                &diagnostic_scope,
                HostError::operation(
                    "MEDIA_JOB_NOT_FOUND",
                    "媒体任务完成时 Host 已找不到任务记录",
                ),
            ),
            Err(error) => {
                if let Some(snapshot) = service.snapshot(&job_id) {
                    emit_snapshot(&app, &snapshot);
                }
                emit_diagnostic(&app, &diagnostic_scope, error);
            }
        }
    });
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn media_generation_status(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<MediaService>>,
    cwd: String,
    kind: MediaKind,
) -> Result<Option<MediaJobSnapshot>, HostError> {
    crate::host_core::ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("MEDIA_WINDOW_NOT_OWNER", error))?;
    let workspace = checked_workspace(&cwd)
        .map_err(|error| HostError::operation("MEDIA_WORKSPACE_INVALID", error))?;
    Ok(service.latest(&workspace, kind))
}

#[tauri::command]
pub(crate) fn media_generation_history(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<MediaService>>,
    cwd: String,
    kind: Option<MediaKind>,
    limit: Option<usize>,
) -> Result<Vec<MediaJobSnapshot>, HostError> {
    crate::host_core::ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("MEDIA_WINDOW_NOT_OWNER", error))?;
    let workspace = checked_workspace(&cwd)
        .map_err(|error| HostError::operation("MEDIA_WORKSPACE_INVALID", error))?;
    Ok(service.history(
        &workspace,
        kind,
        limit.unwrap_or(DEFAULT_HISTORY_LIMIT),
    ))
}

#[tauri::command]
pub(crate) fn media_generation_capabilities() -> MediaGenerationCapabilities {
    MediaGenerationCapabilities {
        aspects: MEDIA_ASPECTS,
        image_counts: &[1, 2, 3, 4],
        video_durations: VIDEO_DURATIONS,
        video_resolutions: VIDEO_RESOLUTIONS,
        max_active_jobs: MAX_ACTIVE_JOBS,
    }
}

#[tauri::command]
pub(crate) fn cancel_media_generation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<MediaService>>,
    cwd: String,
    id: String,
) -> Result<MediaJobSnapshot, HostError> {
    crate::host_core::ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("MEDIA_WINDOW_NOT_OWNER", error))?;
    let workspace = checked_workspace(&cwd)
        .map_err(|error| HostError::operation("MEDIA_WORKSPACE_INVALID", error))?;
    let (snapshot, _) = service.cancel(id.trim(), &workspace)?;
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn open_media_artifact(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<MediaService>>,
    cwd: String,
    id: String,
    artifact_index: usize,
    action: MediaArtifactAction,
) -> Result<(), HostError> {
    crate::host_core::ensure_main_acp_owner(window.label())
        .map_err(|error| HostError::operation("MEDIA_WINDOW_NOT_OWNER", error))?;
    let workspace = checked_workspace(&cwd)
        .map_err(|error| HostError::operation("MEDIA_WORKSPACE_INVALID", error))?;
    let (snapshot, artifact) = service.artifact(id.trim(), &workspace, artifact_index)?;
    let home = grok_home().map_err(|error| {
        HostError::recoverable_environment(
            "MEDIA_HOME_UNAVAILABLE",
            error,
            "检查 Grok 主目录配置后重试",
        )
    })?;
    validate_persisted_artifact(&snapshot, &artifact, &home).map_err(|error| {
        HostError::protocol_with_action(
            "MEDIA_ARTIFACT_AUTHORIZATION_INVALID",
            error,
            "重新生成该媒体产物；若持续失败，请导出支持包",
        )
    })?;

    match (artifact.path.as_deref(), artifact.url.as_deref(), action) {
        (Some(path), None, MediaArtifactAction::Open) => {
            let file = PathBuf::from(path).canonicalize().map_err(|error| {
                HostError::recoverable_environment(
                    "MEDIA_ARTIFACT_MISSING",
                    format!("媒体产物已丢失或不可访问：{error}"),
                    "重新生成产物或恢复对应文件",
                )
            })?;
            crate::file_commands::open_file_default(&file)
        }
        (Some(path), None, MediaArtifactAction::Reveal) => {
            let file = PathBuf::from(path).canonicalize().map_err(|error| {
                HostError::recoverable_environment(
                    "MEDIA_ARTIFACT_MISSING",
                    format!("媒体产物已丢失或不可访问：{error}"),
                    "重新生成产物或恢复对应文件",
                )
            })?;
            crate::file_commands::reveal_file(&file)
        }
        (None, Some(url), MediaArtifactAction::Open) => {
            let parsed = url::Url::parse(url).map_err(|error| {
                HostError::protocol("MEDIA_ARTIFACT_URL_INVALID", format!("媒体链接无效：{error}"))
            })?;
            crate::host_core::spawn_system_browser(&parsed).map_err(|error| {
                HostError::recoverable_environment(
                    "MEDIA_ARTIFACT_OPEN_FAILED",
                    error,
                    "检查系统浏览器后重试",
                )
            })
        }
        (None, Some(_), MediaArtifactAction::Reveal) => Err(HostError::operation(
            "MEDIA_ARTIFACT_REMOTE_REVEAL_UNSUPPORTED",
            "远程媒体产物不能在本地文件管理器中定位",
        )),
        _ => Err(HostError::protocol(
            "MEDIA_ARTIFACT_REFERENCE_INVALID",
            "媒体产物引用无效",
        )),
    }
}

pub(crate) fn scrub_reference_cache(app: &tauri::AppHandle) -> Result<(), String> {
    let root = reference_cache_root(app)?;
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("无法清理媒体参考图缓存 {}：{error}", root.display()))?;
    }
    Ok(())
}

fn prepare_request(
    service: Arc<MediaService>,
    request: MediaGenerationRequest,
) -> Result<PreparedMediaRequest, String> {
    let workspace = checked_workspace(&request.cwd)?;
    let prompt = request.prompt.trim();
    if prompt.is_empty() || prompt.chars().count() > 4_000 {
        return Err("媒体提示词必须为 1–4000 个字符".into());
    }
    if !MEDIA_ASPECTS.contains(&request.aspect.as_str()) {
        return Err("不支持的画面比例".into());
    }
    let reference = match request.reference_id.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(id) => Some(service.acquire_reference(id, &workspace)?),
    };
    let instruction = match request.kind {
        MediaKind::Image => {
            if !(1..=4).contains(&request.count) {
                return Err("图片生成数量必须为 1–4".into());
            }
            if reference.is_some() {
                return Err("文生图任务不能携带视频参考图".into());
            }
            format!(
                "仅执行媒体任务：必须调用 image_gen 恰好 {count} 次，每次 prompt 都使用下方用户描述，aspect_ratio 必须为 {aspect}。不得调用其他工具。全部完成后简短确认即可。\n\n用户描述：{prompt}",
                count = request.count,
                aspect = request.aspect,
            )
        }
        MediaKind::Video => {
            if request.count != 1 {
                return Err("视频任务一次只能生成 1 个产物".into());
            }
            if !VIDEO_DURATIONS.contains(&request.duration) {
                return Err("视频时长只支持 6 秒或 10 秒".into());
            }
            if !VIDEO_RESOLUTIONS.contains(&request.resolution.as_str()) {
                return Err("视频分辨率只支持 480p 或 720p".into());
            }
            if let Some(reference) = reference.as_ref() {
                format!(
                    "仅执行媒体任务：必须调用 image_to_video 恰好 1 次。image 必须为 {image}，prompt 必须使用下方用户描述，duration 必须为 {duration}，resolution_name 必须为 {resolution}。不得调用其他工具。完成后简短确认即可。\n\n用户描述：{prompt}",
                    image = path_for_webview(&reference.path),
                    duration = request.duration,
                    resolution = request.resolution,
                )
            } else {
                format!(
                    "仅执行媒体任务，严格分两步：第一步调用 image_gen 恰好 1 次，为下方用户描述生成视频首帧，aspect_ratio 必须为 {aspect}；第二步调用 image_to_video 恰好 1 次，image 使用第一步返回的绝对路径，prompt 使用下方用户描述，duration 必须为 {duration}，resolution_name 必须为 {resolution}。不得调用其他工具。完成后简短确认即可。\n\n用户描述：{prompt}",
                    aspect = request.aspect,
                    duration = request.duration,
                    resolution = request.resolution,
                )
            }
        }
    };
    Ok(PreparedMediaRequest {
        request,
        workspace,
        prompt: instruction,
        reference,
    })
}

// 让同一调用点在非 Windows 平台不需要虚构 Job Object 类型。
#[cfg(windows)]
macro_rules! windows_job_ref {
    ($job:ident) => {
        Some(&$job)
    };
}
#[cfg(not(windows))]
macro_rules! windows_job_ref {
    ($job:ident) => {
        ()
    };
}

async fn run_media_generation(
    app: &tauri::AppHandle,
    service: &Arc<MediaService>,
    job_id: &str,
    prepared: PreparedMediaRequest,
    mut cancel: oneshot::Receiver<()>,
) -> Result<Vec<MediaArtifact>, MediaRunError> {
    if cancel.try_recv().is_ok() {
        return Err(MediaRunError::Cancelled);
    }
    if let Some(snapshot) = service
        .mark_running(job_id)
        .map_err(|error| MediaRunError::Failed(error.into()))?
    {
        emit_snapshot(app, &snapshot);
    }
    let runtime = configured_grok_command();
    let mut command = Command::new(&runtime.path);
    command
        .arg("--single")
        .arg(&prepared.prompt)
        .args(["--output-format", "streaming-json", "--always-approve"])
        .args(["--tools", MEDIA_GENERATION_TOOLS])
        .current_dir(&prepared.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("GROK_CLIENT_NAME", UPSTREAM_CLI_CLIENT_NAME);
    let home = grok_home().map_err(|error| {
        MediaRunError::Failed(MediaFailure::environment(
            "SECRET_STORE_READ_FAILED",
            error,
            "解锁系统凭据库，或在供应商设置中重新保存 API Key",
        ))
    })?;
    let provider = open_current(home).map_err(|error| {
        MediaRunError::Failed(MediaFailure::environment(
            "SECRET_STORE_READ_FAILED",
            error,
            "解锁系统凭据库，或在供应商设置中重新保存 API Key",
        ))
    })?;
    apply_provider_environment(&mut command, &provider).map_err(|error| {
        MediaRunError::Failed(MediaFailure::environment(
            "SECRET_STORE_READ_FAILED",
            error,
            "解锁系统凭据库，或在供应商设置中重新保存 API Key",
        ))
    })?;
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    #[cfg(windows)]
    let job = crate::process_job::ProcessJob::create_kill_on_close().map_err(|error| {
        MediaRunError::Failed(MediaFailure::environment(
            "MEDIA_PROCESS_ISOLATION_FAILED",
            format!("无法创建媒体进程隔离：{error}"),
            "重启 Grox 后重试；若持续失败，请导出支持包",
        ))
    })?;

    let mut child = command.spawn().map_err(|error| {
        MediaRunError::Failed(MediaFailure::environment(
            "MEDIA_RUNTIME_START_FAILED",
            format!("无法启动 Grok Build 媒体任务：{error}"),
            "在设置中检查 Grok Build 路径与安装状态",
        ))
    })?;
    let pid = child.id().ok_or_else(|| {
        let _ = child.start_kill();
        MediaRunError::Failed(MediaFailure::environment(
            "MEDIA_RUNTIME_PID_MISSING",
            "Grok Build 媒体进程没有可用 PID",
            "重启 Grox 后重试",
        ))
    })?;

    #[cfg(windows)]
    if let Err(error) = job.assign_pid(pid) {
        let _ = child.start_kill();
        return Err(MediaRunError::Failed(MediaFailure::environment(
            "MEDIA_PROCESS_ISOLATION_FAILED",
            format!("无法将媒体进程加入 Job Object：{error}"),
            "重启 Grox 后重试；若持续失败，请导出支持包",
        )));
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        MediaRunError::Failed(MediaFailure::environment(
            "MEDIA_STDOUT_UNAVAILABLE",
            "无法读取 Grok Build 媒体输出",
            "重启 Grox 后重试",
        ))
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        MediaRunError::Failed(MediaFailure::environment(
            "MEDIA_STDERR_UNAVAILABLE",
            "无法读取 Grok Build 媒体错误输出",
            "重启 Grox 后重试",
        ))
    })?;
    let stdout_task = tokio::spawn(capture_stream(stdout));
    let stderr_task = tokio::spawn(capture_stream(stderr));
    enum Exit {
        Status(std::process::ExitStatus),
        Cancelled,
        TimedOut,
    }
    let exit = tokio::select! {
        status = child.wait() => {
            Exit::Status(status.map_err(|error| MediaRunError::Failed(MediaFailure::environment(
                "MEDIA_RUNTIME_WAIT_FAILED",
                format!("无法等待 Grok Build 媒体任务：{error}"),
                "重启 Grox 后重试",
            )))?)
        }
        _ = &mut cancel => {
            terminate_process_tree(&mut child, pid, windows_job_ref!(job));
            let _ = child.wait().await;
            Exit::Cancelled
        }
        _ = tokio::time::sleep(MEDIA_GENERATION_TIMEOUT) => {
            terminate_process_tree(&mut child, pid, windows_job_ref!(job));
            let _ = child.wait().await;
            Exit::TimedOut
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| {
            MediaRunError::Failed(MediaFailure::environment(
                "MEDIA_STDOUT_JOIN_FAILED",
                format!("媒体输出读取任务异常退出：{error}"),
                "重启 Grox 后重试",
            ))
        })?
        .map_err(|error| {
            MediaRunError::Failed(MediaFailure::environment(
                "MEDIA_STDOUT_READ_FAILED",
                format!("无法读取 Grok Build 媒体输出：{error}"),
                "重启 Grox 后重试",
            ))
        })?;
    let stderr = stderr_task
        .await
        .map_err(|error| {
            MediaRunError::Failed(MediaFailure::environment(
                "MEDIA_STDERR_JOIN_FAILED",
                format!("媒体错误流读取任务异常退出：{error}"),
                "重启 Grox 后重试",
            ))
        })?
        .map_err(|error| {
            MediaRunError::Failed(MediaFailure::environment(
                "MEDIA_STDERR_READ_FAILED",
                format!("无法读取 Grok Build 媒体错误输出：{error}"),
                "重启 Grox 后重试",
            ))
        })?;
    drop(prepared.reference);

    match exit {
        Exit::Cancelled => return Err(MediaRunError::Cancelled),
        Exit::TimedOut => {
            return Err(MediaRunError::Failed(MediaFailure::environment(
                "MEDIA_GENERATION_TIMEOUT",
                "媒体生成超过 10 分钟，Host 已终止整个任务进程树",
                "检查网络与账户配额后重试",
            )))
        }
        Exit::Status(status) if !status.success() => {
            let detail = if stderr.bytes.is_empty() {
                &stdout.bytes
            } else {
                &stderr.bytes
            };
            let detail = String::from_utf8_lossy(detail);
            let detail = redact_token_markers(detail.trim());
            let detail = if detail.is_empty() {
                format!("进程退出状态：{status}")
            } else {
                detail.chars().take(4_000).collect::<String>()
            };
            return Err(MediaRunError::Failed(MediaFailure::environment(
                "MEDIA_GENERATION_FAILED",
                format!("Grok Build 媒体任务失败：{detail}"),
                "检查登录状态、网络、账户配额与媒体权限后重试",
            )));
        }
        Exit::Status(_) => {}
    }
    if stdout.truncated {
        return Err(MediaRunError::Failed(MediaFailure::protocol(
            "MEDIA_PROTOCOL_OUTPUT_TOO_LARGE",
            "Grok Build streaming-json 输出超过 8 MB，Host 拒绝解析不完整协议流",
            "更新 Grok Build；若持续失败，请导出支持包",
        )));
    }
    let stdout = String::from_utf8(stdout.bytes).map_err(|_| {
        MediaRunError::Failed(MediaFailure::protocol(
            "MEDIA_PROTOCOL_INVALID_UTF8",
            "Grok Build streaming-json 输出不是有效 UTF-8",
            "更新 Grok Build 后重试",
        ))
    })?;
    let artifacts = extract_media_artifacts(
        &stdout,
        &prepared.workspace,
        prepared.request.kind,
        prepared.request.count,
    )
    .map_err(MediaRunError::Failed)?;
    for artifact in &artifacts {
        if let Some(path) = artifact.path.as_deref() {
            app.asset_protocol_scope()
                .allow_file(PathBuf::from(path))
                .map_err(|error| {
                    MediaRunError::Failed(MediaFailure::environment(
                        "MEDIA_PREVIEW_AUTH_FAILED",
                        format!("无法授权媒体产物预览：{error}"),
                        "重启 Grox 后重试；产物文件仍保留在磁盘",
                    ))
                })?;
        }
    }
    Ok(artifacts)
}

#[cfg(windows)]
fn terminate_process_tree(
    child: &mut Child,
    _pid: u32,
    job: Option<&crate::process_job::ProcessJob>,
) {
    if let Some(job) = job {
        let _ = job.terminate_tree();
    }
    let _ = child.start_kill();
}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child, pid: u32, _job: ()) {
    // 子进程以独立进程组启动；负 PID 杀掉 Grok Build 及其媒体工具后代。
    unsafe {
        let _ = libc::kill(-(pid as i32), libc::SIGKILL);
    }
    let _ = child.start_kill();
}

#[cfg(all(not(unix), not(windows)))]
fn terminate_process_tree(child: &mut Child, _pid: u32, _job: ()) {
    let _ = child.start_kill();
}

async fn capture_stream(mut stream: impl AsyncRead + Unpin) -> Result<CapturedStream, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        let remaining = MAX_CAPTURE_BYTES.saturating_sub(bytes.len());
        let keep = remaining.min(read);
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok(CapturedStream { bytes, truncated })
}

fn extract_media_artifacts(
    output: &str,
    workspace: &Path,
    kind: MediaKind,
    expected_count: u8,
) -> Result<Vec<MediaArtifact>, MediaFailure> {
    let mut tool_names = BTreeMap::<String, String>::new();
    let mut candidates = Vec::<(String, Option<String>, Option<String>)>::new();
    let mut terminal_end = false;
    for (index, line) in output.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line).map_err(|error| {
            MediaFailure::protocol(
                "MEDIA_PROTOCOL_INVALID_JSON",
                format!("Grok Build streaming-json 第 {} 行无效：{error}", index + 1),
                "更新 Grok Build 后重试",
            )
        })?;
        match value.get("type").and_then(Value::as_str) {
            Some("tool_call") => {
                let Some(id) = value.get("toolCallId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(name) = value.get("toolName").and_then(Value::as_str) else {
                    continue;
                };
                if matches!(name, "image_gen" | "image_to_video") {
                    tool_names.insert(id.to_string(), name.to_string());
                }
            }
            Some("tool_call_update")
                if value.get("status").and_then(Value::as_str) == Some("completed") =>
            {
                let Some(id) = value.get("toolCallId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(name) = tool_names.get(id) else {
                    continue;
                };
                let wanted = matches!(
                    (kind, name.as_str()),
                    (MediaKind::Image, "image_gen") | (MediaKind::Video, "image_to_video")
                );
                if !wanted {
                    continue;
                }
                let raw = value.get("rawOutput").unwrap_or(&Value::Null);
                let path = raw.get("path").and_then(Value::as_str).map(str::to_string);
                let url = raw
                    .get("uploaded_url")
                    .or_else(|| raw.get("uploadedUrl"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if path.is_some() || url.is_some() {
                    candidates.push((name.clone(), path, url));
                }
            }
            Some("error") => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Grok Build 返回未知协议错误");
                return Err(MediaFailure::protocol(
                    "MEDIA_PROTOCOL_ERROR_EVENT",
                    redact_token_markers(message),
                    "检查 Grok Build 登录与工具可用性后重试",
                ));
            }
            Some("end") => terminal_end = true,
            _ => {}
        }
    }
    if !terminal_end {
        return Err(MediaFailure::protocol(
            "MEDIA_PROTOCOL_END_MISSING",
            "Grok Build streaming-json 未返回终止事件",
            "更新 Grok Build 后重试",
        ));
    }

    let home = grok_home().map_err(|error| {
        MediaFailure::environment(
            "MEDIA_OUTPUT_ROOT_UNAVAILABLE",
            error,
            "检查 GROK_HOME 后重试",
        )
    })?;
    let mut artifacts = Vec::new();
    for (tool, path, url) in candidates {
        let artifact = if let Some(path) = path {
            checked_local_artifact(&path, workspace, &home, &tool)?
        } else if let Some(url) = url {
            checked_remote_artifact(&url, &tool)?
        } else {
            continue;
        };
        if !artifacts.contains(&artifact) {
            artifacts.push(artifact);
        }
    }
    let expected = if kind == MediaKind::Image {
        expected_count as usize
    } else {
        1
    };
    if artifacts.len() != expected {
        return Err(MediaFailure::protocol(
            "MEDIA_ARTIFACT_COUNT_MISMATCH",
            format!(
                "Grok Build 完成了任务，但结构化产物数量为 {}，预期为 {expected}",
                artifacts.len()
            ),
            "更新 Grok Build 或降低一次生成数量后重试",
        ));
    }
    Ok(artifacts)
}

fn checked_local_artifact(
    value: &str,
    workspace: &Path,
    home: &Path,
    tool: &str,
) -> Result<MediaArtifact, MediaFailure> {
    let requested = PathBuf::from(value);
    if !requested.is_absolute() {
        return Err(protocol_artifact_error("媒体工具返回了非绝对产物路径"));
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| protocol_artifact_error(format!("无法解析媒体产物路径：{error}")))?;
    if !canonical.is_file() {
        return Err(protocol_artifact_error("媒体工具返回的产物不是文件"));
    }
    let workspace = workspace
        .canonicalize()
        .map_err(|error| protocol_artifact_error(format!("无法解析工作区：{error}")))?;
    let sessions = home.join("sessions").canonicalize().ok();
    if !canonical.starts_with(&workspace)
        && !sessions
            .as_ref()
            .is_some_and(|sessions| canonical.starts_with(sessions))
    {
        return Err(protocol_artifact_error(
            "媒体工具返回的产物不在当前工作区或 Grok 会话目录内",
        ));
    }
    let mime = media_mime(&canonical, tool)
        .ok_or_else(|| protocol_artifact_error("媒体工具返回了与工具类型不匹配的文件格式"))?;
    Ok(MediaArtifact {
        path: Some(path_for_webview(&canonical)),
        url: None,
        mime: mime.into(),
    })
}

fn checked_remote_artifact(value: &str, tool: &str) -> Result<MediaArtifact, MediaFailure> {
    if tool != "image_to_video" {
        return Err(protocol_artifact_error("只有视频工具可以返回远程上传 URL"));
    }
    let parsed = url::Url::parse(value)
        .map_err(|error| protocol_artifact_error(format!("媒体 URL 无效：{error}")))?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || is_blocked_service_host(parsed.host_str())
        || !is_media_https_host_allowed(parsed.host_str())
    {
        return Err(protocol_artifact_error("媒体 URL 不满足安全策略"));
    }
    Ok(MediaArtifact {
        path: None,
        url: Some(parsed.to_string()),
        mime: "video/mp4".into(),
    })
}

fn protocol_artifact_error(message: impl Into<String>) -> MediaFailure {
    MediaFailure::protocol(
        "MEDIA_ARTIFACT_INVALID",
        message,
        "更新 Grok Build；若持续失败，请导出支持包",
    )
}

fn media_mime(path: &Path, tool: &str) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match (tool, extension.as_str()) {
        ("image_gen", "png") => Some("image/png"),
        ("image_gen", "jpg" | "jpeg") => Some("image/jpeg"),
        ("image_gen", "webp") => Some("image/webp"),
        ("image_to_video", "mp4") => Some("video/mp4"),
        ("image_to_video", "webm") => Some("video/webm"),
        _ => None,
    }
}

pub(crate) fn is_media_https_host_allowed(host: Option<&str>) -> bool {
    let Some(host) = host.map(|value| value.trim().trim_end_matches('.').to_ascii_lowercase())
    else {
        return false;
    };
    MEDIA_HTTPS_HOST_ALLOWLIST
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

fn checked_reference_payload(name: &str, data: &str) -> Result<(Vec<u8>, &'static str), String> {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or("参考图片缺少扩展名")?;
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("参考图片仅支持 PNG、JPEG 或 WebP".into());
    }
    if data.len() > MAX_MEDIA_REFERENCE_BYTES.saturating_mul(4) / 3 + 1024 {
        return Err("参考图片不能超过 24 MB".into());
    }
    let payload = data
        .rsplit_once(',')
        .map(|(_, value)| value)
        .unwrap_or(data);
    let bytes = BASE64
        .decode(payload)
        .map_err(|error| format!("参考图片编码无效：{error}"))?;
    if bytes.len() > MAX_MEDIA_REFERENCE_BYTES {
        return Err("参考图片不能超过 24 MB".into());
    }
    let detected = prompt_image_mime(&bytes).ok_or("参考图片内容不是有效的 PNG、JPEG 或 WebP")?;
    let (expected, normalized_extension) = match extension.as_str() {
        "png" => ("image/png", "png"),
        "jpg" | "jpeg" => ("image/jpeg", "jpg"),
        "webp" => ("image/webp", "webp"),
        _ => unreachable!(),
    };
    if detected != expected {
        return Err(format!(
            "参考图片内容与扩展名不符（内容 {detected}，扩展名 .{extension}）"
        ));
    }
    Ok((bytes, normalized_extension))
}

fn reference_cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| directory.join("media-references"))
        .map_err(|error| format!("无法定位媒体参考图缓存：{error}"))
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|error| format!("无法创建媒体缓存目录 {}：{error}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法收紧媒体缓存目录权限 {}：{error}", path.display()))
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("无法创建媒体缓存目录 {}：{error}", path.display()))
}

#[cfg(unix)]
fn create_exclusive_private_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt as _;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(|error| format!("无法创建媒体缓存目录 {}：{error}", path.display()))
}

#[cfg(not(unix))]
fn create_exclusive_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir(path)
        .map_err(|error| format!("无法创建媒体缓存目录 {}：{error}", path.display()))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("无法创建媒体参考图 {}：{error}", path.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法保存媒体参考图 {}：{error}", path.display()))?;
    restrict_private_file(path)
}

fn random_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法生成媒体任务 ID：{error}"))?;
    let mut value = String::with_capacity(prefix.len() + 1 + bytes.len() * 2);
    value.push_str(prefix);
    value.push('-');
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    Ok(value)
}

fn emit_snapshot(app: &tauri::AppHandle, snapshot: &MediaJobSnapshot) {
    let _ = app.emit_to("main", MEDIA_GENERATION_EVENT, snapshot.clone());
}

fn emit_diagnostic(app: &tauri::AppHandle, scope: &MediaDiagnosticScope, error: HostError) {
    let _ = app.emit_to(
        "main",
        MEDIA_DIAGNOSTIC_EVENT,
        MediaDiagnostic {
            job_id: scope.job_id.clone(),
            workspace: scope.workspace.clone(),
            kind: scope.kind,
            error,
        },
    );
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "grox-media-service-{label}-{}-{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn request(kind: MediaKind) -> MediaGenerationRequest {
        MediaGenerationRequest {
            kind,
            prompt: "雨夜的未来城市".into(),
            aspect: "16:9".into(),
            count: 1,
            duration: 6,
            resolution: "480p".into(),
            reference_id: None,
            cwd: env!("CARGO_MANIFEST_DIR").into(),
        }
    }

    #[test]
    fn media_contract_matches_current_grok_build_tools() {
        assert_eq!(MEDIA_GENERATION_TOOLS, "image_gen,image_to_video");
        assert_eq!(VIDEO_DURATIONS, &[6, 10]);
        assert_eq!(VIDEO_RESOLUTIONS, &["480p", "720p"]);
        let capabilities = serde_json::to_value(media_generation_capabilities()).unwrap();
        assert_eq!(capabilities["videoDurations"], serde_json::json!([6, 10]));
        assert_eq!(
            capabilities["videoResolutions"],
            serde_json::json!(["480p", "720p"])
        );
        assert_eq!(capabilities["maxActiveJobs"], MAX_ACTIVE_JOBS);
        assert!(!MEDIA_GENERATION_TOOLS.contains("video_gen"));
        assert!(!MEDIA_GENERATION_TOOLS.contains("bash"));
    }

    #[test]
    fn diagnostic_event_is_scoped_to_job_workspace_and_kind() {
        let value = serde_json::to_value(MediaDiagnostic {
            job_id: "media-1".into(),
            workspace: "/workspace".into(),
            kind: MediaKind::Video,
            error: HostError::operation("MEDIA_TEST", "fixture"),
        })
        .unwrap();
        assert_eq!(value["jobId"], "media-1");
        assert_eq!(value["workspace"], "/workspace");
        assert_eq!(value["kind"], "video");
        assert_eq!(value["error"]["code"], "MEDIA_TEST");
    }

    #[test]
    fn video_prompt_uses_two_stage_text_to_video_contract() {
        let service = Arc::new(MediaService::default());
        let prepared = prepare_request(service, request(MediaKind::Video)).unwrap();
        assert!(prepared.prompt.contains("image_gen 恰好 1 次"));
        assert!(prepared.prompt.contains("image_to_video 恰好 1 次"));
        assert!(prepared.prompt.contains("duration 必须为 6"));
        assert!(prepared.prompt.contains("resolution_name 必须为 480p"));
    }

    #[test]
    fn video_contract_rejects_values_the_tool_cannot_execute() {
        let service = Arc::new(MediaService::default());
        let mut invalid = request(MediaKind::Video);
        invalid.duration = 5;
        invalid.resolution = "1080p".into();
        assert!(prepare_request(Arc::clone(&service), invalid).is_err());
        let mut invalid = request(MediaKind::Video);
        invalid.duration = 10;
        invalid.resolution = "4K".into();
        assert!(prepare_request(service, invalid).is_err());
    }

    #[test]
    fn structured_parser_ignores_prose_and_intermediate_first_frame() {
        let workspace = temp_root("structured");
        let video = workspace.join("result.mp4");
        let image = workspace.join("first-frame.jpg");
        fs::write(&video, b"video").unwrap();
        fs::write(&image, b"image").unwrap();
        let output = format!(
            "{{\"type\":\"text\",\"data\":\"/tmp/fake.mp4\"}}\n{{\"type\":\"tool_call\",\"toolCallId\":\"i\",\"toolName\":\"image_gen\"}}\n{{\"type\":\"tool_call_update\",\"toolCallId\":\"i\",\"status\":\"completed\",\"rawOutput\":{{\"path\":{image}}}}}\n{{\"type\":\"tool_call\",\"toolCallId\":\"v\",\"toolName\":\"image_to_video\"}}\n{{\"type\":\"tool_call_update\",\"toolCallId\":\"v\",\"status\":\"completed\",\"rawOutput\":{{\"path\":{video}}}}}\n{{\"type\":\"end\"}}",
            image = serde_json::to_string(&path_for_webview(&image)).unwrap(),
            video = serde_json::to_string(&path_for_webview(&video)).unwrap(),
        );
        let artifacts = extract_media_artifacts(&output, &workspace, MediaKind::Video, 1).unwrap();
        assert_eq!(artifacts.len(), 1);
        let expected = path_for_webview(&video.canonicalize().unwrap());
        assert_eq!(artifacts[0].path.as_deref(), Some(expected.as_str()));
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn parser_fails_closed_without_structured_output_or_end_event() {
        let workspace = temp_root("fail-closed");
        let prose = "{\"type\":\"text\",\"data\":\"result.png\"}\n{\"type\":\"end\"}";
        let error = extract_media_artifacts(prose, &workspace, MediaKind::Image, 1).unwrap_err();
        assert_eq!(error.code, "MEDIA_ARTIFACT_COUNT_MISMATCH");
        let error = extract_media_artifacts(
            "{\"type\":\"text\",\"data\":\"done\"}",
            &workspace,
            MediaKind::Image,
            1,
        )
        .unwrap_err();
        assert_eq!(error.code, "MEDIA_PROTOCOL_END_MISSING");
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn structured_output_cannot_authorize_an_unrelated_local_path() {
        let workspace = temp_root("scope-workspace");
        let outside_root = temp_root("scope-outside");
        let outside = outside_root.join("stolen.jpg");
        fs::write(&outside, b"image").unwrap();
        let output = format!(
            "{{\"type\":\"tool_call\",\"toolCallId\":\"i\",\"toolName\":\"image_gen\"}}\n{{\"type\":\"tool_call_update\",\"toolCallId\":\"i\",\"status\":\"completed\",\"rawOutput\":{{\"path\":{path}}}}}\n{{\"type\":\"end\"}}",
            path = serde_json::to_string(&path_for_webview(&outside)).unwrap(),
        );
        let error = extract_media_artifacts(&output, &workspace, MediaKind::Image, 1).unwrap_err();
        assert_eq!(error.code, "MEDIA_ARTIFACT_INVALID");
        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(outside_root).unwrap();
    }

    #[test]
    fn job_registry_owns_single_active_job_and_cancellation() {
        let service = MediaService::default();
        let workspace = temp_root("registry").canonicalize().unwrap();
        let request = request(MediaKind::Image);
        let (snapshot, mut receiver) = service.create_job(&workspace, &request).unwrap();
        assert_eq!(snapshot.phase, MediaJobPhase::Queued);
        assert!(service.create_job(&workspace, &request).is_err());
        let other_workspace = temp_root("registry-other").canonicalize().unwrap();
        assert!(service.cancel(&snapshot.id, &other_workspace).is_err());
        let (cancelled, sent) = service.cancel(&snapshot.id, &workspace).unwrap();
        assert!(sent);
        assert_eq!(cancelled.phase, MediaJobPhase::Cancelling);
        assert!(receiver.try_recv().is_ok());
        service
            .finish(&snapshot.id, MediaJobPhase::Cancelled, Vec::new(), None)
            .unwrap();
        assert!(service.create_job(&workspace, &request).is_ok());
        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(other_workspace).unwrap();
    }

    #[test]
    fn history_is_workspace_scoped_filtered_and_newest_first() {
        let service = MediaService::default();
        let workspace = temp_root("history-workspace").canonicalize().unwrap();
        let other_workspace = temp_root("history-other").canonicalize().unwrap();

        let (first, _) = service
            .create_job(&workspace, &request(MediaKind::Image))
            .unwrap();
        service
            .finish(&first.id, MediaJobPhase::Completed, Vec::new(), None)
            .unwrap();
        let (video, _) = service
            .create_job(&workspace, &request(MediaKind::Video))
            .unwrap();
        service
            .finish(&video.id, MediaJobPhase::Completed, Vec::new(), None)
            .unwrap();
        let (latest, _) = service
            .create_job(&workspace, &request(MediaKind::Image))
            .unwrap();
        service
            .finish(&latest.id, MediaJobPhase::Completed, Vec::new(), None)
            .unwrap();
        let (outside, _) = service
            .create_job(&other_workspace, &request(MediaKind::Image))
            .unwrap();
        service
            .finish(&outside.id, MediaJobPhase::Completed, Vec::new(), None)
            .unwrap();

        let images = service.history(&workspace, Some(MediaKind::Image), 40);
        assert_eq!(
            images.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
            vec![latest.id.as_str(), first.id.as_str()]
        );
        let limited = service.history(&workspace, None, 2);
        assert_eq!(
            limited.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
            vec![latest.id.as_str(), video.id.as_str()]
        );

        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(other_workspace).unwrap();
    }

    #[test]
    fn artifact_lookup_uses_job_identity_and_workspace_capability() {
        let service = MediaService::default();
        let root = temp_root("artifact-capability");
        let workspace = root.join("workspace");
        let other_workspace = root.join("other");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other_workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let other_workspace = other_workspace.canonicalize().unwrap();
        let output = workspace.join("output.png");
        fs::write(&output, b"image").unwrap();
        let (created, _) = service
            .create_job(&workspace, &request(MediaKind::Image))
            .unwrap();
        service
            .finish(
                &created.id,
                MediaJobPhase::Completed,
                vec![MediaArtifact {
                    path: Some(path_for_webview(&output)),
                    url: None,
                    mime: "image/png".into(),
                }],
                None,
            )
            .unwrap();

        assert!(service.artifact(&created.id, &workspace, 0).is_ok());
        assert_eq!(
            service
                .artifact(&created.id, &other_workspace, 0)
                .unwrap_err()
                .code,
            "MEDIA_JOB_WORKSPACE_MISMATCH"
        );
        assert_eq!(
            service.artifact(&created.id, &workspace, 1).unwrap_err().code,
            "MEDIA_ARTIFACT_NOT_FOUND"
        );
        assert_eq!(
            service.artifact("media-missing", &workspace, 0).unwrap_err().code,
            "MEDIA_JOB_NOT_FOUND"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restored_session_artifact_remains_authorized() {
        let root = temp_root("restored-session-artifact");
        let workspace = root.join("workspace");
        let home = root.join("grok-home");
        let output = home.join("sessions").join("session-1").join("result.png");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(output.parent().unwrap()).unwrap();
        fs::write(&output, b"image").unwrap();
        let snapshot = MediaJobSnapshot {
            id: "media-restored-session-artifact".into(),
            workspace: path_for_webview(&workspace.canonicalize().unwrap()),
            kind: MediaKind::Image,
            prompt: "restored artifact".into(),
            aspect: "1:1".into(),
            count: 1,
            duration: 6,
            resolution: "480p".into(),
            phase: MediaJobPhase::Completed,
            started_at: 1,
            completed_at: Some(2),
            artifacts: vec![MediaArtifact {
                path: Some(path_for_webview(&output.canonicalize().unwrap())),
                url: None,
                mime: "image/png".into(),
            }],
            error: None,
        };

        validate_persisted_artifact(&snapshot, &snapshot.artifacts[0], &home).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn job_registry_enforces_the_advertised_global_limit() {
        let service = MediaService::default();
        let request = request(MediaKind::Image);
        let mut workspaces = Vec::new();
        for index in 0..MAX_ACTIVE_JOBS {
            let workspace = temp_root(&format!("limit-{index}")).canonicalize().unwrap();
            service.create_job(&workspace, &request).unwrap();
            workspaces.push(workspace);
        }
        let overflow = temp_root("limit-overflow").canonicalize().unwrap();
        assert!(service.create_job(&overflow, &request).is_err());
        for workspace in workspaces {
            fs::remove_dir_all(workspace).unwrap();
        }
        fs::remove_dir_all(overflow).unwrap();
    }

    #[test]
    fn journal_restores_jobs_and_settles_crash_leftovers() {
        let root = temp_root("journal-restore");
        let path = root.join("media-jobs.json");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let service = MediaService::default();
        service.initialize(path.clone(), &root).unwrap();
        let (created, _cancel) = service
            .create_job(&workspace, &request(MediaKind::Image))
            .unwrap();
        assert!(path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        let restored = MediaService::default();
        restored.initialize(path.clone(), &root).unwrap();
        let snapshot = restored.latest(&workspace, MediaKind::Image).unwrap();
        assert_eq!(snapshot.id, created.id);
        assert_eq!(snapshot.phase, MediaJobPhase::Failed);
        assert_eq!(snapshot.error.unwrap().code, "MEDIA_JOB_INTERRUPTED");
        let persisted: MediaJournal =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(persisted.jobs[0].phase, MediaJobPhase::Failed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_journal_blocks_new_writes_instead_of_resurrecting_state() {
        let root = temp_root("journal-corrupt");
        let path = root.join("media-jobs.json");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        fs::write(&path, b"{broken").unwrap();
        let before = fs::read(&path).unwrap();
        let service = MediaService::default();
        assert!(service.initialize(path.clone(), &root).is_err());
        let error = service
            .create_job(&workspace, &request(MediaKind::Image))
            .unwrap_err();
        assert_eq!(error.code, "MEDIA_JOURNAL_FAILED");
        assert_eq!(fs::read(path).unwrap(), before);
        assert!(!service.journal_status().readable);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restored_journal_rejects_artifacts_outside_authorized_roots() {
        let root = temp_root("journal-artifact-scope");
        let path = root.join("media-jobs.json");
        let workspace = root.join("workspace");
        let home = root.join("grok-home");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(home.join("sessions")).unwrap();
        let outside = root.join("outside.png");
        fs::write(&outside, b"image").unwrap();
        let journal = MediaJournal {
            version: MEDIA_JOURNAL_VERSION,
            jobs: vec![MediaJobSnapshot {
                id: "media-0123456789abcdef".into(),
                workspace: path_for_webview(&workspace.canonicalize().unwrap()),
                kind: MediaKind::Image,
                prompt: "scope test".into(),
                aspect: "1:1".into(),
                count: 1,
                duration: 6,
                resolution: "480p".into(),
                phase: MediaJobPhase::Completed,
                started_at: 1,
                completed_at: Some(2),
                artifacts: vec![MediaArtifact {
                    path: Some(path_for_webview(&outside.canonicalize().unwrap())),
                    url: None,
                    mime: "image/png".into(),
                }],
                error: None,
            }],
        };
        let content = serde_json::to_string(&journal).unwrap();
        fs::write(&path, &content).unwrap();
        let service = MediaService::default();
        assert!(service.initialize(path.clone(), &home).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), content);
        assert!(!service.journal_status().readable);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn released_reference_is_deleted_only_after_the_active_job_drops_its_lease() {
        let service = Arc::new(MediaService::default());
        let workspace = temp_root("reference-workspace").canonicalize().unwrap();
        let directory = temp_root("reference-file");
        let path = directory.join("reference.jpg");
        fs::write(&path, b"image").unwrap();
        service.register_reference("ref-1".into(), workspace.clone(), path.clone());
        let lease = service
            .acquire_reference("ref-1", &workspace)
            .expect("reference lease");
        let other_workspace = temp_root("reference-other").canonicalize().unwrap();
        assert!(service
            .release_reference("ref-1", &other_workspace)
            .is_err());
        assert!(service.release_reference("ref-1", &workspace).unwrap());
        assert!(path.is_file());
        drop(lease);
        assert!(!directory.exists());
        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(other_workspace).unwrap();
    }

    #[test]
    fn reference_payload_checks_extension_against_content() {
        let jpeg = BASE64.encode(b"\xff\xd8\xffpayload");
        assert!(checked_reference_payload("fake.png", &jpeg).is_err());
        let (_, extension) = checked_reference_payload("real.jpeg", &jpeg).unwrap();
        assert_eq!(extension, "jpg");
    }
}
