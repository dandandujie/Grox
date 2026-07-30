use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

pub struct HttpEndpoint {
    pub url: String,
    pub token: String,
}

const MAX_TYPE_TEXT_BYTES: usize = 20_000;
const MAX_SET_VALUE_BYTES: usize = 20_000;
const MAX_KEYS: usize = 8;
const MAX_SCROLL_DELTA: i32 = 2400;
const MAX_DRAG_DURATION_MS: u64 = 5000;
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

/// Stop accepting connections and drain the worker for a Computer Use lease.
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

pub fn serve_http(lease_id: String) -> Result<HttpEndpoint, String> {
    #[cfg(windows)]
    {
        if platform::is_self_elevated() && std::env::var("GROX_COMPUTER_USE_ALLOW_ELEVATED").as_deref() != Ok("1") {
            return Err(
                "Grox 以管理员权限运行时默认禁用 Computer Use。请用普通权限重启，或设置 GROX_COMPUTER_USE_ALLOW_ELEVATED=1 显式允许"
                    .into(),
            );
        }
    }
    shutdown_http(&lease_id);
    let token = uuid_token()?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("无法启动 Computer Use MCP：{error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置 Computer Use MCP 监听：{error}"))?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    {
        let mut stops = http_stops()
            .lock()
            .map_err(|_| "Computer Use 关闭表锁定失败".to_string())?;
        stops.insert(lease_id.clone(), AtomicBool::new(false));
    }
    let (work_tx, work_rx) = mpsc::sync_channel::<HttpWork>(32);
    {
        let mut workers = http_workers()
            .lock()
            .map_err(|_| "Computer Use 工作队列锁定失败".to_string())?;
        workers.insert(lease_id.clone(), work_tx.clone());
    }

    let worker_lease = lease_id.clone();
    thread::Builder::new()
        .name("grox-computer-mcp-worker".into())
        .spawn(move || {
            let mut state = ComputerState {
                lease_id: Some(worker_lease),
                ..ComputerState::default()
            };
            while let Ok(work) = work_rx.recv() {
                match work {
                    HttpWork::Shutdown => break,
                    HttpWork::Rpc { request, reply } => {
                        let id = request.get("id").cloned();
                        let method = request
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let response = if id.is_none() {
                            None
                        } else {
                            let result = match method {
                                "initialize" => Ok(json!({
                                    "protocolVersion": "2025-06-18",
                                    "capabilities": { "tools": { "listChanged": false } },
                                    "serverInfo": { "name": "grok_desktop_computer", "version": env!("CARGO_PKG_VERSION") }
                                })),
                                "ping" => Ok(json!({})),
                                "tools/list" => Ok(json!({ "tools": tools() })),
                                "tools/call" => {
                                    let params = request.get("params").cloned().unwrap_or_default();
                                    call_tool(params, &mut state)
                                }
                                _ => Err(format!("不支持的 MCP 方法：{method}")),
                            };
                            Some(match result {
                                Ok(result) => (200_u16, Some(json!({"jsonrpc":"2.0","id":id,"result":result}))),
                                Err(message) => (
                                    200,
                                    Some(json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":classified_error(&message)}],"isError":true}})),
                                ),
                            })
                        };
                        if let Some(payload) = response {
                            let _ = reply.send(payload);
                        } else {
                            let _ = reply.send((202, None));
                        }
                    }
                }
            }
        })
        .map_err(|error| format!("无法启动 Computer Use MCP 工作线程：{error}"))?;

    let expected = token.clone();
    let session_id = lease_id.clone();
    let accept_lease = lease_id.clone();
    thread::Builder::new()
        .name("grox-computer-mcp-http".into())
        .spawn(move || {
            loop {
                let stopped = http_stops()
                    .lock()
                    .ok()
                    .and_then(|stops| stops.get(&accept_lease).map(|flag| flag.load(Ordering::SeqCst)))
                    .unwrap_or(true);
                if stopped {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let token = expected.clone();
                        let session_id = session_id.clone();
                        let work_tx = work_tx.clone();
                        // Keep HTTP framing off the tool worker, but serialize
                        // every tools/call onto that single worker so UI Automation
                        // element maps stay coherent.
                        let _ = thread::Builder::new()
                            .name("grox-computer-mcp-request".into())
                            .spawn(move || handle_http(stream, &token, &session_id, work_tx));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => break,
                }
            }
            let _ = work_tx.send(HttpWork::Shutdown);
            let _ = http_workers().lock().map(|mut workers| workers.remove(&accept_lease));
            let _ = http_stops().lock().map(|mut stops| stops.remove(&accept_lease));
        })
        .map_err(|error| format!("无法启动 Computer Use MCP 线程：{error}"))?;
    Ok(HttpEndpoint {
        url: format!("http://{address}/mcp"),
        token,
    })
}

fn uuid_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法创建 Computer Use 令牌：{error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn handle_http(
    mut stream: TcpStream,
    token: &str,
    session_id: &str,
    work_tx: SyncSender<HttpWork>,
) {
    let mut buffer = vec![0_u8; MAX_HTTP_BODY_BYTES];
    let Ok(size) = stream.read(&mut buffer) else { return };
    let request = String::from_utf8_lossy(&buffer[..size]);
    let mut parts = request.split("\r\n\r\n");
    let headers = parts.next().unwrap_or_default();
    let body = parts.next().unwrap_or_default();
    if body.len() > MAX_HTTP_BODY_BYTES {
        let reply = "HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(reply.as_bytes());
        return;
    }
    let authorized = headers.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("authorization: bearer ")
            && tokens_equal(line.trim()["authorization: bearer ".len()..].trim(), token)
    });
    let (status, response) = if !authorized {
        (401, Some(json!({"error":"Unauthorized"})))
    } else if !headers.starts_with("POST ") {
        (405, Some(json!({"error":"Method Not Allowed"})))
    } else {
        match serde_json::from_str::<Value>(body.trim()) {
            Ok(request) => {
                let (reply_tx, reply_rx) = mpsc::sync_channel(1);
                if work_tx
                    .send(HttpWork::Rpc {
                        request,
                        reply: reply_tx,
                    })
                    .is_err()
                {
                    (503, Some(json!({"error":"Computer Use worker unavailable"})))
                } else {
                    match reply_rx.recv_timeout(Duration::from_secs(60)) {
                        Ok((202, None)) => {
                            let reply = format!(
                                "HTTP/1.1 202 Accepted\r\nMcp-Session-Id: {session_id}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            );
                            let _ = stream.write_all(reply.as_bytes());
                            return;
                        }
                        Ok(pair) => pair,
                        Err(_) => (504, Some(json!({"error":"Computer Use worker timeout"}))),
                    }
                }
            }
            Err(error) => (400, Some(json!({"error": error.to_string()}))),
        }
    };
    let payload = response.map(|value| value.to_string()).unwrap_or_default();
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        400 => "Bad Request",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let reply = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nMcp-Session-Id: {session_id}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    let _ = stream.write_all(reply.as_bytes());
}

pub fn run(lease_id: Option<String>) -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut state = ComputerState {
        lease_id,
        ..ComputerState::default()
    };
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_message(
                    &mut stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": { "code": -32700, "message": error.to_string() }
                    }),
                )?;
                continue;
            }
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "grok_desktop_computer", "version": env!("CARGO_PKG_VERSION") }
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => call_tool(
                request.get("params").cloned().unwrap_or_default(),
                &mut state,
            ),
            _ => Err(format!("不支持的 MCP 方法：{method}")),
        };
        let response = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(message) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "content": [{ "type": "text", "text": classified_error(&message) }], "isError": true }
            }),
        };
        write_message(&mut stdout, &response)?;
    }
    Ok(())
}

fn classified_error(message: &str) -> String {
    let (code, text) = [
        ("elevation-blocked", "elevation-blocked:"),
        ("uac-handoff", "uac-handoff:"),
        ("blocklist", "blocklist:"),
    ]
    .into_iter()
    .find_map(|(code, prefix)| message.strip_prefix(prefix).map(|text| (code, text.trim())))
    .unwrap_or(("action-failed", message));
    serde_json::to_string(&json!({"errorCode": code, "message": text}))
        .unwrap_or_else(|_| message.to_string())
}

