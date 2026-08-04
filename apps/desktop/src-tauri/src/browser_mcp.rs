//! Lightweight Browser Use MCP — open URLs and capture headless screenshots.
//! Full CDP automation can be layered later; this gives agents a safe desktop
//! browser loop without shipping a Chromium bundle.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(45);

pub struct HttpEndpoint {
    pub url: String,
    pub token: String,
}

const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;

enum HttpWork {
    Rpc {
        request: Value,
        reply: SyncSender<(u16, Option<Value>)>,
    },
    Shutdown,
}

fn http_stops() -> &'static Mutex<HashMap<String, AtomicBool>> {
    static STOPS: OnceLock<Mutex<HashMap<String, AtomicBool>>> = OnceLock::new();
    STOPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn http_workers() -> &'static Mutex<HashMap<String, SyncSender<HttpWork>>> {
    static WORKERS: OnceLock<Mutex<HashMap<String, SyncSender<HttpWork>>>> = OnceLock::new();
    WORKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn shutdown_http(lease_id: &str) {
    if let Ok(mut stops) = http_stops().lock() {
        if let Some(flag) = stops.remove(lease_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    if let Ok(mut workers) = http_workers().lock() {
        if let Some(tx) = workers.remove(lease_id) {
            let _ = tx.send(HttpWork::Shutdown);
        }
    }
}

fn tokens_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法创建 Browser Use 令牌：{error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn serve_http(lease_id: String) -> Result<HttpEndpoint, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("无法启动 Browser Use MCP：{error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置 Browser Use MCP 监听：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法读取 Browser Use MCP 端口：{error}"))?
        .port();
    let token = random_token()?;
    let stop = AtomicBool::new(false);
    {
        let mut stops = http_stops()
            .lock()
            .map_err(|_| "Browser Use 关闭表锁定失败".to_string())?;
        stops.insert(lease_id.clone(), AtomicBool::new(false));
    }
    let (tx, rx) = mpsc::sync_channel::<HttpWork>(8);
    {
        let mut workers = http_workers()
            .lock()
            .map_err(|_| "Browser Use 工作队列锁定失败".to_string())?;
        workers.insert(lease_id.clone(), tx);
    }

    thread::Builder::new()
        .name("grox-browser-worker".into())
        .spawn(move || {
            while let Ok(work) = rx.recv() {
                match work {
                    HttpWork::Shutdown => break,
                    HttpWork::Rpc { request, reply } => {
                        let response = handle_rpc(&request);
                        let _ = reply.send(response);
                    }
                }
            }
        })
        .map_err(|error| format!("无法启动 Browser Use 工作线程：{error}"))?;

    let accept_token = token.clone();
    let accept_lease = lease_id.clone();
    thread::Builder::new()
        .name("grox-browser-http".into())
        .spawn(move || {
            loop {
                if http_stops()
                    .lock()
                    .ok()
                    .and_then(|stops| stops.get(&accept_lease).map(|flag| flag.load(Ordering::SeqCst)))
                    .unwrap_or(true)
                {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let token = accept_token.clone();
                        let lease = accept_lease.clone();
                        thread::spawn(move || handle_connection(stream, &token, &lease));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(40));
                    }
                    Err(_) => break,
                }
            }
            let _ = stop;
            shutdown_http(&accept_lease);
        })
        .map_err(|error| format!("无法启动 Browser Use MCP 线程：{error}"))?;

    Ok(HttpEndpoint {
        url: format!("http://127.0.0.1:{port}/mcp"),
        token,
    })
}

