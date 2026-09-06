//! 交互式 Grok OAuth 的 Host 生命周期。
//!
//! WebView 只能开始、取消和读取状态；认证方法、URL 轮询、浏览器打开、超时、
//! ACP 请求归属和运行时换代都由本服务裁决。

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use tauri::Emitter;
use tokio::sync::{oneshot, watch};

use crate::{
    acp_host::AcpHostError,
    agent_runtime::{self, AgentAuthenticationState},
    host_core::ensure_main_acp_owner,
    host_core::parse_browser_url,
    host_core::request_acp_json,
    host_core::request_acp_json_tracked,
    host_core::spawn_system_browser,
    turn_runtime::AcpRequestTracker,
    host_core::AcpState,
    McpLeaseStore,
};

const INTERACTIVE_AUTH_TIMEOUT_MS: u64 = 5 * 60 * 1_000;
const AUTH_URL_REQUEST_TIMEOUT_MS: u64 = 3_000;
const AUTH_URL_POLL_ATTEMPTS: usize = 60;
const AUTH_URL_POLL_DELAY_MS: u64 = 50;

struct AgentAuthenticationAttempt {
    id: u64,
    generation: u64,
    request_seq: u64,
    cancel: watch::Receiver<bool>,
}

struct AgentAuthenticationStart {
    /// 只有第一个调用者负责执行认证；后续调用者只等待同一个结果。
    attempt: Option<AgentAuthenticationAttempt>,
    completion: oneshot::Receiver<Result<AgentAuthenticationState, AcpHostError>>,
}

struct ActiveAuthentication {
    id: u64,
    generation: u64,
    cancel: watch::Sender<bool>,
    waiters: Vec<oneshot::Sender<Result<AgentAuthenticationState, AcpHostError>>>,
}

#[derive(Default)]
struct AuthenticationLifecycleInner {
    next_id: u64,
    active: Option<ActiveAuthentication>,
}

/// 只保存活动事务和等待者；认证快照仍只保存在 `AcpState.connection`，避免
/// 出现第二份“是否已登录”的事实。
#[derive(Default)]
pub(crate) struct AgentAuthenticationLifecycle {
    inner: Mutex<AuthenticationLifecycleInner>,
}

impl AgentAuthenticationLifecycle {
    fn begin(&self, generation: u64) -> Result<AgentAuthenticationStart, AcpHostError> {
        let (reply, completion) = oneshot::channel();
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(active) = inner.active.as_mut() {
            if active.generation != generation {
                return Err(AcpHostError::operation(
                    "AUTH_RUNTIME_CHANGED",
                    "认证事务属于已替换的 Agent 运行时，请重新发起登录",
                ));
            }
            active.waiters.push(reply);
            return Ok(AgentAuthenticationStart {
                attempt: None,
                completion,
            });
        }

        inner.next_id = inner.next_id.wrapping_add(1).max(1);
        let id = inner.next_id;
        let (cancel, cancel_rx) = watch::channel(false);
        inner.active = Some(ActiveAuthentication {
            id,
            generation,
            cancel,
            waiters: vec![reply],
        });
        Ok(AgentAuthenticationStart {
            attempt: Some(AgentAuthenticationAttempt {
                id,
                generation,
                request_seq: id,
                cancel: cancel_rx,
            }),
            completion,
        })
    }

    fn finish(
        &self,
        attempt_id: u64,
        result: Result<AgentAuthenticationState, AcpHostError>,
    ) -> bool {
        let waiters = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if !inner
                .active
                .as_ref()
                .is_some_and(|active| active.id == attempt_id)
            {
                return false;
            }
            inner
                .active
                .take()
                .map(|active| active.waiters)
                .unwrap_or_default()
        };
        for waiter in waiters {
            let _ = waiter.send(result.clone());
        }
        true
    }

    pub(crate) fn cancel_active(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .as_ref()
            .is_some_and(|active| active.cancel.send(true).is_ok())
    }

    pub(crate) fn reset(&self, error: AcpHostError) {
        let active = self
            .inner
            .lock()
            .unwrap_or_else(|failure| failure.into_inner())
            .active
            .take();
        let Some(active) = active else {
            return;
        };
        let _ = active.cancel.send(true);
        for waiter in active.waiters {
            let _ = waiter.send(Err(error.clone()));
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .is_some()
    }
}

