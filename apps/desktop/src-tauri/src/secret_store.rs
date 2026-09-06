//! Grox 管理密钥的单一持久化边界。
//!
//! OS 凭据库保存密钥正文；当平台凭据库明确不可用时，降级到权限为 0600 的
//! 私有文件。调用方只持有稳定引用，不能自行再写 `.env` 或供应商元数据文件。

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

use crate::host_core::atomic_write_private;

const KEYRING_SERVICE: &str = "dev.grox.desktop";
const SECRET_FILE_NAME: &str = "grox-secrets.json";
const SECRET_FILE_VERSION: u8 = 1;
const MAX_SECRET_FILE_BYTES: u64 = 2 * 1024 * 1024;

static SECRET_FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SecretBackendKind {
    Keychain,
    PrivateFile,
    LegacyFile,
    Missing,
}

#[derive(Debug)]
pub(crate) struct StoredSecret {
    value: String,
    backend: SecretBackendKind,
}

impl StoredSecret {
    pub(crate) fn expose(&self) -> &str {
        &self.value
    }

    pub(crate) fn backend(&self) -> SecretBackendKind {
        self.backend
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretFile {
    #[serde(default = "secret_file_version")]
    version: u8,
    #[serde(default)]
    present: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    fallback_values: BTreeMap<String, String>,
    /// OS 凭据库暂时不可用时，删除操作仍需立即对 Grox 生效。墓碑阻止旧凭据
    /// 在凭据库恢复后被重新读取；下一次显式保存会清除它。
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    tombstones: BTreeSet<String>,
}

fn secret_file_version() -> u8 {
    SECRET_FILE_VERSION
}

pub(crate) struct SecretStore {
    path: PathBuf,
}

impl SecretStore {
    pub(crate) fn new(grok_home: &Path) -> Self {
        Self {
            path: grok_home.join(SECRET_FILE_NAME),
        }
    }

    pub(crate) fn set(&self, reference: &str, value: &str) -> Result<SecretBackendKind, String> {
        validate_reference(reference)?;
        if value.is_empty() {
            self.delete(reference)?;
            return Ok(SecretBackendKind::Missing);
        }
        if value.len() > 16 * 1024 || value.chars().any(char::is_control) {
            return Err("密钥不能超过 16 KB 或包含控制字符".into());
        }

        let _guard = secret_file_lock();
        let mut file = read_secret_file(&self.path)?;
        let prior_keychain = keychain_get(reference);
        let backend = match prior_keychain.as_ref() {
            Ok(prior) => match keychain_set(reference, value) {
                Ok(()) => {
                    file.present.insert(reference.to_string());
                    file.fallback_values.remove(reference);
                    file.tombstones.remove(reference);
                    if let Err(error) = write_secret_file(&self.path, &file) {
                        let rollback = match prior.as_deref() {
                            Some(previous) => keychain_set(reference, previous),
                            None => keychain_delete(reference),
                        };
                        return Err(match rollback {
                            Ok(()) => error,
                            Err(rollback) => {
                                format!("{error}；OS 凭据库回滚也失败：{rollback}")
                            }
                        });
                    }
                    SecretBackendKind::Keychain
                }
                Err(error) => {
                    tracing::warn!(
                        target: "grox::secrets",
                        reference,
                        error = %error,
                        "OS credential store unavailable; using private-file backend"
                    );
                    file.present.insert(reference.to_string());
                    file.fallback_values
                        .insert(reference.to_string(), value.to_string());
                    file.tombstones.remove(reference);
                    write_secret_file(&self.path, &file)?;
                    SecretBackendKind::PrivateFile
                }
            },
            Err(error) => {
                // 无法读取旧值时不能安全覆盖凭据库，否则元数据写入失败后无从
                // 回滚。直接使用明确可见的私有文件后备。
                tracing::warn!(
                    target: "grox::secrets",
                    reference,
                    error = %error,
                    "OS credential store unreadable; using private-file backend"
                );
                file.present.insert(reference.to_string());
                file.fallback_values
                    .insert(reference.to_string(), value.to_string());
                file.tombstones.remove(reference);
                write_secret_file(&self.path, &file)?;
                SecretBackendKind::PrivateFile
            }
        };
        Ok(backend)
    }

    pub(crate) fn get(&self, reference: &str) -> Result<Option<StoredSecret>, String> {
        validate_reference(reference)?;
        let _guard = secret_file_lock();
        let file = read_secret_file(&self.path)?;
        if file.tombstones.contains(reference) {
            return Ok(None);
        }
        // 一旦 set 明确降级，私有文件就是该引用的权威值。不能先返回凭据库中
        // 可能残留的旧值，否则“保存成功”后下一次进程仍会使用旧密钥。
        if let Some(value) = file.fallback_values.get(reference) {
            return Ok(Some(StoredSecret {
                value: value.clone(),
                backend: SecretBackendKind::PrivateFile,
            }));
        }
        match keychain_get(reference) {
            Ok(Some(value)) => {
                return Ok(Some(StoredSecret {
                    value,
                    backend: SecretBackendKind::Keychain,
                }))
            }
            Ok(None) => {}
            Err(error) => return Err(format!("无法读取 OS 凭据库中的密钥：{error}")),
        }
        if file.present.contains(reference) {
            return Err("密钥元数据存在，但 OS 凭据库中没有对应值".into());
        }
        Ok(None)
    }

    pub(crate) fn backend(&self, reference: &str) -> Result<SecretBackendKind, String> {
        validate_reference(reference)?;
        let _guard = secret_file_lock();
        let file = read_secret_file(&self.path)?;
        if file.tombstones.contains(reference) {
            Ok(SecretBackendKind::Missing)
        } else if file.fallback_values.contains_key(reference) {
            Ok(SecretBackendKind::PrivateFile)
        } else if file.present.contains(reference) {
            Ok(SecretBackendKind::Keychain)
        } else {
            Ok(SecretBackendKind::Missing)
        }
    }

    pub(crate) fn delete(&self, reference: &str) -> Result<(), String> {
        validate_reference(reference)?;
        let _guard = secret_file_lock();
        let mut file = read_secret_file(&self.path)?;
        let prior_keychain = keychain_get(reference);
        let keychain_deleted = match prior_keychain.as_ref() {
            Ok(_) => match keychain_delete(reference) {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(
                        target: "grox::secrets",
                        reference,
                        error = %error,
                        "credential deletion deferred behind tombstone"
                    );
                    false
                }
            },
            Err(error) => {
                // 删除语义以 Grox 是否还能读到凭据为准。无法清理 OS 中的陈旧项时
                // 写入墓碑，避免应用在凭据库恢复后把它“复活”。
                tracing::warn!(
                    target: "grox::secrets",
                    reference,
                    error = %error,
                    "credential deletion deferred behind tombstone"
                );
                false
            }
        };
        file.present.remove(reference);
        file.fallback_values.remove(reference);
        if keychain_deleted {
            file.tombstones.remove(reference);
        } else {
            file.tombstones.insert(reference.to_string());
        }
        if let Err(error) = write_secret_file(&self.path, &file) {
            if keychain_deleted {
                if let Some(previous) = prior_keychain.ok().flatten() {
                    if let Err(rollback) = keychain_set(reference, &previous) {
                        return Err(format!("{error}；OS 凭据库回滚也失败：{rollback}"));
                    }
                }
            }
            return Err(error);
        }
        Ok(())
    }
}

fn secret_file_lock() -> std::sync::MutexGuard<'static, ()> {
    SECRET_FILE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn validate_reference(reference: &str) -> Result<(), String> {
    if reference.is_empty()
        || reference.len() > 128
        || !reference.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return Err("无效的密钥引用".into());
    }
    Ok(())
}