fn handle_connection(mut stream: TcpStream, token: &str, lease_id: &str) {
    let Ok(clone) = stream.try_clone() else {
        return;
    };
    let mut reader = std::io::BufReader::new(clone);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    if !request_line.starts_with("POST ") {
        let _ = write_response(&mut stream, 405, Some(json!({"error":"Method Not Allowed"})));
        return;
    }
    let mut headers = HashMap::<String, String>::new();
    let mut content_length = 0_usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line == "\r\n" || line == "\n" || line.is_empty()
        {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            if key == "content-length" {
                content_length = value.parse().unwrap_or(0).min(MAX_HTTP_BODY_BYTES);
            }
            headers.insert(key, value);
        }
    }
    let authorized = headers
        .get("authorization")
        .map(|value| {
            value
                .strip_prefix("Bearer ")
                .map(|candidate| tokens_equal(candidate, token))
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if !authorized {
        let _ = write_response(&mut stream, 401, Some(json!({"error":"unauthorized"})));
        return;
    }
    let mut body = vec![0_u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body).is_err() {
        let _ = write_response(&mut stream, 400, Some(json!({"error":"bad body"})));
        return;
    }
    let request: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let workers = http_workers().lock().ok();
    let Some(tx) = workers.as_ref().and_then(|map| map.get(lease_id)) else {
        let _ = write_response(
            &mut stream,
            503,
            Some(json!({"error":"Browser Use worker unavailable"})),
        );
        return;
    };
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    if tx
        .send(HttpWork::Rpc {
            request,
            reply: reply_tx,
        })
        .is_err()
    {
        let _ = write_response(
            &mut stream,
            503,
            Some(json!({"error":"Browser Use worker unavailable"})),
        );
        return;
    }
    match reply_rx.recv_timeout(Duration::from_secs(60)) {
        Ok((status, payload)) => {
            let _ = write_response(&mut stream, status, payload);
        }
        Err(_) => {
            let _ = write_response(
                &mut stream,
                504,
                Some(json!({"error":"Browser Use worker timeout"})),
            );
        }
    }
}

fn write_response(stream: &mut TcpStream, status: u16, body: Option<Value>) -> std::io::Result<()> {
    let payload = body
        .map(|value| serde_json::to_vec(&value).unwrap_or_default())
        .unwrap_or_default();
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        400 => "Bad Request",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(header.as_bytes())?;
    if !payload.is_empty() {
        stream.write_all(&payload)?;
    }
    Ok(())
}

fn handle_rpc(request: &Value) -> (u16, Option<Value>) {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => (
            200,
            Some(json!({
                "jsonrpc":"2.0",
                "id": id,
                "result": {
                    "protocolVersion":"2024-11-05",
                    "capabilities":{"tools":{}},
                    "serverInfo":{"name":"grox_desktop_browser","version":"0.1.0"}
                }
            })),
        ),
        "notifications/initialized" => (200, None),
        "tools/list" => (
            200,
            Some(json!({
                "jsonrpc":"2.0",
                "id": id,
                "result":{"tools": tools()}
            })),
        ),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(name, &args) {
                Ok(result) => (
                    200,
                    Some(json!({
                        "jsonrpc":"2.0",
                        "id": id,
                        "result": result
                    })),
                ),
                Err(error) => (
                    200,
                    Some(json!({
                        "jsonrpc":"2.0",
                        "id": id,
                        "result": {
                            "content":[{"type":"text","text": error}],
                            "isError": true
                        }
                    })),
                ),
            }
        }
        _ => (
            200,
            Some(json!({
                "jsonrpc":"2.0",
                "id": id,
                "error":{"code":-32601,"message":"Method not found"}
            })),
        ),
    }
}

fn tools() -> Vec<Value> {
    vec![
        json!({
            "name":"browser_open",
            "description":"在系统默认浏览器中打开 HTTPS/HTTP URL。",
            "inputSchema":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}
        }),
        json!({
            "name":"browser_screenshot",
            "description":"使用本机 Chrome/Edge/Chromium 无头模式对本机回环 URL 截图并返回 PNG。远程 URL 会被拒绝，以避免重定向/DNS rebinding 泄露私网内容。",
            "inputSchema":{"type":"object","properties":{"url":{"type":"string"},"width":{"type":"integer"},"height":{"type":"integer"}},"required":["url"]}
        }),
    ]
}

fn checked_url(raw: &str) -> Result<String, String> {
    checked_url_with_resolver(raw, resolve_host_ips)
}

/// Screenshots return page pixels into the agent context. Chrome may follow
/// redirects / rebinding after our pre-flight check, so remote targets are
/// refused until request-layer enforcement exists.
fn checked_screenshot_url(raw: &str) -> Result<String, String> {
    checked_screenshot_url_with_resolver(raw, resolve_host_ips)
}

