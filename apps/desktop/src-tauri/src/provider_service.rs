//! Provider profile use cases and persistence coordination.
//!
//! `provider_profiles` remains the pure profile domain. This service owns the
//! filesystem/SecretStore transaction boundary and exposes only command-sized
//! operations to the Tauri host. HTTP stays in `main.rs`; refresh is explicitly
//! prepare -> await -> commit.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::process::Command;
use crate::{
    provider_profiles::{
        checked_model_ids, provider_profile_secret_ref, ProviderApiBackend, ProviderProfileSummary,
        ProviderProfileUpdate, ProviderProfilesFile, GROK_MODELS_BASE_URL_KEY,
        GROX_PROVIDER_KIND_KEY, GROX_PROVIDER_PROFILE_ID_KEY, SECRET_REF_DIRECT_COMPATIBLE,
    },
    secret_store::{SecretBackendKind, SecretStore, StoredSecret},
};

pub(crate) const SECRET_REF_OFFICIAL_PROVIDER: &str = "provider:official";
const GROX_MANAGED_PROVIDER_START: &str = "# >>> Grox managed provider";
const GROX_MANAGED_PROVIDER_END: &str = "# <<< Grox managed provider";

// Profile mutations are small local transactions. Serializing them prevents a
// save/delete/refresh commit in this process from publishing a stale snapshot.
static PROVIDER_TRANSACTION: Mutex<()> = Mutex::new(());

pub(crate) type ProviderSummary = ProviderProfileSummary<SecretBackendKind>;

pub(crate) struct ProviderServiceHostOps {
    pub(crate) read_text: fn(&Path) -> Result<String, String>,
    pub(crate) atomic_write_private: fn(&Path, &str) -> Result<(), String>,
    pub(crate) atomic_create_private: fn(&Path, &str) -> Result<bool, String>,
    pub(crate) normalize_endpoint: fn(&str, bool) -> Result<String, String>,
    pub(crate) restore_auth_overrides: fn(&Path) -> Result<(), String>,
    pub(crate) restore_backend_overrides: fn(&Path) -> Result<(), String>,
    pub(crate) compatible_route_active: fn(&Path) -> Result<bool, String>,
    pub(crate) legacy_active_profile_id: fn(&Path) -> Result<Option<String>, String>,
    pub(crate) legacy_account_mode: fn(&Path) -> Result<Option<String>, String>,
    pub(crate) clear_legacy_metadata: fn(&Path) -> Result<(), String>,
    /// `(home, model_ids, base_url, primary_model, api_backend)`
    pub(crate) apply_backend_overrides:
        fn(&Path, &[String], &str, &str, &str) -> Result<(), String>,
}

pub(crate) struct ProviderService {
    home: PathBuf,
    secrets: SecretStore,
    host: ProviderServiceHostOps,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ProviderServiceErrorKind {
    Operation,
    Protocol,
    Storage,
}

#[derive(Debug)]
pub(crate) struct ProviderServiceError {
    pub(crate) kind: ProviderServiceErrorKind,
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) action: Option<&'static str>,
}

impl ProviderServiceError {
    fn operation(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: ProviderServiceErrorKind::Operation,
            code,
            message: message.into(),
            action: None,
        }
    }

    fn protocol(code: &'static str, message: impl Into<String>, action: &'static str) -> Self {
        Self {
            kind: ProviderServiceErrorKind::Protocol,
            code,
            message: message.into(),
            action: Some(action),
        }
    }

    fn storage(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind: ProviderServiceErrorKind::Storage,
            code,
            message: message.into(),
            action: Some("检查系统凭据库和 ~/.grok 的访问权限后重试"),
        }
    }
}

pub(crate) struct ProviderProfilesSnapshot {
    pub(crate) active_id: Option<String>,
    pub(crate) profiles: Vec<ProviderSummary>,
}

pub(crate) struct SaveProviderProfileInput {
    pub(crate) id: Option<String>,
    pub(crate) name: String,
    pub(crate) api_key: Option<String>,
    pub(crate) base_url: String,
    pub(crate) allow_insecure_http: bool,
    pub(crate) api_backend: ProviderApiBackend,
    pub(crate) resident_models: Vec<String>,
}

/// Contains a secret for the native HTTP request. It intentionally implements
/// neither `Debug` nor `Serialize` and never crosses the WebView boundary.
pub(crate) struct ProviderRefreshTarget {
    id: String,
    base_url: String,
    allow_insecure_http: bool,
    api_key: String,
}

impl ProviderRefreshTarget {
    pub(crate) fn api_key(&self) -> &str {
        &self.api_key
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn allow_insecure_http(&self) -> bool {
        self.allow_insecure_http
    }
}

pub(crate) struct ProviderStatusSnapshot {
    pub(crate) kind: &'static str,
    pub(crate) has_api_key: bool,
    pub(crate) base_url: Option<String>,
    pub(crate) secret_backend: SecretBackendKind,
}

pub(crate) struct ConfigureProviderInput {
    pub(crate) kind: String,
    pub(crate) api_key: Option<String>,
    pub(crate) base_url: Option<String>,
}

pub(crate) struct RuntimeProviderEnvironment {
    pub(crate) api_key: Option<String>,
    pub(crate) compatible: bool,
}

impl ProviderService {
    pub(crate) fn new(home: PathBuf, host: ProviderServiceHostOps) -> Self {
        let secrets = SecretStore::new(&home);
        Self {
            home,
            secrets,
            host,
        }
    }

