//! Host-attested operator preferences (native app data).
//!
//! Computer Use opt-in and Bypass permission mode must not live only in
//! webview localStorage (XSS / DevTools can flip them). Source of truth is
//! `host_prefs.json` under the Tauri app data dir (single path, process cache).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{de, Deserialize, Deserializer, Serialize};

use crate::{
    host_core::atomic_write_bounded_private,
    permission_policy::PermissionMode,
};

const PREFS_FILE: &str = "host_prefs.json";
const MAX_PREFS_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPrefs {
    /// Operator enabled Computer Use (desktop control) in Settings.
    #[serde(default)]
    pub computer_use_enabled: bool,
    /// Browser MCP 与自动化均读取 Host 偏好，页面重载不能改变后台会话能力。
    #[serde(default)]
    pub browser_use_enabled: bool,
    /// Host 授权上限；页面、队列和自动化只能请求更严格的模式。
    #[serde(default, deserialize_with = "deserialize_permission_mode")]
    pub permission_mode: PermissionMode,
    /// Optional override for FE mid-turn idle (minutes).
    #[serde(default)]
    pub prompt_idle_minutes: Option<u32>,
    /// Optional override for absolute turn ceiling (hours).
    #[serde(default)]
    pub prompt_absolute_hours: Option<u32>,
    /// One-shot latch: FE→host CU migration already ran (0.2.25).
    /// Without this, re-enabling localStorage after intentional host opt-out
    /// silently re-opens the host gate on every boot (review P1).
    #[serde(default)]
    pub computer_use_fe_migrated: bool,
    /// 一次性把旧版 localStorage Browser Use 选择迁入 Host。
    #[serde(default)]
    pub browser_use_fe_migrated: bool,
}

fn deserialize_permission_mode<'de, D>(deserializer: D) -> Result<PermissionMode, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    if raw.is_empty() {
        // 0.3.2 之前的前端会把未初始化的选择保存为空串；升级时按新安装默认值迁移。
        return Ok(PermissionMode::default());
    }
    PermissionMode::parse(&raw)
        .ok_or_else(|| de::Error::unknown_variant(&raw, &["default", "auto", "bypass"]))
}

impl Default for HostPrefs {
    fn default() -> Self {
        Self {
            computer_use_enabled: false,
            browser_use_enabled: false,
            permission_mode: PermissionMode::default(),
            prompt_idle_minutes: None,
            prompt_absolute_hours: None,
            computer_use_fe_migrated: false,
            browser_use_fe_migrated: false,
        }
    }
}

static PREFS_CACHE: Mutex<Option<HostPrefs>> = Mutex::new(None);
/// Single data dir for this process (set from AppHandle at startup / first command).
static PREFS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
/// 所有读取、迁移与更新共享同一把锁，避免不同设置的 RMW 互相覆盖。
static PREFS_IO: Mutex<()> = Mutex::new(());

fn prefs_path_from_dir(app_data: &Path) -> PathBuf {
    app_data.join(PREFS_FILE)
}

/// Pin the only prefs directory this process will use (0.2.20).
pub fn set_data_dir(dir: PathBuf) {
    if let Ok(mut guard) = PREFS_DIR.lock() {
        *guard = Some(dir);
    }
}

/// Gate read: env-independent; only process cache (filled by load/save).
pub fn is_computer_use_enabled() -> bool {
    PREFS_CACHE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.computer_use_enabled))
        .unwrap_or(false)
}

pub fn load_prefs(app_data: &Path) -> Result<HostPrefs, String> {
    let _io = PREFS_IO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    load_prefs_unlocked(app_data)
}

fn load_prefs_unlocked(app_data: &Path) -> Result<HostPrefs, String> {
    set_data_dir(app_data.to_path_buf());
    let path = prefs_path_from_dir(app_data);
    let prefs = match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(prefs) => prefs,
            Err(error) => {
                clear_cache();
                return Err(format!("Host 偏好文件损坏 {}：{error}", path.display()));
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => HostPrefs::default(),
        Err(error) => {
            clear_cache();
            return Err(format!("无法读取 Host 偏好 {}：{error}", path.display()));
        }
    };
    if let Ok(mut guard) = PREFS_CACHE.lock() {
        *guard = Some(prefs.clone());
    }
    Ok(prefs)
}