fn checked_screenshot_url_with_resolver(
    raw: &str,
    resolve: impl Fn(&str) -> Result<Vec<std::net::IpAddr>, String>,
) -> Result<String, String> {
    let url = checked_url_with_resolver(raw, &resolve)?;
    let parsed = url::Url::parse(&url).map_err(|_| "无效 URL".to_string())?;
    if !url_is_loopback_only(&parsed, &resolve)? {
        return Err(
            "无头截图仅允许本机回环地址，以防重定向或 DNS rebinding 访问私网/云元数据"
                .into(),
        );
    }
    Ok(url)
}

fn url_is_loopback_only(
    url: &url::Url,
    resolve: impl Fn(&str) -> Result<Vec<std::net::IpAddr>, String>,
) -> Result<bool, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL 缺少主机名".to_string())?
        .trim_start_matches('[')
        .trim_end_matches(']');
    let host_lower = host.to_ascii_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".localhost") {
        match resolve(host) {
            Ok(addresses) if !addresses.is_empty() => {
                Ok(addresses.into_iter().all(address_is_loopback))
            }
            Ok(_) | Err(_) => Ok(true),
        }
    } else if let Ok(address) = host.parse::<std::net::IpAddr>() {
        Ok(address_is_loopback(address))
    } else {
        Ok(false)
    }
}

/// Validate a redirect Location as its own navigation target. Used by tests and
/// any future request-layer hop checks; Chromium itself cannot be constrained
/// here, which is why remote screenshots remain disabled.
fn checked_redirect_location_with_resolver(
    base: &str,
    location: &str,
    resolve: impl Fn(&str) -> Result<Vec<std::net::IpAddr>, String>,
) -> Result<String, String> {
    let base_url = url::Url::parse(base).map_err(|_| "无效基准 URL".to_string())?;
    let next = base_url
        .join(location.trim())
        .map_err(|_| "无效重定向 Location".to_string())?;
    checked_url_with_resolver(next.as_str(), resolve)
}

fn checked_url_with_resolver(
    raw: &str,
    resolve: impl Fn(&str) -> Result<Vec<std::net::IpAddr>, String>,
) -> Result<String, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "无效 URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只允许 http/https URL".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL 不能包含用户名或密码".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL 缺少主机名".to_string())?
        .trim_start_matches('[')
        .trim_end_matches(']');
    let host_lower = host.to_ascii_lowercase();
    if looks_like_metadata_host(&host_lower) {
        return Err("不允许访问云元数据主机名".into());
    }
    let is_loopback_name =
        host_lower == "localhost" || host_lower.ends_with(".localhost");
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        enforce_browser_address(address, url.scheme())?;
    } else if is_loopback_name {
        // Prefer resolved loopback addresses when DNS works; name-only fallback
        // keeps local preview URLs usable on resolvers that skip .localhost.
        match resolve(host) {
            Ok(addresses) if !addresses.is_empty() => {
                for address in addresses {
                    if !address_is_loopback(address) {
                        return Err("localhost 主机名解析到了非回环地址".into());
                    }
                }
            }
            Ok(_) | Err(_) => {}
        }
    } else {
        if url.scheme() != "https" {
            return Err("非本机地址必须使用 HTTPS".into());
        }
        let addresses = resolve(host)?;
        if addresses.is_empty() {
            return Err(format!("无法解析主机名：{host}"));
        }
        for address in addresses {
            enforce_browser_address(address, url.scheme())?;
        }
    }
    Ok(url.to_string())
}

fn resolve_host_ips(host: &str) -> Result<Vec<std::net::IpAddr>, String> {
    use std::net::ToSocketAddrs;
    let mut addresses = (host, 0u16)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析主机名 {host}：{error}"))?
        .map(|socket| socket.ip())
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(format!("主机名 {host} 没有解析到任何地址"));
    }
    Ok(addresses)
}

fn enforce_browser_address(address: std::net::IpAddr, scheme: &str) -> Result<(), String> {
    if address_is_loopback(address) {
        return Ok(());
    }
    if is_blocked_browser_ip(address) {
        return Err("不允许访问私有、链路本地或云元数据地址".into());
    }
    if scheme != "https" {
        return Err("非本机地址必须使用 HTTPS".into());
    }
    Ok(())
}