    pub(crate) fn list(&self) -> Result<ProviderProfilesSnapshot, ProviderServiceError> {
        let profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let active_id = self
            .active_profile(&profiles)
            .map_err(|error| {
                ProviderServiceError::storage("PROVIDER_METADATA_READ_FAILED", error)
            })?
            .map(|profile| profile.id().to_string());
        let summaries = profiles
            .summaries(|reference, legacy| self.secret_state(reference, legacy))
            .map_err(|error| ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error))?;
        Ok(ProviderProfilesSnapshot {
            active_id,
            profiles: summaries,
        })
    }

    pub(crate) fn save(
        &self,
        request: SaveProviderProfileInput,
    ) -> Result<ProviderSummary, ProviderServiceError> {
        let _transaction = provider_transaction();
        self.migrate_legacy_secrets()
            .map_err(|error| ProviderServiceError::storage("SECRET_MIGRATION_FAILED", error))?;
        let name = request.name.trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(ProviderServiceError::operation(
                "PROVIDER_NAME_INVALID",
                "供应商名称必须为 1–80 个可见字符",
            ));
        }
        let id = request.id.unwrap_or_else(new_profile_id);
        if !valid_profile_id(&id) {
            return Err(ProviderServiceError::operation(
                "PROVIDER_PROFILE_ID_INVALID",
                "无效的供应商档案 ID",
            ));
        }
        let mut profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let reference = provider_profile_secret_ref(&id);
        let previous_secret = self
            .secrets
            .get(&reference)
            .map_err(|error| ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error))?;
        let requested_key = request
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty());
        let key = requested_key
            .or_else(|| previous_secret.as_ref().map(StoredSecret::expose))
            .ok_or_else(|| {
                ProviderServiceError::operation("PROVIDER_API_KEY_REQUIRED", "API Key 不能为空")
            })?;
        checked_api_key(key)
            .map_err(|error| ProviderServiceError::operation("PROVIDER_API_KEY_INVALID", error))?;
        let secret_changed = requested_key.is_some_and(|requested| {
            previous_secret
                .as_ref()
                .is_none_or(|previous| previous.expose() != requested)
        });
        let resident_models = checked_model_ids(request.resident_models)
            .map_err(|error| ProviderServiceError::operation("PROVIDER_MODEL_ID_INVALID", error))?;
        let base_url =
            (self.host.normalize_endpoint)(&request.base_url, request.allow_insecure_http)
                .map_err(|error| ProviderServiceError::operation("PROVIDER_URL_INVALID", error))?;
        compatible_provider_metadata(
            &base_url,
            request.allow_insecure_http,
            Some(&id),
            self.host.normalize_endpoint,
        )
        .map_err(|error| ProviderServiceError::operation("PROVIDER_URL_INVALID", error))?;
        profiles.upsert_profile(
            ProviderProfileUpdate::new(id.clone(), name.to_owned(), base_url, request.api_backend)
                .allow_insecure_http(request.allow_insecure_http)
                .resident_models(resident_models),
            secret_changed,
            self.host.normalize_endpoint,
        );
        if secret_changed {
            self.secrets.set(&reference, key).map_err(|error| {
                ProviderServiceError::storage("SECRET_STORE_WRITE_FAILED", error)
            })?;
        }
        let summary = match profiles.summary(&id, |reference, legacy| {
            self.secret_state(reference, legacy)
        }) {
            Ok(summary) => summary,
            Err(error) => {
                if secret_changed {
                    if let Err(rollback) = self.restore_secret(
                        &reference,
                        previous_secret.as_ref().map(StoredSecret::expose),
                    ) {
                        return Err(ProviderServiceError::storage(
                            "PROVIDER_PROFILE_ROLLBACK_FAILED",
                            format!("{error}；密钥回滚也失败：{rollback}"),
                        ));
                    }
                }
                return Err(ProviderServiceError::storage(
                    "SECRET_STORE_READ_FAILED",
                    error,
                ));
            }
        };
        if let Err(error) = self.write_profiles(&profiles) {
            if secret_changed {
                if let Err(rollback) = self.restore_secret(
                    &reference,
                    previous_secret.as_ref().map(StoredSecret::expose),
                ) {
                    return Err(ProviderServiceError::storage(
                        "PROVIDER_PROFILE_ROLLBACK_FAILED",
                        format!("{error}；密钥回滚也失败：{rollback}"),
                    ));
                }
            }
            return Err(ProviderServiceError::storage(
                "PROVIDER_PROFILE_WRITE_FAILED",
                error,
            ));
        }
        Ok(summary)
    }

    /// Phase 1: resolve the exact profile identity and secret before awaiting
    /// network I/O. The returned target is native-only and non-serializable.
    pub(crate) fn prepare_refresh(
        &self,
        id: &str,
    ) -> Result<ProviderRefreshTarget, ProviderServiceError> {
        let _transaction = provider_transaction();
        self.migrate_legacy_secrets()
            .map_err(|error| ProviderServiceError::storage("SECRET_MIGRATION_FAILED", error))?;
        let profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let profile = profiles.profile(id).cloned().ok_or_else(|| {
            ProviderServiceError::operation("PROVIDER_PROFILE_NOT_FOUND", "供应商档案不存在")
        })?;
        let secret = self
            .require_secret(&provider_profile_secret_ref(profile.id()))
            .map_err(|error| ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error))?;
        Ok(ProviderRefreshTarget {
            id: profile.id().to_string(),
            base_url: profile.base_url().to_string(),
            allow_insecure_http: profile.allow_insecure_http(),
            api_key: secret.expose().to_string(),
        })
    }

    /// Phase 3: after HTTP completes, re-read and verify both id and normalized
    /// endpoint before publishing the catalog. A concurrent delete or edit is
    /// therefore fail-closed rather than updating a replacement row.
    pub(crate) fn commit_refresh(
        &self,
        target: ProviderRefreshTarget,
        models: Vec<String>,
    ) -> Result<ProviderSummary, ProviderServiceError> {
        let _transaction = provider_transaction();
        let mut profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let current = profiles.profile(&target.id).ok_or_else(|| {
            ProviderServiceError::operation("PROVIDER_PROFILE_DELETED", "供应商档案已被删除")
        })?;
        let expected = (self.host.normalize_endpoint)(&target.base_url, target.allow_insecure_http);
        let actual =
            (self.host.normalize_endpoint)(current.base_url(), current.allow_insecure_http());
        if expected.is_err() || expected != actual {
            return Err(ProviderServiceError::operation(
                "PROVIDER_PROFILE_CHANGED",
                "供应商档案在模型目录请求期间已更改，请重试",
            ));
        }
        profiles.update_catalog(&target.id, models).map_err(|()| {
            ProviderServiceError::operation("PROVIDER_PROFILE_DELETED", "供应商档案已被删除")
        })?;
        let summary = profiles
            .summary(&target.id, |reference, legacy| {
                self.secret_state(reference, legacy)
            })
            .map_err(|error| ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error))?;
        self.write_profiles(&profiles).map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILE_WRITE_FAILED", error)
        })?;
        Ok(summary)
    }

    pub(crate) fn activate(&self, id: &str) -> Result<(), ProviderServiceError> {
        let _transaction = provider_transaction();
        self.migrate_legacy_secrets()
            .map_err(|error| ProviderServiceError::storage("SECRET_MIGRATION_FAILED", error))?;
        let mut profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let profile = profiles.profile(id).cloned().ok_or_else(|| {
            ProviderServiceError::operation("PROVIDER_PROFILE_NOT_FOUND", "供应商档案不存在")
        })?;
        self.require_secret(&provider_profile_secret_ref(profile.id()))
            .map_err(|error| ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error))?;
        let model_ids = profile.compatible_backend_model_ids();
        let primary_model = model_ids.first().ok_or_else(|| {
            ProviderServiceError::operation(
                "PROVIDER_MODEL_REQUIRED",
                "供应商没有可用模型；请先获取模型目录并选择一个模型",
            )
        })?;
        let backend = profile
            .api_backend()
            .config_value(profile.name(), profile.base_url());
        // 仅校验服务地址；供应商本身写在 config.toml 的 `[model.*]` 段里。
        compatible_provider_metadata(
            profile.base_url(),
            profile.allow_insecure_http(),
            Some(profile.id()),
            self.host.normalize_endpoint,
        )
        .map_err(|error| ProviderServiceError::operation("PROVIDER_URL_INVALID", error))?;
        let path = self.env_path();
        let current = (self.host.read_text)(&path).map_err(|error| {
            ProviderServiceError::storage("PROVIDER_METADATA_READ_FAILED", error)
        })?;
        let transition = (|| {
            (self.host.restore_auth_overrides)(&self.home)?;
            (self.host.apply_backend_overrides)(
                &self.home,
                &model_ids,
                profile.base_url(),
                primary_model,
                backend,
            )?;
            // 迁移：旧版本在 `.env` 里也记了一份供应商，清空它。
            (self.host.atomic_write_private)(&path, &replace_managed_env_block(&current, ""))?;
            profiles.set_active_id(Some(profile.id()));
            profiles.set_account_mode("compatible")?;
            self.write_profiles(&profiles)
        })();
        if let Err(error) = transition {
            let rollback = (self.host.atomic_write_private)(&path, &current)
                .and_then(|_| self.synchronize_active_backend_raw());
            return Err(ProviderServiceError::storage(
                "PROVIDER_ACTIVATION_FAILED",
                match rollback {
                    Ok(()) => error,
                    Err(rollback) => format!("{error}；旧供应商回滚也失败：{rollback}"),
                },
            ));
        }
        Ok(())
    }

    pub(crate) fn delete(&self, id: &str) -> Result<(), ProviderServiceError> {
        let _transaction = provider_transaction();
        self.migrate_legacy_secrets()
            .map_err(|error| ProviderServiceError::storage("SECRET_MIGRATION_FAILED", error))?;
        let mut profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let profile = profiles.profile(id).cloned().ok_or_else(|| {
            ProviderServiceError::operation("PROVIDER_PROFILE_NOT_FOUND", "供应商档案不存在")
        })?;
        let was_active = self
            .active_profile(&profiles)
            .map_err(|error| {
                ProviderServiceError::storage("PROVIDER_METADATA_READ_FAILED", error)
            })?
            .is_some_and(|active| active.id() == id);
        let active_environment = if was_active {
            let path = self.env_path();
            let current = (self.host.read_text)(&path).map_err(|error| {
                ProviderServiceError::storage("PROVIDER_METADATA_READ_FAILED", error)
            })?;
            Some((path, current))
        } else {
            None
        };
        let reference = provider_profile_secret_ref(profile.id());
        let previous_secret = self
            .secrets
            .get(&reference)
            .map_err(|error| ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error))?;
        self.secrets
            .delete(&reference)
            .map_err(|error| ProviderServiceError::storage("SECRET_STORE_DELETE_FAILED", error))?;
        profiles.remove_profile(id);
        let result = (|| {
            if let Some((path, current)) = active_environment.as_ref() {
                (self.host.restore_auth_overrides)(&self.home)?;
                (self.host.restore_backend_overrides)(&self.home)?;
                (self.host.atomic_write_private)(path, &replace_managed_env_block(current, ""))?;
            }
            self.write_profiles(&profiles)
        })();
        if let Err(error) = result {
            let mut failure = error;
            if let Some((path, current)) = active_environment.as_ref() {
                if let Err(rollback) = (self.host.atomic_write_private)(path, current)
                    .and_then(|_| self.synchronize_active_backend_raw())
                {
                    failure = format!("{failure}；活动供应商回滚也失败：{rollback}");
                }
            }
            if let Err(rollback) = self.restore_secret(
                &reference,
                previous_secret.as_ref().map(StoredSecret::expose),
            ) {
                return Err(ProviderServiceError::storage(
                    "PROVIDER_PROFILE_ROLLBACK_FAILED",
                    format!("{failure}；密钥回滚也失败：{rollback}"),
                ));
            }
            return Err(ProviderServiceError::storage(
                "PROVIDER_PROFILE_DELETE_FAILED",
                failure,
            ));
        }
        Ok(())
    }

    pub(crate) fn status(&self) -> Result<ProviderStatusSnapshot, ProviderServiceError> {
        let profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let active = self.active_profile(&profiles).map_err(|error| {
            ProviderServiceError::storage("PROVIDER_METADATA_READ_FAILED", error)
        })?;
        let kind = if active.is_some() {
            "compatible"
        } else {
            profiles.account_mode().map_err(|error| {
                ProviderServiceError::storage("PROVIDER_METADATA_READ_FAILED", error)
            })?
        };
        let base_url = active.as_ref().map(|profile| profile.base_url().to_string());
        let reference = match kind {
            "official" => Some(SECRET_REF_OFFICIAL_PROVIDER.to_string()),
            "compatible" => active
                .as_ref()
                .map(|profile| provider_profile_secret_ref(profile.id())),
            _ => None,
        };
        let secret_backend = match reference {
            Some(reference) => self.secrets.backend(&reference).map_err(|error| {
                ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error)
            })?,
            None => SecretBackendKind::Missing,
        };
        Ok(ProviderStatusSnapshot {
            kind: match kind {
                "official" => "official",
                "compatible" => "compatible",
                _ => "oauth",
            },
            has_api_key: secret_backend != SecretBackendKind::Missing,
            base_url,
            secret_backend,
        })
    }

    pub(crate) fn configure(
        &self,
        request: ConfigureProviderInput,
    ) -> Result<(), ProviderServiceError> {
        let _transaction = provider_transaction();
        self.migrate_legacy_secrets()
            .map_err(|error| ProviderServiceError::storage("SECRET_MIGRATION_FAILED", error))?;
        let mut profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let path = self.env_path();
        let current = (self.host.read_text)(&path).map_err(|error| {
            ProviderServiceError::storage("PROVIDER_METADATA_READ_FAILED", error)
        })?;
        let requested_key = request
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut secret_change = None;
        // 只做凭据校验；供应商本身写在 config.toml 里。
        match request.kind.as_str() {
            "oauth" => {}
            "official" => {
                if let Some(key) = requested_key {
                    checked_api_key(key).map_err(|error| {
                        ProviderServiceError::operation("PROVIDER_API_KEY_INVALID", error)
                    })?;
                    secret_change = Some((SECRET_REF_OFFICIAL_PROVIDER, key));
                } else {
                    self.require_secret(SECRET_REF_OFFICIAL_PROVIDER)
                        .map_err(|error| {
                            ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error)
                        })?;
                }
            }
            "compatible" => {
                let base_url = request.base_url.as_deref().unwrap_or_default();
                if let Some(key) = requested_key {
                    checked_api_key(key).map_err(|error| {
                        ProviderServiceError::operation("PROVIDER_API_KEY_INVALID", error)
                    })?;
                    secret_change = Some((SECRET_REF_DIRECT_COMPATIBLE, key));
                } else {
                    self.require_secret(SECRET_REF_DIRECT_COMPATIBLE)
                        .map_err(|error| {
                            ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error)
                        })?;
                }
                compatible_provider_metadata(base_url, false, None, self.host.normalize_endpoint)
                    .map_err(|error| {
                        ProviderServiceError::operation("PROVIDER_URL_INVALID", error)
                    })?;
            }
            _ => {
                return Err(ProviderServiceError::operation(
                    "PROVIDER_KIND_INVALID",
                    "未知账户接入类型",
                ))
            }
        };
        let previous_secret = if let Some((reference, key)) = secret_change {
            let previous = self.secrets.get(reference).map_err(|error| {
                ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error)
            })?;
            self.secrets.set(reference, key).map_err(|error| {
                ProviderServiceError::storage("SECRET_STORE_WRITE_FAILED", error)
            })?;
            Some((reference, previous))
        } else {
            None
        };
        let result = (|| {
            (self.host.restore_auth_overrides)(&self.home)?;
            (self.host.restore_backend_overrides)(&self.home)?;
            // `.env` 托管块是旧版本的第二套供应商真相源。这里顺手清空它，
            // 迁移完成后只保留 Grox 自有档案和 CLI 的实际路由。
            (self.host.atomic_write_private)(&path, &replace_managed_env_block(&current, ""))?;
            profiles.set_active_id(None);
            profiles.set_account_mode(&request.kind)?;
            self.write_profiles(&profiles)
        })();
        if let Err(error) = result {
            let mut failure = error;
            if let Err(rollback) = (self.host.atomic_write_private)(&path, &current)
                .and_then(|_| self.synchronize_active_backend_raw())
            {
                failure = format!("{failure}；旧供应商回滚也失败：{rollback}");
            }
            if let Some((reference, previous)) = previous_secret {
                if let Err(rollback) =
                    self.restore_secret(reference, previous.as_ref().map(StoredSecret::expose))
                {
                    return Err(ProviderServiceError::storage(
                        "PROVIDER_CONFIG_ROLLBACK_FAILED",
                        format!("{failure}；密钥回滚也失败：{rollback}"),
                    ));
                }
            }
            return Err(ProviderServiceError::storage(
                "PROVIDER_CONFIG_WRITE_FAILED",
                failure,
            ));
        }
        Ok(())
    }

    pub(crate) fn runtime_environment(
        &self,
    ) -> Result<RuntimeProviderEnvironment, ProviderServiceError> {
        let _transaction = provider_transaction();
        self.migrate_legacy_secrets()
            .map_err(|error| ProviderServiceError::storage("SECRET_MIGRATION_FAILED", error))?;
        let profiles = self.read_profiles().map_err(|error| {
            ProviderServiceError::storage("PROVIDER_PROFILES_READ_FAILED", error)
        })?;
        let active = self.active_profile(&profiles).map_err(|error| {
            ProviderServiceError::protocol(
                "PROVIDER_PROFILE_REFERENCE_INVALID",
                error,
                "重新选择供应商档案，或切回官方账户后重试",
            )
        })?;
        let kind = if active.is_some() {
            "compatible"
        } else {
            profiles.account_mode().map_err(|error| {
                ProviderServiceError::storage("PROVIDER_METADATA_READ_FAILED", error)
            })?
        };
        let reference = match kind {
            "oauth" => None,
            "official" => Some(SECRET_REF_OFFICIAL_PROVIDER.to_string()),
            "compatible" => active
                .as_ref()
                .map(|profile| provider_profile_secret_ref(profile.id())),
            _ => {
                return Err(ProviderServiceError::protocol(
                    "PROVIDER_METADATA_INVALID",
                    format!("未知的 Host 供应商模式：{kind}"),
                    "重新选择供应商后重试",
                ))
            }
        };
        let api_key = reference
            .map(|reference| {
                self.require_secret(&reference)
                    .map(|secret| secret.expose().to_string())
            })
            .transpose()
            .map_err(|error| ProviderServiceError::storage("SECRET_STORE_READ_FAILED", error))?;
        Ok(RuntimeProviderEnvironment {
            api_key,
            compatible: kind == "compatible",
        })
    }

    pub(crate) fn restore_legacy_auth_overrides(&self) -> Result<(), String> {
        (self.host.restore_auth_overrides)(&self.home)
    }

    pub(crate) fn migrate_legacy_config_metadata(&self) -> Result<(), String> {
        let _transaction = provider_transaction();
        let mut profiles = self.read_profiles()?;
        let mut changed = false;
        if let Some(id) = (self.host.legacy_active_profile_id)(&self.home)? {
            if profiles.profile(&id).is_none() {
                return Err(format!("旧配置引用的供应商档案 {id} 不存在"));
            }
            profiles.set_active_id(Some(&id));
            changed = true;
        }
        if let Some(mode) = (self.host.legacy_account_mode)(&self.home)? {
            profiles.set_account_mode(&mode)?;
            changed = true;
        }
        if changed {
            self.write_profiles(&profiles)?;
        }
        (self.host.clear_legacy_metadata)(&self.home)
    }

    pub(crate) fn synchronize_active_backend(&self) -> Result<(), String> {
        self.synchronize_active_backend_raw()
    }

    fn synchronize_active_backend_raw(&self) -> Result<(), String> {
        let mut profiles = self.read_profiles()?;
        let profile = if (self.host.compatible_route_active)(&self.home)? {
            self.active_profile(&profiles)?
        } else {
            let managed = parse_managed_provider_env(&self.env_path(), self.host.read_text);
            let profile = profiles
                .profile_for_managed_values(&managed, self.host.normalize_endpoint)
                .cloned();
            if let Some(profile) = profile.as_ref() {
                profiles.set_active_id(Some(profile.id()));
                self.write_profiles(&profiles)?;
            }
            profile
        };
        if let Some(profile) = profile {
            let model_ids = profile.compatible_backend_model_ids();
            let primary_model = model_ids
                .first()
                .ok_or("当前供应商没有可用模型，无法配置请求协议")?;
            let backend = profile
                .api_backend()
                .config_value(profile.name(), profile.base_url());
            (self.host.apply_backend_overrides)(
                &self.home,
                &model_ids,
                profile.base_url(),
                primary_model,
                backend,
            )
        } else {
            (self.host.restore_backend_overrides)(&self.home)
        }
    }

    fn profiles_path(&self) -> PathBuf {
        self.home.join("grox-providers.json")
    }

    fn env_path(&self) -> PathBuf {
        self.home.join(".env")
    }

    fn read_profiles(&self) -> Result<ProviderProfilesFile, String> {
        let path = self.profiles_path();
        let managed = parse_managed_provider_env(&self.env_path(), self.host.read_text);
        ProviderProfilesFile::read_with_recovery(
            &path,
            &managed,
            self.host.read_text,
            self.host.atomic_create_private,
            self.host.normalize_endpoint,
        )
    }

    fn write_profiles(&self, profiles: &ProviderProfilesFile) -> Result<(), String> {
        let content = profiles
            .to_pretty_json()
            .map_err(|error| format!("无法序列化供应商目录：{error}"))?;
        (self.host.atomic_write_private)(&self.profiles_path(), &content)
    }

    /// 当前路由对应的 Grox 供应商档案。
    fn active_profile(
        &self,
        profiles: &ProviderProfilesFile,
    ) -> Result<Option<crate::provider_profiles::StoredProviderProfile>, String> {
        if !(self.host.compatible_route_active)(&self.home)? {
            return Ok(None);
        }
        let id = profiles
            .active_id()
            .ok_or("当前中转路由没有登记所属供应商档案")?;
        profiles
            .profile(id)
            .cloned()
            .map(Some)
            .ok_or_else(|| format!("活动供应商档案 {id} 不存在"))
    }

    fn secret_state(
        &self,
        reference: &str,
        legacy_value: Option<&str>,
    ) -> Result<(SecretBackendKind, bool), String> {
        let backend = if legacy_value.is_some_and(|value| !value.trim().is_empty()) {
            SecretBackendKind::LegacyFile
        } else {
            self.secrets.backend(reference)?
        };
        Ok((backend, backend != SecretBackendKind::Missing))
    }

    fn require_secret(&self, reference: &str) -> Result<StoredSecret, String> {
        let secret = self
            .secrets
            .get(reference)?
            .ok_or_else(|| "API Key 为空或已从系统凭据库删除".to_string())?;
        debug_assert_ne!(secret.backend(), SecretBackendKind::Missing);
        Ok(secret)
    }

    fn restore_secret(&self, reference: &str, previous: Option<&str>) -> Result<(), String> {
        match previous {
            Some(value) => self.secrets.set(reference, value).map(|_| ()),
            None => self.secrets.delete(reference),
        }
    }

    /// Legacy plaintext is copied into SecretStore before its old copy is
    /// removed. A later metadata failure therefore never loses the credential.
    fn migrate_legacy_secrets(&self) -> Result<(), String> {
        let mut profiles = self.read_profiles()?;
        let legacy_secrets = profiles.take_legacy_secrets();
        for (id, key) in &legacy_secrets {
            checked_api_key(key)?;
            self.secrets.set(&provider_profile_secret_ref(id), key)?;
        }
        if !legacy_secrets.is_empty() {
            self.write_profiles(&profiles)?;
        }

        let env_path = self.env_path();
        let current = (self.host.read_text)(&env_path)?;
        let values = parse_managed_provider_env(&env_path, self.host.read_text);
        let Some(key) = values
            .get("XAI_API_KEY")
            .map(String::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
        else {
            return Ok(());
        };
        checked_api_key(key)?;
        let base_url = values
            .get(GROK_MODELS_BASE_URL_KEY)
            .filter(|value| !value.trim().is_empty());
        let (reference, kind, profile_id) = if let Some(base_url) = base_url {
            let active =
                profiles.legacy_active_profile_for_endpoint(base_url, self.host.normalize_endpoint);
            (
                active
                    .map(|profile| provider_profile_secret_ref(profile.id()))
                    .unwrap_or_else(|| SECRET_REF_DIRECT_COMPATIBLE.to_string()),
                "compatible",
                active.map(|profile| profile.id()),
            )
        } else {
            (SECRET_REF_OFFICIAL_PROVIDER.to_string(), "official", None)
        };
        self.secrets.set(&reference, key)?;
        // 密钥已进入系统凭据库；托管块的其余字段由 config.toml 承担，
        // 迁移到此为止，不再重建 `.env`。
        let _ = (kind, profile_id);
        (self.host.atomic_write_private)(&env_path, &replace_managed_env_block(&current, ""))
    }
}