fn clear_cache() {
    if let Ok(mut guard) = PREFS_CACHE.lock() {
        *guard = None;
    }
}

pub fn save_prefs(app_data: &Path, prefs: &HostPrefs) -> Result<(), String> {
    let _io = PREFS_IO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    save_prefs_unlocked(app_data, prefs)
}

fn save_prefs_unlocked(app_data: &Path, prefs: &HostPrefs) -> Result<(), String> {
    set_data_dir(app_data.to_path_buf());
    let path = prefs_path_from_dir(app_data);
    let raw = serde_json::to_string_pretty(prefs).map_err(|e| format!("序列化 host_prefs：{e}"))?;
    atomic_write_bounded_private(&path, &raw, MAX_PREFS_BYTES)?;
    if let Ok(mut guard) = PREFS_CACHE.lock() {
        *guard = Some(prefs.clone());
    }
    Ok(())
}

/// 在同一把 Host 锁内读取、修改并原子提交偏好。
pub fn update_prefs(
    app_data: &Path,
    update: impl FnOnce(&mut HostPrefs) -> Result<(), String>,
) -> Result<HostPrefs, String> {
    let _io = PREFS_IO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut prefs = load_prefs_unlocked(app_data)?;
    update(&mut prefs)?;
    save_prefs_unlocked(app_data, &prefs)?;
    Ok(prefs)
}

/// Silent one-shot migration: FE had CU on, host never set (0.2.20).
/// After the first migration attempt, `computer_use_fe_migrated` stays true so
/// later boots cannot re-open the host gate from localStorage alone.
pub fn migrate_computer_use_from_fe(
    app_data: &Path,
    fe_enabled: bool,
) -> Result<HostPrefs, String> {
    update_prefs(app_data, |prefs| {
        if prefs.computer_use_fe_migrated {
            return Ok(());
        }
        if fe_enabled && !prefs.computer_use_enabled {
            prefs.computer_use_enabled = true;
        }
        prefs.computer_use_fe_migrated = true;
        Ok(())
    })
}

pub fn migrate_browser_use_from_fe(app_data: &Path, fe_enabled: bool) -> Result<HostPrefs, String> {
    update_prefs(app_data, |prefs| {
        if prefs.browser_use_fe_migrated {
            return Ok(());
        }
        prefs.browser_use_enabled = fe_enabled;
        prefs.browser_use_fe_migrated = true;
        Ok(())
    })
}

pub fn set_computer_use(app_data: &Path, enabled: bool) -> Result<HostPrefs, String> {
    update_prefs(app_data, |prefs| {
        prefs.computer_use_enabled = enabled;
        prefs.computer_use_fe_migrated = true;
        if enabled && prefs.permission_mode == PermissionMode::Bypass {
            prefs.permission_mode = PermissionMode::Default;
        }
        Ok(())
    })
}

pub fn set_browser_use(app_data: &Path, enabled: bool) -> Result<HostPrefs, String> {
    update_prefs(app_data, |prefs| {
        prefs.browser_use_enabled = enabled;
        prefs.browser_use_fe_migrated = true;
        Ok(())
    })
}