fn address_is_loopback(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

fn is_blocked_browser_ip(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(v4) => is_blocked_browser_v4(v4),
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_browser_v4(v4);
            }
            v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

fn is_blocked_browser_v4(v4: std::net::Ipv4Addr) -> bool {
    v4.is_private()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_unspecified()
        || v4.octets()[0] == 0
        || matches!(v4.octets(), [100, 64..=127, ..])
        || v4.octets() == [169, 254, 169, 254]
}

fn looks_like_metadata_host(host: &str) -> bool {
    host == "metadata.google.internal"
        || host == "metadata"
        || host.ends_with(".internal")
        || host.contains("metadata.google")
}

fn call_tool(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "browser_open" => {
            let url = checked_url(args.get("url").and_then(Value::as_str).unwrap_or(""))?;
            open_url(&url)?;
            Ok(json!({
                "content":[{"type":"text","text": format!("已在系统浏览器打开 {url}")}]
            }))
        }
        "browser_screenshot" => {
            let url = checked_screenshot_url(args.get("url").and_then(Value::as_str).unwrap_or(""))?;
            let width = args.get("width").and_then(Value::as_u64).unwrap_or(1280).min(1920);
            let height = args.get("height").and_then(Value::as_u64).unwrap_or(720).min(1200);
            let png = headless_screenshot(&url, width as u32, height as u32)?;
            Ok(json!({
                "content":[
                    {"type":"text","text": format!("已截取 {url}")},
                    {"type":"image","data": BASE64.encode(png), "mimeType":"image/png"}
                ]
            }))
        }
        _ => Err(format!("未知工具：{name}")),
    }
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map_err(|error| format!("无法打开浏览器：{error}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("无法打开浏览器：{error}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("无法打开浏览器：{error}"))?;
        Ok(())
    }
}

fn chromium_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let program = std::env::var_os("PROGRAMFILES").map(PathBuf::from);
        let program_x86 = std::env::var_os("PROGRAMFILES(X86)").map(PathBuf::from);
        for root in [local, program, program_x86].into_iter().flatten() {
            paths.push(root.join("Google/Chrome/Application/chrome.exe"));
            paths.push(root.join("Microsoft/Edge/Application/msedge.exe"));
            paths.push(root.join("Chromium/Application/chrome.exe"));
        }
        paths.push(PathBuf::from("chrome.exe"));
        paths.push(PathBuf::from("msedge.exe"));
    }
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        paths.push(PathBuf::from(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ));
        paths.push(PathBuf::from(
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for bin in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"] {
            paths.push(PathBuf::from(bin));
        }
    }
    paths
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).map_err(|error| format!("无法生成随机名：{error}"))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Private random subdirectory + O_EXCL create so a peer process cannot pre-plant
/// a symlink at a predictable `grox-browser-<nanos>.png` path.
fn secure_temp_png(prefix: &str) -> Result<(PathBuf, PathBuf), String> {
    let dir = std::env::temp_dir().join(format!("grox-shots-{}", random_hex(16)?));
    fs::create_dir(&dir).map_err(|error| format!("无法创建截图临时目录：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    let path = dir.join(format!("{prefix}-{}.png", random_hex(16)?));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("无法创建截图临时文件：{error}"))?;
    Ok((dir, path))
}

fn wait_child_with_timeout(child: &mut Child, timeout: Duration) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < timeout => {
                thread::sleep(Duration::from_millis(40));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("截图超时，已终止浏览器进程".into());
            }
            Err(error) => return Err(format!("无法等待截图进程：{error}")),
        }
    }
}

