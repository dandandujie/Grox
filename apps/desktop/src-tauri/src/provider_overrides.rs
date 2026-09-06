//! 供应商 config.toml 覆盖域：auth/backend 覆盖存储、`[model.*]` 段改写、
//! `[grox]` 元数据与默认路由读取。
//!
//! 自 main.rs 下沉（PRODUCT_REVIEW.md P1：消除 provider DI 反向依赖）。
//! 这些操作全部以 `home: &Path` 为边界、经由 host_core 原子写落盘，
//! `provider_service::open_current` 以此组装 `ProviderServiceHostOps`。

use crate::host_core::{
    atomic_create_private, atomic_write_private, read_bounded_text, CONFIG_WRITE_NONCE,
    MAX_CONFIG_BYTES,
};
use crate::provider_profiles::{is_relay_section_id, provider_section_id};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use toml_edit::{value as toml_value, Document, Item, Table, TableLike};

/// Grox changes only the endpoint, credential source, and request protocol
/// for an active compatible provider. Keep the exact prior TOML items so
/// switching back to OAuth or the official API restores user configuration.
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAuthOverridesFile {
    #[serde(default)]
    models: BTreeMap<String, ProviderModelAuthBackup>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderModelAuthBackup {
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
pub(crate) struct ProviderBackendOverridesFile {
    models: BTreeMap<String, ProviderBackendBackup>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderBackendBackup {
    model_existed: bool,
    env_key: Option<String>,
    base_url: Option<String>,
    api_backend: Option<String>,
    model: Option<String>,
}


pub(crate) const GROX_PROVIDER_AUTH_OVERRIDES_FILE: &str = "grox-provider-auth-overrides.json";
pub(crate) const GROX_PROVIDER_BACKEND_OVERRIDES_FILE: &str = "grox-provider-backend-overrides.json";

pub(crate) fn provider_auth_overrides_path(home: &Path) -> PathBuf {
    home.join(GROX_PROVIDER_AUTH_OVERRIDES_FILE)
}

pub(crate) fn read_provider_auth_overrides(home: &Path) -> Result<ProviderAuthOverridesFile, String> {
    let path = provider_auth_overrides_path(home);
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

pub(crate) fn write_provider_auth_overrides(
    home: &Path,
    value: &ProviderAuthOverridesFile,
) -> Result<(), String> {
    let path = provider_auth_overrides_path(home);
    if value.models.is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法移除 Grox 兼容服务认证还原信息：{error}"))?;
        }
        return Ok(());
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化 Grox 兼容服务认证还原信息：{error}"))?;
    atomic_write_private(&path, &content)
}

pub(crate) fn parse_grok_config_document(content: &str) -> Result<Document, String> {
    content.parse::<Document>().map_err(|error| {
        format!(
            "Grok config.toml 格式无效，无法安全切换兼容服务认证：{error}。请先修复该文件后重试。"
        )
    })
}

pub(crate) fn config_value_item(raw: &str) -> Result<Item, String> {
    let document = format!("value = {raw}\n")
        .parse::<Document>()
        .map_err(|error| format!("无法还原原有模型认证配置：{error}"))?;
    document
        .get("value")
        .cloned()
        .ok_or_else(|| "无法还原原有模型认证配置".to_string())
}

pub(crate) fn model_table_mut<'a>(document: &'a mut Document, model_id: &str) -> Result<(&'a mut dyn TableLike, bool), String> {
    let root = document.as_table_mut();
    if !root.contains_key("model") {
        root.insert("model", Item::Table(Table::new()));
    }
    let models = root
        .get_mut("model")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| {
            "Grok config.toml 中的 [model] 不是 TOML 表，无法安全写入兼容服务认证".to_string()
        })?;
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

pub(crate) fn restore_grox_provider_auth_overrides(home: &Path) -> Result<(), String> {
    let overrides = read_provider_auth_overrides(home)?;
    if overrides.models.is_empty() {
        return Ok(());
    }
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
        write_provider_auth_overrides(home, &ProviderAuthOverridesFile::default())?;
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

    atomic_write_private(&path, &document.to_string())?;
    write_provider_auth_overrides(home, &ProviderAuthOverridesFile::default())
}

pub(crate) fn provider_backend_overrides_path(home: &Path) -> PathBuf {
    home.join(GROX_PROVIDER_BACKEND_OVERRIDES_FILE)
}

pub(crate) fn read_provider_backend_overrides(home: &Path) -> Result<ProviderBackendOverridesFile, String> {
    let path = provider_backend_overrides_path(home);
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

pub(crate) fn write_provider_backend_overrides(
    home: &Path,
    value: &ProviderBackendOverridesFile,
) -> Result<(), String> {
    let path = provider_backend_overrides_path(home);
    if value.models.is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法移除 Grox 兼容服务协议还原信息：{error}"))?;
        }
        return Ok(());
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化 Grox 兼容服务协议还原信息：{error}"))?;
    atomic_write_private(&path, &content)
}

pub(crate) fn restore_grox_provider_backend_overrides(home: &Path) -> Result<(), String> {
    // v0.3.3 及更早版本把中转配置写进用户自己的 `[model.<模型名>]`，因此需要
    // 一份备份才能还原。现在 Grox 只写带前缀的自有段，删除即可。这里同时处理
    // 两件事：把遗留备份还原回去（一次性），以及删掉所有自有段。
    let legacy = read_provider_backend_overrides(home)?;
    let path = home.join("config.toml");
    if !path.exists() {
        return write_provider_backend_overrides(home, &ProviderBackendOverridesFile::default());
    }
    let content = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    let mut document = parse_grok_config_document(&content)?;
    let root = document.as_table_mut();
    let Some(models) = root.get_mut("model").and_then(Item::as_table_like_mut) else {
        set_models_default_model(&mut document, None)?;
        document.as_table_mut().remove(GROX_TABLE);
        atomic_write_private(&path, &document.to_string())?;
        return write_provider_backend_overrides(home, &ProviderBackendOverridesFile::default());
    };

    for (model_id, backup) in &legacy.models {
        let Some(model) = models.get_mut(model_id).and_then(Item::as_table_like_mut) else {
            continue;
        };
        for (key, saved) in [
            ("env_key", backup.env_key.as_deref()),
            ("base_url", backup.base_url.as_deref()),
            ("api_backend", backup.api_backend.as_deref()),
            ("model", backup.model.as_deref()),
        ] {
            match saved {
                Some(raw) => {
                    model.insert(key, config_value_item(raw)?);
                }
                None => {
                    model.remove(key);
                }
            }
        }
        model.remove("supports_reasoning_effort");
    }
    // 只有当 Grox 创建过、且用户此后没有往里加设置时才整段删除。
    for model_id in legacy
        .models
        .iter()
        .filter_map(|(id, backup)| (!backup.model_existed).then_some(id.clone()))
        .collect::<Vec<_>>()
    {
        let empty = models
            .get(&model_id)
            .and_then(Item::as_table_like)
            .is_some_and(|model| model.is_empty());
        if empty {
            models.remove(&model_id);
        }
    }

    // Grox 自有段无需备份：整段都是我们写的。
    for section_id in models
        .iter()
        .map(|(id, _)| id.to_string())
        .filter(|id| is_relay_section_id(id))
        .collect::<Vec<_>>()
    {
        models.remove(&section_id);
    }
    if models.is_empty() {
        root.remove("model");
    }
    // Grox owns `[models] default` only while a compatible profile is active.
    // Leaving it behind would keep pointing the CLI at a section we just
    // removed, so official sessions would start on a dangling model id.
    set_models_default_model(&mut document, None)?;
    document.as_table_mut().remove("grox");
    atomic_write_private(&path, &document.to_string())?;
    write_provider_backend_overrides(home, &ProviderBackendOverridesFile::default())
}

/// 写入 Grox 自有的 `[model.*]` 段并把 `[models] default` 指过去。
///
/// 不把应用元数据塞进 config.toml：官方 CLI 会为未知字段报警。
pub(crate) fn apply_grox_provider_sections(
    home: &Path,
    model_ids: &[String],
    base_url: &str,
    primary_model: &str,
    api_backend: &str,
) -> Result<(), String> {
    // Switches are transactional at the config level: first restore the
    // previous profile's exact values, then add Chat Completions only for the
    // selected models advertised by the new profile.
    restore_grox_provider_backend_overrides(home)?;
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

    let path = home.join("config.toml");
    let content = if path.exists() {
        read_bounded_text(&path, MAX_CONFIG_BYTES)?
    } else {
        String::new()
    };
    let mut document = parse_grok_config_document(&content)?;
    for model_id in ids {
        // 段名是 Grox 自有命名空间，上游真名写在段内。第三方反代暴露
        // grok-4.5 时段名是 grox-relay-grok-4.5，官方段不受影响。
        let section_id = provider_section_id(&model_id);
        let (model, _existed) = model_table_mut(&mut document, &section_id)?;
        // A named env key is the documented credential selector; the actual
        // secret remains solely in the ACP child's managed environment.
        // Do not expose a relay key as XAI_API_KEY. Grok Build's official
        // helper models would otherwise send it to api.x.ai for titles/search.
        model.insert("env_key", toml_value("OPENAI_API_KEY"));
        model.insert("base_url", toml_value(base_url));
        model.insert("api_backend", toml_value(api_backend));
        // 上游请求体里的模型名，与段名无关。
        model.insert("model", toml_value(&model_id));
        // CLI 把段名当作 modelId 报告给界面；给它一个可读的显示名，否则模型
        // 选择器里出现的是带前缀的内部段名。
        model.insert("name", toml_value(&model_id));
        // Grok Build gates forwarding `--reasoning-effort` on this flag. Without
        // it a reasoning-capable gateway is asked for no reasoning at all, and
        // the session shows an answer with no thinking content.
        model.insert("supports_reasoning_effort", toml_value(true));
    }
    // Route explicitly instead of relying on whichever id the CLI defaults to.
    // This is the documented switch (`[models] default`) and keeps the active
    // provider readable from config.toml alone.
    set_models_default_model(&mut document, Some(&provider_section_id(primary_model)))?;
    atomic_write_private(&path, &document.to_string())
}

pub(crate) const GROX_TABLE: &str = "grox";
pub(crate) const GROX_ACCOUNT_MODE_KEY: &str = "account_mode";
pub(crate) const GROX_ACTIVE_PROVIDER_KEY: &str = "active_provider_id";

pub(crate) fn legacy_grox_account_mode(home: &Path) -> Result<Option<String>, String> {
    let path = home.join("config.toml");
    if !path.exists() {
        return Ok(None);
    }
    let document = parse_grok_config_document(&read_bounded_text(&path, MAX_CONFIG_BYTES)?)?;
    Ok(document
        .as_table()
        .get(GROX_TABLE)
        .and_then(Item::as_table_like)
        .and_then(|grox| grox.get(GROX_ACCOUNT_MODE_KEY))
        .and_then(|item| item.as_str())
        .map(str::to_owned))
}

/// `[models] default` 是否指向 Grox 自有的中转段。
pub(crate) fn active_provider_route_is_relay(home: &Path) -> Result<bool, String> {
    let path = home.join("config.toml");
    if !path.exists() {
        return Ok(false);
    }
    let document = parse_grok_config_document(&read_bounded_text(&path, MAX_CONFIG_BYTES)?)?;
    Ok(document
        .as_table()
        .get("models")
        .and_then(Item::as_table_like)
        .and_then(|models| models.get("default"))
        .and_then(|item| item.as_str())
        .is_some_and(is_relay_section_id))
}

/// 从 config.toml 读出当前激活的供应商档案 id。
///
/// `[models] default` 指向中转段时，`[grox] active_provider_id` 说明它属于
/// 哪个档案。返回 `None` 表示当前不是 Grox 中转路由（官方或未配置）。
pub(crate) fn legacy_active_provider_profile_id(home: &Path) -> Result<Option<String>, String> {
    let path = home.join("config.toml");
    if !path.exists() {
        return Ok(None);
    }
    let document = parse_grok_config_document(&read_bounded_text(&path, MAX_CONFIG_BYTES)?)?;
    let root = document.as_table();
    let Some(default_id) = root
        .get("models")
        .and_then(Item::as_table_like)
        .and_then(|models| models.get("default"))
        .and_then(|item| item.as_str())
    else {
        return Ok(None);
    };
    if !is_relay_section_id(default_id) {
        return Ok(None);
    }
    Ok(root
        .get(GROX_TABLE)
        .and_then(Item::as_table_like)
        .and_then(|grox| grox.get(GROX_ACTIVE_PROVIDER_KEY))
        .and_then(|item| item.as_str())
        .map(str::to_string))
}

/// 把界面上选中的上游模型名解析成 `session/set_model` 实际要用的段 id。
///
/// 只有当前默认路由仍指向 Grox 中转时才翻译。单看命名空间段是否存在不够：
/// 用户手动切回官方后，残留段不能继续劫持 `session/set_model`。
pub(crate) fn resolve_agent_model_id(home: &Path, model_id: &str) -> Result<String, String> {
    let section_id = provider_section_id(model_id);
    if section_id == model_id {
        return Ok(section_id);
    }
    let path = home.join("config.toml");
    if !path.exists() {
        return Ok(model_id.to_string());
    }
    let document = parse_grok_config_document(&read_bounded_text(&path, MAX_CONFIG_BYTES)?)?;
    let root = document.as_table();
    let relay_active = root
        .get("models")
        .and_then(Item::as_table_like)
        .and_then(|models| models.get("default"))
        .and_then(|item| item.as_str())
        .is_some_and(is_relay_section_id)
        && root
        .get("model")
        .and_then(Item::as_table_like)
        .is_some_and(|models| models.contains_key(&section_id));
    Ok(if relay_active {
        section_id
    } else {
        model_id.to_string()
    })
}

/// Set or clear `[models] default`. Grok Build reads this as the model used for
/// new sessions, so it is the one line that decides the active route.
pub(crate) fn set_models_default_model(document: &mut Document, model_id: Option<&str>) -> Result<(), String> {
    let root = document.as_table_mut();
    let Some(model_id) = model_id else {
        if let Some(models) = root.get_mut("models").and_then(Item::as_table_like_mut) {
            let owns_default = models
                .get("default")
                .and_then(|item| item.as_str())
                .is_some_and(is_relay_section_id);
            if owns_default {
                models.remove("default");
            }
            if models.is_empty() {
                root.remove("models");
            }
        }
        return Ok(());
    };
    if !root.contains_key("models") {
        root.insert("models", Item::Table(Table::new()));
    }
    let models = root
        .get_mut("models")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "Grok config.toml 中的 [models] 不是 TOML 表，无法写入默认模型".to_string())?;
    models.insert("default", toml_value(model_id));
    Ok(())
}

pub(crate) fn clear_legacy_grox_metadata(home: &Path) -> Result<(), String> {
    let path = home.join("config.toml");
    if !path.exists() {
        return Ok(());
    }
    let mut document = parse_grok_config_document(&read_bounded_text(&path, MAX_CONFIG_BYTES)?)?;
    if document.as_table_mut().remove(GROX_TABLE).is_some() {
        atomic_write_private(&path, &document.to_string())?;
    }
    Ok(())
}

pub(crate) fn read_provider_service_text(path: &Path) -> Result<String, String> {
    read_bounded_text(path, MAX_CONFIG_BYTES)
}