/// Bypass 提权确认与写入处于同一个偏好事务内，避免检查后状态被并发修改。
pub fn set_permission_mode(
    app_data: &Path,
    mode: PermissionMode,
    confirm_bypass: impl FnOnce() -> bool,
) -> Result<HostPrefs, String> {
    update_prefs(app_data, |prefs| {
        if mode == PermissionMode::Bypass
            && prefs.permission_mode != PermissionMode::Bypass
            && !confirm_bypass()
        {
            return Ok(());
        }
        prefs.permission_mode = mode;
        if mode == PermissionMode::Bypass {
            prefs.computer_use_enabled = false;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // 被测实现使用进程级目录与缓存；并行测试会互相覆盖临时文件和缓存。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn isolate_process_state() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap();
        *PREFS_CACHE.lock().unwrap() = None;
        *PREFS_DIR.lock().unwrap() = None;
        guard
    }

    fn temp_dir() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("grox-host-prefs-test-{n}"))
    }

    #[test]
    fn roundtrip_and_gate_cache() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        let mut p = HostPrefs::default();
        assert!(!is_computer_use_enabled());
        p.computer_use_enabled = true;
        save_prefs(&dir, &p).expect("save");
        assert!(is_computer_use_enabled());
        // Clear cache and reload from disk.
        if let Ok(mut g) = PREFS_CACHE.lock() {
            *g = None;
        }
        let loaded = load_prefs(&dir).unwrap();
        assert!(loaded.computer_use_enabled);
        assert!(is_computer_use_enabled());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_only_when_host_off() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        let p = HostPrefs::default();
        save_prefs(&dir, &p).unwrap();
        let out = migrate_computer_use_from_fe(&dir, true).unwrap();
        assert!(out.computer_use_enabled);
        assert!(out.computer_use_fe_migrated);
        // Second migrate is no-op keep true.
        let out2 = migrate_computer_use_from_fe(&dir, false).unwrap();
        assert!(out2.computer_use_enabled);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_does_not_reopen_after_host_opt_out() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        // First boot: FE had CU on → migrate opens host gate once.
        let out = migrate_computer_use_from_fe(&dir, true).unwrap();
        assert!(out.computer_use_enabled);
        // Operator opts out on host.
        let mut off = out;
        off.computer_use_enabled = false;
        save_prefs(&dir, &off).unwrap();
        // localStorage still "1" must not re-open gate.
        let again = migrate_computer_use_from_fe(&dir, true).unwrap();
        assert!(!again.computer_use_enabled);
        assert!(again.computer_use_fe_migrated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn browser_migration_preserves_the_frontend_choice_once() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);

        let migrated = migrate_browser_use_from_fe(&dir, true).unwrap();
        assert!(migrated.browser_use_enabled);
        assert!(migrated.browser_use_fe_migrated);

        let mut disabled = migrated;
        disabled.browser_use_enabled = false;
        save_prefs(&dir, &disabled).unwrap();
        let unchanged = migrate_browser_use_from_fe(&dir, true).unwrap();
        assert!(!unchanged.browser_use_enabled);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_existing_prefs_fail_closed_without_rewrite() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        let mut prefs = HostPrefs::default();
        prefs.computer_use_enabled = true;
        save_prefs(&dir, &prefs).unwrap();
        assert!(is_computer_use_enabled());
        let path = prefs_path_from_dir(&dir);
        fs::write(&path, b"{not-json").unwrap();

        let error = load_prefs(&dir).unwrap_err();
        assert!(error.contains("Host 偏好文件损坏"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not-json");
        assert!(!is_computer_use_enabled());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_empty_permission_mode_uses_current_default() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            prefs_path_from_dir(&dir),
            r#"{"computerUseEnabled":true,"permissionMode":""}"#,
        )
        .unwrap();

        let loaded = load_prefs(&dir).unwrap();
        assert_eq!(loaded.permission_mode, PermissionMode::Auto);
        assert!(loaded.computer_use_enabled);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_permission_mode_still_fails_closed() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            prefs_path_from_dir(&dir),
            r#"{"computerUseEnabled":true,"permissionMode":"root"}"#,
        )
        .unwrap();

        let error = load_prefs(&dir).unwrap_err();
        assert!(error.contains("Host 偏好文件损坏"));
        assert!(!is_computer_use_enabled());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_updates_preserve_unrelated_fields_and_safety_invariant() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        let bypass = set_permission_mode(&dir, PermissionMode::Bypass, || true).unwrap();
        assert_eq!(bypass.permission_mode, PermissionMode::Bypass);
        assert!(!bypass.computer_use_enabled);

        let browser = set_browser_use(&dir, true).unwrap();
        assert_eq!(browser.permission_mode, PermissionMode::Bypass);
        assert!(browser.browser_use_enabled);

        let computer = set_computer_use(&dir, true).unwrap();
        assert_eq!(computer.permission_mode, PermissionMode::Default);
        assert!(computer.computer_use_enabled);
        assert!(computer.browser_use_enabled);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelling_native_bypass_confirmation_keeps_current_mode() {
        let _test = isolate_process_state();
        let dir = temp_dir();
        let unchanged = set_permission_mode(&dir, PermissionMode::Bypass, || false).unwrap();
        assert_eq!(unchanged.permission_mode, PermissionMode::Auto);
        let _ = fs::remove_dir_all(&dir);
    }
}
