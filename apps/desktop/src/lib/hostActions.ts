import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { bridge } from "../bridge";
import type { ConfigDocument } from "../bridge/types";

export const runtimeCall = <T>(method: string, params?: Record<string, unknown>) => bridge.callExtension(method, params) as Promise<T>;
export const readConfigDocuments = (cwd: string) => bridge.readConfigDocuments(cwd);
export const writeConfigDocument = (document: ConfigDocument, cwd: string) => bridge.writeConfigDocument(document, cwd);
export const loadRuntimeSession = (id: string) => bridge.loadSession(id);

/** 订阅 Host 事件（如媒体生成进度）；组件经此入口，不直连 Tauri event。 */
export const hostListen = <T>(event: string, handler: (payload: T) => void) =>
  listen<T>(event, ({ payload }) => handler(payload));

/** 当前窗口代理（标题栏最小化/最大化/关闭）。仅在 Tauri 环境调用。 */
export const currentWindow = () => getCurrentWindow();

/** UI 可用的最小 Host 副作用入口；具体命令名不再散落在组件里。 */
export const openExternal = (url: string) => invoke<void>("open_external", { url });
export const installUpdate = (version: string) => invoke<void>("install_update", { version });
export const rollbackUpdate = (version: string) => invoke<void>("rollback_update", { version });
export const revealSupportBundle = (path: string) => invoke<void>("reveal_support_bundle", { path });
export const openInApp = (cwd: string, app: string) => invoke<void>("open_in_app", { cwd, app });
export const releaseMediaReference = (cwd: string, id: string) => invoke<void>("release_media_reference", { cwd, id });
export const gitSummary = <T>(cwd: string) => invoke<T>("git_summary", { cwd });
export const gitCheckout = (cwd: string, branch: string) => invoke<string>("git_checkout", { cwd, branch });
export const prepareGitCommit = (cwd: string) => invoke<string>("prepare_git_commit", { cwd });
export const gitCommit = (cwd: string, message: string, confirmToken: string) => invoke<string>("git_commit", { cwd, message, confirmToken });
export const prepareGitPush = (cwd: string) => invoke<string>("prepare_git_push", { cwd });
export const gitPush = (cwd: string, confirmToken: string) => invoke<string>("git_push", { cwd, confirmToken });
export const prepareGitWorktreeRemove = (cwd: string, path: string) => invoke<string>("prepare_git_worktree_remove", { cwd, path });
export const gitWorktreeRemove = (request: { cwd: string; path: string; confirmToken: string }) => invoke<string>("git_worktree_remove", { request });
export const gitWorktreeAdd = (cwd: string, name: string, branch: string | null) => invoke<string>("git_worktree_add", { cwd, name, branch });
export const searchSessionHistory = (query: string, sessionIds: string[]) => invoke<string[]>("search_session_history", { query, sessionIds });
export const exportSessionSupportBundle = <T>(sessionId: string, clientSnapshot: unknown) => invoke<T>("export_session_support_bundle", { sessionId, clientSnapshot });
export const gitWorktrees = <T>(cwd: string) => invoke<T>("git_worktrees", { cwd });
export const sessionJournalStatus = <T>() => invoke<T>("session_journal_status");
export const agentRuntimeStatus = <T>() => invoke<T>("agent_runtime_status");
export const getUpdateStatus = <T>() => invoke<T>("get_update_status");
export const mediaGenerationHistory = <T>(cwd: string, kind: string, limit: number) => invoke<T>("media_generation_history", { cwd, kind, limit });
export const mediaGenerationCapabilities = <T>() => invoke<T>("media_generation_capabilities");
export const openMediaArtifact = (cwd: string, id: string, artifactIndex: number, action: "open" | "reveal") => invoke<void>("open_media_artifact", { cwd, id, artifactIndex, action });
export const startMediaGeneration = <T>(request: Record<string, unknown>) => invoke<T>("start_media_generation", { request });
export const cancelMediaGeneration = <T>(cwd: string, id: string) => invoke<T>("cancel_media_generation", { cwd, id });
export const saveMediaReference = <T>(cwd: string, name: string, data: string) => invoke<T>("save_media_reference", { cwd, name, data });