#[derive(Default)]
struct ComputerState {
    active_window: Option<i64>,
    state_id: u64,
    stopped: bool,
    paused: bool,
    lease_id: Option<String>,
}

fn write_message(stdout: &mut impl Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdout, value).map_err(|error| error.to_string())?;
    stdout.write_all(b"\n").map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

fn tools() -> Vec<Value> {
    vec![
        tool(
            "list_apps",
            "列出可控的桌面应用窗口。",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "list_windows",
            "列出当前可控的顶层窗口及其窗口句柄。",
            json!({"type":"object","properties":{"appId":{"type":"string"}},"additionalProperties":false}),
        ),
        tool(
            "start",
            "选择并激活窗口，返回初始 UI 状态。",
            json!({"type":"object","properties":{"windowId":{"type":"integer"}},"required":["windowId"],"additionalProperties":false}),
        ),
        tool(
            "pause",
            "暂停当前 Computer Use 会话。",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "resume",
            "继续已暂停的 Computer Use 会话并重新观察窗口。",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "stop",
            "紧急停止当前 Computer Use 会话；必须重新创建或加载会话后才能再次控制。",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "get_window_state",
            "观察当前窗口：截图、状态 ID 和 UI Automation 元素。",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "activate_window",
            "重新激活已选择的窗口。",
            json!({"type":"object","properties":{"stateId":{"type":"integer"}},"required":["stateId"],"additionalProperties":false}),
        ),
        tool(
            "click",
            "单击当前窗口内的 UI Automation 元素或截图坐标。",
            target_schema(),
        ),
        tool(
            "press_key",
            "按下组合键。",
            json!({"type":"object","properties":{"keys":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":8},"stateId":{"type":"integer"}},"required":["keys","stateId"],"additionalProperties":false}),
        ),
        tool(
            "type_text",
            "输入文本。",
            json!({"type":"object","properties":{"elementId":{"type":"string","minLength":1},"text":{"type":"string","maxLength":20000},"stateId":{"type":"integer"}},"required":["text","stateId"],"additionalProperties":false}),
        ),
        tool(
            "set_value",
            "通过 UI Automation 设置元素值。",
            json!({"type":"object","properties":{"elementId":{"type":"string"},"value":{"type":"string"},"stateId":{"type":"integer"}},"required":["elementId","value","stateId"],"additionalProperties":false}),
        ),
        tool("double_click", "双击指定元素或坐标。", target_schema()),
        tool(
            "perform_secondary_action",
            "在当前窗口内执行右键操作。",
            target_schema(),
        ),
        tool(
            "scroll",
            "在当前窗口内垂直或水平滚动。",
            json!({"type":"object","properties":{"elementId":{"type":"string","minLength":1},"x":{"type":"integer"},"y":{"type":"integer"},"deltaX":{"type":"integer","minimum":-2400,"maximum":2400},"deltaY":{"type":"integer","minimum":-2400,"maximum":2400},"stateId":{"type":"integer"}},"required":["stateId"],"additionalProperties":false}),
        ),
        tool(
            "drag",
            "在当前窗口内拖动；起点可使用元素或截图坐标。",
            json!({"type":"object","properties":{"elementId":{"type":"string","minLength":1},"x":{"type":"integer"},"y":{"type":"integer"},"endX":{"type":"integer"},"endY":{"type":"integer"},"durationMs":{"type":"integer","minimum":0,"maximum":5000,"default":500},"stateId":{"type":"integer"}},"required":["endX","endY","stateId"],"additionalProperties":false}),
        ),
        tool(
            "wait",
            "等待界面稳定后重新观察窗口。",
            json!({"type":"object","properties":{"milliseconds":{"type":"integer","minimum":0,"maximum":30000},"stateId":{"type":"integer"}},"required":["stateId"],"additionalProperties":false}),
        ),
        tool(
            "computer_screenshot",
            "兼容工具：观察当前目标窗口，不捕获其他桌面内容。",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "computer_mouse_move",
            "兼容工具：将鼠标移动到当前窗口截图坐标。",
            state_xy_schema(),
        ),
        tool(
            "computer_click",
            "兼容工具：在当前窗口截图坐标执行鼠标单击、双击或右击。",
            json!({"type":"object","properties":{"x":{"type":"integer"},"y":{"type":"integer"},"button":{"type":"string","enum":["left","right","middle"],"default":"left"},"clicks":{"type":"integer","minimum":1,"maximum":2,"default":1},"stateId":{"type":"integer"}},"required":["x","y","stateId"],"additionalProperties":false}),
        ),
        tool(
            "computer_drag",
            "兼容工具：在当前窗口截图坐标内拖动。",
            json!({"type":"object","properties":{"fromX":{"type":"integer"},"fromY":{"type":"integer"},"toX":{"type":"integer"},"toY":{"type":"integer"},"durationMs":{"type":"integer","minimum":0,"maximum":5000,"default":500},"stateId":{"type":"integer"}},"required":["fromX","fromY","toX","toY","stateId"],"additionalProperties":false}),
        ),
        tool(
            "computer_scroll",
            "兼容工具：在当前窗口截图坐标滚动鼠标滚轮。",
            json!({"type":"object","properties":{"x":{"type":"integer"},"y":{"type":"integer"},"deltaX":{"type":"integer","minimum":-2400,"maximum":2400},"deltaY":{"type":"integer","minimum":-2400,"maximum":2400},"delta":{"type":"integer","minimum":-2400,"maximum":2400},"stateId":{"type":"integer"}},"required":["x","y","stateId"],"additionalProperties":false}),
        ),
        tool(
            "computer_key",
            "按下安全组合键（例如 CTRL+L、ENTER、ESC）。禁止 Win/Meta 与 Alt+Tab、Alt+F4、Ctrl+Esc 等系统切换组合键。",
            json!({"type":"object","properties":{"keys":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":8},"stateId":{"type":"integer"}},"required":["keys","stateId"],"additionalProperties":false}),
        ),
        tool(
            "computer_type",
            "通过 Unicode 键盘事件输入文本。",
            json!({"type":"object","properties":{"text":{"type":"string","maxLength":20000},"stateId":{"type":"integer"}},"required":["text","stateId"],"additionalProperties":false}),
        ),
        tool(
            "computer_wait",
            "等待界面完成动画或加载。",
            json!({"type":"object","properties":{"milliseconds":{"type":"integer","minimum":0,"maximum":30000},"stateId":{"type":"integer"}},"required":["stateId"],"additionalProperties":false}),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn target_schema() -> Value {
    json!({"type":"object","properties":{"elementId":{"type":"string","minLength":1},"x":{"type":"integer"},"y":{"type":"integer"},"stateId":{"type":"integer"}},"required":["stateId"],"additionalProperties":false})
}

fn state_xy_schema() -> Value {
    json!({"type":"object","properties":{"x":{"type":"integer"},"y":{"type":"integer"},"stateId":{"type":"integer"}},"required":["x","y","stateId"],"additionalProperties":false})
}

fn call_tool(params: Value, state: &mut ComputerState) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if state
        .lease_id
        .as_deref()
        .is_some_and(emergency_stop_requested)
    {
        state.active_window = None;
        state.paused = false;
        state.stopped = true;
    }
    let result = call_tool_inner(name, &args, state);
    audit_event(
        name,
        state.active_window,
        if result.is_ok() { "success" } else { "failure" },
    );
    result
}

fn call_tool_inner(name: &str, args: &Value, state: &mut ComputerState) -> Result<Value, String> {
    if state.stopped && !matches!(name, "list_apps" | "list_windows" | "stop") {
        return Err(
            "Computer Use 已紧急停止；为防止代理自动恢复，必须由用户重新创建或加载会话后才能再次控制"
                .into(),
        );
    }
    if state.paused && !matches!(name, "list_apps" | "list_windows" | "resume" | "stop") {
        return Err("Computer Use 已暂停；请先调用 resume 或 stop".into());
    }
    match name {
        "list_apps" => Ok(json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string(&list_apps()?).map_err(|error| error.to_string())?
            }]
        })),
        "list_windows" => {
            let app_id = args.get("appId").and_then(Value::as_str);
            let windows = platform::list_windows()?
                .into_iter()
                .filter(|window| {
                    app_id.map_or(true, |expected| {
                        window.get("appId").and_then(Value::as_str) == Some(expected)
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": serde_json::to_string(&windows).map_err(|error| error.to_string())?
                }]
            }))
        }
        "start" => {
            let hwnd = int64(args, "windowId")?;
            platform::activate(hwnd)?;
            state.active_window = Some(hwnd);
            state.paused = false;
            observe(state)
        }
        "pause" => {
            ensure_active(state)?;
            state.paused = true;
            ok_text("Computer Use 已暂停")
        }
        "resume" => {
            if !state.paused {
                return Err("Computer Use 当前未暂停".into());
            }
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            platform::activate(hwnd)?;
            state.paused = false;
            observe(state)
        }
        "stop" => {
            state.active_window = None;
            state.paused = false;
            state.stopped = true;
            if let Some(lease_id) = state.lease_id.as_deref() {
                mark_emergency_stop(lease_id)?;
            }
            ok_text("Computer Use 已紧急停止；重新创建或加载会话后才能再次控制")
        }
        "activate_window" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            platform::activate(hwnd)?;
            observe(state)
        }
        "get_window_state" => observe(state),
        "click" | "double_click" | "perform_secondary_action" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let (x, y) = platform::target_point(
                hwnd,
                args.get("elementId").and_then(Value::as_str),
                optional_int(args, "x"),
                optional_int(args, "y"),
            )?;
            let (button, clicks) = match name {
                "perform_secondary_action" => ("right", 1),
                "double_click" => ("left", 2),
                _ => ("left", 1),
            };
            platform::click(hwnd, x, y, button, clicks)?;
            observe(state)
        }
        "press_key" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let keys = args
                .get("keys")
                .and_then(Value::as_array)
                .ok_or("keys 必须是数组")?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            if keys.is_empty() || keys.len() > MAX_KEYS {
                return Err(format!("keys 数量必须在 1–{MAX_KEYS} 之间"));
            }
            platform::key(hwnd, &keys)?;
            observe(state)
        }
        "type_text" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .ok_or("缺少 text")?;
            if text.len() > MAX_TYPE_TEXT_BYTES {
                return Err(format!("text 不能超过 {MAX_TYPE_TEXT_BYTES} 字节"));
            }
            if text.chars().any(char::is_control) {
                return Err("text 不能包含控制字符".into());
            }
            if let Some(element_id) = args.get("elementId").and_then(Value::as_str) {
                let (x, y) = platform::target_point(hwnd, Some(element_id), None, None)?;
                platform::click(hwnd, x, y, "left", 1)?;
            }
            platform::type_text(hwnd, text)?;
            observe(state)
        }
        "set_value" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let value = args
                .get("value")
                .and_then(Value::as_str)
                .ok_or("缺少 value")?;
            if value.len() > MAX_SET_VALUE_BYTES {
                return Err(format!("value 不能超过 {MAX_SET_VALUE_BYTES} 字节"));
            }
            platform::set_value(
                hwnd,
                args.get("elementId")
                    .and_then(Value::as_str)
                    .ok_or("缺少 elementId")?,
                value,
            )?;
            observe(state)
        }
        "scroll" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let delta_x = bounded_delta(args, "deltaX")?.unwrap_or(0);
            let delta_y = bounded_delta(args, "deltaY")?
                .or(bounded_delta(args, "delta")?)
                .unwrap_or(if delta_x == 0 { -480 } else { 0 });
            platform::scroll(
                hwnd,
                args.get("elementId").and_then(Value::as_str),
                optional_int(args, "x"),
                optional_int(args, "y"),
                delta_x,
                delta_y,
            )?;
            observe(state)
        }
        "drag" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let (from_x, from_y) = platform::target_point(
                hwnd,
                args.get("elementId").and_then(Value::as_str),
                optional_int(args, "x"),
                optional_int(args, "y"),
            )?;
            platform::drag(
                hwnd,
                from_x,
                from_y,
                int(args, "endX")?,
                int(args, "endY")?,
                bounded_duration_ms(args)?,
            )?;
            observe(state)
        }
        "wait" => {
            check_state(args, state)?;
            std::thread::sleep(std::time::Duration::from_millis(
                args.get("milliseconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(500)
                    .min(30_000),
            ));
            observe(state)
        }
        "computer_screenshot" => {
            ensure_active(state)?;
            observe(state)
        }
        "computer_mouse_move" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            platform::move_mouse(hwnd, int(args, "x")?, int(args, "y")?)?;
            observe(state)
        }
        "computer_click" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            platform::click(
                hwnd,
                int(args, "x")?,
                int(args, "y")?,
                args.get("button").and_then(Value::as_str).unwrap_or("left"),
                args.get("clicks").and_then(Value::as_u64).unwrap_or(1) as u32,
            )?;
            observe(state)
        }
        "computer_drag" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            platform::drag(
                hwnd,
                int(args, "fromX")?,
                int(args, "fromY")?,
                int(args, "toX")?,
                int(args, "toY")?,
                bounded_duration_ms(args)?,
            )?;
            observe(state)
        }
        "computer_scroll" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let delta_x = bounded_delta(args, "deltaX")?.unwrap_or(0);
            let delta_y = bounded_delta(args, "deltaY")?
                .or(bounded_delta(args, "delta")?)
                .unwrap_or(if delta_x == 0 { -480 } else { 0 });
            platform::scroll(
                hwnd,
                None,
                optional_int(args, "x"),
                optional_int(args, "y"),
                delta_x,
                delta_y,
            )?;
            observe(state)
        }
        "computer_key" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let keys = args
                .get("keys")
                .and_then(Value::as_array)
                .ok_or("keys 必须是数组")?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            if keys.is_empty() || keys.len() > MAX_KEYS {
                return Err(format!("keys 数量必须在 1–{MAX_KEYS} 之间"));
            }
            platform::key(hwnd, &keys)?;
            observe(state)
        }
        "computer_type" => {
            check_state(args, state)?;
            let hwnd = state.active_window.ok_or("尚未选择窗口")?;
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .ok_or("缺少 text")?;
            if text.len() > MAX_TYPE_TEXT_BYTES {
                return Err(format!("text 不能超过 {MAX_TYPE_TEXT_BYTES} 字节"));
            }
            platform::type_text(hwnd, text)?;
            observe(state)
        }
        "computer_wait" => {
            check_state(args, state)?;
            std::thread::sleep(std::time::Duration::from_millis(
                args.get("milliseconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(500)
                    .min(30_000),
            ));
            observe(state)
        }
        _ => Err(format!("未知工具：{name}")),
    }
}