#[derive(Default)]
struct AuthenticationRequestTracker {
    request_id: AtomicU64,
}

impl AcpRequestTracker for AuthenticationRequestTracker {
    fn request_started(&self, request_id: u64, method: &str) -> Result<(), AcpHostError> {
        if method != "authenticate" {
            return Err(AcpHostError::protocol(
                "AUTH_REQUEST_INVALID",
                "认证事务只能跟踪 authenticate 请求",
            ));
        }
        self.request_id
            .compare_exchange(0, request_id, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| {
                AcpHostError::protocol("AUTH_REQUEST_DUPLICATED", "认证事务重复注册了 ACP 请求")
            })
    }

    fn request_finished(&self, request_id: u64) {
        let _ =
            self.request_id
                .compare_exchange(request_id, 0, Ordering::AcqRel, Ordering::Acquire);
    }
}

impl AuthenticationRequestTracker {
    fn active_request_id(&self) -> Option<u64> {
        match self.request_id.load(Ordering::Acquire) {
            0 => None,
            request_id => Some(request_id),
        }
    }
}

fn emit_state(app: &tauri::AppHandle, auth: &AgentAuthenticationState) {
    let _ = app.emit("agent-runtime-auth-state", auth);
}

fn runtime_changed() -> AcpHostError {
    AcpHostError::environment(
        "AUTH_RUNTIME_CHANGED",
        "认证期间 Agent 运行时已退出或被替换",
        false,
        false,
        "重新连接 Agent 后再次登录",
    )
}

async fn wait_for_cancel(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}

fn map_auth_result(result: Result<serde_json::Value, AcpHostError>) -> Result<(), AcpHostError> {
    result.map(|_| ()).map_err(|error| {
        if error.code == "ACP_REQUEST_TIMEOUT" {
            AcpHostError::environment(
                "AUTH_TIMEOUT",
                "Grok 登录在 5 分钟内没有完成",
                false,
                false,
                "检查登录页或网络后重新发起登录",
            )
        } else {
            error
        }
    })
}

async fn abort(
    state: &AcpState,
    leases: &McpLeaseStore,
    generation: u64,
    request_seq: u64,
    tracker: &AuthenticationRequestTracker,
    failure: AcpHostError,
) -> AcpHostError {
    let _ = request_acp_json(
        state,
        leases,
        "x.ai/auth/cancel",
        serde_json::json!({ "request_seq": request_seq }),
        generation,
        AUTH_URL_REQUEST_TIMEOUT_MS,
        None,
    )
    .await;
    if let Some(request_id) = tracker.active_request_id() {
        state
            .requests
            .reject(request_id, generation, failure.clone())
            .await;
    }
    failure
}