fn provider_transaction() -> std::sync::MutexGuard<'static, ()> {
    PROVIDER_TRANSACTION
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn new_profile_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("provider-{}-{nanos}", std::process::id())
}

fn valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

pub(crate) fn replace_managed_env_block(content: &str, replacement: &str) -> String {
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

pub(crate) fn parse_managed_provider_env(
    path: &Path,
    read_text: fn(&Path) -> Result<String, String>,
) -> BTreeMap<String, String> {
    let Ok(content) = read_text(path) else {
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

fn env_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn compatible_provider_metadata(
    base_url: &str,
    allow_insecure_http: bool,
    profile_id: Option<&str>,
    normalize_endpoint: fn(&str, bool) -> Result<String, String>,
) -> Result<String, String> {
    let base = normalize_endpoint(base_url.trim(), allow_insecure_http)?;
    let mut lines = vec![
        format!("{GROX_PROVIDER_KIND_KEY}={}", env_value("compatible")),
        format!("{GROK_MODELS_BASE_URL_KEY}={}", env_value(&base)),
        format!(
            "GROK_MODELS_LIST_URL={}",
            env_value(&compatible_models_url(
                &base,
                allow_insecure_http,
                normalize_endpoint,
            )?)
        ),
    ];
    if let Some(profile_id) = profile_id {
        lines.push(format!(
            "{GROX_PROVIDER_PROFILE_ID_KEY}={}",
            env_value(profile_id)
        ));
    }
    Ok(lines.join("\n"))
}

pub(crate) fn compatible_models_url(
    base_url: &str,
    allow_insecure_http: bool,
    normalize_endpoint: fn(&str, bool) -> Result<String, String>,
) -> Result<String, String> {
    let base = normalize_endpoint(base_url, allow_insecure_http)?;
    let mut parsed = url::Url::parse(&base).map_err(|error| format!("无效服务地址：{error}"))?;
    let path = parsed.path().trim_end_matches('/');
    if !path.ends_with("/models") {
        parsed.set_path(&format!("{path}/models"));
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string().trim_end_matches('/').to_owned())
}

pub(crate) fn is_loopback_host(host: Option<&str>) -> bool {
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

pub(crate) fn is_blocked_service_host(host: Option<&str>) -> bool {
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
                (octets[0] == 169 && octets[1] == 254) || octets == [100, 100, 100, 200]
            })
        }
    }
}

