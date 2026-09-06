//! Host 结构化诊断日志。
//!
//! GUI 从 Dock/Finder 启动时通常没有可回看的 stderr。这里把生命周期与
//! 错误事件同时写入 stderr 和按日滚动文件，并限制保留数量与总大小。
//! 日志调用方只记录身份、状态和错误分类，禁止记录 ACP 正文或凭据值。

use std::{
    fs::{self, File},
    io::{Read as _, Seek as _, SeekFrom, Write as _},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use serde::Serialize;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const LOG_PREFIX: &str = "host.log";
const MAX_LOG_FILES: usize = 8;
const MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;
const SUPPORT_TAIL_BYTES: u64 = 192 * 1024;
const DEFAULT_FILTER: &str = "warn,grox=info";

static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostLogStatus {
    initialized: bool,
    files: usize,
    bytes: u64,
    max_files: usize,
    max_bytes: u64,
}

pub(crate) fn init(log_dir: PathBuf) -> Result<(), String> {
    create_private_log_directory(&log_dir)?;
    prune(&log_dir)?;
    // 正式包不接受外部 RUST_LOG 扩大文件日志范围，避免依赖库把请求 URL、
    // header 或正文写进支持包。debug 构建仍允许开发者显式提高诊断级别。
    let filter = if cfg!(debug_assertions) {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER))
    } else {
        EnvFilter::new(DEFAULT_FILTER)
    };
    let file_appender = tracing_appender::rolling::daily(&log_dir, LOG_PREFIX);
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_target(true)
        .with_ansi(cfg!(debug_assertions));
    let file_layer = fmt::layer()
        .with_writer(file_writer)
        .with_target(true)
        .with_ansi(false);
    tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer)
        .with(file_layer)
        .try_init()
        .map_err(|error| format!("无法初始化 Host 结构化日志：{error}"))?;
    LOG_GUARD
        .set(guard)
        .map_err(|_| "Host 结构化日志已初始化".to_string())?;
    let _ = LOG_DIR.set(log_dir.clone());
    install_panic_hook(log_dir.clone());
    tracing::info!(target: "grox::host", "Host structured logging ready");
    Ok(())
}

fn create_private_log_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("无法创建 Host 日志目录 {}：{error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法限制 Host 日志目录权限：{error}"))?;
    }
    Ok(())
}

pub(crate) fn status() -> HostLogStatus {
    let Some(log_dir) = LOG_DIR.get() else {
        return HostLogStatus {
            initialized: false,
            files: 0,
            bytes: 0,
            max_files: MAX_LOG_FILES,
            max_bytes: MAX_LOG_BYTES,
        };
    };
    let files = log_files(log_dir);
    HostLogStatus {
        initialized: true,
        files: files.len(),
        bytes: files
            .iter()
            .filter_map(|path| path.metadata().ok())
            .map(|metadata| metadata.len())
            .sum(),
        max_files: MAX_LOG_FILES,
        max_bytes: MAX_LOG_BYTES,
    }
}

pub(crate) fn recent_redacted_tail() -> String {
    let Some(log_dir) = LOG_DIR.get() else {
        return "Host file logging was not initialized.".into();
    };
    // panic payload 可能携带任意业务数据；支持包只收集由 tracing 调用点约束过字段的结构化日志。
    let mut files = log_files(log_dir)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(LOG_PREFIX))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|path| {
        std::cmp::Reverse(
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    });
    let mut remaining = SUPPORT_TAIL_BYTES;
    let mut chunks = Vec::new();
    for path in files {
        if remaining == 0 {
            break;
        }
        let Ok(chunk) = read_tail(&path, remaining) else {
            continue;
        };
        remaining = remaining.saturating_sub(chunk.len() as u64);
        chunks.push(chunk);
    }
    crate::support_bundle::redact_token_markers(&chunks.join("\n"))
}

fn prune(log_dir: &Path) -> Result<(), String> {
    let mut files = log_files(log_dir);
    files.sort_by_key(|path| {
        std::cmp::Reverse(
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    });
    let mut kept_bytes = 0_u64;
    for (index, path) in files.into_iter().enumerate() {
        let bytes = path.metadata().map(|value| value.len()).unwrap_or(0);
        if index < MAX_LOG_FILES && kept_bytes.saturating_add(bytes) <= MAX_LOG_BYTES {
            kept_bytes = kept_bytes.saturating_add(bytes);
            continue;
        }
        fs::remove_file(&path)
            .map_err(|error| format!("无法清理旧 Host 日志 {}：{error}", path.display()))?;
    }
    Ok(())
}

fn log_files(log_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(log_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(LOG_PREFIX) || name == "panic.log")
        })
        .collect()
}

fn read_tail(path: &Path, max_bytes: u64) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("无法读取 Host 日志 {}：{error}", path.display()))?;
    let length = file
        .metadata()
        .map_err(|error| format!("无法读取 Host 日志元数据：{error}"))?
        .len();
    let start = length.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("无法定位 Host 日志尾部：{error}"))?;
    let mut bytes = Vec::new();
    file.take(max_bytes)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 Host 日志尾部：{error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn install_panic_hook(log_dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|value| format!("{}:{}:{}", value.file(), value.line(), value.column()))
            .unwrap_or_else(|| "unknown".into());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| (*value).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic".into());
        let line = format!(
            "{} PANIC thread={} location={} message={}\n{}\n",
            chrono::Local::now().to_rfc3339(),
            std::thread::current().name().unwrap_or("unnamed"),
            location,
            payload,
            std::backtrace::Backtrace::force_capture(),
        );
        let path = log_dir.join("panic.log");
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
            let _ = crate::host_core::restrict_private_file(&path);
        }
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log_dir(name: &str) -> PathBuf {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "grox-host-log-{name}-{}-{}",
            std::process::id(),
            timestamp
        ))
    }

    #[test]
    fn pruning_keeps_newest_files_within_count() {
        let dir = temp_log_dir("prune");
        fs::create_dir_all(&dir).unwrap();
        for index in 0..10 {
            fs::write(dir.join(format!("host.log.2026-08-{index:02}")), b"line").unwrap();
        }
        prune(&dir).unwrap();
        assert_eq!(log_files(&dir).len(), MAX_LOG_FILES);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tail_is_bounded_and_keeps_latest_bytes() {
        let dir = temp_log_dir("tail");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("host.log.2026-08-15");
        fs::write(&path, b"0123456789").unwrap();
        assert_eq!(read_tail(&path, 4).unwrap(), "6789");
        let _ = fs::remove_dir_all(dir);
    }
}