async fn run(
    state: &AcpState,
    leases: &McpLeaseStore,
    method_id: &str,
    attempt: &mut AgentAuthenticationAttempt,
) -> Result<(), AcpHostError> {
    let tracker = AuthenticationRequestTracker::default();
    let mut authenticate = Box::pin(request_acp_json_tracked(
        state,
        leases,
        "authenticate",
        serde_json::json!({
            "methodId": method_id,
            "_meta": {
                "use_oauth": true,
                "force_interactive": true,
                "request_seq": attempt.request_seq,
            },
        }),
        attempt.generation,
        INTERACTIVE_AUTH_TIMEOUT_MS,
        None,
        Some(&tracker),
    ));

    let mut auth_url = None;
    for poll in 0..AUTH_URL_POLL_ATTEMPTS {
        if poll > 0 {
            tokio::select! {
                _ = wait_for_cancel(&mut attempt.cancel) => {
                    return Err(abort(
                        state,
                        leases,
                        attempt.generation,
                        attempt.request_seq,
                        &tracker,
                        AcpHostError::operation("AUTH_CANCELLED", "登录已由用户取消"),
                    ).await);
                }
                result = &mut authenticate => return map_auth_result(result),
                _ = tokio::time::sleep(Duration::from_millis(AUTH_URL_POLL_DELAY_MS)) => {}
            }
        }

        let get_url = request_acp_json(
            state,
            leases,
            "x.ai/auth/get_url",
            serde_json::json!({}),
            attempt.generation,
            AUTH_URL_REQUEST_TIMEOUT_MS,
            None,
        );
        tokio::pin!(get_url);
        let response = tokio::select! {
            _ = wait_for_cancel(&mut attempt.cancel) => {
                return Err(abort(
                    state,
                    leases,
                    attempt.generation,
                    attempt.request_seq,
                    &tracker,
                    AcpHostError::operation("AUTH_CANCELLED", "登录已由用户取消"),
                ).await);
            }
            result = &mut authenticate => return map_auth_result(result),
            response = &mut get_url => response,
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                return Err(abort(
                    state,
                    leases,
                    attempt.generation,
                    attempt.request_seq,
                    &tracker,
                    error,
                )
                .await);
            }
        };
        auth_url = response
            .get("auth_url")
            .or_else(|| response.get("authUrl"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        if auth_url.is_some() {
            break;
        }
    }

    let auth_url = match auth_url {
        Some(auth_url) => auth_url,
        None => {
            return Err(abort(
                state,
                leases,
                attempt.generation,
                attempt.request_seq,
                &tracker,
                AcpHostError::environment(
                    "AUTH_URL_UNAVAILABLE",
                    "Grok Agent 没有返回登录链接",
                    false,
                    false,
                    "确认网络可访问 Grok 登录服务后重试",
                ),
            )
            .await);
        }
    };
    let parsed = match parse_browser_url(&auth_url) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Err(abort(
                state,
                leases,
                attempt.generation,
                attempt.request_seq,
                &tracker,
                AcpHostError::protocol(
                    "AUTH_URL_INVALID",
                    format!("Grok Agent 返回了不安全的登录链接：{error}"),
                ),
            )
            .await);
        }
    };
    if let Err(error) = spawn_system_browser(&parsed) {
        return Err(abort(
            state,
            leases,
            attempt.generation,
            attempt.request_seq,
            &tracker,
            AcpHostError::environment(
                "AUTH_BROWSER_OPEN_FAILED",
                error,
                false,
                false,
                "请检查系统默认浏览器后重新登录",
            ),
        )
        .await);
    }

    tokio::select! {
        _ = wait_for_cancel(&mut attempt.cancel) => {
            Err(abort(
                state,
                leases,
                attempt.generation,
                attempt.request_seq,
                &tracker,
                AcpHostError::operation("AUTH_CANCELLED", "登录已由用户取消"),
            ).await)
        }
        result = &mut authenticate => map_auth_result(result),
    }
}

#[tauri::command]
pub(crate) async fn agent_runtime_auth_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<AgentAuthenticationState, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    state
        .ready_connection()
        .await
        .map(|connection| connection.auth)
        .ok_or_else(|| {
            AcpHostError::environment(
                "AUTH_RUNTIME_OFFLINE",
                "Agent 运行时尚未连接，无法读取认证状态",
                false,
                false,
                "先重新连接 Agent",
            )
        })
}

