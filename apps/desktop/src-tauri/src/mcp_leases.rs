//! Holds Computer/Browser MCP endpoint credentials outside the WebView.
//!
//! Session create/load messages may only reference lease ids; `acp_send`
//! injects the real Authorization headers before the line reaches the CLI.

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
};

#[derive(Default)]
pub struct McpLeaseStore {
    computer: Mutex<HashMap<String, Value>>,
    browser: Mutex<HashMap<String, Value>>,
}

impl McpLeaseStore {
    pub fn put_computer(&self, lease_id: String, server: Value) -> Result<(), String> {
        self.computer
            .lock()
            .map_err(|_| "Computer Use 租约表锁定失败".to_string())?
            .insert(lease_id, server);
        Ok(())
    }

    pub fn put_browser(&self, lease_id: String, server: Value) -> Result<(), String> {
        self.browser
            .lock()
            .map_err(|_| "Browser Use 租约表锁定失败".to_string())?
            .insert(lease_id, server);
        Ok(())
    }

    pub fn get_computer(&self, lease_id: &str) -> Option<Value> {
        self.computer.lock().ok()?.get(lease_id).cloned()
    }

    pub fn get_browser(&self, lease_id: &str) -> Option<Value> {
        self.browser.lock().ok()?.get(lease_id).cloned()
    }

    pub fn remove_computer(&self, lease_id: &str) {
        if let Ok(mut guard) = self.computer.lock() {
            guard.remove(lease_id);
        }
    }

    pub fn remove_browser(&self, lease_id: &str) {
        if let Ok(mut guard) = self.browser.lock() {
            guard.remove(lease_id);
        }
    }
}

pub fn computer_server_config(url: &str, token: &str) -> Value {
    json!({
        "type": "http",
        "name": "grok_desktop_computer",
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
        assert_eq!(servers[0]["name"], "grok_desktop_computer");
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
}