fn headless_screenshot(url: &str, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let (dir, out) = secure_temp_png("browser")?;
    let cleanup = || {
        let _ = fs::remove_file(&out);
        let _ = fs::remove_dir_all(&dir);
    };
    let mut last_error = "未找到 Chrome / Edge / Chromium".to_string();
    for candidate in chromium_candidates() {
        let mut command = Command::new(&candidate);
        command.args([
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            &format!("--window-size={width},{height}"),
            &format!("--screenshot={}", out.display()),
            url,
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            command.creation_flags(0x0800_0000);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                last_error = format!("{}：{error}", candidate.display());
                continue;
            }
        };
        match wait_child_with_timeout(&mut child, SCREENSHOT_TIMEOUT) {
            Ok(status) if status.success() && out.exists() => {
                let bytes = fs::read(&out).map_err(|error| {
                    cleanup();
                    format!("无法读取截图：{error}")
                })?;
                cleanup();
                if bytes.is_empty() {
                    return Err("截图为空".into());
                }
                return Ok(bytes);
            }
            Ok(status) => {
                last_error = format!("{} 退出码 {:?}", candidate.display(), status.code());
            }
            Err(error) => {
                last_error = format!("{}：{error}", candidate.display());
            }
        }
        let _ = fs::remove_file(&out);
    }
    cleanup();
    Err(format!("无头截图失败：{last_error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn public_resolver(host: &str) -> Result<Vec<IpAddr>, String> {
        match host {
            "example.com" => Ok(vec![IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))]),
            "evil.example" => Ok(vec![IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))]),
            "mixed.example" => Ok(vec![
                IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)),
                IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
            ]),
            "localhost" => Ok(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]),
            other => Err(format!("unexpected host in test resolver: {other}")),
        }
    }

    #[test]
    fn browser_url_allows_https_and_loopback_http() {
        assert!(checked_url_with_resolver("https://example.com/page", public_resolver).is_ok());
        assert!(checked_url("http://127.0.0.1:5173/").is_ok());
        assert!(checked_url_with_resolver("http://localhost:3000", public_resolver).is_ok());
    }

    #[test]
    fn browser_url_rejects_private_metadata_and_cleartext_wan() {
        assert!(checked_url_with_resolver("http://example.com", public_resolver).is_err());
        assert!(checked_url("https://192.168.1.1/").is_err());
        assert!(checked_url("http://10.0.0.5/").is_err());
        assert!(checked_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(checked_url("http://metadata.google.internal/").is_err());
        assert!(checked_url("https://user:pass@example.com/").is_err());
    }

    #[test]
    fn browser_url_rejects_ipv6_mapped_private_and_metadata() {
        assert!(checked_url("https://[::ffff:169.254.169.254]/latest/meta-data").is_err());
        assert!(checked_url("https://[::ffff:192.168.1.1]/").is_err());
        assert!(checked_url("https://[::ffff:10.0.0.5]/").is_err());
        assert!(checked_url("http://[::ffff:127.0.0.1]:5173/").is_ok());
        let mapped_loopback = IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 1));
        assert!(address_is_loopback(mapped_loopback));
        assert!(is_blocked_browser_ip(
            "::ffff:169.254.169.254".parse().unwrap()
        ));
    }

    #[test]
    fn browser_url_rejects_hostnames_that_resolve_to_blocked_ips() {
        assert!(checked_url_with_resolver("https://evil.example/", public_resolver).is_err());
        assert!(checked_url_with_resolver("https://mixed.example/", public_resolver).is_err());
    }

    #[test]
    fn screenshot_allows_loopback_only_and_rejects_remote() {
        assert!(checked_screenshot_url_with_resolver("http://127.0.0.1:5173/", public_resolver).is_ok());
        assert!(checked_screenshot_url_with_resolver("http://localhost:3000", public_resolver).is_ok());
        assert!(checked_screenshot_url_with_resolver("https://example.com/page", public_resolver).is_err());
        assert!(checked_screenshot_url("https://192.168.1.1/").is_err());
        assert!(checked_screenshot_url("http://169.254.169.254/latest/meta-data").is_err());
    }

    #[test]
    fn redirect_and_rebinding_targets_are_rejected_at_policy_layer() {
        // Simulated 302 Location to cloud metadata / private LAN.
        assert!(checked_redirect_location_with_resolver(
            "https://example.com/start",
            "http://169.254.169.254/latest/meta-data",
            public_resolver,
        )
        .is_err());
        assert!(checked_redirect_location_with_resolver(
            "https://example.com/start",
            "https://evil.example/secret",
            public_resolver,
        )
        .is_err());
        assert!(checked_redirect_location_with_resolver(
            "https://example.com/start",
            "https://mixed.example/",
            public_resolver,
        )
        .is_err());
        assert!(checked_redirect_location_with_resolver(
            "https://example.com/start",
            "/relative-still-on-public-origin",
            public_resolver,
        )
        .is_ok());
        // DNS rebinding-style second lookup: public name flips to metadata IP.
        assert!(checked_url_with_resolver("https://evil.example/", public_resolver).is_err());
        // Remote screenshots stay disabled so Chromium cannot chase these hops.
        assert!(checked_screenshot_url_with_resolver("https://example.com/", public_resolver).is_err());
    }
}
