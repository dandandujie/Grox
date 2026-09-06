//! Holds Computer/Browser MCP endpoint credentials outside the WebView.
//!
//! Session create/load messages may only reference lease ids; Host outbound channels
//! inject the real Authorization headers before the line reaches the CLI.

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::{
    browser_mcp,
    computer_mcp,
};

const MAX_LEASES_PER_KIND: usize = 32;
const LEASE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone)]
struct LeaseEntry {
    server: Value,
    created: Instant,
}

#[derive(Default)]
pub struct McpLeaseStore {
    computer: Mutex<HashMap<String, LeaseEntry>>,
    browser: Mutex<HashMap<String, LeaseEntry>>,
    sessions: Mutex<HashMap<String, SessionLeaseBinding>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionLeaseBinding {
    pub computer: Option<String>,
    pub browser: Option<String>,
}

fn prune_leases(
    map: &mut HashMap<String, LeaseEntry>,
    reserve_slot: bool,
) -> Vec<String> {
    let now = Instant::now();
    let mut removed = map
        .iter()
        .filter_map(|(lease_id, entry)| {
            (now.duration_since(entry.created) >= LEASE_TTL).then(|| lease_id.clone())
        })
        .collect::<Vec<_>>();
    for lease_id in &removed {
        map.remove(lease_id);
    }
    while reserve_slot && map.len() >= MAX_LEASES_PER_KIND {
        let Some(oldest) = map
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        map.remove(&oldest);
        removed.push(oldest);
    }
    removed
}

impl McpLeaseStore {
    pub fn put_computer(&self, lease_id: String, server: Value) -> Result<(), String> {
        let mut guard = self
            .computer
            .lock()
            .map_err(|_| "Computer Use 租约表锁定失败".to_string())?;
        let removed = prune_leases(&mut guard, true);
        guard.insert(
            lease_id,
            LeaseEntry {
                server,
                created: Instant::now(),
            },
        );
        drop(guard);
        for lease_id in removed {
            self.clear_computer_binding(&lease_id);
            computer_mcp::shutdown_http(&lease_id);
        }
        Ok(())
    }

    pub fn put_browser(&self, lease_id: String, server: Value) -> Result<(), String> {
        let mut guard = self
            .browser
            .lock()
            .map_err(|_| "Browser Use 租约表锁定失败".to_string())?;
        let removed = prune_leases(&mut guard, true);
        guard.insert(
            lease_id,
            LeaseEntry {
                server,
                created: Instant::now(),
            },
        );
        drop(guard);
        for lease_id in removed {
            self.clear_browser_binding(&lease_id);
            browser_mcp::shutdown_http(&lease_id);
        }
        Ok(())
    }

    pub fn get_computer(&self, lease_id: &str) -> Option<Value> {
        let (server, removed) = {
            let mut guard = self.computer.lock().ok()?;
            let removed = prune_leases(&mut guard, false);
            let server = guard.get(lease_id).map(|entry| entry.server.clone());
            (server, removed)
        };
        for lease_id in removed {
            self.clear_computer_binding(&lease_id);
            computer_mcp::shutdown_http(&lease_id);
        }
        server
    }

    pub fn get_browser(&self, lease_id: &str) -> Option<Value> {
        let (server, removed) = {
            let mut guard = self.browser.lock().ok()?;
            let removed = prune_leases(&mut guard, false);
            let server = guard.get(lease_id).map(|entry| entry.server.clone());
            (server, removed)
        };
        for lease_id in removed {
            self.clear_browser_binding(&lease_id);
            browser_mcp::shutdown_http(&lease_id);
        }
        server
    }

    pub fn remove_computer(&self, lease_id: &str) {
        if let Ok(mut guard) = self.computer.lock() {
            guard.remove(lease_id);
        }
        self.clear_computer_binding(lease_id);
    }

    pub fn remove_browser(&self, lease_id: &str) {
        if let Ok(mut guard) = self.browser.lock() {
            guard.remove(lease_id);
        }
        self.clear_browser_binding(lease_id);
    }