fn list_apps() -> Result<Vec<Value>, String> {
    let mut apps = std::collections::BTreeMap::<String, Value>::new();
    for window in platform::list_windows()? {
        let app_id = window
            .get("appId")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let entry = apps.entry(app_id.clone()).or_insert_with(|| {
            json!({
                "appId": app_id,
                "name": window.get("processName").cloned().unwrap_or_else(|| json!("unknown")),
                "processName": window.get("processName").cloned().unwrap_or_else(|| json!("unknown")),
                "executablePath": window.get("executablePath").cloned().unwrap_or(Value::Null),
                "windowCount": 0,
                "controllable": false,
                "blockedReason": window.get("blockedReason").cloned().unwrap_or(Value::Null),
                "blockedCode": window.get("blockedCode").cloned().unwrap_or(Value::Null)
            })
        });
        entry["windowCount"] = json!(entry["windowCount"].as_u64().unwrap_or_default() + 1);
        if window.get("controllable").and_then(Value::as_bool) == Some(true) {
            entry["controllable"] = json!(true);
            entry["blockedReason"] = Value::Null;
            entry["blockedCode"] = Value::Null;
        }
    }
    Ok(apps.into_values().collect())
}

fn emergency_stop_marker(lease_id: &str) -> Result<PathBuf, String> {
    if lease_id.len() != 32 || !lease_id.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("Computer Use 租约标识无效".into());
    }
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Grox")
        .join("computer-use-stops");
    Ok(root.join(format!("{lease_id}.stop")))
}

pub fn mark_emergency_stop(lease_id: &str) -> Result<(), String> {
    shutdown_http(lease_id);
    let path = emergency_stop_marker(lease_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Computer Use 停止目录：{error}"))?;
    }
    std::fs::write(path, b"stopped")
        .map_err(|error| format!("无法写入 Computer Use 紧急停止标记：{error}"))
}