#[tauri::command]
pub(crate) async fn agent_runtime_authenticate(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
    leases: tauri::State<'_, Arc<McpLeaseStore>>,
) -> Result<AgentAuthenticationState, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    let connection = state.ready_connection().await.ok_or_else(|| {
        AcpHostError::environment(
            "AUTH_RUNTIME_OFFLINE",
            "Agent 运行时尚未连接，无法开始登录",
            false,
            false,
            "先重新连接 Agent",
        )
    })?;
    let (method_id, label) = agent_runtime::interactive_auth_method(&connection.initialize)
        .ok_or_else(|| {
            AcpHostError::protocol(
                "AUTH_METHOD_UNAVAILABLE",
                "Grok Agent 没有声明可用的交互认证方式",
            )
        })?;
    let start = state.authentication.begin(connection.generation)?;
    if let Some(mut attempt) = start.attempt {
        let in_progress = AgentAuthenticationState {
            required: true,
            in_progress: true,
            method_id: Some(method_id.clone()),
            label: Some(label.clone()),
            error: None,
        };
        if !state.set_authentication_state(connection.generation, in_progress.clone()) {
            state
                .authentication
                .finish(attempt.id, Err(runtime_changed()));
        } else {
            emit_state(&app, &in_progress);
            let app = app.clone();
            let state = state.inner().clone();
            let leases = leases.inner().clone();
            tauri::async_runtime::spawn(async move {
                let result = run(state.as_ref(), leases.as_ref(), &method_id, &mut attempt).await;
                let auth = AgentAuthenticationState {
                    required: result.is_err(),
                    in_progress: false,
                    method_id: Some(method_id),
                    label: Some(label),
                    error: result.as_ref().err().map(|error| error.message.clone()),
                };
                let completion = match result {
                    Ok(()) => Ok(auth.clone()),
                    Err(error) => Err(error),
                };
                if state.set_authentication_state(attempt.generation, auth.clone()) {
                    emit_state(&app, &auth);
                    state.authentication.finish(attempt.id, completion);
                } else {
                    state
                        .authentication
                        .finish(attempt.id, Err(runtime_changed()));
                }
            });
        }
    }
    start.completion.await.map_err(|_| {
        AcpHostError::environment(
            "AUTH_LIFECYCLE_CLOSED",
            "认证事务在返回结果前已被 Host 清算",
            false,
            false,
            "重新连接 Agent 后再次登录",
        )
    })?
}

#[tauri::command]
pub(crate) async fn agent_runtime_auth_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<AgentAuthenticationState, AcpHostError> {
    ensure_main_acp_owner(window.label())
        .map_err(|error| AcpHostError::operation("ACP_WINDOW_NOT_OWNER", error))?;
    state.authentication.cancel_active();
    agent_runtime_auth_status(window, state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_deduplicates_waiters_and_finishes_once() {
        tauri::async_runtime::block_on(async {
            let lifecycle = AgentAuthenticationLifecycle::default();
            let first = lifecycle.begin(7).unwrap();
            let second = lifecycle.begin(7).unwrap();
            assert!(first.attempt.is_some());
            assert!(second.attempt.is_none());
            assert!(lifecycle.is_active());

            let attempt_id = first.attempt.as_ref().unwrap().id;
            let state = AgentAuthenticationState {
                required: false,
                in_progress: false,
                method_id: Some("grok.com".into()),
                label: Some("Grok account".into()),
                error: None,
            };
            assert!(lifecycle.finish(attempt_id, Ok(state.clone())));
            assert!(!lifecycle.finish(attempt_id, Ok(state.clone())));
            assert_eq!(first.completion.await.unwrap().unwrap(), state);
            assert_eq!(second.completion.await.unwrap().unwrap(), state);
            assert!(!lifecycle.is_active());
        });
    }

    #[test]
    fn cancel_is_sticky_and_reset_rejects_waiters() {
        tauri::async_runtime::block_on(async {
            let lifecycle = AgentAuthenticationLifecycle::default();
            let start = lifecycle.begin(3).unwrap();
            let mut attempt = start.attempt.unwrap();
            assert!(lifecycle.cancel_active());
            attempt.cancel.changed().await.unwrap();
            assert!(*attempt.cancel.borrow());

            lifecycle.reset(AcpHostError::operation(
                "AUTH_RUNTIME_CHANGED",
                "运行时已替换",
            ));
            let error = start.completion.await.unwrap().unwrap_err();
            assert_eq!(error.code, "AUTH_RUNTIME_CHANGED");
            assert!(!lifecycle.is_active());
        });
    }

    #[test]
    fn timeout_is_presented_as_an_environment_error() {
        let error = map_auth_result(Err(AcpHostError::environment(
            "ACP_REQUEST_TIMEOUT",
            "request timeout",
            true,
            true,
            "retry",
        )))
        .unwrap_err();
        assert_eq!(error.domain, "environment");
        assert_eq!(error.code, "AUTH_TIMEOUT");
    }
}