    /// 提交一次成功的 session/new|load 资源事务，并返回旧绑定供 Host 停止被替换的 MCP。
    pub fn bind_session(
        &self,
        session_id: String,
        binding: SessionLeaseBinding,
    ) -> SessionLeaseBinding {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if binding.computer.is_none() && binding.browser.is_none() {
            sessions.remove(&session_id).unwrap_or_default()
        } else {
            sessions.insert(session_id, binding).unwrap_or_default()
        }
    }

    pub fn take_session(&self, session_id: &str) -> SessionLeaseBinding {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id)
            .unwrap_or_default()
    }

    pub fn computer_for_session(&self, session_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .and_then(|binding| binding.computer.clone())
    }

    pub fn drain_computer(&self) -> Vec<String> {
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for binding in sessions.values_mut() {
                binding.computer = None;
            }
            sessions.retain(|_, binding| binding.browser.is_some());
        }
        let mut computer = self
            .computer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        computer.drain().map(|(lease_id, _)| lease_id).collect()
    }

    pub fn drain_browser(&self) -> Vec<String> {
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for binding in sessions.values_mut() {
                binding.browser = None;
            }
            sessions.retain(|_, binding| binding.computer.is_some());
        }
        let mut browser = self
            .browser
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        browser.drain().map(|(lease_id, _)| lease_id).collect()
    }

    pub fn drain_all(&self) -> (Vec<String>, Vec<String>) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        let computer = self
            .computer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .map(|(lease_id, _)| lease_id)
            .collect();
        let browser = self
            .browser
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .map(|(lease_id, _)| lease_id)
            .collect();
        (computer, browser)
    }

    fn clear_computer_binding(&self, lease_id: &str) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for binding in sessions.values_mut() {
            if binding.computer.as_deref() == Some(lease_id) {
                binding.computer = None;
            }
        }
        sessions.retain(|_, binding| binding.browser.is_some());
    }

    fn clear_browser_binding(&self, lease_id: &str) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for binding in sessions.values_mut() {
            if binding.browser.as_deref() == Some(lease_id) {
                binding.browser = None;
            }
        }
        sessions.retain(|_, binding| binding.computer.is_some());
    }
}

pub fn computer_server_config(url: &str, token: &str) -> Value {
    json!({
        "type": "http",
        "name": "grox_desktop_computer",
        "url": url,
        "headers": [{
            "name": "Authorization",
            "value": format!("Bearer {token}")
        }]
    })
}

pub fn browser_server_config(url: &str, token: &str) -> Value {
    json!({
        "type": "http",
        "name": "grox_desktop_browser",
        "url": url,
        "headers": [{
            "name": "Authorization",
            "value": format!("Bearer {token}")
        }]
    })
}