pub fn clear_emergency_stop(lease_id: &str) -> Result<(), String> {
    let path = emergency_stop_marker(lease_id)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清除 Computer Use 紧急停止标记：{error}")),
    }
}

fn emergency_stop_requested(lease_id: &str) -> bool {
    emergency_stop_marker(lease_id)
        .map(|path| path.is_file())
        .unwrap_or(true)
}

fn audit_event(action: &str, window: Option<i64>, outcome: &str) {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let path = std::path::PathBuf::from(profile)
            .join(".grok")
            .join("computer-use-audit.jsonl");
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or_default();
            let record = json!({"timestampMs": timestamp, "action": action, "windowId": window, "outcome": outcome});
            let _ = writeln!(file, "{}", record);
        }
    }
}

fn int64(value: &Value, key: &str) -> Result<i64, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("缺少或无效的 {key}"))
}
fn ensure_active(state: &ComputerState) -> Result<(), String> {
    if state.active_window.is_none() {
        Err("请先调用 start 选择窗口".into())
    } else {
        Ok(())
    }
}
fn check_state(args: &Value, state: &ComputerState) -> Result<(), String> {
    ensure_active(state)?;
    let id = args
        .get("stateId")
        .and_then(Value::as_u64)
        .ok_or("缺少 stateId")?;
    if id != state.state_id {
        return Err(format!("stateId 已过期，当前值为 {}", state.state_id));
    }
    Ok(())
}
fn observe(state: &mut ComputerState) -> Result<Value, String> {
    state.state_id = state.state_id.saturating_add(1);
    window_state(state)
}
fn window_state(state: &ComputerState) -> Result<Value, String> {
    let hwnd = state.active_window.ok_or("尚未选择窗口")?;
    let capture = platform::window_state(hwnd)?;
    Ok(json!({"content":[
        {"type":"text","text":serde_json::to_string(&json!({
            "stateId":state.state_id,
            "window":capture.window,
            "screenshotSize":{"width":capture.width,"height":capture.height},
            "coordinateSpace":"window-screenshot-pixels",
            "elements":capture.elements,
            "treeTruncated":capture.tree_truncated
        })).map_err(|e| e.to_string())?},
        {"type":"image","data":BASE64.encode(capture.png),"mimeType":"image/png"}
    ]}))
}

fn int(value: &Value, key: &str) -> Result<i32, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
        .ok_or_else(|| format!("缺少或无效的 {key}"))
}

fn ok_text(text: &str) -> Result<Value, String> {
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

#[cfg(windows)]
pub struct Capture {
    pub png: Vec<u8>,
}

fn optional_int(value: &Value, key: &str) -> Option<i32> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .and_then(|number| i32::try_from(number).ok())
}

fn bounded_delta(value: &Value, key: &str) -> Result<Option<i32>, String> {
    let Some(raw) = value.get(key) else {
        return Ok(None);
    };
    let Some(number) = raw.as_i64().and_then(|n| i32::try_from(n).ok()) else {
        return Err(format!("无效的 {key}"));
    };
    if !(-MAX_SCROLL_DELTA..=MAX_SCROLL_DELTA).contains(&number) {
        return Err(format!("{key} 必须在 ±{MAX_SCROLL_DELTA} 之间"));
    }
    Ok(Some(number))
}

fn bounded_duration_ms(value: &Value) -> Result<u64, String> {
    let duration = value
        .get("durationMs")
        .and_then(Value::as_u64)
        .unwrap_or(500);
    if duration > MAX_DRAG_DURATION_MS {
        return Err(format!("durationMs 不能超过 {MAX_DRAG_DURATION_MS}"));
    }
    Ok(duration)
}

fn clamp_window_point(width: i32, height: i32, x: i32, y: i32) -> (i32, i32) {
    (
        x.clamp(0, (width - 1).max(0)),
        y.clamp(0, (height - 1).max(0)),
    )
}

pub struct WindowState {
    pub elements: Vec<serde_json::Value>,
    pub png: Vec<u8>,
    pub width: i32,
    pub height: i32,
    pub window: serde_json::Value,
    pub tree_truncated: bool,
}

#[cfg(windows)]
mod platform {
    use super::{Capture, WindowState};
    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
    use serde_json::Value;
    use std::{cell::RefCell, collections::HashMap, io::Cursor, path::Path};
    use uiautomation::{
        patterns::{UIInvokePattern, UIScrollItemPattern, UIValuePattern},
        types::Handle,
        UIAutomation, UIElement,
    };
    use windows::core::PWSTR;
    use windows::Win32::{
        Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT},
        Graphics::Gdi::*,
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::{
            AttachThreadInput, GetCurrentThreadId, OpenProcess, OpenProcessToken,
            QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::{
            HiDpi::GetDpiForWindow,
            Input::KeyboardAndMouse::*,
            WindowsAndMessaging::{
                BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindowRect, GetWindowTextW,
                GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetCursorPos,
                SetForegroundWindow, ShowWindow, SW_RESTORE,
            },
        },
    };

    thread_local! {
        static ELEMENTS: RefCell<HashMap<String, UIElement>> = RefCell::new(HashMap::new());
    }