fn keyring_entry(reference: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, reference).map_err(|error| error.to_string())
}

fn keychain_get(reference: &str) -> Result<Option<String>, String> {
    match keyring_entry(reference)?.get_password() {
        Ok(value) if value.is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn keychain_set(reference: &str, value: &str) -> Result<(), String> {
    keyring_entry(reference)?
        .set_password(value)
        .map_err(|error| error.to_string())
}

fn keychain_delete(reference: &str) -> Result<(), String> {
    match keyring_entry(reference)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_secret_file(path: &Path) -> Result<SecretFile, String> {
    if !path.exists() {
        return Ok(SecretFile {
            version: SECRET_FILE_VERSION,
            ..SecretFile::default()
        });
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("无法读取密钥文件元数据 {}：{error}", path.display()))?;
    if metadata.len() > MAX_SECRET_FILE_BYTES {
        return Err("Grox 密钥文件超过 2 MB 安全上限".into());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("无法读取密钥文件 {}：{error}", path.display()))?;
    let file: SecretFile = serde_json::from_str(&content)
        .map_err(|error| format!("Grox 密钥文件已损坏，拒绝覆盖：{error}"))?;
    if file.version != SECRET_FILE_VERSION {
        return Err(format!("不支持的 Grox 密钥文件版本：{}", file.version));
    }
    Ok(file)
}

fn write_secret_file(path: &Path, file: &SecretFile) -> Result<(), String> {
    if file.present.is_empty() && file.fallback_values.is_empty() && file.tombstones.is_empty() {
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("无法移除空密钥文件 {}：{error}", path.display()))?;
        }
        return Ok(());
    }
    let content = serde_json::to_string_pretty(file)
        .map_err(|error| format!("无法序列化密钥元数据：{error}"))?;
    atomic_write_private(path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn temp_file(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "grox-secret-store-{label}-{}-{}",
            std::process::id(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        directory.join(SECRET_FILE_NAME)
    }

    #[test]
    fn private_file_roundtrip_preserves_backend_without_exposing_presence_values() {
        let path = temp_file("roundtrip");
        let mut file = SecretFile {
            version: SECRET_FILE_VERSION,
            ..SecretFile::default()
        };
        file.present.insert("provider:test".into());
        file.fallback_values
            .insert("provider:test".into(), "unit-secret".into());
        write_secret_file(&path, &file).unwrap();
        let loaded = read_secret_file(&path).unwrap();
        assert!(loaded.present.contains("provider:test"));
        assert_eq!(
            loaded
                .fallback_values
                .get("provider:test")
                .map(String::as_str),
            Some("unit-secret")
        );
        let store = SecretStore { path: path.clone() };
        let secret = store.get("provider:test").unwrap().unwrap();
        assert_eq!(secret.expose(), "unit-secret");
        assert_eq!(secret.backend(), SecretBackendKind::PrivateFile);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn corrupt_or_unknown_files_fail_closed() {
        let path = temp_file("corrupt");
        fs::write(&path, "not-json").unwrap();
        assert!(read_secret_file(&path).is_err());
        fs::write(&path, r#"{"version":2}"#).unwrap();
        assert!(read_secret_file(&path).is_err());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn deletion_tombstone_prevents_credential_resurrection() {
        let path = temp_file("tombstone");
        let mut file = SecretFile {
            version: SECRET_FILE_VERSION,
            ..SecretFile::default()
        };
        file.present.insert("provider:test".into());
        file.tombstones.insert("provider:test".into());
        write_secret_file(&path, &file).unwrap();

        let store = SecretStore { path: path.clone() };
        assert!(store.get("provider:test").unwrap().is_none());
        assert_eq!(
            store.backend("provider:test").unwrap(),
            SecretBackendKind::Missing
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn secret_references_are_bounded_and_not_paths() {
        assert!(validate_reference("provider:abc-123").is_ok());
        assert!(validate_reference("../provider").is_err());
        assert!(validate_reference("provider/abc").is_err());
        assert!(validate_reference(&"x".repeat(129)).is_err());
    }
}