pub(crate) fn checked_service_url_with_policy(
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
    let allowed_http =
        parsed.scheme() == "http" && (is_loopback_host(parsed.host_str()) || allow_insecure_http);
    if !secure && !allowed_http {
        return Err(format!(
            "{label}必须使用 HTTPS；远程 HTTP 需要显式启用不安全连接"
        ));
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
pub(crate) fn checked_service_url(value: &str, label: &str) -> Result<String, String> {
    checked_service_url_with_policy(value, label, false)
}

pub(crate) fn normalize_provider_endpoint(
    value: &str,
    allow_insecure_http: bool,
) -> Result<String, String> {
    checked_service_url_with_policy(value, "服务地址", allow_insecure_http)
}

pub(crate) fn checked_api_key(value: &str) -> Result<&str, String> {
    if value.chars().any(char::is_control) {
        return Err("API Key 不能包含换行符或控制字符".into());
    }
    if value.len() > 16 * 1024 {
        return Err("API Key 过长".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> Result<String, String> {
        if !path.exists() {
            return Ok(String::new());
        }
        std::fs::read_to_string(path).map_err(|error| error.to_string())
    }

    fn write(path: &Path, content: &str) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(path, content).map_err(|error| error.to_string())
    }

    fn create(path: &Path, content: &str) -> Result<bool, String> {
        use std::io::Write as _;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => file
                .write_all(content.as_bytes())
                .map(|()| true)
                .map_err(|error| error.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    fn noop_restore(_: &Path) -> Result<(), String> {
        Ok(())
    }

    fn noop_apply(
        _: &Path,
        _: &[String],
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    fn inactive_route(_: &Path) -> Result<bool, String> {
        Ok(false)
    }

    fn no_legacy_value(_: &Path) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn test_service(root: &Path) -> ProviderService {
        ProviderService::new(
            root.to_path_buf(),
            ProviderServiceHostOps {
                read_text: read,
                atomic_write_private: write,
                atomic_create_private: create,
                normalize_endpoint: normalize_provider_endpoint,
                restore_auth_overrides: noop_restore,
                restore_backend_overrides: noop_restore,
                apply_backend_overrides: noop_apply,
                compatible_route_active: inactive_route,
                legacy_active_profile_id: no_legacy_value,
                legacy_account_mode: no_legacy_value,
                clear_legacy_metadata: noop_restore,
            },
        )
    }

    fn test_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "grox-provider-service-{label}-{}-{}",
            std::process::id(),
            new_profile_id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_profile(root: &Path, base_url: &str) {
        let mut profiles = ProviderProfilesFile::default();
        profiles.upsert_profile(
            ProviderProfileUpdate::new(
                "provider-test".into(),
                "Test".into(),
                base_url.into(),
                ProviderApiBackend::Auto,
            ),
            false,
            normalize_provider_endpoint,
        );
        write(
            &root.join("grox-providers.json"),
            &profiles.to_pretty_json().unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn managed_metadata_contains_no_secret() {
        let env = compatible_provider_metadata(
            "https://gateway.example.com/v1",
            false,
            Some("provider-test"),
            normalize_provider_endpoint,
        )
        .unwrap();
        assert!(env.contains("GROX_PROVIDER_PROFILE_ID=\"provider-test\""));
        assert!(env.contains("GROK_MODELS_LIST_URL=\"https://gateway.example.com/v1/models\""));
        assert!(!env.contains("XAI_API_KEY"));
    }

    #[test]
    fn managed_environment_ignores_unmarked_values() {
        let root = std::env::temp_dir().join(format!(
            "grox-provider-service-env-{}-{}",
            std::process::id(),
            new_profile_id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(".env");
        std::fs::write(
            &path,
            "XAI_API_KEY=outside\n# >>> Grox managed provider\nGROX_PROVIDER_KIND=\"official\"\n# <<< Grox managed provider\n",
        )
        .unwrap();
        let values = parse_managed_provider_env(&path, read);
        assert_eq!(
            values.get(GROX_PROVIDER_KIND_KEY).map(String::as_str),
            Some("official")
        );
        assert!(!values.contains_key("XAI_API_KEY"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_urls_keep_ssrf_and_cleartext_policy() {
        assert!(checked_service_url("https://api.example.com/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://localhost:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://api.example.com/v1", "服务地址").is_err());
        assert!(
            checked_service_url_with_policy("http://api.example.com/v1", "服务地址", true,).is_ok()
        );
        assert!(
            checked_service_url_with_policy("http://169.254.169.254/latest", "服务地址", true,)
                .is_err()
        );
        assert!(
            checked_service_url("https://[::ffff:169.254.169.254]/latest", "服务地址").is_err()
        );
        assert!(checked_service_url("https://metadata.google.internal/", "服务地址").is_err());
        assert!(checked_service_url("https://192.168.1.20/v1", "服务地址").is_ok());
        assert!(checked_api_key("secret\nINJECTED=1").is_err());
    }

    #[test]
    fn refresh_commit_fails_closed_after_concurrent_edit_or_delete() {
        let root = test_root("refresh-race");
        write_profile(&root, "https://gateway.example/v1");
        let service = test_service(&root);
        let target = ProviderRefreshTarget {
            id: "provider-test".into(),
            base_url: "https://gateway.example/v1".into(),
            allow_insecure_http: false,
            api_key: "not-serialized".into(),
        };

        write_profile(&root, "https://other.example/v1");
        let error = service
            .commit_refresh(target, vec!["grok-build".into()])
            .err()
            .unwrap();
        assert_eq!(error.code, "PROVIDER_PROFILE_CHANGED");

        write(&root.join("grox-providers.json"), "{\"profiles\":[]}").unwrap();
        let deleted = ProviderRefreshTarget {
            id: "provider-test".into(),
            base_url: "https://gateway.example/v1".into(),
            allow_insecure_http: false,
            api_key: "not-serialized".into(),
        };
        let error = service
            .commit_refresh(deleted, vec!["grok-build".into()])
            .err()
            .unwrap();
        assert_eq!(error.code, "PROVIDER_PROFILE_DELETED");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refresh_commit_persists_catalog_without_secret() {
        let root = test_root("refresh-commit");
        write_profile(&root, "https://gateway.example/v1");
        let service = test_service(&root);
        let target = ProviderRefreshTarget {
            id: "provider-test".into(),
            base_url: "https://gateway.example/v1/".into(),
            allow_insecure_http: false,
            api_key: "must-not-persist".into(),
        };
        service
            .commit_refresh(target, vec!["grok-build".into()])
            .unwrap();
        let persisted = std::fs::read_to_string(root.join("grox-providers.json")).unwrap();
        assert!(persisted.contains("grok-build"), "{persisted}");
        assert!(!persisted.contains("must-not-persist"), "{persisted}");
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// 用 provider_overrides 域的 host 操作装配当前 ProviderService。
/// main.rs / runtime_lifecycle / media_service 统一经此获取实例。
pub(crate) fn open_current(home: PathBuf) -> Result<ProviderService, String> {
    Ok(ProviderService::new(
        home,
        ProviderServiceHostOps {
            read_text: crate::provider_overrides::read_provider_service_text,
            atomic_write_private: crate::host_core::atomic_write_private,
            atomic_create_private: crate::host_core::atomic_create_private,
            normalize_endpoint: normalize_provider_endpoint,
            restore_auth_overrides: crate::provider_overrides::restore_grox_provider_auth_overrides,
            restore_backend_overrides: crate::provider_overrides::restore_grox_provider_backend_overrides,
            apply_backend_overrides: crate::provider_overrides::apply_grox_provider_sections,
            compatible_route_active: crate::provider_overrides::active_provider_route_is_relay,
            legacy_active_profile_id: crate::provider_overrides::legacy_active_provider_profile_id,
            legacy_account_mode: crate::provider_overrides::legacy_grox_account_mode,
            clear_legacy_metadata: crate::provider_overrides::clear_legacy_grox_metadata,
        },
    ))
}

/// 让每个 CLI 子进程从干净的 provider 环境启动，再注入当前选中的凭据。
///
/// 路由完全由 config.toml 的 `[model.*]` 段和 `[models] default` 表达；
/// `GROK_MODELS_BASE_URL` 是另一套全局路由机制，两套并存意味着同一件事有
/// 两个真相源、会互相矛盾；这里只保留前者，环境里仅注入凭据。
pub(crate) fn apply_provider_environment(
    command: &mut Command,
    service: &ProviderService,
) -> Result<(), String> {
    for key in [
        "XAI_API_KEY",
        "OPENAI_API_KEY",
        GROK_MODELS_BASE_URL_KEY,
        "GROK_MODELS_LIST_URL",
    ] {
        command.env_remove(key);
    }
    let runtime = service
        .runtime_environment()
        .map_err(|error| error.message)?;
    if let Some(secret) = runtime.api_key {
        command.env(
            if runtime.compatible { "OPENAI_API_KEY" } else { "XAI_API_KEY" },
            secret,
        );
    }
    Ok(())
}