    pub fn list_windows() -> Result<Vec<serde_json::Value>, String> {
        let mut out = Vec::new();
        unsafe {
            EnumWindows(Some(enum_window), LPARAM(&mut out as *mut _ as isize))
                .map_err(|e| e.to_string())?;
        }
        Ok(out)
    }

    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        let mut buffer = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buffer);
        let title = String::from_utf16_lossy(&buffer[..len as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            return true.into();
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err()
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return true.into();
        }
        let out = &mut *(lparam.0 as *mut Vec<serde_json::Value>);
        out.push(window_info(hwnd, title));
        true.into()
    }

    fn window_info(hwnd: HWND, title: String) -> serde_json::Value {
        unsafe {
            let mut rect = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            let mut process_id = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
            let executable_path = process_path(process_id);
            let process_name = executable_path
                .as_deref()
                .and_then(|value| Path::new(value).file_stem())
                .and_then(|value| value.to_str())
                .unwrap_or("unknown")
                .to_string();
            let elevated = is_process_elevated(process_id);
            let blocklisted = is_blocked_target(&process_name, &title, executable_path.as_deref());
            let blocked_code = if elevated {
                Some("elevated")
            } else if blocklisted {
                Some("blocklist")
            } else {
                None
            };
            let blocked_reason = match blocked_code {
                Some("elevated") => Some("目标窗口运行于更高或管理员权限级别"),
                Some("blocklist") => Some("该应用位于 Computer Use 不可控制清单"),
                _ => None,
            };
            serde_json::json!({
                "windowId": hwnd.0 as i64,
                "appId": process_name.to_ascii_lowercase(),
                "processId": process_id,
                "processName": process_name,
                "executablePath": executable_path,
                "title": title,
                "bounds": {
                    "x": rect.left,
                    "y": rect.top,
                    "width": rect.right - rect.left,
                    "height": rect.bottom - rect.top
                },
                "dpi": GetDpiForWindow(hwnd),
                "minimized": IsIconic(hwnd).as_bool(),
                "foreground": GetForegroundWindow() == hwnd,
                "controllable": blocked_code.is_none(),
                "blockedReason": blocked_reason,
                "blockedCode": blocked_code
            })
        }
    }

    fn is_blocked_target(process_name: &str, title: &str, executable_path: Option<&str>) -> bool {
        let process = process_name.trim().to_ascii_lowercase();
        let title = title.to_ascii_lowercase();
        let executable = executable_path.unwrap_or("").to_ascii_lowercase();
        let blocked_process = [
            "grox",
            "grox-desktop",
            "grok build desktop",
            "grok-build-desktop",
            "chatgpt",
            "powershell",
            "pwsh",
            "cmd",
            "windowsterminal",
            "wt",
            "conhost",
            "explorer",
            "regedit",
            "mmc",
            "taskmgr",
            "compmgmtlauncher",
            "services",
            "msconfig",
            "gpedit",
            "secpol",
            "lusrmgr",
            "devmgmt",
            "diskmgmt",
            "eventvwr",
            "perfmon",
            "control",
            "systemsettings",
            "applicationframehost",
            "installer",
            "msiexec",
            "trustedinstaller",
            "consent",
            "userac",
            "useracpc",
            "ssh",
            "sftp",
            "scp",
            "putty",
            "winscp",
            "filezilla",
        ]
        .iter()
        .any(|value| process == *value);
        let blocked_title = [
            "grox",
            "grok build desktop",
            "windows security",
            "user account control",
            "用户账户控制",
            "windows 安全",
            "registry editor",
            "注册表编辑器",
            "task manager",
            "任务管理器",
            "services",
            "computer management",
            "local group policy",
        ]
        .iter()
        .any(|value| title.contains(value));
        let blocked_path = [
            r"\explorer.exe",
            r"\regedit.exe",
            r"\mmc.exe",
            r"\taskmgr.exe",
            r"\msiexec.exe",
            r"\consent.exe",
            r"\useraccountcontrolsettings.exe",
        ]
        .iter()
        .any(|suffix| executable.ends_with(suffix));
        blocked_process || blocked_title || blocked_path
    }

    pub fn is_self_elevated() -> bool {
        unsafe { is_process_elevated(std::process::id()) }
    }

    unsafe fn process_path(process_id: u32) -> Option<String> {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut buffer = vec![0u16; 32_768];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .ok()
        .map(|_| String::from_utf16_lossy(&buffer[..size as usize]));
        let _ = CloseHandle(process);
        result
    }

    unsafe fn is_process_elevated(process_id: u32) -> bool {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return false;
        };
        let mut token = Default::default();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
            let _ = CloseHandle(process);
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0;
        let elevated = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok()
            && elevation.TokenIsElevated != 0;
        let _ = CloseHandle(token);
        let _ = CloseHandle(process);
        elevated
    }

    pub fn activate(hwnd: i64) -> Result<(), String> {
        unsafe {
            let handle = HWND(hwnd as *mut _);
            if handle.0.is_null() || !IsWindow(handle).as_bool() {
                return Err("目标窗口不存在".into());
            }
            let mut buffer = [0u16; 512];
            let len = GetWindowTextW(handle, &mut buffer);
            let info = window_info(
                handle,
                String::from_utf16_lossy(&buffer[..len as usize])
                    .trim()
                    .to_string(),
            );
            if info.get("controllable").and_then(Value::as_bool) != Some(true) {
                let code = info
                    .get("blockedCode")
                    .and_then(Value::as_str)
                    .unwrap_or("blocklist");
                return Err(if code == "elevated" {
                    "elevation-blocked: 目标以管理员权限运行，无法控制。请用普通权限重新启动目标程序；Grox 不会控制更高完整性进程，也不会自行提权".into()
                } else {
                    "blocklist: 该应用位于 Computer Use 不可控制清单".into()
                });
            }
            let _ = ShowWindow(handle, SW_RESTORE);
            for attempt in 0..3 {
                if GetForegroundWindow() == handle {
                    return Ok(());
                }
                let foreground = GetForegroundWindow();
                let current_thread = GetCurrentThreadId();
                let target_thread = GetWindowThreadProcessId(handle, None);
                let foreground_thread = if foreground.0.is_null() {
                    0
                } else {
                    GetWindowThreadProcessId(foreground, None)
                };
                let attached_foreground = foreground_thread != 0
                    && foreground_thread != current_thread
                    && AttachThreadInput(current_thread, foreground_thread, true).as_bool();
                let attached_target = target_thread != 0
                    && target_thread != current_thread
                    && AttachThreadInput(current_thread, target_thread, true).as_bool();
                let _ = BringWindowToTop(handle);
                let _ = SetForegroundWindow(handle);
                let _ = SetFocus(handle);
                if attached_target {
                    let _ = AttachThreadInput(current_thread, target_thread, false);
                }
                if attached_foreground {
                    let _ = AttachThreadInput(current_thread, foreground_thread, false);
                }
                std::thread::sleep(std::time::Duration::from_millis(120 + attempt * 80));
            }
            let foreground = GetForegroundWindow();
            let mut foreground_title = [0u16; 512];
            let foreground_length = GetWindowTextW(foreground, &mut foreground_title);
            let foreground_title =
                String::from_utf16_lossy(&foreground_title[..foreground_length as usize])
                    .to_ascii_lowercase();
            if [
                "user account control",
                "用户账户控制",
                "windows security",
                "windows 安全",
            ]
            .iter()
            .any(|value| foreground_title.contains(value))
            {
                Err("uac-handoff: 请由用户手动完成 Windows UAC 或安全确认，然后回到 Grox 调用 resume".into())
            } else {
                Err("Windows 拒绝将目标窗口置于前台".into())
            }
        }
    }

    pub fn window_state(hwnd: i64) -> Result<WindowState, String> {
        activate(hwnd)?;
        let handle = HWND(hwnd as *mut _);
        let mut rect = RECT::default();
        unsafe { GetWindowRect(handle, &mut rect).map_err(|error| error.to_string())? };
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err("目标窗口尺寸无效".into());
        }
        let capture = capture_rect(rect.left, rect.top, width, height)?;
        let mut elements = Vec::new();
        ELEMENTS.with(|values| values.borrow_mut().clear());
        if let Ok(automation) = UIAutomation::new() {
            if let Ok(root) = automation.element_from_handle(Handle::from(hwnd as isize)) {
                if let Ok(walker) = automation.get_control_view_walker() {
                    collect_elements(&walker, &root, &mut elements, rect, 0);
                }
            }
        }
        let mut title_buffer = [0u16; 512];
        let title_length = unsafe { GetWindowTextW(handle, &mut title_buffer) };
        let window = window_info(
            handle,
            String::from_utf16_lossy(&title_buffer[..title_length as usize])
                .trim()
                .to_string(),
        );
        Ok(WindowState {
            png: capture.png,
            elements,
            width,
            height,
            window,
            tree_truncated: ELEMENTS.with(|values| values.borrow().len() >= 240),
        })
    }

    fn collect_elements(
        walker: &uiautomation::UITreeWalker,
        element: &uiautomation::UIElement,
        out: &mut Vec<serde_json::Value>,
        window: RECT,
        depth: usize,
    ) {
        if out.len() >= 240 || depth > 12 {
            return;
        }
        if let Ok(rect) = element.get_bounding_rectangle() {
            let name = element.get_name().unwrap_or_default();
            let control_type = element
                .get_control_type()
                .map(|v| format!("{v:?}"))
                .unwrap_or_default();
            if rect.get_right() > rect.get_left() && rect.get_bottom() > rect.get_top() {
                let element_id = format!("e{}", out.len() + 1);
                let value_pattern = element.get_pattern::<UIValuePattern>().ok();
                let mut patterns = Vec::new();
                if element.get_pattern::<UIInvokePattern>().is_ok() {
                    patterns.push("Invoke");
                }
                if value_pattern.is_some() {
                    patterns.push("Value");
                }
                if element.get_pattern::<UIScrollItemPattern>().is_ok() {
                    patterns.push("ScrollItem");
                }
                ELEMENTS.with(|values| {
                    values
                        .borrow_mut()
                        .insert(element_id.clone(), element.clone());
                });
                out.push(serde_json::json!({
                    "elementId": element_id,
                    "name": name,
                    "controlType": control_type,
                    "value": value_pattern.and_then(|pattern| pattern.get_value().ok()),
                    "bounds": {
                        "x": rect.get_left() - window.left,
                        "y": rect.get_top() - window.top,
                        "width": rect.get_right() - rect.get_left(),
                        "height": rect.get_bottom() - rect.get_top()
                    },
                    "enabled": element.is_enabled().unwrap_or(false),
                    "patterns": patterns
                }));
            }
        }
        if let Ok(mut child) = walker.get_first_child(element) {
            loop {
                collect_elements(walker, &child, out, window, depth + 1);
                match walker.get_next_sibling(&child) {
                    Ok(next) => child = next,
                    Err(_) => break,
                }
                if out.len() >= 240 {
                    break;
                }
            }
        }
    }

    pub fn set_value(hwnd: i64, element_id: &str, value: &str) -> Result<(), String> {
        ensure_target_foreground(hwnd)?;
        let element = find_element(element_id)?;
        let pattern = element
            .get_pattern::<UIValuePattern>()
            .map_err(|_| "目标不支持 ValuePattern；请重新观察并使用点击后输入".to_string())?;
        if pattern.is_readonly().unwrap_or(true) {
            return Err("目标 ValuePattern 为只读".into());
        }
        pattern.set_value(value).map_err(|error| error.to_string())
    }

    fn find_element(element_id: &str) -> Result<UIElement, String> {
        ELEMENTS.with(|values| {
            values
                .borrow()
                .get(element_id)
                .cloned()
                .ok_or_else(|| "elementId 不属于当前界面状态；请重新观察".to_string())
        })
    }

    pub fn target_point(
        hwnd: i64,
        element_id: Option<&str>,
        x: Option<i32>,
        y: Option<i32>,
    ) -> Result<(i32, i32), String> {
        if let Some(element_id) = element_id {
            let element = find_element(element_id)?;
            let bounds = element
                .get_bounding_rectangle()
                .map_err(|error| error.to_string())?;
            let window = window_rect(hwnd)?;
            return Ok(clamp_local_point(
                window,
                bounds.get_left() - window.left + (bounds.get_right() - bounds.get_left()) / 2,
                bounds.get_top() - window.top + (bounds.get_bottom() - bounds.get_top()) / 2,
            ));
        }
        let window = window_rect(hwnd)?;
        Ok(clamp_local_point(
            window,
            x.unwrap_or((window.right - window.left) / 2),
            y.unwrap_or((window.bottom - window.top) / 2),
        ))
    }

    fn capture_rect(x: i32, y: i32, width: i32, height: i32) -> Result<Capture, String> {
        if width <= 0 || height <= 0 {
            return Err("无法读取截图区域尺寸".into());
        }
        unsafe {
            let screen = GetDC(HWND::default());
            let memory = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            let old = SelectObject(memory, bitmap);
            let copied = BitBlt(
                memory,
                0,
                0,
                width,
                height,
                screen,
                x,
                y,
                SRCCOPY | CAPTUREBLT,
            );
            if copied.is_err() {
                let _ = DeleteObject(bitmap);
                let _ = DeleteDC(memory);
                ReleaseDC(HWND::default(), screen);
                return Err("屏幕捕获失败".into());
            }
            let mut info = BITMAPINFO::default();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = width;
            info.bmiHeader.biHeight = -height;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB.0;
            let mut pixels = vec![0u8; width as usize * height as usize * 4];
            let lines = GetDIBits(
                screen,
                bitmap,
                0,
                height as u32,
                Some(pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            );
            SelectObject(memory, old);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(memory);
            ReleaseDC(HWND::default(), screen);
            if lines == 0 {
                return Err("读取截图像素失败".into());
            }
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            let image = ImageBuffer::<Rgba<u8>, _>::from_raw(width as u32, height as u32, pixels)
                .ok_or("截图缓冲区无效")?;
            let mut png = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(image)
                .write_to(&mut png, ImageFormat::Png)
                .map_err(|error| error.to_string())?;
            Ok(Capture {
                png: png.into_inner(),
            })
        }
    }

    pub fn move_mouse(hwnd: i64, x: i32, y: i32) -> Result<(), String> {
        ensure_target_foreground(hwnd)?;
        let (screen_x, screen_y) = to_screen_point(hwnd, x, y)?;
        unsafe { SetCursorPos(screen_x, screen_y).map_err(|error| error.to_string()) }
    }

    pub fn click(hwnd: i64, x: i32, y: i32, button: &str, clicks: u32) -> Result<(), String> {
        move_mouse(hwnd, x, y)?;
        let (down, up) = match button {
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        };
        for _ in 0..clicks.clamp(1, 2) {
            mouse(down, 0)?;
            mouse(up, 0)?;
        }
        Ok(())
    }

    pub fn drag(
        hwnd: i64,
        from_x: i32,
        from_y: i32,
        to_x: i32,
        to_y: i32,
        duration_ms: u64,
    ) -> Result<(), String> {
        let window = window_rect(hwnd)?;
        let (from_x, from_y) = clamp_local_point(window, from_x, from_y);
        let (to_x, to_y) = clamp_local_point(window, to_x, to_y);
        move_mouse(hwnd, from_x, from_y)?;
        mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
        let steps = (duration_ms / 16).clamp(1, 120);
        for step in 1..=steps {
            let t = step as f64 / steps as f64;
            move_mouse(
                hwnd,
                from_x + ((to_x - from_x) as f64 * t) as i32,
                from_y + ((to_y - from_y) as f64 * t) as i32,
            )?;
            std::thread::sleep(std::time::Duration::from_millis(duration_ms / steps));
        }
        mouse(MOUSEEVENTF_LEFTUP, 0)
    }

    pub fn scroll(
        hwnd: i64,
        element_id: Option<&str>,
        x: Option<i32>,
        y: Option<i32>,
        delta_x: i32,
        delta_y: i32,
    ) -> Result<(), String> {
        if let Some(element_id) = element_id {
            if let Ok(pattern) = find_element(element_id).and_then(|element| {
                element
                    .get_pattern::<UIScrollItemPattern>()
                    .map_err(|error| error.to_string())
            }) {
                ensure_target_foreground(hwnd)?;
                return pattern
                    .scroll_into_view()
                    .map_err(|error| error.to_string());
            }
        }
        let (x, y) = target_point(hwnd, element_id, x, y)?;
        move_mouse(hwnd, x, y)?;
        if delta_y != 0 {
            mouse(MOUSEEVENTF_WHEEL, delta_y as u32)?;
        }
        if delta_x != 0 {
            mouse(MOUSEEVENTF_HWHEEL, delta_x as u32)?;
        }
        Ok(())
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: u32) -> Result<(), String> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    mouseData: data,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        send(&[input])
    }

    pub fn type_text(hwnd: i64, text: &str) -> Result<(), String> {
        ensure_target_foreground(hwnd)?;
        let mut inputs = Vec::new();
        for unit in text.encode_utf16() {
            inputs.push(unicode_input(unit, false));
            inputs.push(unicode_input(unit, true));
        }
        for chunk in inputs.chunks(512) {
            send(chunk)?;
        }
        Ok(())
    }

    fn key_input(key: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    ..Default::default()
                },
            },
        }
    }

    fn unicode_input(unit: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE
                        | if up {
                            KEYEVENTF_KEYUP
                        } else {
                            KEYBD_EVENT_FLAGS(0)
                        },
                    ..Default::default()
                },
            },
        }
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == inputs.len() as u32 {
            Ok(())
        } else {
            Err(format!("仅发送了 {sent}/{} 个输入事件", inputs.len()))
        }
    }

    fn window_rect(hwnd: i64) -> Result<RECT, String> {
        unsafe {
            let handle = HWND(hwnd as *mut _);
            if handle.0.is_null() || !IsWindow(handle).as_bool() {
                return Err("目标窗口不存在".into());
            }
            let mut rect = RECT::default();
            GetWindowRect(handle, &mut rect).map_err(|error| error.to_string())?;
            if rect.right <= rect.left || rect.bottom <= rect.top {
                return Err("目标窗口尺寸无效".into());
            }
            Ok(rect)
        }
    }

    fn clamp_local_point(window: RECT, x: i32, y: i32) -> (i32, i32) {
        super::clamp_window_point(window.right - window.left, window.bottom - window.top, x, y)
    }

    fn to_screen_point(hwnd: i64, x: i32, y: i32) -> Result<(i32, i32), String> {
        let window = window_rect(hwnd)?;
        let (x, y) = clamp_local_point(window, x, y);
        Ok((window.left + x, window.top + y))
    }

    fn ensure_target_foreground(hwnd: i64) -> Result<(), String> {
        let handle = HWND(hwnd as *mut _);
        let _ = window_rect(hwnd)?;
        if !unsafe { IsWindow(handle).as_bool() } {
            return Err("目标窗口不存在".into());
        }
        let mut buffer = [0u16; 512];
        let len = unsafe { GetWindowTextW(handle, &mut buffer) };
        let title = String::from_utf16_lossy(&buffer[..len as usize])
            .trim()
            .to_string();
        let info = window_info(handle, title);
        if info.get("controllable").and_then(Value::as_bool) != Some(true) {
            let code = info
                .get("blockedCode")
                .and_then(Value::as_str)
                .unwrap_or("blocklist");
            return Err(if code == "elevated" {
                "elevation-blocked: 目标以管理员权限运行，无法控制".into()
            } else {
                "blocklist: 该应用位于 Computer Use 不可控制清单".into()
            });
        }
        let foreground = unsafe { GetForegroundWindow() };
        if foreground != handle {
            return Err(
                "目标窗口已不在前台；为避免控制错误应用，请重新调用 activate_window 或 get_window_state"
                    .into(),
            );
        }
        Ok(())
    }

    fn deny_dangerous_keys(keys: &[&str]) -> Result<(), String> {
        if keys.is_empty() || keys.len() > super::MAX_KEYS {
            return Err(format!("keys 数量必须在 1–{} 之间", super::MAX_KEYS));
        }
        let upper = keys
            .iter()
            .map(|key| key.trim().to_ascii_uppercase())
            .collect::<Vec<_>>();
        let has = |name: &str| upper.iter().any(|key| key == name);
        if has("WIN") || has("META") || has("LWIN") || has("RWIN") {
            return Err("不允许发送 Windows 徽标键".into());
        }
        if has("ALT") && (has("TAB") || has("F4") || has("ESC") || has("ESCAPE")) {
            return Err("不允许发送 Alt+Tab / Alt+F4 / Alt+Esc 等系统切换组合键".into());
        }
        if (has("CTRL") || has("CONTROL")) && (has("ESC") || has("ESCAPE")) {
            return Err("不允许发送 Ctrl+Esc 系统组合键".into());
        }
        if (has("CTRL") || has("CONTROL")) && has("SHIFT") && (has("ESC") || has("ESCAPE")) {
            return Err("不允许发送 Ctrl+Shift+Esc".into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn deny_dangerous_keys_for_test(keys: &[&str]) -> Result<(), String> {
        deny_dangerous_keys(keys)
    }

    pub fn key(hwnd: i64, keys: &[&str]) -> Result<(), String> {
        deny_dangerous_keys(keys)?;
        ensure_target_foreground(hwnd)?;
        let mut virtual_keys = Vec::new();
        for name in keys {
            let (key, modifiers) = vk(name)?;
            if modifiers & 2 != 0 && !virtual_keys.contains(&VK_CONTROL) {
                virtual_keys.push(VK_CONTROL);
            }
            if modifiers & 4 != 0 && !virtual_keys.contains(&VK_MENU) {
                virtual_keys.push(VK_MENU);
            }
            if modifiers & 1 != 0 && !virtual_keys.contains(&VK_SHIFT) {
                virtual_keys.push(VK_SHIFT);
            }
            if !virtual_keys.contains(&key) {
                virtual_keys.push(key);
            }
        }
        let mut inputs = Vec::with_capacity(virtual_keys.len() * 2);
        for key in &virtual_keys {
            inputs.push(key_input(*key, false));
        }
        for key in virtual_keys.iter().rev() {
            inputs.push(key_input(*key, true));
        }
        send(&inputs)
    }

    fn vk(name: &str) -> Result<(VIRTUAL_KEY, u8), String> {
        let upper = name.trim().to_ascii_uppercase();
        let key = match upper.as_str() {
            "CTRL" | "CONTROL" => VK_CONTROL,
            "SHIFT" => VK_SHIFT,
            "ALT" => VK_MENU,
            "WIN" | "META" | "LWIN" | "RWIN" => {
                return Err("不允许发送 Windows 徽标键".into());
            }
            "ENTER" | "RETURN" => VK_RETURN,
            "ESC" | "ESCAPE" => VK_ESCAPE,
            "TAB" => VK_TAB,
            "SPACE" => VK_SPACE,
            "BACKSPACE" => VK_BACK,
            "DELETE" | "DEL" => VK_DELETE,
            "UP" => VK_UP,
            "DOWN" => VK_DOWN,
            "LEFT" => VK_LEFT,
            "RIGHT" => VK_RIGHT,
            "HOME" => VK_HOME,
            "END" => VK_END,
            "PAGEUP" => VK_PRIOR,
            "PAGEDOWN" => VK_NEXT,
            "F1" => VK_F1,
            "F2" => VK_F2,
            "F3" => VK_F3,
            "F4" => VK_F4,
            "F5" => VK_F5,
            "F6" => VK_F6,
            "F7" => VK_F7,
            "F8" => VK_F8,
            "F9" => VK_F9,
            "F10" => VK_F10,
            "F11" => VK_F11,
            "F12" => VK_F12,
            _ => {
                let mut characters = name.chars();
                let Some(character) = characters.next() else {
                    return Err("缺少按键".into());
                };
                if characters.next().is_some() {
                    return Err(format!("不支持的按键：{name}"));
                }
                let translated = unsafe { VkKeyScanW(character as u16) };
                if translated == -1 {
                    return Err(format!("当前 Windows 键盘布局不支持按键：{name}"));
                }
                return Ok((
                    VIRTUAL_KEY((translated as u16 & 0xff) as u16),
                    ((translated as u16 >> 8) & 0x07) as u8,
                ));
            }
        };
        Ok((key, 0))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::WindowState;
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_png() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("grox-cu-{nanos}.png"))
    }

    fn read_png(path: &PathBuf) -> Result<Vec<u8>, String> {
        let bytes = fs::read(path).map_err(|error| format!("无法读取截图：{error}"))?;
        let _ = fs::remove_file(path);
        if bytes.is_empty() {
            return Err("截图为空".into());
        }
        Ok(bytes)
    }

    #[cfg(target_os = "macos")]
    fn capture_screen_png() -> Result<Vec<u8>, String> {
        let path = temp_png();
        let status = Command::new("screencapture")
            .args(["-x", "-t", "png"])
            .arg(&path)
            .status()
            .map_err(|error| format!("无法调用 screencapture：{error}"))?;
        if !status.success() {
            return Err("screencapture 失败；请确认已授予屏幕录制权限".into());
        }
        read_png(&path)
    }

    #[cfg(not(target_os = "macos"))]
    fn capture_screen_png() -> Result<Vec<u8>, String> {
        let path = temp_png();
        let attempts = [
            ("gnome-screenshot", vec!["-f".into(), path.to_string_lossy().to_string()]),
            ("import", vec!["-window".into(), "root".into(), path.to_string_lossy().to_string()]),
            ("scrot", vec![path.to_string_lossy().to_string()]),
        ];
        for (bin, args) in attempts {
            if let Ok(status) = Command::new(bin).args(&args).status() {
                if status.success() && path.exists() {
                    return read_png(&path);
                }
            }
        }
        Err("无法截图：请安装 gnome-screenshot、ImageMagick(import) 或 scrot".into())
    }

    pub fn is_self_elevated() -> bool {
        false
    }

    pub fn list_windows() -> Result<Vec<serde_json::Value>, String> {
        #[cfg(target_os = "macos")]
        {
            let output = Command::new("osascript")
                .args([
                    "-e",
                    r#"set out to ""
tell application "System Events"
  set procs to application processes whose background only is false and visible is true
  repeat with p in procs
    set pname to name of p
    try
      set wins to windows of p
      repeat with w in wins
        set wname to name of w
        set out to out & pname & character id 9 & wname & linefeed
      end repeat
    end try
  end repeat
end tell
return out"#,
                ])
                .output()
                .map_err(|error| format!("无法枚举窗口：{error}"))?;
            if !output.status.success() {
                return Err("无法枚举窗口；请在「系统设置 → 隐私与安全性 → 辅助功能」中允许 Grox".into());
            }
            let text = String::from_utf8_lossy(&output.stdout);
            let mut items = Vec::new();
            for (index, line) in text.lines().enumerate() {
                let mut parts = line.splitn(2, '\t');
                let Some(app) = parts.next() else { continue };
                let title = parts.next().unwrap_or("").trim();
                if app.trim().is_empty() {
                    continue;
                }
                items.push(json!({
                    "windowId": (index as i64) + 1,
                    "title": title,
                    "app": app.trim(),
                    "pid": 0,
                }));
            }
            if items.is_empty() {
                items.push(json!({
                    "windowId": 1,
                    "title": "Desktop",
                    "app": "Screen",
                    "pid": 0,
                }));
            }
            return Ok(items);
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(vec![json!({
                "windowId": 1,
                "title": "Desktop",
                "app": "Screen",
                "pid": 0,
            })])
        }
    }

    pub fn activate(window_id: i64) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let windows = list_windows()?;
            let Some(target) = windows
                .iter()
                .find(|item| item.get("windowId").and_then(|v| v.as_i64()) == Some(window_id))
            else {
                return Err("窗口不存在".into());
            };
            let app = target
                .get("app")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .replace('\\', "\\\\")
                .replace('"', "\\\"");
            let script = format!(
                r#"tell application "{app}" to activate"#
            );
            let status = Command::new("osascript")
                .args(["-e", &script])
                .status()
                .map_err(|error| format!("无法激活窗口：{error}"))?;
            if !status.success() {
                return Err("激活窗口失败；请授予辅助功能权限".into());
            }
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window_id;
            Ok(())
        }
    }

    pub fn window_state(window_id: i64) -> Result<WindowState, String> {
        let _ = window_id;
        let png = capture_screen_png()?;
        let (width, height) = image::load_from_memory(&png)
            .map(|image| (image.width() as i32, image.height() as i32))
            .unwrap_or((1280, 720));
        let windows = list_windows().unwrap_or_default();
        let window = windows
            .into_iter()
            .find(|item| item.get("windowId").and_then(|v| v.as_i64()) == Some(window_id))
            .unwrap_or_else(|| {
                json!({
                    "windowId": window_id,
                    "title": "Desktop",
                    "app": "Screen",
                    "pid": 0,
                })
            });
        Ok(WindowState {
            elements: Vec::new(),
            png,
            width,
            height,
            window,
            tree_truncated: true,
        })
    }

    pub fn set_value(_: i64, _: &str, _: &str) -> Result<(), String> {
        Err("当前平台不支持 UI Automation set_value；请改用 type / click".into())
    }

    pub fn target_point(
        _: i64,
        _: Option<&str>,
        x: Option<i32>,
        y: Option<i32>,
    ) -> Result<(i32, i32), String> {
        Ok((x.unwrap_or(0), y.unwrap_or(0)))
    }

    pub fn move_mouse(_: i64, x: i32, y: i32) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let script = format!(
                r#"tell application "System Events" to set position of mouse to {{{x}, {y}}}"#
            );
            // System Events does not expose mouse position set on all macOS versions.
            // Prefer cliclick when present.
            if Command::new("cliclick")
                .arg(format!("m:{x},{y}"))
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
            {
                return Ok(());
            }
            let _ = script;
            return Err("macOS 鼠标移动需要安装 cliclick（brew install cliclick）或改用 click".into());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (x, y);
            Err("Linux Computer Use 鼠标控制需要 xdotool；当前版本仅支持截图观察".into())
        }
    }

    pub fn click(_: i64, x: i32, y: i32, button: &str, clicks: u32) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let button_flag = match button {
                "right" => "rc",
                "middle" => "mc",
                _ => "c",
            };
            let repeats = clicks.max(1).min(3);
            for _ in 0..repeats {
                let ok = Command::new("cliclick")
                    .arg(format!("{button_flag}:{x},{y}"))
                    .status()
                    .map(|status| status.success())
                    .unwrap_or(false);
                if !ok {
                    return Err("macOS 点击需要 cliclick（brew install cliclick），并授予辅助功能权限".into());
                }
            }
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (x, y, button, clicks);
            Err("Linux Computer Use 点击需要 xdotool；当前版本仅支持截图观察".into())
        }
    }

    pub fn drag(_: i64, _: i32, _: i32, _: i32, _: i32, _: u64) -> Result<(), String> {
        Err("当前平台暂不支持 drag".into())
    }

    pub fn scroll(
        _: i64,
        _: Option<&str>,
        _: Option<i32>,
        _: Option<i32>,
        _: i32,
        _: i32,
    ) -> Result<(), String> {
        Err("当前平台暂不支持 scroll".into())
    }

    pub fn key(_: i64, keys: &[&str]) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let chord = keys.join("+").to_lowercase();
            let script = format!(
                r#"tell application "System Events" to keystroke "{}" using {{}}"#,
                chord.replace('"', "")
            );
            // Best-effort single character; complex chords need cliclick/kd
            if keys.len() == 1 && keys[0].len() == 1 {
                let status = Command::new("osascript")
                    .args(["-e", &script])
                    .status()
                    .map_err(|error| format!("无法发送按键：{error}"))?;
                if status.success() {
                    return Ok(());
                }
            }
            return Err(format!(
                "macOS 复杂按键组合请安装 cliclick；收到：{}",
                keys.join("+")
            ));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = keys;
            Err("Linux Computer Use 按键需要 xdotool；当前版本仅支持截图观察".into())
        }
    }

    pub fn type_text(_: i64, text: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            if text.chars().any(char::is_control) {
                return Err("输入文本不能包含控制字符".into());
            }
            let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!(
                r#"tell application "System Events" to keystroke "{escaped}""#
            );
            let status = Command::new("osascript")
                .args(["-e", &script])
                .status()
                .map_err(|error| format!("无法输入文本：{error}"))?;
            if !status.success() {
                return Err("输入失败；请授予辅助功能权限".into());
            }
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = text;
            Err("Linux Computer Use 输入需要 xdotool；当前版本仅支持截图观察".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_schemas_are_specific_and_stateful() {
        let listed = tools();
        let click = listed
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some("click"))
            .expect("click tool");
        let schema = click.get("inputSchema").expect("click schema");
        assert!(schema["properties"].get("stateId").is_some());
        assert!(schema["properties"].get("elementId").is_some());
        assert!(schema["properties"].get("text").is_none());

        let scroll = listed
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some("scroll"))
            .expect("scroll tool");
        assert!(scroll["inputSchema"]["properties"].get("deltaX").is_some());
        assert!(scroll["inputSchema"]["properties"].get("deltaY").is_some());
    }

    #[test]
    fn emergency_stop_is_sticky_for_the_mcp_process() {
        let mut state = ComputerState::default();
        call_tool_inner("stop", &json!({}), &mut state).expect("stop succeeds");
        let error = call_tool_inner("start", &json!({"windowId": 1}), &mut state)
            .expect_err("start must remain blocked");
        assert!(error.contains("必须由用户重新创建或加载会话"));
    }

    #[test]
    fn pause_blocks_actions_until_resume_or_stop() {
        let mut state = ComputerState {
            active_window: Some(1),
            ..ComputerState::default()
        };
        call_tool_inner("pause", &json!({}), &mut state).expect("pause succeeds");
        let error = call_tool_inner("get_window_state", &json!({}), &mut state)
            .expect_err("observation must stay paused");
        assert!(error.contains("已暂停"));
    }

    #[test]
    fn window_coordinates_are_clamped_to_the_selected_window() {
        assert_eq!(clamp_window_point(800, 600, -50, 900), (0, 599));
        assert_eq!(clamp_window_point(800, 600, 120, 300), (120, 300));
    }

    #[test]
    fn elevation_and_uac_failures_remain_machine_readable() {
        let elevated: Value =
            serde_json::from_str(&classified_error("elevation-blocked: 管理员窗口"))
                .expect("structured elevation error");
        assert_eq!(elevated["errorCode"], "elevation-blocked");
        let uac: Value = serde_json::from_str(&classified_error("uac-handoff: 等待用户确认"))
            .expect("structured UAC error");
        assert_eq!(uac["errorCode"], "uac-handoff");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_dangerous_system_chords() {
        assert!(platform::deny_dangerous_keys_for_test(&["WIN", "R"]).is_err());
        assert!(platform::deny_dangerous_keys_for_test(&["ALT", "TAB"]).is_err());
        assert!(platform::deny_dangerous_keys_for_test(&["ALT", "F4"]).is_err());
        assert!(platform::deny_dangerous_keys_for_test(&["CTRL", "C"]).is_ok());
    }

    #[test]
    fn emergency_stop_marker_round_trips_for_a_lease() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let lease_id = format!("{nonce:032x}");
        clear_emergency_stop(&lease_id).expect("clean test lease");
        mark_emergency_stop(&lease_id).expect("mark emergency stop");
        assert!(emergency_stop_requested(&lease_id));
        clear_emergency_stop(&lease_id).expect("clear emergency stop");
        assert!(!emergency_stop_requested(&lease_id));
    }
}