/// Rewrite session/new|load so mcpServers come only from native lease storage.
/// Lease ids travel in `_meta.groxComputerLeaseId` / `_meta.groxBrowserLeaseId`.
pub fn inject_mcp_servers(line: &str, store: &McpLeaseStore) -> Result<String, String> {
    let Ok(mut value) = serde_json::from_str::<Value>(line) else {
        return Ok(line.to_string());
    };
    let method = value.get("method").and_then(Value::as_str).unwrap_or_default();
    if method != "session/new" && method != "session/load" {
        return Ok(line.to_string());
    }
    let Some(params) = value.get_mut("params").and_then(Value::as_object_mut) else {
        return Ok(line.to_string());
    };

    let meta = params.get("_meta").cloned().unwrap_or_else(|| json!({}));
    let meta_obj = meta.as_object();
    let computer_lease = meta_obj
        .and_then(|object| object.get("groxComputerLeaseId"))
        .and_then(Value::as_str);
    let browser_lease = meta_obj
        .and_then(|object| object.get("groxBrowserLeaseId"))
        .and_then(Value::as_str);

    let mut servers = Vec::new();
    if let Some(lease_id) = computer_lease {
        if let Some(server) = store.get_computer(lease_id) {
            servers.push(server);
        }
    }
    if let Some(lease_id) = browser_lease {
        if let Some(server) = store.get_browser(lease_id) {
            servers.push(server);
        }
    }
    // Never trust mcpServers (or Authorization headers) supplied by the WebView.
    params.insert("mcpServers".into(), Value::Array(servers));

    if let Some(meta_value) = params.get_mut("_meta").and_then(Value::as_object_mut) {
        meta_value.remove("groxComputerLeaseId");
        meta_value.remove("groxBrowserLeaseId");
    }

    serde_json::to_string(&value).map_err(|error| format!("无法序列化 ACP 消息：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_servers_from_lease_ids_and_strips_webview_payload() {
        let store = McpLeaseStore::default();
        store
            .put_computer(
                "abc".into(),
                computer_server_config("http://127.0.0.1:9/mcp", "secret-token"),
            )
            .unwrap();
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[{"name":"evil","headers":[{"name":"Authorization","value":"Bearer leaked"}]}],"_meta":{"groxComputerLeaseId":"abc"}}}"#;
        let rewritten = inject_mcp_servers(line, &store).unwrap();
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        let servers = value["params"]["mcpServers"].as_array().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "grox_desktop_computer");
        assert_eq!(
            servers[0]["headers"][0]["value"],
            "Bearer secret-token"
        );
        assert!(value["params"]["_meta"].get("groxComputerLeaseId").is_none());
    }

    #[test]
    fn ignores_non_session_methods() {
        let store = McpLeaseStore::default();
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{}}"#;
        assert_eq!(inject_mcp_servers(line, &store).unwrap(), line);
    }

    #[test]
    fn session_bindings_replace_atomically_and_drain_by_kind() {
        let store = McpLeaseStore::default();
        store
            .put_computer(
                "computer-a".into(),
                computer_server_config("http://127.0.0.1:9/mcp", "tok"),
            )
            .unwrap();
        store
            .put_browser(
                "browser-a".into(),
                browser_server_config("http://127.0.0.1:9/mcp", "tok"),
            )
            .unwrap();
        assert_eq!(
            store.bind_session(
                "session-1".into(),
                SessionLeaseBinding {
                    computer: Some("computer-a".into()),
                    browser: Some("browser-a".into()),
                },
            ),
            SessionLeaseBinding::default()
        );
        assert_eq!(
            store.computer_for_session("session-1").as_deref(),
            Some("computer-a")
        );
        assert_eq!(store.drain_browser(), ["browser-a"]);
        assert!(store.get_browser("browser-a").is_none());
        assert_eq!(
            store.take_session("session-1"),
            SessionLeaseBinding {
                computer: Some("computer-a".into()),
                browser: None,
            }
        );
    }

    #[test]
    fn lease_store_enforces_capacity_by_evicting_oldest() {
        let store = McpLeaseStore::default();
        store
            .put_computer(
                "lease-0".into(),
                computer_server_config("http://127.0.0.1:9/mcp", "tok"),
            )
            .unwrap();
        store.bind_session(
            "session-old".into(),
            SessionLeaseBinding {
                computer: Some("lease-0".into()),
                browser: None,
            },
        );
        for index in 1..(MAX_LEASES_PER_KIND + 4) {
            store
                .put_computer(
                    format!("lease-{index}"),
                    computer_server_config("http://127.0.0.1:9/mcp", "tok"),
                )
                .unwrap();
        }
        let guard = store.computer.lock().unwrap();
        assert!(guard.len() <= MAX_LEASES_PER_KIND);
        assert!(!guard.contains_key("lease-0"));
        assert!(guard.contains_key(&format!("lease-{}", MAX_LEASES_PER_KIND + 3)));
        drop(guard);
        assert!(store.computer_for_session("session-old").is_none());
        assert!(store
            .get_computer(&format!("lease-{}", MAX_LEASES_PER_KIND + 3))
            .is_some());
        assert_eq!(store.computer.lock().unwrap().len(), MAX_LEASES_PER_KIND);
    }
}
