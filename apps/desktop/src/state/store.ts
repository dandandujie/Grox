/* ─────────────────────────────────────────────────────────────────────────
   Central store. Owns session state, applies bridge events, exposes actions.
   The UI never touches the bridge directly.
   ───────────────────────────────────────────────────────────────────────── */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import { EFFORTS, isSessionTerminal, MODELS } from "../bridge/types";
import { notifyDesktop } from "../lib/notify";
import { createSerialMutationQueue } from "../lib/serialMutationQueue";
import type {
  BillingInfo,
  BridgeEvent,
  PermissionMode,
  PromptAttachment,
  Session,
  SessionMeta,
  PreviewFile,
  ProjectPreview,
  GrokRuntimeInfo,
  WorkspaceEntry,
  WorkflowRun,
} from "../bridge/types";
import { DEMO_CWD } from "../demo/data";
import {
  cancelPendingSessionJournal,
  flushAllPendingSessionJournals,
  flushSessionJournal,
  recordSessionJournalHostEvent,
  scheduleSaveSessionJournal,
  scrubSessionJournalOrphans,
  setSessionJournalFailureHandler,
} from "../lib/sessionCache";
import {
  clearDraftBuffer,
  flushDraftPersistence,
  loadDraftBuffer,
  saveDraftBuffer,
  setDraftFailureHandler,
} from "../lib/draftPersistence";
import { readStoredPermissionMode } from "../lib/permissionMode";
import { turnHasLiveText } from "../lib/processFold";
import {
  POST_PROMPT_SETTLE_MS,
  nextQueueDrainParked,
  reconcileIncomingStatus,
  sessionAcceptsNewPrimaryPrompt,
  settleLiveProcessBlocks,
  settleLiveTextBlocks,
  shouldDrainLocalQueue,
  shouldArmPostPromptSettle,
  shouldPromotePostPrompt,
  statusAfterGateResolve,
} from "../lib/sessionRuntime";
import { isLiveBusyStatus, mergeOfflineWithLive } from "../lib/offlineMerge";
import {
  consumeShellUpgradeRescan,
  sanitizeCatalogStatusOnColdStart,
  shouldCloseDetachedSession,
  shouldForceOfflineRescan,
} from "../lib/sessionOpenPolicy";
import {
  nextLocalDrainIndex,
  moveQueueEntry,
  rehomeHeldQueueForRecovery,
} from "../lib/promptQueue";
import {
  loadPromptQueues,
  loadPromptQueuesFromBrowser,
  mergeHydratedPromptQueues,
  parsePromptQueueSnapshot,
  persistPromptQueues,
} from "../lib/promptQueuePersistence";
import { formatGroxError, runtimeNoticeFromError, toGroxError } from "../lib/errorModel";
import { cleanApiError } from "../lib/runtimeNotice";
import type { ErrorFallback } from "../lib/errorModel";
import { commitComposerSubmission } from "../lib/composerSubmission";
import {
  adoptNativeAutomation,
  loadAutomations,
  persistAutomations,
  removeAutomation,
  patchAutomation,
  setAutomationEnabled,
  upsertAutomation,
} from "../lib/automations";
import type { Automation } from "../lib/automations";
import {
  failLatestAutomationSessionRun,
  loadAutomationRunHistory,
  newAutomationRunId,
  patchAutomationRun,
  persistAutomationRunHistory,
  prependAutomationRun,
} from "../lib/automationRunHistory";
import type { AutomationRunRecord } from "../lib/automationRunHistory";
import { nextViewNavigation, shouldCommitViewNavigation } from "../lib/viewNavigation";
import type { ViewNavigationIntent } from "../lib/viewNavigation";
import {
  isComputerUseOperatorEnabled,
  setComputerUseHostEnvEnabled,
  setComputerUseHostPrefsEnabled,
} from "../lib/computerUse";
import {
  dedupeProjects,
  dismissProjectId,
  ensureProject as ensureProjectPure,
  isDraftSessionId,
  isEphemeralSessionId,
  maySurfaceProject,
  projectId,
  samePath,
  undismissProjectId,
} from "../lib/projectCatalog";
import {
  buildDraftRestoreAfterSessionNewFailure,
  shouldRetainDraftBufferUntilSessionReady,
} from "../lib/draftLaunchRecovery";
import { sessionShellFromMeta } from "../lib/sessionShell";
import {
  hydrateSessionOfflineDetailed,
  preferRicherSession,
} from "../lib/offlineSessionHydrate";
import {
  POST_TURN_RECONCILE_DELAYS_MS,
  resumeInterruptedSessionIfHostActive,
  sessionTranscriptSignature,
} from "../lib/sessionJournalReconcile";
import { isUnavailableSessionError } from "../lib/sessionUnavailable";
import { isWorkflowTerminal, mergeWorkflowRun } from "./workflowProjection";
import { providerDefaultModel, providerModelState, providerProfilesState, resolveModelState } from "./providerDomain";
import { mapGitDiffs } from "./diffDomain";
import { blocksBeforePrompt, isHiddenWorkflowControlPrompt, patchBlock, patchTool } from "./sessionDomain";
import { loadJson, loadSessionComposers, loadWorkflowRuns, SESSION_COMPOSERS_KEY, WORKFLOW_RUNS_KEY } from "./durableState";
import { decorateSessionMetas, mergeProjectMetas, mergeSessionMetas } from "./catalogDomain";
import { beginFilePreview, closeFilePreview, failFilePreview, finishFilePreview } from "./previewDomain";
import { useAutomationCapability } from "./automationCapabilityStore";
import { usePreviewCapability } from "./previewCapabilityStore";
import { useProviderCapability } from "./providerCapabilityStore";
import { emptyCapabilityState } from "./capabilityTypes";
import type { DesktopState, InspectorTab, ProjectMeta, QueuedPrompt, SessionComposerState, View } from "./storeTypes";
export type { InspectorTab, ProjectMeta, QueuedPrompt, SessionComposerState, View } from "./storeTypes";

interface SessionFlags {
  pinned?: boolean;
  archived?: boolean;
  completionUnread?: boolean;
}

const uid = () => crypto.randomUUID();
const automationCapability = useAutomationCapability.getState;
const previewCapability = usePreviewCapability.getState;
const providerCapability = useProviderCapability.getState;
const suppressedQueueDrain = new Set<string>();
/** 用户主动停止的回合；下一次 Host idle 必须保留“已停止”而不是伪装完成。 */
const userStoppedSessions = new Set<string>();
/** Prompt RPC already returned; late thinking/tools are a continuation, not a new turn. */
const promptReturnedSessions = new Set<string>();
const continuationSettleTimers = new Map<string, number>();
/** A newer prompt invalidates every delayed disk reconcile from the prior turn. */
const postTurnReconcileGenerations = new Map<string, number>();
const postTurnReconcilePendingGenerations = new Map<string, number>();
/** Upgrade generation: force background load once per session after shell bump. */
let upgradeForceOfflineRescan = false;
const upgradeForceRescanned = new Set<string>();
let catalogPersistTimer: number | undefined;
let pendingCatalog: SessionMeta[] | undefined;
let composerPersistTimer: number | undefined;
let pendingComposerStates: Record<string, SessionComposerState> | undefined;
let workflowPersistTimer: number | undefined;
let pendingWorkflowRuns: Record<string, WorkflowRun[]> | undefined;
let historySyncPromise: Promise<void> | undefined;
// 项目预览检测/启动会跨进程等待。快速重试、手动输入 URL 或切换工作区后，
// 旧请求只能结束自己的 IPC，不能再覆盖用户当前看到的预览状态。
let projectPreviewRequestGeneration = 0;
// 文件预览是可重入入口：快速点击 A→B 或关闭面板时，较慢的旧请求不能
// 覆盖新文件，也不能在关闭后重新写入错误/内容。
let previewRequestGeneration = 0;
let viewNavigation: ViewNavigationIntent = { generation: 0, sessionId: null };
let pendingForegroundNavigation: ViewNavigationIntent | null = null;

function persistSessionComposers(states: Record<string, SessionComposerState>) {
  pendingComposerStates = states;
  if (composerPersistTimer !== undefined) return;
  composerPersistTimer = window.setTimeout(() => {
    const serializable = Object.fromEntries(
      Object.entries(pendingComposerStates ?? {}).map(([id, { attachments: _attachments, ...state }]) => [id, state]),
    );
    localStorage.setItem(SESSION_COMPOSERS_KEY, JSON.stringify(serializable));
    pendingComposerStates = undefined;
    composerPersistTimer = undefined;
  }, 300);
}

function persistWorkflowRuns(runs: Record<string, WorkflowRun[]>) {
  pendingWorkflowRuns = runs;
  if (workflowPersistTimer !== undefined) return;
  workflowPersistTimer = window.setTimeout(() => {
    // Keep a bounded, session-keyed archive. Full workflow event payloads can
    // be large, so the live in-memory view keeps 64 events while the durable
    // archive keeps the latest 48 per run and 48 runs per session. A child
    // transcript is independently bounded so research history stays local.
    const archive = Object.fromEntries(
      Object.entries(pendingWorkflowRuns ?? {}).map(([sessionId, entries]) => [sessionId, entries.slice(-48).map((entry) => ({
        ...entry,
        events: entry.events.slice(-48),
        agentTraces: entry.agentTraces?.map((trace) => ({ ...trace, entries: trace.entries.slice(-80) })),
      }))]),
    );
    localStorage.setItem(WORKFLOW_RUNS_KEY, JSON.stringify(archive));
    pendingWorkflowRuns = undefined;
    workflowPersistTimer = undefined;
  }, 300);
}

const DISMISSED_PROJECTS_KEY = "grox.dismissedProjects";
const DELETED_SESSIONS_KEY = "grox.deletedSessions";
const LEGACY_ARCHIVED_PROJECT_PATHS_KEY = "grox.legacyArchivedProjectPaths";

function loadDismissedProjects(): Set<string> {
  const raw = loadJson<string[]>(DISMISSED_PROJECTS_KEY, []);
  return new Set(raw.map((entry) => projectId(entry)).filter(Boolean));
}

function persistDismissedProjects(dismissed: Iterable<string>) {
  localStorage.setItem(
    DISMISSED_PROJECTS_KEY,
    JSON.stringify([...new Set([...dismissed].map((entry) => projectId(entry)).filter(Boolean))].sort()),
  );
}

function loadDeletedSessions(): Set<string> {
  return new Set(loadJson<string[]>(DELETED_SESSIONS_KEY, []).filter(Boolean));
}

function persistDeletedSessions(ids: Iterable<string>) {
  localStorage.setItem(DELETED_SESSIONS_KEY, JSON.stringify([...new Set(ids)].sort()));
}

function markSessionsDeleted(ids: Iterable<string>) {
  const deleted = loadDeletedSessions();
  for (const id of ids) deleted.add(id);
  persistDeletedSessions(deleted);
}

function clearSessionFlags(ids: Iterable<string>) {
  const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
  let changed = false;
  for (const id of ids) {
    if (!(id in flags)) continue;
    delete flags[id];
    changed = true;
  }
  if (changed) localStorage.setItem("grox.sessionFlags", JSON.stringify(flags));
}

function loadProjects(): ProjectMeta[] {
  const loaded = dedupeProjects(loadJson<ProjectMeta[]>("grox.projects", []));
  localStorage.setItem("grox.projects", JSON.stringify(loaded));
  return loaded;
}

function migrateLegacyProjectArchives(projects: ProjectMeta[], sessions: SessionMeta[]) {
  const archivedPaths = [
    ...loadJson<string[]>(LEGACY_ARCHIVED_PROJECT_PATHS_KEY, []),
    ...projects.filter((project) => project.archived).map((project) => project.path),
  ].filter((path, index, all) => all.findIndex((candidate) => samePath(candidate, path)) === index);
  if (archivedPaths.length === 0) return { projects, sessions };
  localStorage.setItem(LEGACY_ARCHIVED_PROJECT_PATHS_KEY, JSON.stringify(archivedPaths));
  const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
  const nextSessions = sessions.map((session) => {
    if (!archivedPaths.some((path) => samePath(path, session.cwd))) return session;
    flags[session.id] = { ...flags[session.id], archived: true };
    return { ...session, archived: true };
  });
  const nextProjects = projects.map((project) => ({ ...project, archived: false }));
  localStorage.setItem("grox.projects", JSON.stringify(nextProjects));
  localStorage.setItem("grox.sessionFlags", JSON.stringify(flags));
  return { projects: nextProjects, sessions: nextSessions };
}

function finishLegacyProjectArchiveMigration(sessions: SessionMeta[]) {
  const archivedPaths = loadJson<string[]>(LEGACY_ARCHIVED_PROJECT_PATHS_KEY, []);
  if (archivedPaths.length === 0) return;
  const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
  for (const session of sessions) {
    if (!archivedPaths.some((path) => samePath(path, session.cwd))) continue;
    flags[session.id] = { ...flags[session.id], archived: true };
  }
  localStorage.setItem("grox.sessionFlags", JSON.stringify(flags));
  localStorage.removeItem(LEGACY_ARCHIVED_PROJECT_PATHS_KEY);
}

function ensureProject(
  projects: ProjectMeta[],
  path: string,
  options?: { restore?: boolean },
): ProjectMeta[] {
  const dismissed = loadDismissedProjects();
  const id = projectId(path);
  // Passive open / session_ready / CLI import must NOT resurrect removed projects.
  // Only explicit restore (new project folder picker) clears dismissal.
  if (!maySurfaceProject({ path, dismissed, restore: options?.restore })) {
    return dedupeProjects(projects) as ProjectMeta[];
  }
  if (options?.restore && id && dismissed.has(id)) {
    persistDismissedProjects(undismissProjectId(dismissed, id));
  }
  const next = ensureProjectPure(projects, path) as ProjectMeta[];
  localStorage.setItem("grox.projects", JSON.stringify(next));
  return next;
}

function decorateSessions(metas: SessionMeta[]) {
  const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
  const legacyArchivedPaths = loadJson<string[]>(LEGACY_ARCHIVED_PROJECT_PATHS_KEY, []);
  return decorateSessionMetas(metas, flags, legacyArchivedPaths);
}

function persistSessionCatalog(metas: SessionMeta[]) {
  if (catalogPersistTimer !== undefined) window.clearTimeout(catalogPersistTimer);
  catalogPersistTimer = undefined;
  pendingCatalog = undefined;
  const clean = metas.map(({ pinned: _pinned, archived: _archived, ...meta }) => meta);
  localStorage.setItem("grox.sessionCatalog", JSON.stringify(clean));
}

function mergeSessions(
  existing: SessionMeta[],
  incoming: SessionMeta[],
  cwd?: string,
): SessionMeta[] {
  const deleted = loadDeletedSessions();
  // Project-scoped loads retain offline rows; full loads replace duplicate ids.
  const merged = mergeSessionMetas(existing, incoming, cwd, deleted, decorateSessions);
  persistSessionCatalog(merged);
  return merged;
}

function mergeDiscoveredProjects(projects: ProjectMeta[], sessions: SessionMeta[]): ProjectMeta[] {
  const next = mergeProjectMetas(projects, sessions, loadDismissedProjects()) as ProjectMeta[];
  if (JSON.stringify(next) !== JSON.stringify(projects)) {
    localStorage.setItem("grox.projects", JSON.stringify(next));
  }
  return next;
}

function dropEphemeralSessions(
  sessions: Record<string, Session>,
  keepId?: string | null,
): Record<string, Session> {
  return Object.fromEntries(
    Object.entries(sessions).filter(([id]) => id === keepId || !isEphemeralSessionId(id)),
  );
}

function setSessionFlag(id: string, patch: SessionFlags) {
  const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
  flags[id] = { ...flags[id], ...patch };
  localStorage.setItem("grox.sessionFlags", JSON.stringify(flags));
}

/* StrictMode mounts effects twice in dev — subscribe once, ever. */
let bridgeSubscribed = false;
let workspaceWatchTimer: number | undefined;
let workspaceWatchTick = 0;
let pendingLaunch: { text: string; attachments: PromptAttachment[] } | undefined;
let providerRestoreGeneration = 0;
let capabilityLoadPromise: Promise<void> | undefined;

function scheduleSessionCatalog(metas: SessionMeta[]) {
  pendingCatalog = metas;
  if (catalogPersistTimer !== undefined) return;
  catalogPersistTimer = window.setTimeout(() => {
    if (pendingCatalog) persistSessionCatalog(pendingCatalog);
    pendingCatalog = undefined;
    catalogPersistTimer = undefined;
  }, 300);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (workspaceWatchTimer !== undefined) window.clearInterval(workspaceWatchTimer);
    if (catalogPersistTimer !== undefined) window.clearTimeout(catalogPersistTimer);
    if (composerPersistTimer !== undefined) window.clearTimeout(composerPersistTimer);
    if (workflowPersistTimer !== undefined) window.clearTimeout(workflowPersistTimer);
  });
}

type HostPrefsProjection = {
  computerUseEnabled: boolean;
  browserUseEnabled: boolean;
  permissionMode: PermissionMode;
};

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "default" || value === "auto" || value === "bypass";
}

export const useDesktop = create<DesktopState>((set, get) => {
  const errorText = (cause: unknown) => cleanApiError(cause);
  const formattedError = (cause: unknown, fallback: ErrorFallback) =>
    formatGroxError(toGroxError(cause, fallback));
  // Host 偏好属于同一份权威快照。把三类写入按点击顺序提交，避免并发
  // IPC 以不同顺序取得 Host mutex，最终状态背离最后一次用户选择。
  const enqueueHostPrefsMutation = createSerialMutationQueue();

  const publishRuntimeError = (cause: unknown, fallback: ErrorFallback) => {
    const notice = runtimeNoticeFromError(toGroxError(cause, fallback), fallback.severity ?? "error");
    set((state) => ({
      runtimeNotices: [...state.runtimeNotices.filter((item) => item.id !== notice.id), notice],
    }));
  };

  const applyHostPrefs = (
    prefs: HostPrefsProjection,
    targetSessionId?: string | null,
    updatePermission = true,
  ) => {
    if (!isPermissionMode(prefs.permissionMode)
      || typeof prefs.computerUseEnabled !== "boolean"
      || typeof prefs.browserUseEnabled !== "boolean") {
      publishRuntimeError(new Error("Host 返回了无效的偏好快照"), {
        domain: "protocol",
        code: "HOST_PREFS_INVALID",
        message: "Host 权限偏好快照无效",
        recoverable: true,
        action: "重启 Grox；若问题持续，请导出支持包",
      });
      return;
    }

    try {
      localStorage.setItem("grok.permissionMode", prefs.permissionMode);
      localStorage.setItem("grox.browserUseEnabled", prefs.browserUseEnabled ? "1" : "0");
    } catch (cause) {
      publishRuntimeError(cause, {
        domain: "environment",
        code: "HOST_PREFS_CACHE_FAILED",
        message: "Host 偏好已生效，但页面缓存未能更新",
        recoverable: true,
        action: "任务不受影响；当前运行仍使用 Host 权威设置，重启后会重新读取",
        severity: "warning",
      });
    }
    setComputerUseHostPrefsEnabled(prefs.computerUseEnabled);
    const computerUseEnabled = isComputerUseOperatorEnabled();
    bridge.setComputerUseEnabled(computerUseEnabled);
    bridge.setBrowserUseEnabled(prefs.browserUseEnabled);

    const state = get();
    const appliesToVisibleSession = targetSessionId == null || state.activeId === targetSessionId;
    if (updatePermission && appliesToVisibleSession) bridge.setPermissionMode(prefs.permissionMode);
    if (!targetSessionId) {
      set({
        ...(updatePermission && appliesToVisibleSession ? { permissionMode: prefs.permissionMode } : {}),
        computerUseEnabled,
        browserUseEnabled: prefs.browserUseEnabled,
      });
      return;
    }
    if (!updatePermission) {
      set({ computerUseEnabled, browserUseEnabled: prefs.browserUseEnabled });
      return;
    }
    const current = state.sessionComposers[targetSessionId] ?? {
      text: "",
      attachments: [],
      model: state.model,
      effort: state.effort,
      mode: state.mode,
      permissionMode: prefs.permissionMode,
    };
    const sessionComposers = {
      ...state.sessionComposers,
      [targetSessionId]: { ...current, permissionMode: prefs.permissionMode },
    };
    persistSessionComposers(sessionComposers);
    set({
      ...(appliesToVisibleSession ? { permissionMode: prefs.permissionMode } : {}),
      computerUseEnabled,
      browserUseEnabled: prefs.browserUseEnabled,
      sessionComposers,
    });
  };

  const publishJournalReadError = (sessionId: string, cause: unknown) => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    publishRuntimeError(cause, {
      domain: "environment",
      code: "SESSION_JOURNAL_READ_FAILED",
      message: `会话 ${sessionId} 的应用 journal 无法读取`,
      recoverable: true,
      action: "已改用 Agent 磁盘历史展示；重启 Grox 后自动重试",
        severity: "warning",
    });
  };

  const publishAgentHistoryReadError = (sessionId: string, cause: unknown) => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    publishRuntimeError(cause, {
      domain: "environment",
      code: "AGENT_HISTORY_READ_FAILED",
      message: `会话 ${sessionId} 的 Agent 历史无法读取`,
      recoverable: true,
      action: "应用 journal 仍可用于展示；重启 Grox 后自动重试",
        severity: "warning",
    });
  };

  const parkInterruptedSession = (sessionId: string) => {
    const state = get();
    if ((state.promptQueues[sessionId] ?? []).length === 0) {
      suppressedQueueDrain.delete(sessionId);
      set({ queueDrainParked: nextQueueDrainParked(state.queueDrainParked, sessionId, false) });
      return;
    }
    suppressedQueueDrain.add(sessionId);
    set({ queueDrainParked: nextQueueDrainParked(state.queueDrainParked, sessionId, true) });
    publishRuntimeError(new Error("应用在回合完成前退出"), {
      domain: "environment",
      code: "SESSION_TURN_INTERRUPTED",
      message: "检测到未完成的会话回合，提示队列已暂停",
      recoverable: true,
      action: "检查会话末尾后，使用“恢复队列”继续发送",
    });
  };

  setSessionJournalFailureHandler((sessionId, cause) => {
    const conflict = String(cause).includes("journal 写入冲突");
    publishRuntimeError(cause, {
      domain: conflict ? "operation" : "environment",
      code: conflict ? "SESSION_JOURNAL_CONFLICT" : "SESSION_JOURNAL_WRITE_FAILED",
      message: conflict
        ? `会话 ${sessionId} 已在另一个窗口写入更新快照`
        : `会话 ${sessionId} 的应用 journal 未能写入磁盘`,
      recoverable: true,
      action: conflict
        ? "重新打开该会话以合并最新 journal；当前窗口不会继续覆盖磁盘"
        : "当前窗口仍保留内容；请检查应用数据目录的可用空间和写入权限",
    });
  });

  setDraftFailureHandler((cwd, cause) => {
    publishRuntimeError(cause, {
      domain: "environment",
      code: "DRAFT_STORAGE_FAILED",
      message: `工作区 ${cwd} 的未发送草稿未能写入 Host`,
      recoverable: true,
      action: "当前编辑器仍保留内容；请不要关闭页面，并检查应用数据目录权限与磁盘空间",
    });
  });

  const savePromptQueues = (queues: Record<string, QueuedPrompt[]>) => {
    void persistPromptQueues(queues).catch((cause) => {
      publishRuntimeError(cause, {
        domain: "environment",
        code: "PROMPT_QUEUE_WRITE_FAILED",
        message: "提示队列未能写入本地磁盘",
        recoverable: true,
        action: "请检查应用数据目录的可用空间和写入权限",
      });
    });
  };

  const saveAutomationHistory = (history: AutomationRunRecord[]) => {
    automationCapability().setRunHistory(history);
    set({ automationRunHistory: history });
    try {
      persistAutomationRunHistory(history);
    } catch (cause) {
      publishRuntimeError(cause, {
        domain: "environment",
        code: "AUTOMATION_HISTORY_WRITE_FAILED",
        message: "自动化运行记录未能写入本地存储",
        recoverable: true,
        action: "任务状态仍保留在当前窗口；请检查应用数据目录的可用空间和写入权限",
      });
    }
  };

  const drainPromptQueue = (sessionId: string) => {
    const state = get();
    const session = state.sessions[sessionId];
    const queue = state.promptQueues[sessionId] ?? [];
    if (!session || !shouldDrainLocalQueue({
      status: session.status,
      providerSwitching: state.providerSwitching,
      restoring: state.restoringSessionId === sessionId,
      suppressed: suppressedQueueDrain.has(sessionId)
        || postTurnReconcilePendingGenerations.has(sessionId)
        || Boolean(state.queueDrainParked[sessionId]),
      queueLength: queue.length,
      hasLiveProcess: turnHasLiveText(session.blocks),
    })) return;

    const drainAt = nextLocalDrainIndex(
      queue.map((item) => ({
        ...item,
        state: item.state ?? ("queued" as const),
        source: item.source ?? ("local" as const),
      })),
    );
    if (drainAt < 0) return;
    const next = queue[drainAt];
    const currentComposer = state.sessionComposers[sessionId] ?? {
      text: "", attachments: [], model: state.model, effort: state.effort,
      mode: state.mode, permissionMode: state.permissionMode,
    };
    const sessionComposers = {
      ...state.sessionComposers,
      [sessionId]: {
        ...currentComposer,
        model: next.model,
        effort: next.effort,
        mode: next.mode,
        permissionMode: next.permissionMode,
      },
    };
    persistSessionComposers(sessionComposers);
    set({ sessionComposers });
    // 队列行不能在 RPC 被 Host 接受前消失。execute_foreground_turn 会在
    // 原生事务内领取该 id，并用权威磁盘内容派发、消费或异常回队。
    get().sendPrompt(next.text, next.attachments, sessionId, next.mode, undefined, next.id);
  };

  const applyQueuedModel = (sessionId: string) => {
    const state = get();
    const model = state.pendingSessionModels[sessionId];
    const session = state.sessions[sessionId];
    if (!model || !session || !isSessionTerminal(session.status)) return;
    const current = state.sessionComposers[sessionId] ?? {
      text: "",
      attachments: [],
      model: state.model,
      effort: state.effort,
      mode: state.mode,
      permissionMode: state.permissionMode,
    };
    const pendingSessionModels = { ...state.pendingSessionModels };
    delete pendingSessionModels[sessionId];
    const sessionComposers = {
      ...state.sessionComposers,
      [sessionId]: { ...current, model },
    };
    localStorage.setItem("grok.model", model);
    persistSessionComposers(sessionComposers);
    set({
      pendingSessionModels,
      sessionComposers,
      ...(state.activeId === sessionId ? { model } : {}),
    });
  };

  const clearContinuationSettle = (sessionId: string) => {
    const timer = continuationSettleTimers.get(sessionId);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    continuationSettleTimers.delete(sessionId);
  };

  const markPromptInFlight = (sessionId: string) => {
    promptReturnedSessions.delete(sessionId);
    clearContinuationSettle(sessionId);
    postTurnReconcileGenerations.set(
      sessionId,
      (postTurnReconcileGenerations.get(sessionId) ?? 0) + 1,
    );
    postTurnReconcilePendingGenerations.delete(sessionId);
  };

  const lastPrimaryPromptText = (session: Session | undefined): string | null => {
    const block = [...session?.blocks ?? []].reverse().find(
      (item) => item.type === "user" && !item.interjected,
    );
    return block?.type === "user" ? block.text : null;
  };

  const schedulePostTurnReconcile = (sessionId: string) => {
    const initial = get().sessions[sessionId];
    const expectedPrompt = lastPrimaryPromptText(initial);
    if (!initial || !expectedPrompt) return;
    const generation = (postTurnReconcileGenerations.get(sessionId) ?? 0) + 1;
    postTurnReconcileGenerations.set(sessionId, generation);
    postTurnReconcilePendingGenerations.set(sessionId, generation);
    const startedAt = Date.now();

    void (async () => {
      try {
        for (const targetDelay of POST_TURN_RECONCILE_DELAYS_MS) {
          const remaining = targetDelay - (Date.now() - startedAt);
          if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
          if (postTurnReconcileGenerations.get(sessionId) !== generation) return;
          const current = get().sessions[sessionId];
          if (!current || !isSessionTerminal(current.status) || lastPrimaryPromptText(current) !== expectedPrompt) return;

          const hydration = await hydrateSessionOfflineDetailed(sessionId, current);
          if (postTurnReconcileGenerations.get(sessionId) !== generation) return;
          const latest = get().sessions[sessionId];
          if (!latest || !isSessionTerminal(latest.status) || lastPrimaryPromptText(latest) !== expectedPrompt) return;
          if (hydration.journalError) publishJournalReadError(sessionId, hydration.journalError);
          if (hydration.agentError) publishAgentHistoryReadError(sessionId, hydration.agentError);
          if (!hydration.session) continue;
          // The Agent can persist its final answer before our queued settled
          // journal write lands. The live idle status proves this is a normal
          // completion, so remove the provisional crash marker and keep the
          // Agent transcript instead of silently dropping the final answer.
          const hydrated = hydration.outcome === "interrupted"
            ? resumeInterruptedSessionIfHostActive(hydration.session).session
            : hydration.session;
          const candidate = mergeOfflineWithLive(hydrated, latest);
          candidate.status = latest.status;
          if (sessionTranscriptSignature(candidate) === sessionTranscriptSignature(latest)) continue;
          const next = { ...candidate, updatedAt: Date.now() };
          set({ sessions: { ...get().sessions, [sessionId]: next } });
          flushSessionJournal(next);
          return;
        }
      } finally {
        if (postTurnReconcilePendingGenerations.get(sessionId) === generation) {
          postTurnReconcilePendingGenerations.delete(sessionId);
          if (Date.now() - startedAt >= POST_PROMPT_SETTLE_MS) {
            window.setTimeout(() => drainPromptQueue(sessionId), 0);
          }
        }
      }
    })();
  };

  const applyPostPromptContinuation = (sessionId: string) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    const promptReturned = promptReturnedSessions.has(sessionId);
    const hasLiveText = turnHasLiveText(session.blocks);
    if (shouldPromotePostPrompt({
      status: session.status,
      promptReturned,
      hasLiveText,
    })) {
      const state = get();
      const current = state.sessions[sessionId];
      if (current && current.status === "idle") {
        set({
          sessions: {
            ...state.sessions,
            [sessionId]: { ...current, status: "running", updatedAt: Date.now() },
          },
        });
      }
    }
    const after = get().sessions[sessionId];
    if (!after || !shouldArmPostPromptSettle({
      status: after.status,
      promptReturned,
      hasLiveText: turnHasLiveText(after.blocks),
    })) {
      clearContinuationSettle(sessionId);
      return;
    }
    clearContinuationSettle(sessionId);
    continuationSettleTimers.set(sessionId, window.setTimeout(() => {
      continuationSettleTimers.delete(sessionId);
      const current = get().sessions[sessionId];
      if (!current || !promptReturnedSessions.has(sessionId)) return;
      if (current.status !== "running" && !turnHasLiveText(current.blocks)) return;
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            status: "connecting",
            updatedAt: Date.now(),
            blocks: settleLiveTextBlocks(current.blocks),
          },
        },
      });
      drainPromptQueue(sessionId);
    }, POST_PROMPT_SETTLE_MS));
  };

  const applyEvent = (e: BridgeEvent) => {
    const { sessions, sessionIndex } = get();

    const withSession = (
      sessionId: string,
      fn: (s: Session) => Session,
      touchCatalogue = true,
      completionUnread?: boolean,
    ) => {
      const state = get();
      const s = state.sessions[sessionId];
      if (!s) return;
      const next = { ...fn(s), updatedAt: Date.now() };
      // Terminal turns flush cache immediately (BSOD window); live turns debounce.
      if (isSessionTerminal(next.status)) flushSessionJournal(next);
      else scheduleSaveSessionJournal(next);
      if (!touchCatalogue) {
        set({ sessions: { ...state.sessions, [sessionId]: next } });
        if (isSessionTerminal(next.status)) applyQueuedModel(sessionId);
        return;
      }
      const nextIndex = state.sessionIndex.map((m) =>
        m.id === sessionId
          ? {
              ...m,
              updatedAt: next.updatedAt,
              lastStatus: next.status,
              ...(completionUnread === undefined ? {} : { completionUnread }),
            }
          : m,
      );
      if (isSessionTerminal(next.status)) {
        // Catalogue row status should survive hard crash too.
        persistSessionCatalog(nextIndex);
      } else {
        scheduleSessionCatalog(nextIndex);
      }
      set({
        sessions: { ...state.sessions, [sessionId]: next },
        sessionIndex: nextIndex,
      });
      if (isSessionTerminal(next.status)) applyQueuedModel(sessionId);
    };

    switch (e.type) {
      case "auth_state":
        set({ auth: e.state });
        if (!e.state.required && !e.state.inProgress && get().historySyncedAt === 0 && !get().historySyncing) {
          window.setTimeout(() => void get().refreshHistory(), 250);
        }
        if (!e.state.required && !e.state.inProgress) {
          window.setTimeout(() => void get().refreshAccount(), 250);
        }
        break;
      case "runtime_state":
        set((state) => ({
          runtimeConnection: e.state,
          // 同一 Bridge 随后成功握手，先前的可恢复连接错误已经失效，
          // 不能继续悬挂在界面上让用户误以为当前仍离线。
          runtimeNotices: e.state === "ready"
            ? state.runtimeNotices.filter((notice) => ![
                "error-environment-ACP_REQUEST_TIMEOUT",
                "error-environment-ACP_START_FAILED",
                "error-environment-ACP_SPAWN_FAILED",
              ].includes(notice.id))
            : state.runtimeNotices,
        }));
        break;
      case "runtime_occupancy":
        set((state) => {
          let sessions = state.sessions;
          let queueDrainParked = state.queueDrainParked;
          for (const sessionId of e.occupancy.activeTurnSessionIds) {
            const current = sessions[sessionId];
            if (!current) continue;
            const resumed = resumeInterruptedSessionIfHostActive(current);
            const shouldMarkRunning = current.status === "idle" || current.status === "disconnected";
            if (!resumed.resumed && !shouldMarkRunning) continue;
            const activeSession = shouldMarkRunning
              ? { ...resumed.session, status: "running" as const, preview: false }
              : resumed.session;
            if (resumed.resumed) {
              suppressedQueueDrain.delete(sessionId);
              queueDrainParked = nextQueueDrainParked(queueDrainParked, sessionId, false);
            }
            sessions = { ...sessions, [sessionId]: activeSession };
            scheduleSaveSessionJournal(activeSession);
          }
          return { runtimeOccupancy: e.occupancy, sessions, queueDrainParked };
        });
        break;
      case "session_journal_checkpoint": {
        const session = get().sessions[e.sessionId];
        if (!session) break;
        recordSessionJournalHostEvent(e.sessionId, e.streamId, e.sequence);
        scheduleSaveSessionJournal(session);
        break;
      }
      case "prompt_queue_changed": {
        const queue = parsePromptQueueSnapshot(e.queue);
        if (queue.length !== e.queue.length) {
          publishRuntimeError(new Error("Host 返回了无效提示队列快照"), {
            domain: "protocol",
            code: "PROMPT_QUEUE_SNAPSHOT_INVALID",
            message: "提示队列快照无法投影",
            recoverable: true,
            action: "保留当前队列并导出诊断；不要重复发送",
          });
          break;
        }
        set((state) => {
          const promptQueues = { ...state.promptQueues, [e.sessionId]: queue };
          if (e.reason !== "claimed") return { promptQueues };
          const claimed = queue.find((item) => item.id === e.itemId);
          const session = state.sessions[e.sessionId];
          if (!claimed || !session) return { promptQueues };
          let blockIndex = -1;
          for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
            const block = session.blocks[index];
            if (block.type === "user" && !block.interjected) {
              blockIndex = index;
              break;
            }
          }
          if (blockIndex < 0) return { promptQueues };
          const blocks = [...session.blocks];
          const block = blocks[blockIndex];
          if (block.type !== "user") return { promptQueues };
          blocks[blockIndex] = {
            ...block,
            text: claimed.text,
            attachments: claimed.attachments.map(({ id, kind, name, mime, size }) => ({
              id, kind, name, mime, size,
            })),
          };
          const currentComposer = state.sessionComposers[e.sessionId];
          return {
            promptQueues,
            sessions: {
              ...state.sessions,
              [e.sessionId]: { ...session, blocks },
            },
            ...(currentComposer
              ? {
                  sessionComposers: {
                    ...state.sessionComposers,
                    [e.sessionId]: {
                      ...currentComposer,
                      model: claimed.model,
                      effort: claimed.effort,
                      mode: claimed.mode,
                      permissionMode: claimed.permissionMode,
                    },
                  },
                }
              : {}),
          };
        });
        break;
      }
      case "automation_session_started": {
        const automation = e.started.automation as Automation;
        const sessionComposers = {
          ...get().sessionComposers,
          [e.started.sessionId]: {
            text: "",
            attachments: [],
            model: automation.model,
            effort: automation.effort,
            mode: automation.mode,
            permissionMode: automation.permissionMode,
          },
        };
        persistSessionComposers(sessionComposers);
        const existingRun = get().automationRunHistory.find((row) => (
          row.automationId === automation.id
          && row.sessionId === e.started.sessionId
        ));
        if (!existingRun) {
          saveAutomationHistory(prependAutomationRun(get().automationRunHistory, {
            id: newAutomationRunId(e.started.claimedAt),
            automationId: automation.id,
            title: automation.title,
            at: e.started.claimedAt,
            outcome: "started",
            source: e.started.source,
            sessionId: e.started.sessionId,
            detail: "Host 已创建并注册会话，自动化回合正在运行。",
          }));
        }
        set({
          automationRunningId: automation.id,
          sessionComposers,
        });
        void notifyDesktop("已安排任务已启动", automation.title);
        break;
      }
      case "automation_session_settled": {
        const settled = e.settled;
        const updated = settled.automation as Automation | null | undefined;
        if (updated) {
          const nextAutomations = adoptNativeAutomation(updated);
          automationCapability().setAutomations(nextAutomations);
          set({ automations: nextAutomations });
        }
        if (settled.error) {
          const detail = formatGroxError(settled.error);
          if (settled.sessionId) {
            saveAutomationHistory(failLatestAutomationSessionRun(
              get().automationRunHistory,
              settled.sessionId,
              detail,
            ));
          } else {
            const automation = updated
              ?? get().automations.find((item) => item.id === settled.automationId);
            saveAutomationHistory(prependAutomationRun(get().automationRunHistory, {
              id: newAutomationRunId(settled.claimedAt),
              automationId: settled.automationId,
              title: automation?.title ?? settled.automationId,
              at: settled.claimedAt,
              outcome: "error",
              source: settled.source,
              detail,
            }));
          }
        } else if (settled.sessionId) {
          const run = get().automationRunHistory.find((row) => (
            row.sessionId === settled.sessionId
            && ["starting", "started"].includes(row.outcome)
          ));
          if (run) {
            saveAutomationHistory(patchAutomationRun(get().automationRunHistory, run.id, {
              outcome: "completed",
              detail: "Host 已完成回合并持久化自动化结算。",
            }));
          }
        }
        if (get().automationRunningId === settled.automationId) {
          automationCapability().setRunningId(null);
          set({ automationRunningId: null });
        }
        break;
      }
      case "automation_runner_tick":
        automationCapability().setLastTickAt(e.status.checkedAt ?? null);
        automationCapability().setRunningId(e.status.activeAutomationId ?? null);
        set({
          automationLastTickAt: e.status.checkedAt ?? null,
            automationRunningId: e.status.activeAutomationId ?? null,
        });
        break;
      case "model_state":
        {
          const currentState = get();
          const profile = currentState.providerProfiles.find((item) => item.id === currentState.activeProviderProfileId);
          const resolved = resolveModelState(providerModelState(e.state, profile));
          const { activeId, sessionComposers } = get();
          const active = activeId ? sessionComposers[activeId] : undefined;
          const model = active && resolved.models.some((item) => item.id === active.model)
            ? active.model
            : resolved.model;
          const nextComposers = activeId && active
            ? { ...sessionComposers, [activeId]: { ...active, model } }
            : sessionComposers;
          if (nextComposers !== sessionComposers) persistSessionComposers(nextComposers);
          set({ ...resolved, model, sessionComposers: nextComposers });
        }
        break;
      case "mode_state": {
        const state = get();
        const current = state.sessionComposers[e.sessionId];
        if (!current) {
          if (state.activeId === e.sessionId) set({ mode: e.mode });
          break;
        }
        const sessionComposers = {
          ...state.sessionComposers,
          [e.sessionId]: { ...current, mode: e.mode },
        };
        persistSessionComposers(sessionComposers);
        set({
          sessionComposers,
          ...(state.activeId === e.sessionId ? { mode: e.mode } : {}),
        });
        break;
      }
      case "available_commands":
        set({ slashCommands: { ...get().slashCommands, [e.sessionId]: e.commands } });
        break;
      case "workflow_update": {
        const state = get();
        const current = state.workflows[e.sessionId] ?? [];
        const previous = current.find((run) => run.runId === e.workflow.runId);
        if (previous && previous.revision > e.workflow.revision) break;
        const workflow = mergeWorkflowRun(previous, e.workflow);
        const next = workflow.status === "cleared"
          ? current.filter((run) => run.runId !== e.workflow.runId)
          : [...current.filter((run) => run.runId !== e.workflow.runId), workflow]
              .sort((a, b) => Number(isWorkflowTerminal(a.status)) - Number(isWorkflowTerminal(b.status)));
        // Background commands (notably /deep-research) return immediately.
        // Surface their live run in the GUI as soon as the first update
        // arrives, instead of leaving the user to discover the hidden panel.
        set({
          workflows: { ...state.workflows, [e.sessionId]: next },
          ...(state.activeId === e.sessionId && workflow.status !== "cleared"
            ? { inspectorOpen: true, inspectorTab: "tasks" as InspectorTab, terminalOpen: false, previewOpen: false, planPreviewOpen: false }
            : {}),
        });
        persistWorkflowRuns({ ...state.workflows, [e.sessionId]: next });
        break;
      }
      case "workflow_trace_update": {
        const state = get();
        const current = state.workflows[e.sessionId] ?? [];
        const next = current.map((workflow) => workflow.runId !== e.runId ? workflow : {
          ...workflow,
          agentTraces: [
            ...(workflow.agentTraces ?? []).filter((trace) => trace.childSessionId !== e.trace.childSessionId),
            e.trace,
          ],
        });
        if (next === current || !current.some((workflow) => workflow.runId === e.runId)) break;
        set({ workflows: { ...state.workflows, [e.sessionId]: next } });
        persistWorkflowRuns({ ...state.workflows, [e.sessionId]: next });
        break;
      }
      case "session_meta": {
        const current = sessions[e.sessionId];
        const nextIndex = sessionIndex.map((meta) =>
          meta.id === e.sessionId ? { ...meta, ...e.patch } : meta,
        );
        persistSessionCatalog(nextIndex);
        set({
          sessions: current
            ? { ...sessions, [e.sessionId]: { ...current, ...e.patch } }
            : sessions,
          sessionIndex: nextIndex,
        });
        break;
      }
      case "session_ready": {
        if (loadDeletedSessions().has(e.session.id)) break;
        const issuedNavigation = e.background ? null : pendingForegroundNavigation;
        const attachesForeground = !e.background && (
          !issuedNavigation || shouldCommitViewNavigation(issuedNavigation, viewNavigation)
        );
        if (!e.background) pendingForegroundNavigation = null;
        const effectiveBackground = e.background || !attachesForeground;
        const filteredSession = {
          ...e.session,
          blocks: e.session.blocks.filter((block) => !isHiddenWorkflowControlPrompt(block)),
          preview: e.preview === true,
        };
        const existing = sessions[filteredSession.id];
        scheduleSaveSessionJournal(filteredSession);
        const localPreviewSuffix = e.background && !e.preview && existing?.preview
          ? existing.blocks.filter((block) => !block.id.startsWith(`preview-${filteredSession.id}-`))
          : [];
        // Idle background load: offline/ACP spine + live-only insert (order fix).
        // Busy sessions keep live blocks untouched.
        let spineMerged: Session | null = null;
        if (
          e.background &&
          !e.preview &&
          existing &&
          !isLiveBusyStatus(existing.status) &&
          !isLiveBusyStatus(filteredSession.status)
        ) {
          spineMerged = mergeOfflineWithLive(filteredSession, existing);
        }
        const readySession = e.preview && existing
          ? mergeOfflineWithLive(filteredSession, existing)
          : spineMerged
            ? spineMerged
          : localPreviewSuffix.length > 0
            ? {
                ...filteredSession,
                blocks: [...filteredSession.blocks, ...localPreviewSuffix],
                status: existing?.status ?? filteredSession.status,
              }
            : e.background && existing && existing.blocks.length > filteredSession.blocks.length
              ? { ...filteredSession, blocks: existing.blocks }
            : filteredSession;
        const launch = e.background ? undefined : pendingLaunch;
        if (!e.background) pendingLaunch = undefined;
        const optimistic = e.background
          ? undefined
          : Object.values(sessions).find((item) => item.id.startsWith("pending-"));
        const nextSession = launch && optimistic
          ? {
              ...readySession,
              title: launch.text.trim().slice(0, 56) || readySession.title,
              blocks: [{
                type: "user" as const,
                id: uid(),
                text: launch.text,
                attachments: launch.attachments.map(({ id, kind, name, mime, size }) => ({ id, kind, name, mime, size })),
                ts: Date.now(),
              }],
              status: "running" as const,
            }
          : readySession;
        // pending launch 的标题只存在于 nextSession；索引必须使用同一份快照，
        // 否则侧栏会一直显示上游的 Untitled mission。
        const { blocks: _b, usage: _u, status: _st, preview: _preview, ...meta } = nextSession;
        const previousMeta = sessionIndex.find((item) => item.id === readySession.id);
        const indexedMeta = {
          ...decorateSessions([meta])[0],
          lastStatus: nextSession.status,
          completionUnread: previousMeta?.completionUnread ?? false,
        };
        const nextIndex = effectiveBackground && previousMeta
          ? sessionIndex.map((item) => item.id === readySession.id ? indexedMeta : item)
          : [indexedMeta, ...sessionIndex.filter((item) => item.id !== readySession.id)];
        // Passive session bind must not resurrect a removed project row.
        const projects = ensureProject(get().projects, readySession.cwd);
        persistSessionCatalog(nextIndex);
        const state = get();
        const existingComposer = state.sessionComposers[readySession.id];
        const composer: SessionComposerState = existingComposer ?? {
          text: "",
          attachments: [],
          model: state.models.some((item) => item.id === readySession.model)
            ? readySession.model
            : state.model,
          effort: state.effort,
          mode: state.mode,
          permissionMode: state.permissionMode,
        };
        // Drop ephemeral draft/pending composer shells once a real session binds.
        const sessionComposers = Object.fromEntries(
          Object.entries({ ...state.sessionComposers, [readySession.id]: composer })
            .filter(([id]) => !isEphemeralSessionId(id)),
        );
        persistSessionComposers(sessionComposers);
        const remainsActive = state.activeId === readySession.id && state.view === "session";
        if (attachesForeground || remainsActive) bridge.setPermissionMode(composer.permissionMode);
        const nextSessions = e.background
          ? sessions
          : Object.fromEntries(Object.entries(sessions).filter(([id]) => !isEphemeralSessionId(id)));
        const readyProjectId = projects.some((project) => samePath(project.path, readySession.cwd))
          ? projectId(readySession.cwd)
          : null;
        if (attachesForeground) {
          viewNavigation = nextViewNavigation(viewNavigation, readySession.id, readySession.cwd);
        }
        set({
          sessions: { ...nextSessions, [readySession.id]: nextSession },
          sessionIndex: nextIndex,
          projects,
          sessionComposers,
          ...(attachesForeground ? {
            workspace: readySession.cwd,
            activeProjectId: readyProjectId,
            activeId: readySession.id,
            view: "session" as const,
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            permissionMode: composer.permissionMode,
          } : remainsActive ? {
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            permissionMode: composer.permissionMode,
          } : {}),
        });
        if (launch) {
          // Create path succeeded — crash buffer is no longer needed.
          void clearDraftBuffer(readySession.cwd).catch(() => {});
          void bridge.prompt(readySession.id, launch.text, {
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            permissionMode: composer.permissionMode,
            attachments: launch.attachments,
          });
        }
        break;
      }
      case "block_add":
        if (isHiddenWorkflowControlPrompt(e.block)) break;
        withSession(e.sessionId, (s) => s.blocks.some((block) => block.id === e.block.id)
          ? s
          : { ...s, blocks: [...s.blocks, e.block] });
        // Tools must not keep a post-prompt continuation alive — a leftover
        // running LRC / cargo test would reset the settle timer forever.
        if (e.block.type === "thinking" || e.block.type === "assistant") {
          applyPostPromptContinuation(e.sessionId);
        }
        if (e.block.type === "plan" && get().activeId === e.sessionId) {
          set({ planPreviewOpen: true, previewOpen: false, inspectorOpen: false, terminalOpen: false });
        }
        break;
      case "block_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: patchBlock(s.blocks, e.blockId, e.patch),
        }), false);
        applyPostPromptContinuation(e.sessionId);
        break;
      case "tool_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: patchTool(s.blocks, e.blockId, e.call),
        }), false);
        break;
      case "plan_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && b.type === "plan" ? { ...b, steps: e.steps } : b,
          ),
        }), false);
        break;
      case "assistant_append":
      case "thinking_append":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && (b.type === "assistant" || b.type === "thinking")
              ? { ...b, text: b.text + e.delta }
              : b,
          ),
        }), false);
        applyPostPromptContinuation(e.sessionId);
        break;
      case "user_append":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && b.type === "user"
              ? { ...b, text: b.text + e.delta }
              : b,
          ),
        }), false);
        break;
      case "permission_request":
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "awaiting_permission",
          blocks: [
            ...s.blocks,
            { type: "permission", id: e.blockId, req: e.req, ts: Date.now() },
          ],
        }));
        if (e.req.purpose === "plan" && get().activeId === e.sessionId) {
          set({ planPreviewOpen: true, previewOpen: false, inspectorOpen: false, terminalOpen: false });
        }
        void notifyDesktop(
          localStorage.getItem("grox.language") === "en-US" ? "Approval needed" : "需要批准",
          e.req.description || (localStorage.getItem("grox.language") === "en-US" ? "Grok is waiting for permission" : "Grok 正在等待工具权限"),
        );
        break;
      case "permission_resolved":
        withSession(e.sessionId, (s) => {
          const blocks = s.blocks.map((b) =>
            b.id === e.blockId && b.type === "permission"
              ? { ...b, resolved: e.option }
              : b,
          );
          return {
            ...s,
            status: statusAfterGateResolve(blocks, s.status),
            blocks,
          };
        });
        break;
      case "question_request":
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "awaiting_input",
          blocks: [
            ...s.blocks,
            { type: "question", id: e.blockId, req: e.req, ts: Date.now() },
          ],
        }));
        void notifyDesktop(
          localStorage.getItem("grox.language") === "en-US" ? "Question pending" : "需要回答",
          localStorage.getItem("grox.language") === "en-US" ? "Grok is waiting for your answer" : "Grok 正在等待你的回答",
        );
        break;
      case "question_resolved":
        withSession(e.sessionId, (s) => {
          const blocks = s.blocks.map((b) =>
            b.id === e.blockId && b.type === "question"
              ? { ...b, response: e.response }
              : b,
          );
          return {
            ...s,
            status: statusAfterGateResolve(blocks, s.status),
            blocks,
          };
        });
        break;
      case "status":
        if (e.status === "idle") promptReturnedSessions.add(e.sessionId);
        if (e.status === "running") markPromptInFlight(e.sessionId);
        const stoppedByUser = e.status === "idle" && userStoppedSessions.delete(e.sessionId);
        withSession(
          e.sessionId,
          (s) => {
            const status = stoppedByUser ? "cancelled" : reconcileIncomingStatus(s.blocks, s.status, e.status);
            return {
              ...s,
              status,
              blocks: status === "idle" ? settleLiveTextBlocks(s.blocks) : s.blocks,
            };
          },
          true,
          e.status === "idle" ? get().activeId !== e.sessionId : e.status === "running" ? false : undefined,
        );
        applyPostPromptContinuation(e.sessionId);
        if (e.status === "idle") {
          schedulePostTurnReconcile(e.sessionId);
          window.setTimeout(() => drainPromptQueue(e.sessionId), POST_PROMPT_SETTLE_MS);
        }
        break;
      case "usage":
        withSession(e.sessionId, (s) => ({ ...s, usage: e.usage }), false);
        break;
      case "runtime_notice":
        set((state) => ({
          runtimeNotices: state.runtimeNotices.some((item) => item.id === e.notice.id)
            ? state.runtimeNotices
            : [...state.runtimeNotices, e.notice],
        }));
        void notifyDesktop(e.notice.title, e.notice.message);
        break;
      case "error":
        {
          const automation = get().automations.find((item) => item.lastSessionId === e.sessionId);
          if (automation) {
            const automations = patchAutomation(get().automations, automation.id, { lastError: formatGroxError(e.error) });
            set({ automations });
            void persistAutomations(automations).catch(() => {});
            saveAutomationHistory(failLatestAutomationSessionRun(
              get().automationRunHistory,
              e.sessionId,
              formatGroxError(e.error),
            ));
          }
        }
        if (e.error.holdQueue) {
          const state = get();
          const recoverable = (state.promptQueues[e.sessionId] ?? []).map((item) => ({
            ...item,
            state: item.state ?? ("queued" as const),
          }));
          if (recoverable.length > 0) suppressedQueueDrain.add(e.sessionId);
          else suppressedQueueDrain.delete(e.sessionId);
          const promptQueues = {
            ...state.promptQueues,
            [e.sessionId]: rehomeHeldQueueForRecovery(recoverable),
          };
          set({
            promptQueues,
            queueDrainParked: nextQueueDrainParked(state.queueDrainParked, e.sessionId, recoverable.length > 0),
          });
          savePromptQueues(promptQueues);
        }
        withSession(
          e.sessionId,
          (s) => ({
            ...s,
            status: e.error.fatal ? "failed" : s.status,
            blocks: [
              ...s.blocks,
              { type: "system", id: uid(), text: formatGroxError(e.error), ts: Date.now(), kind: "error" },
            ],
          }),
          true,
          e.error.fatal ? false : undefined,
        );
        if (e.error.domain === "environment") {
          const notice = runtimeNoticeFromError(e.error);
          set((state) => ({
            runtimeNotices: state.runtimeNotices.some((item) => item.id === notice.id)
              ? state.runtimeNotices
              : [...state.runtimeNotices, notice],
          }));
        }
        break;
    }
  };

  const resumePromptQueues = () => {
    window.setTimeout(() => {
      for (const sessionId of Object.keys(get().promptQueues)) drainPromptQueue(sessionId);
    }, 0);
  };

  // Changing provider replaces the ACP child. Reattach the visible session
  // only after that replacement, and lock the composer during the short load
  // so the first request cannot target a dead child process.
  const restoreActiveSessionAfterProviderSwitch = () => {
    const { activeId, sessions } = get();
    if (!activeId || isEphemeralSessionId(activeId) || !sessions[activeId]) {
      set({ restoringSessionId: null });
      resumePromptQueues();
      return;
    }
    const generation = ++providerRestoreGeneration;
    set({ restoringSessionId: activeId });
    void bridge.loadSession(activeId).then(
      () => {
        if (generation === providerRestoreGeneration) {
          set({ restoringSessionId: null });
          resumePromptQueues();
        }
      },
      (error) => {
        if (generation !== providerRestoreGeneration) return;
        set({
          restoringSessionId: null,
          startupError: `模型服务已切换，但当前会话同步失败：${errorText(error)}`,
        });
        resumePromptQueues();
      },
    );
  };

  return {
    ready: false,
    startupError: null,
    runtimeNotices: [],
    runtimeConnection: bridge.kind === "mock" ? "ready" : "starting",
    runtimeOccupancy: { activeTurnSessionIds: [], lifecycleActive: false, pendingLifecycle: 0 },
    auth: { required: false, inProgress: false },
    bridgeKind: bridge.kind,
    workspace: DEMO_CWD,
    view: "home",
    projects: loadProjects(),
    activeProjectId: null,
    sessionIndex: [],
    sessions: {},
    activeId: null,
    ...emptyCapabilityState,
    restoringSessionId: null,
    runtime: null,
    runtimeBusy: false,
    accountSetupOpen:
      localStorage.getItem("grox.accountSetupComplete") !== "1" && bridge.kind !== "mock",
    automationRunHistory: loadAutomationRunHistory(),
    planPreviewOpen: false,
    slashCommands: {},
    workflows: loadWorkflowRuns(),

    model: localStorage.getItem("grok.model") ?? "grok-build",
    models: MODELS,
    modelsUpdatedAt: 0,
    effort: EFFORTS.find((effort) => effort === localStorage.getItem("grok.effort")) ?? "high",
    mode: "agent",
    permissionMode: readStoredPermissionMode(localStorage.getItem("grok.permissionMode")),
    computerUseEnabled: isComputerUseOperatorEnabled(),
    browserUseEnabled: localStorage.getItem("grox.browserUseEnabled") !== "0",
    sessionComposers: loadSessionComposers(),
    promptQueues: loadPromptQueuesFromBrowser(),
    pendingSessionModels: {},
    queueDrainParked: {} as Record<string, boolean>,

    inspectorOpen: false,
    inspectorTab: "files",
    terminalOpen: false,
    paletteOpen: false,
    settingsOpen: false,
    historySyncing: false,
    historyCount: 0,
    historyError: null,
    historySyncedAt: 0,

    async loadCapabilities() {
      if (capabilityLoadPromise) return capabilityLoadPromise;
      capabilityLoadPromise = (async () => {
        const [automationLoad, providerLoad] = await Promise.all([
          loadAutomations().then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error })),
          Promise.all([bridge.getProviderStatus(), bridge.listProviderProfiles()]).then(
            ([provider, profiles]) => ({ value: { provider, profiles }, error: null as unknown }),
            (error: unknown) => ({ value: null, error }),
          ),
        ]);
        set({
          ...(automationLoad.value ? { automations: automationLoad.value } : {}),
          ...(providerLoad.value ? {
            provider: providerLoad.value.provider,
            ...providerProfilesState(providerLoad.value.profiles),
          } : {}),
        });
        if (automationLoad.value) automationCapability().setAutomations(automationLoad.value);
        if (providerLoad.value) {
          providerCapability().setProvider(providerLoad.value.provider);
          providerCapability().setProfiles(providerLoad.value.profiles.profiles, providerLoad.value.profiles.activeId);
        }
        automationCapability().setRunHistory(get().automationRunHistory);
        for (const [code, message, error] of [
          ["AUTOMATION_READ_FAILED", "无法恢复已安排任务", automationLoad.error],
          ["PROVIDER_PROFILES_READ_FAILED", "无法读取模型服务配置", providerLoad.error],
        ] as const) {
          if (!error) continue;
          const notice = runtimeNoticeFromError(toGroxError(error, {
            domain: "environment", code, message, recoverable: true,
            action: "不影响发送任务；重启 Grox 后自动重试",
          }), "warning");
          set((state) => ({ runtimeNotices: [...state.runtimeNotices.filter((item) => item.id !== notice.id), notice] }));
        }
      })().finally(() => { capabilityLoadPromise = undefined; });
      return capabilityLoadPromise;
    },

    async init() {
      if (bridgeSubscribed) return;
      bridgeSubscribed = true;
      bridge.subscribe(applyEvent);

      // ── Phase 0: paint the shell from local cache only ─────────────────
      // Critical: do NOT await CLI spawn / initialize in this turn. An
      // await here keeps the microtask queue busy for 2–3s and starves
      // React paint + pointer events even after ready:true is set.
      const migration = migrateLegacyProjectArchives(
        get().projects,
        decorateSessions(loadJson<SessionMeta[]>("grox.sessionCatalog", [])),
      );
      const deletedSessions = loadDeletedSessions();
      const visibleSessionIndex = migration.sessions
        .filter((session) => !deletedSessions.has(session.id))
        .map((session) => ({
          ...session,
          lastStatus: sanitizeCatalogStatusOnColdStart(session.lastStatus),
        }));
      persistSessionCatalog(visibleSessionIndex);
      const cachedWorkspace = (() => {
        try {
          return localStorage.getItem("grok.workspace")?.trim() || "";
        } catch {
          return "";
        }
      })();
      if (cachedWorkspace) {
        const projects = ensureProject(migration.projects, cachedWorkspace);
        set({
          workspace: cachedWorkspace,
          projects,
          activeProjectId: projectId(cachedWorkspace),
          sessionIndex: visibleSessionIndex,
          ready: true,
        });
      } else {
        set({ projects: migration.projects, sessionIndex: visibleSessionIndex, ready: true });
      }

      // Deep links / agent boot are scheduled after a real interaction window.
      const params = new URLSearchParams(window.location.search);
      const open = params.get("open");
      const prompt = params.get("prompt");
      const needsImmediateAgent = Boolean(open || prompt);

      // ── Phase 1 (macrotask): host-only prefs. Never spawn CLI here. ───
      // Case B freeze: UI painted but unclickable for 2–3s because ensureReady
      // + getWorkspace/getAuth pile IPC/JSON on the main thread right after paint.
      window.setTimeout(() => {
        void (async () => {
          try {
            const feCu = localStorage.getItem("grox.computerUseEnabled") !== "0";
            const feBrowser = localStorage.getItem("grox.browserUseEnabled") !== "0";
            await invoke("host_prefs_migrate_computer_use", { feEnabled: feCu }).catch((cause) => {
              // 可选能力的偏好迁移失败不阻断任何任务：按默认设置运行即可。
              publishRuntimeError(cause, {
                domain: "environment",
                code: "HOST_PREFS_MIGRATION_FAILED",
                message: "Computer Use 偏好迁移失败，本次启动按默认设置运行",
                recoverable: true,
                severity: "warning",
                action: "可在设置的通用页重新调整该能力",
              });
            });
            await invoke("host_prefs_migrate_browser_use", { feEnabled: feBrowser }).catch((cause) => {
              publishRuntimeError(cause, {
                domain: "environment",
                code: "HOST_PREFS_MIGRATION_FAILED",
                message: "Browser Use 偏好迁移失败，本次启动按默认设置运行",
                recoverable: true,
                severity: "warning",
                action: "可在设置的通用页重新调整该能力",
              });
            });

            const [hostPrefsLoad, envOn, env, promptQueueLoad] = await Promise.all([
              invoke<HostPrefsProjection>("host_prefs_get").then(
                (value) => ({ value, error: null as unknown }),
                (error: unknown) => ({ value: null, error }),
              ),
              invoke<boolean>("computer_use_env_enabled").catch(() => false),
              invoke<{ appVersion?: string }>("desktop_environment").catch(() => null),
              loadPromptQueues().then(
                (value) => ({ value, error: null as unknown }),
                (error: unknown) => ({ value: null, error }),
              ),
            ]);
            setComputerUseHostEnvEnabled(Boolean(envOn));
            if (hostPrefsLoad.value) applyHostPrefs(hostPrefsLoad.value);
            if (env?.appVersion && consumeShellUpgradeRescan(env.appVersion)) {
              upgradeForceOfflineRescan = true;
              upgradeForceRescanned.clear();
            }
            set((state) => ({
              ...(promptQueueLoad.value
                ? { promptQueues: mergeHydratedPromptQueues(promptQueueLoad.value, state.promptQueues) }
                : {}),
            }));
            for (const [code, message, error] of [
              ["HOST_PREFS_READ_FAILED", "无法读取 Host 权限偏好", hostPrefsLoad.error],
              ["PROMPT_QUEUE_READ_FAILED", "无法恢复已持久化的提示队列", promptQueueLoad.error],
            ] as const) {
              if (!error) continue;
              const notice = runtimeNoticeFromError(toGroxError(error, {
                domain: "environment",
                code,
                message,
                recoverable: true,
                action: "不影响发送任务；重启 Grox 后自动重试",
              }), "warning");
              set((state) => ({ runtimeNotices: [...state.runtimeNotices.filter((item) => item.id !== notice.id), notice] }));
            }
          } catch (cause) {
            publishRuntimeError(cause, {
              domain: "environment",
              code: "HOST_BOOTSTRAP_FAILED",
              message: "Host 启动偏好与持久化状态未能完整恢复",
              recoverable: true,
              action: "检查应用数据目录后重启 Grox",
            });
          }
        })();
      }, 0);

      // ── Phase 2: agent boot only after idle (or immediately for deep links).
      // Keep the shell fully interactive for ~2s before the Host starts ACP connection work.
      const bootAgent = () => {
        void (async () => {
          try {
            // Intentionally start connect here (not at import, not at ready:true).
            void bridge.ensureReady?.();

            const runtimeP = bridge.kind === "acp"
              ? invoke<GrokRuntimeInfo>("grok_runtime_info").catch(() => null)
              : Promise.resolve(null);
            const workspaceP = bridge.getWorkspace().catch(() => get().workspace);
            const authP = bridge.getAuthState().catch(() => get().auth);
            const modelP = bridge.getModelState().catch(() => ({
              models: get().models,
              currentId: get().model,
            }));
            const providerP = bridge.getProviderStatus().catch(() => get().provider);

            const [runtime, workspace, auth, modelState, provider] = await Promise.all([
              runtimeP,
              workspaceP,
              authP,
              modelP,
              providerP,
            ]);

            const projects = ensureProject(get().projects, workspace);
            set({
              runtime: runtime ?? null,
              computerUseEnabled: isComputerUseOperatorEnabled(),
              // Never force-open setup mid-session unless runtime truly missing.
              accountSetupOpen: get().accountSetupOpen || Boolean(runtime?.selectionRequired),
              workspace,
              projects,
              activeProjectId: projectId(workspace),
              auth,
              ...resolveModelState(modelState),
              provider,
              startupError: null,
            });

            if (!auth.required) void get().refreshAccount();
            window.setTimeout(() => {
              if (get().auth.inProgress) return;
              if (get().view !== "session") return;
              void get().refreshWorkspaceFiles();
              void get().refreshProjectPreview(false);
              void get().refreshWorkspaceDiffs();
            }, 1_500);

            window.setTimeout(() => {
              void scrubSessionJournalOrphans();
            }, 4_000);
            window.setTimeout(() => {
              if (!get().auth.inProgress && get().historySyncedAt === 0) void get().refreshHistory();
            }, 3_500);

            if (workspaceWatchTimer === undefined) {
              workspaceWatchTimer = window.setInterval(() => {
                if (document.visibilityState !== "visible" || get().auth.inProgress || get().view !== "session") return;
                workspaceWatchTick += 1;
                void get().refreshWorkspaceDiffs();
                if (workspaceWatchTick % 3 === 0) void get().refreshWorkspaceFiles();
                if (get().projectPreview.status === "starting") void get().refreshProjectPreview();
              }, 2_000);
            }

            if (open) void get().openSession(open);
            else if (prompt) void get().newSession({ text: prompt }).catch(() => {});
          } catch (error) {
            set({
              ready: true,
              startupError: errorText(error),
            });
          }
        })();
      };

      if (needsImmediateAgent) {
        // Deep-link must talk to the agent; still yield one frame for paint.
        window.setTimeout(bootAgent, 50);
      } else if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => bootAgent(), { timeout: 2_800 });
      } else {
        window.setTimeout(bootAgent, 1_800);
      }
    },

    dismissRuntimeNotice: (id) => set((state) => ({
      runtimeNotices: state.runtimeNotices.filter((item) => item.id !== id),
    })),

    goHome: () => {
      bridge.invalidateWorkspaceSelection();
      viewNavigation = nextViewNavigation(viewNavigation, null);
      const state = get();
      const currentId = state.activeId;
      const current = currentId ? state.sessions[currentId] : undefined;
      if (shouldCloseDetachedSession({ currentId, nextId: null, status: current?.status })) {
        void bridge.closeSession(currentId!).catch(() => {});
      }
      set({
        view: "home",
        activeId: null,
        sessions: dropEphemeralSessions(state.sessions),
        inspectorOpen: false,
        terminalOpen: false,
        previewOpen: false,
        previewFile: null,
        planPreviewOpen: false,
      });
    },

    async openSession(id) {
      const beforeOpen = get();
      bridge.invalidateWorkspaceSelection();
      const meta = beforeOpen.sessionIndex.find((entry) => entry.id === id);
      const navigation = nextViewNavigation(viewNavigation, id, meta?.cwd);
      viewNavigation = navigation;
      const currentId = beforeOpen.activeId;
      const current = currentId ? beforeOpen.sessions[currentId] : undefined;
      if (shouldCloseDetachedSession({ currentId, nextId: id, status: current?.status })) {
        void bridge.closeSession(currentId!).catch(() => {});
      }
      if (meta?.completionUnread) {
        const sessionIndex = beforeOpen.sessionIndex.map((entry) =>
          entry.id === id ? { ...entry, completionUnread: false } : entry,
        );
        persistSessionCatalog(sessionIndex);
        set({ sessionIndex });
      }
      if (meta) {
        if (!samePath(meta.cwd, get().workspace)) {
          await get().setWorkspace(meta.cwd, { navigation });
        } else {
          // Even when the visible project already matches, issue a workspace
          // selection so an older cross-project validation cannot win later.
          await bridge.setWorkspace(meta.cwd);
        }
      }
      if (!shouldCommitViewNavigation(navigation, viewNavigation)) return;
      const state = get();
      let existing = state.sessions[id];
      const composer = state.sessionComposers[id];
      if (composer) bridge.setPermissionMode(composer.permissionMode);

      // Never leave activeId set with sessions[id] missing — that paints the
      // infinite black "RESTORING MISSION" spinner when cache/ACP is slow.
      if (!existing && meta) {
        const shellStatus = meta.lastStatus && !isSessionTerminal(meta.lastStatus)
          ? "disconnected"
          : meta.lastStatus ?? "idle";
        existing = sessionShellFromMeta(meta, shellStatus);
        set({
          activeId: id,
          view: "session",
          sessions: { ...state.sessions, [id]: existing },
          ...(composer ? {
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            permissionMode: composer.permissionMode,
          } : {}),
        });
      } else {
        set({
          activeId: id,
          view: "session",
          ...(composer ? {
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            permissionMode: composer.permissionMode,
          } : {}),
        });
      }

      const forceRescan = shouldForceOfflineRescan({
        upgradeRescanActive: upgradeForceOfflineRescan,
        sessionAlreadyForceRescanned: upgradeForceRescanned.has(id),
      });
      const needsHydrate = !existing || existing.preview || existing.blocks.length === 0 || forceRescan;
      const openMeta: SessionMeta | null = (meta ?? existing)
        ? {
            id,
            title: meta?.title ?? existing?.title ?? "Untitled mission",
            cwd: meta?.cwd ?? existing?.cwd ?? get().workspace,
            createdAt: meta?.createdAt ?? existing?.createdAt ?? Date.now(),
            updatedAt: meta?.updatedAt ?? existing?.updatedAt ?? Date.now(),
            model: meta?.model ?? existing?.model ?? get().model,
            lastStatus: meta?.lastStatus ?? existing?.lastStatus,
            summary: meta?.summary ?? existing?.summary,
            completionUnread: meta?.completionUnread,
            parentId: meta?.parentId ?? existing?.parentId,
            demo: meta?.demo ?? existing?.demo,
            pinned: meta?.pinned ?? existing?.pinned,
            archived: meta?.archived ?? existing?.archived,
          }
        : null;

      // Local cache + disk jsonl first (fast paint). ACP may fail with "找不到会话"
      // when the CLI catalogue no longer lists a sidebar id.
      if (openMeta && (!existing || existing.blocks.length === 0 || existing.preview || isSessionTerminal(existing.status))) {
        void hydrateSessionOfflineDetailed(id, openMeta).then((hydration) => {
          if (hydration.journalError) publishJournalReadError(id, hydration.journalError);
          if (hydration.agentError) publishAgentHistoryReadError(id, hydration.agentError);
          if (hydration.outcome === "interrupted") parkInterruptedSession(id);
          const offline = hydration.session;
          if (!offline) return;
          const latest = get();
          if (latest.activeId !== id) return;
          const currentSession = latest.sessions[id];
          const next = hydration.outcome === "interrupted"
            ? offline
            : preferRicherSession(currentSession, offline);
          if (next === currentSession) return;
          set({ sessions: { ...latest.sessions, [id]: next } });
        });
      }

      // ACP bind / full history when needed.
      if (needsHydrate) {
        if (forceRescan) upgradeForceRescanned.add(id);
        void bridge.loadSession(id, { background: true }).catch((error) => {
          const message = errorText(error);
          void (async () => {
            const hydration = openMeta ? await hydrateSessionOfflineDetailed(id, openMeta) : null;
            if (hydration?.journalError) publishJournalReadError(id, hydration.journalError);
            if (hydration?.agentError) publishAgentHistoryReadError(id, hydration.agentError);
            if (hydration?.outcome === "interrupted") parkInterruptedSession(id);
            const offline = hydration?.session ?? null;
            set((latest) => {
              if (latest.activeId !== id) return latest;
              const shell = latest.sessions[id];
              if (offline && offline.blocks.length > 0) {
                const next = hydration?.outcome === "interrupted"
                  ? offline
                  : preferRicherSession(shell, offline);
                return {
                  // Soft notice — offline history is still usable.
                  startupError: `会话未能绑定到 CLI（已显示本地历史）：${message}`,
                  sessions: { ...latest.sessions, [id]: { ...next, preview: true } },
                };
              }
              const unavailable = isUnavailableSessionError(message);
              const friendly = unavailable
                ? (message.includes("找不到") || message.includes("会话")
                  ? `找不到会话：${id}`
                  : `Session not found: ${id}`)
                : message;
              return {
                startupError: unavailable
                  ? null
                  : `会话后台同步失败：${message}`,
                sessions: shell
                  ? {
                      ...latest.sessions,
                      [id]: {
                        ...shell,
                        blocks: shell.blocks.length > 0
                          ? shell.blocks
                          : [{
                              type: "system" as const,
                              id: `open-fail-${id}`,
                              text: friendly,
                              ts: Date.now(),
                              kind: "error" as const,
                            }],
                        preview: false,
                      },
                    }
                  : latest.sessions,
              };
            });
          })();
        });
      }
    },

    async newSession(launch) {
      const beforeNew = get();
      bridge.invalidateWorkspaceSelection();
      viewNavigation = nextViewNavigation(viewNavigation, null, beforeNew.workspace);
      const currentId = beforeNew.activeId;
      const current = currentId ? beforeNew.sessions[currentId] : undefined;
      if (shouldCloseDetachedSession({ currentId, nextId: null, status: current?.status })) {
        void bridge.closeSession(currentId!).catch(() => {});
      }
      const launchAttachments = launch?.attachments ?? [];
      const hasLaunch = Boolean(launch && (launch.text.trim() || launchAttachments.length > 0));

      // Empty "+" / new mission: open a local draft composer only. Do not call
      // session/new or insert an "Untitled mission" into the sidebar until the
      // operator actually sends the first message.
      if (!hasLaunch) {
        pendingLaunch = undefined;
        const draftId = `draft-${uid()}`;
        viewNavigation = nextViewNavigation(viewNavigation, draftId, beforeNew.workspace);
        const now = Date.now();
        const workspace = get().workspace;
        let recovered: Awaited<ReturnType<typeof loadDraftBuffer>> = null;
        try {
          recovered = await loadDraftBuffer(workspace);
        } catch (cause) {
          publishRuntimeError(cause, {
            domain: "environment",
            code: "DRAFT_READ_FAILED",
            message: "未发送草稿无法从 Host 恢复",
            recoverable: true,
            action: "已保留磁盘文件并打开空编辑器；重启 Grox 后自动重试",
            severity: "warning",
          });
        }
        const recoveredText = recovered?.text ?? "";
        const recoveredAttachments = (recovered?.attachments ?? []).map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          mime: item.mime,
          size: item.size,
          text: item.text,
          data: item.data,
        }));
        const hasRecovered = Boolean(recoveredText.trim() || recoveredAttachments.length > 0);
        set((state) => {
          const baseComposers = state.sessionComposers;
          const sessionComposers = hasRecovered
            ? {
                ...baseComposers,
                [draftId]: {
                  text: recoveredText,
                  attachments: recoveredAttachments,
                  model: state.model,
                  effort: state.effort,
                  mode: state.mode,
                  permissionMode: state.permissionMode,
                },
              }
            : baseComposers;
          if (hasRecovered) persistSessionComposers(sessionComposers);
          return {
            view: "session" as const,
            activeId: draftId,
            sessionComposers,
            sessions: {
              ...dropEphemeralSessions(state.sessions),
              [draftId]: {
                id: draftId,
                title: "",
                cwd: workspace,
                createdAt: now,
                updatedAt: now,
                model: state.model,
                blocks: [],
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  costUSD: 0,
                  contextUsed: 0,
                  contextMax: 0,
                  turns: 0,
                },
                status: "idle" as const,
              },
            },
            startupError: null,
          };
        });
        return;
      }

      pendingLaunch = {
        text: launch!.text,
        attachments: launchAttachments,
      };
      const pendingId = `pending-${uid()}`;
      viewNavigation = nextViewNavigation(viewNavigation, pendingId, beforeNew.workspace);
      pendingForegroundNavigation = viewNavigation;
      const now = Date.now();
      set((state) => ({
        view: "session",
        activeId: pendingId,
        sessions: {
          ...dropEphemeralSessions(state.sessions),
          [pendingId]: {
            id: pendingId,
            title: "正在创建任务",
            cwd: state.workspace,
            createdAt: now,
            updatedAt: now,
            model: state.model,
            blocks: [{
              type: "user" as const,
              id: uid(),
              text: launch!.text,
              attachments: launchAttachments.map(({ id, kind, name, mime, size }) => ({ id, kind, name, mime, size })),
              ts: now,
            }],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              costUSD: 0,
              contextUsed: 0,
              contextMax: 0,
              turns: 0,
            },
            // The ACP session has not been created yet. This is not a turn
            // that can be aborted; the composer represents this separately.
            status: "idle",
          },
        },
      }));
      try {
        await bridge.newSession(get().workspace);
        set({ startupError: null });
      } catch (error) {
        // Keep the just-sent draft recoverable: session/new (CLI boot, auth,
        // or ACP) can fail after we already left the draft shell.
        const failedLaunch = pendingLaunch;
        pendingLaunch = undefined;
        pendingForegroundNavigation = null;
        const draftId = `draft-${uid()}`;
        const workspace = get().workspace;
        const restored = buildDraftRestoreAfterSessionNewFailure({
          pendingId,
          draftId,
          workspace,
          launch: failedLaunch,
          sessions: get().sessions,
          sessionComposers: get().sessionComposers,
          controls: {
            model: get().model,
            effort: get().effort,
            mode: get().mode,
            permissionMode: get().permissionMode,
          },
          now: Date.now(),
        });
        if (restored.draftText.trim() || restored.draftAttachments.length > 0) {
          void saveDraftBuffer(workspace, restored.draftText, restored.draftAttachments).catch(() => {});
        }
        persistSessionComposers(restored.sessionComposers);
        set({
          sessions: restored.sessions,
          sessionComposers: restored.sessionComposers,
          activeId: restored.activeId,
          view: restored.view,
          startupError: errorText(error),
        });
        // 调用方（首页、并行任务面板）只有收到拒绝，才能保留自己的输入
        // 和附件。store 已恢复草稿壳并呈现错误，fire-and-forget 入口会
        // 显式吞掉这个已处理的拒绝。
        throw error;
      }
    },

    async newProject() {
      try {
        const cwd = await invoke<string | null>("pick_workspace");
        if (!cwd) return;
        // Explicit folder pick is the only restore path for dismissed projects.
        await get().setWorkspace(cwd, { restoreProject: true });
        await get().newSession();
      } catch (error) {
        set({ startupError: errorText(error) });
      }
    },

    async openProject(id) {
      const project = get().projects.find(
        (entry) => entry.id === id || samePath(entry.path, id) || entry.id === projectId(id),
      );
      if (!project) return;
      try {
        await get().setWorkspace(project.path);
      } catch (error) {
        set({ startupError: errorText(error) });
        throw error;
      }
    },

    renameProject(id, name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const projects = get().projects.map((project) =>
        project.id === id ? { ...project, name: trimmed } : project,
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      set({ projects });
    },

    pinProject(id) {
      const projects = get().projects.map((project) =>
        project.id === id ? { ...project, pinned: !project.pinned } : project,
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      set({ projects });
    },

    async archiveProject(id) {
      const target = get().projects.find((project) => project.id === id);
      if (!target) return;
      let baseSessionIndex = get().sessionIndex;
      try {
        const discovered = await bridge.listSessions(target.path);
        baseSessionIndex = mergeSessions(baseSessionIndex, discovered, target.path);
      } catch (error) {
        set({
          startupError: `无法完整枚举项目会话，将只处理当前已加载会话：${errorText(error)}`,
        });
      }
      const projectSessions = baseSessionIndex.filter((session) => samePath(session.cwd, target.path));
      if (projectSessions.length === 0) return;
      const archived = !projectSessions.every((session) => session.archived);
      const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
      const sessionIndex = baseSessionIndex.map((session) => {
        if (!samePath(session.cwd, target.path)) return session;
        flags[session.id] = { ...flags[session.id], archived };
        return { ...session, archived };
      });
      const projects = get().projects.map((project) =>
        project.id === id ? { ...project, archived: false } : project,
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      localStorage.setItem("grox.sessionFlags", JSON.stringify(flags));
      set({
        projects,
        sessionIndex,
        ...(archived && projectSessions.some((session) => session.id === get().activeId)
          ? { activeId: null, view: "home" as View }
          : {}),
      });
    },

    async removeProject(id) {
      const target = get().projects.find((project) => project.id === id || samePath(project.path, id));
      const path = target?.path ?? id;
      const dismissId = target ? projectId(target.path) : projectId(id);
      const errors: string[] = [];
      const sessionIds = get().sessionIndex
        .filter((meta) => samePath(meta.cwd, path))
        .map((meta) => meta.id);
      if (dismissId) {
        persistDismissedProjects(dismissProjectId(loadDismissedProjects(), dismissId));
      }
      const projects = get().projects.filter(
        (project) => project.id !== id && project.id !== dismissId && !samePath(project.path, id),
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      markSessionsDeleted(sessionIds);
      clearSessionFlags(sessionIds);
      const sessionIndex = get().sessionIndex.filter((meta) => !sessionIds.includes(meta.id));
      persistSessionCatalog(sessionIndex);
      const activeId = get().activeId;
      const leaveActive = Boolean(activeId && sessionIds.includes(activeId));

      // 删除意图必须先同步反映在目录和侧栏，不能被 CLI 启动或分页枚举阻塞。
      set({
        projects,
        sessionIndex,
        ...(get().activeProjectId === id || get().activeProjectId === dismissId
          ? { activeProjectId: null }
          : {}),
        ...(leaveActive ? { activeId: null, view: "home" as View } : {}),
      });

      for (const sessionId of sessionIds) {
        try {
          await get().deleteSession(sessionId);
        } catch (error) {
          errors.push(errorText(error));
        }
      }
      try {
        if ("__TAURI_INTERNALS__" in window) {
          const diskSessionIds = await invoke<string[]>("delete_project_session_data", { cwd: path });
          markSessionsDeleted(diskSessionIds);
          clearSessionFlags(diskSessionIds);
          for (const sessionId of diskSessionIds) {
            if (sessionIds.includes(sessionId)) continue;
            void bridge.deleteSession(sessionId).catch((error) => {
              console.info("CLI project session/delete skipped for stale session", sessionId, error);
            });
          }
        }
      } catch (error) {
        errors.push(errorText(error));
      }
      if (errors.length > 0) {
        set({ startupError: `项目已从侧栏删除，但部分磁盘会话清理失败：${errors.join("；")}` });
      }
    },

    async openProjectInExplorer(id) {
      const project = id
        ? get().projects.find((entry) => entry.id === id)
        : get().projects.find((entry) => entry.id === get().activeProjectId);
      try {
        await invoke("open_in_explorer", { cwd: project?.path ?? get().workspace, path: null });
      } catch (error) {
        set({ startupError: errorText(error) });
      }
    },

    async createProjectWorktree(id) {
      const project = get().projects.find((entry) => entry.id === id);
      if (!project) return;
      try {
        const path = await invoke<string>("create_permanent_worktree", { cwd: project.path });
        // Make the result discoverable immediately, just like Codex's
        // permanent-worktree action: create it, then reveal it in Finder.
        await invoke("open_in_explorer", { cwd: path, path: null });
      } catch (error) {
        set({ startupError: errorText(error) });
      }
    },

    async setWorkspace(cwd, options) {
      const navigation = options?.navigation
        ?? nextViewNavigation(viewNavigation, null, cwd);
      if (!options?.navigation) viewNavigation = navigation;
      const isCurrentSelection = () => shouldCommitViewNavigation(navigation, viewNavigation);
      await bridge.setWorkspace(cwd);
      if (!isCurrentSelection()) return;
      const workspace = await bridge.getWorkspace();
      if (!isCurrentSelection()) return;
      const fetchedSessions = await bridge.listSessions(workspace);
      if (!isCurrentSelection()) return;
      const sessionIndex = mergeSessions(get().sessionIndex, fetchedSessions, workspace);
      const projects = ensureProject(get().projects, workspace, {
        restore: Boolean(options?.restoreProject),
      });
      const activeProjectId = projects.some((project) => samePath(project.path, workspace))
        ? projectId(workspace)
        : null;
      set({
        workspace,
        projects,
        activeProjectId,
        sessionIndex: decorateSessions(sessionIndex),
        startupError: null,
        activeId: null,
        view: "home",
        workspaceDiffs: [],
        workspaceDiffReady: false,
        projectPreview: { status: "idle" },
        previewOpen: false,
        previewFile: null,
        planPreviewOpen: false,
      });
      if (!isCurrentSelection()) return;
      void get().refreshWorkspaceFiles();
      void get().refreshWorkspaceDiffs();
      void get().refreshProjectPreview(false);
    },

    async authenticate() {
      try {
        await bridge.authenticate();
        set({ auth: await bridge.getAuthState(), startupError: null });
        void get().refreshAccount();
        void get().refreshHistory();
      } catch (error) {
        let code = "";
        if (typeof error === "object" && error !== null) {
          const failure = error as { code?: unknown; error?: { code?: unknown } };
          code = String(failure.code ?? failure.error?.code ?? "");
        }
        set({
          auth: await bridge.getAuthState(),
          startupError: code === "AUTH_CANCELLED"
            ? null
            : errorText(error),
        });
      }
    },

    async cancelAuthentication() {
      await bridge.cancelAuthentication();
      set({ auth: await bridge.getAuthState(), startupError: null });
    },

    async logout() {
      await bridge.logout();
      const auth = await bridge.getAuthState();
      set({ auth, account: null, billing: null, startupError: null });
      await get().refreshAccount();
    },

    async refreshAccount() {
      set({ accountLoading: true });
      const provider = await bridge.getProviderStatus().catch(() => get().provider);
      try {
        const account = await bridge.getAccountInfo();
        let billing: BillingInfo | null = null;
        if (account.authenticated) {
          try {
            billing = await bridge.getBillingInfo();
          } catch {
            // Billing is only available for OAuth accounts.
          }
        }
        set({ account, billing, provider, accountLoading: false });
      } catch {
        set({ account: null, billing: null, provider, accountLoading: false });
      }
    },

    async refreshModels() {
      const state = await bridge.getModelState();
      const profile = get().providerProfiles.find((item) => item.id === get().activeProviderProfileId);
      const resolved = resolveModelState(providerModelState(state, profile));
      const { activeId, sessionComposers } = get();
      const active = activeId ? sessionComposers[activeId] : undefined;
      const model = active && resolved.models.some((item) => item.id === active.model) ? active.model : resolved.model;
      const next = activeId && active ? { ...sessionComposers, [activeId]: { ...active, model } } : sessionComposers;
      if (next !== sessionComposers) persistSessionComposers(next);
      set({ ...resolved, model, sessionComposers: next });
    },

    async configureProvider(config) {
      const wasComplete = localStorage.getItem("grox.accountSetupComplete") === "1";
      localStorage.setItem("grox.accountSetupComplete", "1");
      set({ accountSetupOpen: false });
      try {
        set({ providerSwitching: true });
        providerCapability().setSwitching(true);
        await bridge.configureProvider(config);
      } catch (error) {
        if (!wasComplete) localStorage.removeItem("grox.accountSetupComplete");
        set({ accountSetupOpen: !wasComplete, providerSwitching: false });
        throw error;
      }
      try {
        const [provider] = await Promise.all([
          bridge.getProviderStatus(),
          get().refreshProviderProfiles(),
        ]);
        // A compatible profile may have left a model id (for example a
        // provider-specific `grok-4.3-fast`) in the active composer. OAuth
        // only exposes the models reported by the fresh official agent, so
        // normalize it before the send lock is lifted rather than making the
        // first prompt fail a `session/set_model` RPC.
        await get().refreshModels();
        providerCapability().setProvider(provider);
        providerCapability().setSwitching(false);
        set({ provider, providerSwitching: false, startupError: null });
        restoreActiveSessionAfterProviderSwitch();
      } catch (error) {
        providerCapability().setSwitching(false);
        set({
          providerSwitching: false,
          startupError: formattedError(error, {
            domain: "environment",
            code: "PROVIDER_RUNTIME_SWITCH_FAILED",
            action: "确认凭据库可用、服务地址可达后重试",
          }),
        });
        throw error;
      }
      void get().refreshAccount().catch((error) => {
        set({ startupError: formattedError(error, {
          domain: "environment",
          code: "PROVIDER_STATUS_REFRESH_FAILED",
        }) });
      });
    },

    async refreshProviderProfiles() {
      try {
        const result = await bridge.listProviderProfiles();
        providerCapability().setProfiles(result.profiles, result.activeId);
        set(providerProfilesState(result));
      } catch (error) {
        set({ startupError: formattedError(error, {
          domain: "environment",
          code: "PROVIDER_PROFILES_READ_FAILED",
          action: "检查 ~/.grok/grox-providers.json 与系统凭据库后重试",
        }) });
        throw error;
      }
    },

    async saveProviderProfile(config) {
      const wasActive = Boolean(config.id && get().activeProviderProfileId === config.id);
      let profile = await bridge.saveProviderProfile(config);
      try {
        profile = await bridge.refreshProviderModels(profile.id);
      } catch (error) {
        set({ startupError: formattedError(error, {
          domain: "environment",
          code: "PROVIDER_MODELS_FETCH_FAILED",
          message: "供应商已保存，但模型列表获取失败",
          action: "检查服务地址、API Key 与网关的 /models 兼容性",
        }) });
      }
      if (wasActive) {
        set({ providerSwitching: true });
        try {
          // Editing the active profile also replaces the ACP child. Reload the
          // mission afterwards; otherwise its next turn can stay attached to
          // the child created for the previous endpoint.
          await bridge.activateProviderProfile(profile.id);
          restoreActiveSessionAfterProviderSwitch();
        } finally {
          set({ providerSwitching: false });
        }
      }
      await get().refreshProviderProfiles();
      if (get().activeProviderProfileId === profile.id) {
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
      }
      return profile;
    },

    async fetchProviderModels(config) {
      return bridge.fetchProviderModels(config);
    },

    async refreshProviderModels(id) {
      const profile = await bridge.refreshProviderModels(id);
      await get().refreshProviderProfiles();
      return profile;
    },

    async activateProviderProfile(id) {
      const expected = get().providerProfiles.find((profile) => profile.id === id);
      set({ providerSwitching: true });
      providerCapability().setSwitching(true);
      try {
        await bridge.activateProviderProfile(id);
        const activeId = get().activeId;
        const providerPromise = bridge.getProviderStatus();
        const profilesRefresh = get().refreshProviderProfiles();
        const provider = await providerPromise;
        const selectedBase = expected?.baseUrl.replace(/\/+$/, "");
        const activeBase = provider.baseUrl?.replace(/\/+$/, "");
        if (provider.kind !== "compatible" || !selectedBase || activeBase !== selectedBase) {
          throw new Error("供应商配置没有被 ACP 子进程确认，请检查服务地址后重试");
        }
        providerCapability().setProvider(provider);
        set({ provider });
        const preferredModel = providerDefaultModel(expected);
        if (preferredModel) {
          localStorage.setItem("grok.model", preferredModel);
          set((state) => {
            const composer = activeId ? state.sessionComposers[activeId] : undefined;
            const sessionComposers = activeId && composer
              ? { ...state.sessionComposers, [activeId]: { ...composer, model: preferredModel } }
              : state.sessionComposers;
            if (sessionComposers !== state.sessionComposers) persistSessionComposers(sessionComposers);
            return { model: preferredModel, sessionComposers };
          });
        }
        await profilesRefresh;
        providerCapability().setSwitching(false);
        set({ providerSwitching: false, startupError: null });
        restoreActiveSessionAfterProviderSwitch();
      } catch (error) {
        providerCapability().setSwitching(false);
        set({ providerSwitching: false });
        throw error;
      }
      void Promise.all([get().refreshAccount(), get().refreshModels()]).catch((error) => {
        set({ startupError: formattedError(error, {
          domain: "environment",
          code: "PROVIDER_STATE_REFRESH_FAILED",
        }) });
      });
    },

    async deleteProviderProfile(id) {
      const wasActive = get().activeProviderProfileId === id;
      await bridge.deleteProviderProfile(id);
      await get().refreshProviderProfiles();
      if (wasActive) {
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
        set({ activeId: null, view: "home", startupError: null });
      }
    },

    async refreshRuntime() {
      if (bridge.kind !== "acp") return;
      set({ runtimeBusy: true });
      try {
        const runtime = await invoke<GrokRuntimeInfo>("grok_runtime_info");
        set({ runtime, runtimeBusy: false });
      } catch (error) {
        set({
          runtimeBusy: false,
          startupError: errorText(error),
        });
      }
    },

    async installOfficialRuntime() {
      set({ runtimeBusy: true });
      try {
        await invoke<GrokRuntimeInfo>("install_official_grok_cli");
        window.location.reload();
      } catch (error) {
        set({ runtimeBusy: false });
        throw error;
      }
    },

    saveAutomation(automation) {
      const automations = upsertAutomation(get().automations, automation);
      automationCapability().setAutomations(automations);
      set({ automations });
      void persistAutomations(automations).catch((cause) => {
        publishRuntimeError(cause, {
          domain: "environment",
          code: "AUTOMATION_WRITE_FAILED",
          message: "自动化未能写入本地磁盘",
          recoverable: true,
          action: "当前进程仍保留任务；请检查磁盘空间和应用数据目录权限",
        });
      });
    },

    deleteAutomation(id) {
      const automations = removeAutomation(get().automations, id);
      automationCapability().setAutomations(automations);
      set({ automations });
      void persistAutomations(automations).catch((cause) => {
        publishRuntimeError(cause, {
          domain: "environment",
          code: "AUTOMATION_DELETE_WRITE_FAILED",
          message: "自动化删除结果未能写入本地磁盘",
          recoverable: true,
          action: "任务可能在重启后重新出现；请检查应用数据目录权限后再次删除",
        });
      });
    },

    setAutomationEnabled(id, enabled) {
      const automations = setAutomationEnabled(get().automations, id, enabled);
      automationCapability().setAutomations(automations);
      set({ automations });
      void persistAutomations(automations).catch((cause) => {
        publishRuntimeError(cause, {
          domain: "environment",
          code: "AUTOMATION_STATE_WRITE_FAILED",
          message: "自动化启停状态未能写入本地磁盘",
          recoverable: true,
          action: "当前进程已更新；重启前请检查应用数据目录权限",
        });
      });
    },

    async runAutomation(id) {
      automationCapability().setRunningId(id);
      set({ automationRunningId: id });
      try {
        await invoke("run_automation_now", { id });
      } catch (cause) {
        if (get().automationRunningId === id) {
          automationCapability().setRunningId(null);
          set({ automationRunningId: null });
        }
        const automation = get().automations.find((item) => item.id === id);
        const error = toGroxError(cause, {
          domain: "operation",
          code: "AUTOMATION_RUN_NOW_FAILED",
          message: automation ? `现在不能运行“${automation.title}”` : "自动化任务不存在",
          recoverable: true,
          action: "等待当前会话或自动化结束，并确认 Agent 运行时已连接",
        });
        if (automation) {
          saveAutomationHistory(prependAutomationRun(get().automationRunHistory, {
            id: newAutomationRunId(),
            automationId: automation.id,
            title: automation.title,
            at: Date.now(),
            outcome: error.domain === "operation" ? "skipped" : "error",
            source: "run_now",
            detail: error.message,
          }));
        }
        const notice = runtimeNoticeFromError(error);
        set((state) => ({
          runtimeNotices: [...state.runtimeNotices.filter((item) => item.id !== notice.id), notice],
        }));
      }
    },

    clearAutomationRunHistory() {
      saveAutomationHistory([]);
    },

    setAccountSetupOpen: (accountSetupOpen) => set({ accountSetupOpen }),

    async refreshWorkspaceFiles() {
      try {
        const workspaceFiles = await invoke<WorkspaceEntry[]>("list_workspace_files", {
          cwd: get().workspace,
        });
        set({ workspaceFiles });
      } catch (error) {
        set({ previewError: errorText(error) });
      }
    },

    async refreshWorkspaceDiffs() {
      if (bridge.kind === "mock") return;
      try {
        const response = await bridge.callExtension<unknown>("x.ai/git/diffs", {
          gitRoot: get().workspace,
          from: "HEAD",
          to: "working",
          includePatch: true,
          includeContent: true,
          maxPatchBytes: 2_000_000,
          maxPatchLines: 20_000,
        });
        set({ workspaceDiffs: mapGitDiffs(response), workspaceDiffReady: true });
      } catch {
        // Non-git workspaces and older agents simply have no project-level diff.
      }
    },

    async refreshProjectPreview(start = false) {
      const generation = ++projectPreviewRequestGeneration;
      const cwd = get().workspace;
      if (bridge.kind === "mock") {
        set({ projectPreview: { status: "none" } });
        return;
      }
      try {
        const projectPreview = await invoke<ProjectPreview>("start_project_preview", {
          cwd,
          start,
        });
        if (generation !== projectPreviewRequestGeneration || get().workspace !== cwd) return;
        const shouldOpen = start && (projectPreview.status === "starting" || projectPreview.status === "ready");
        set({
          projectPreview,
          ...(shouldOpen ? { inspectorOpen: true, inspectorTab: "preview" as InspectorTab, terminalOpen: false, previewOpen: false, planPreviewOpen: false } : {}),
        });
      } catch (error) {
        if (generation !== projectPreviewRequestGeneration || get().workspace !== cwd) return;
        set({
          projectPreview: {
            status: "error",
            error: errorText(error),
          },
        });
      }
    },

    setProjectPreviewUrl(url) {
      projectPreviewRequestGeneration += 1;
      set({ projectPreview: { ...get().projectPreview, status: "ready", url } });
    },

    async openPreview(path) {
      const generation = ++previewRequestGeneration;
      const cwd = get().workspace;
      set(beginFilePreview());
      previewCapability().setLoading(true);
      previewCapability().setError(null);
      previewCapability().setFile(null);
      try {
        let previewFile = await invoke<PreviewFile>("read_preview_file", {
          cwd,
          path,
        });
        if (generation !== previewRequestGeneration) return;
        if (["html", "image", "video", "audio", "pdf"].includes(previewFile.kind)) {
          const url = await invoke<string>("start_file_preview", {
            cwd,
            path,
          });
          if (generation !== previewRequestGeneration) return;
          previewFile = { ...previewFile, url };
        }
        previewCapability().setFile(previewFile);
        previewCapability().setLoading(false);
        set(finishFilePreview(previewFile));
      } catch (error) {
        if (generation !== previewRequestGeneration) return;
        const message = errorText(error);
        previewCapability().setFile(null);
        previewCapability().setLoading(false);
        previewCapability().setError(message);
        set(failFilePreview(message));
      }
    },

    closePreview: () => {
      previewRequestGeneration += 1;
      previewCapability().setFile(null);
      previewCapability().setLoading(false);
      previewCapability().setError(null);
      set(closeFilePreview());
    },

    async deleteSession(id) {
      markPromptInFlight(id);
      // 先写防复活标记并清理本地索引，避免 CLI 列表刷新与删除请求竞态。
      markSessionsDeleted([id]);
      clearSessionFlags([id]);
      // 取消尚未落盘的 debounce；否则删除完成后旧缓存可能被定时器重新写回。
      cancelPendingSessionJournal(id);
      const { sessionIndex, sessions, activeId, sessionComposers, workflows } = get();
      const rest = { ...sessions };
      delete rest[id];
      const nextComposers = { ...sessionComposers };
      delete nextComposers[id];
      const nextWorkflows = { ...workflows };
      delete nextWorkflows[id];
      const promptQueues = { ...get().promptQueues };
      delete promptQueues[id];
      const pendingSessionModels = { ...get().pendingSessionModels };
      delete pendingSessionModels[id];
      persistSessionComposers(nextComposers);
      persistWorkflowRuns(nextWorkflows);
      savePromptQueues(promptQueues);
      const nextIndex = sessionIndex.filter((m) => m.id !== id);
      persistSessionCatalog(nextIndex);
      if (activeId === id) {
        // 作废仍在等待 workspace/ACP 的旧 openSession；否则它会在删除后
        // 重新提交 activeId，留下没有实体的“正在恢复任务”页面。
        viewNavigation = nextViewNavigation(viewNavigation, null);
      }
      set({
        sessionIndex: nextIndex,
        sessions: rest,
        sessionComposers: nextComposers,
        workflows: nextWorkflows,
        promptQueues,
        pendingSessionModels,
        startupError: null,
        ...(activeId === id ? { activeId: null, view: "home" as View, restoringSessionId: null } : {}),
      });

      // 先通知运行中的回合停止写入，降低 Windows 上历史文件仍被占用的概率。
      bridge.cancel(id);
      let diskError: Error | null = null;
      try {
        if ("__TAURI_INTERNALS__" in window) await invoke("delete_session_data", { id });
      } catch (error) {
        const message = errorText(error);
        set({ startupError: `会话已从侧栏删除，但本地历史清理失败：${message}` });
        diskError = new Error(message);
      }
      // 本机磁盘是删除语义的权威来源。上游 CLI 同步可能因未启动、旧会话或
      // 不支持 delete 方法而卡住，不能反过来阻塞本地删除。
      void bridge.deleteSession(id).catch((error) => {
        console.info("CLI session/delete skipped for stale session", id, error);
      });
      if (diskError) throw diskError;
    },

    async removeSessionFromSidebar(id) {
      await get().deleteSession(id);
    },

    renameSession(id, title) {
      void bridge.renameSession(id, title).catch((error) => {
        set({ startupError: `会话标题仅在本机更新，CLI 重命名失败：${errorText(error)}` });
      });
      const { sessionIndex, sessions } = get();
      const nextIndex = sessionIndex.map((m) => (m.id === id ? { ...m, title } : m));
      persistSessionCatalog(nextIndex);
      set({
        sessionIndex: nextIndex,
        sessions: sessions[id]
          ? { ...sessions, [id]: { ...sessions[id], title } }
          : sessions,
      });
    },

    pinSession(id) {
      const current = get().sessionIndex.find((meta) => meta.id === id);
      const pinned = !current?.pinned;
      setSessionFlag(id, { pinned });
      set({
        sessionIndex: get().sessionIndex.map((meta) =>
          meta.id === id ? { ...meta, pinned } : meta,
        ),
      });
    },

    archiveSession(id) {
      const current = get().sessionIndex.find((meta) => meta.id === id);
      const archived = !current?.archived;
      setSessionFlag(id, { archived });
      set({
        sessionIndex: get().sessionIndex.map((meta) =>
          meta.id === id ? { ...meta, archived } : meta,
        ),
        ...(get().activeId === id && archived ? { activeId: null, view: "home" as View } : {}),
      });
    },

    markSessionUnread(id) {
      const nextIndex = get().sessionIndex.map((meta) =>
        meta.id === id ? { ...meta, completionUnread: true } : meta,
      );
      setSessionFlag(id, { completionUnread: true });
      persistSessionCatalog(nextIndex);
      set({ sessionIndex: nextIndex });
    },

    async copySessionValue(id, value) {
      const meta = get().sessionIndex.find((entry) => entry.id === id);
      if (!meta) return;
      try {
        const text = value === "cwd"
          ? meta.cwd
          : value === "id"
            ? meta.id
            : (() => {
                const url = new URL(window.location.href);
                url.search = "";
                url.hash = "";
                url.searchParams.set("open", meta.id);
                return url.toString();
              })();
        await navigator.clipboard.writeText(text);
      } catch (error) {
        set({ startupError: errorText(error) });
      }
    },

    async continueSessionInNewChat(id) {
      const meta = get().sessionIndex.find((entry) => entry.id === id);
      if (!meta) return;
      try {
        if (!samePath(meta.cwd, get().workspace)) await get().setWorkspace(meta.cwd);
        // 原生 fork 复制完整上下文但不启动新一轮，避免合成提示被全局
        // AGENTS/user_rules 改写意图，也避免用户只想查看时产生模型费用。
        const forked = await bridge.forkSession(id, meta.cwd, meta.title);
        // fork 的完整历史已经写入 CLI 会话目录。先以后台恢复路径合并
        // 磁盘历史，再切换视图；仅依赖 session/load 通知会把复制成功的
        // 会话短暂显示成空白对话。
        await bridge.loadSession(forked.sessionId, { background: true });
        await get().openSession(forked.sessionId);
      } catch (error) {
        set({ startupError: errorText(error) });
      }
    },

    async continueSessionInNewWorktree(id) {
      const meta = get().sessionIndex.find((entry) => entry.id === id);
      if (!meta) return;
      try {
        // Host 等待源回合结算、创建干净 worktree，并通过 Grok Build
        // x.ai/session/fork 复制完整上下文；不再用摘要提示伪装会话继续。
        const forked = await bridge.forkSessionInNewWorktree(id, meta.cwd);
        await get().setWorkspace(forked.cwd);
        await bridge.loadSession(forked.sessionId);
      } catch (error) {
        set({ startupError: errorText(error) });
      }
    },

    sendPrompt(text, attachments = [], targetSessionId, modeOverride, submission, queueItemId) {
      const { activeId, sessions, model, effort, mode, permissionMode, sessionComposers, providerSwitching, restoringSessionId } = get();
      const sessionId = targetSessionId ?? activeId;
      if (providerSwitching || restoringSessionId === sessionId) return false;
      const session = sessionId ? sessions[sessionId] : null;
      if (!session) return false;
      const storedComposer = sessionComposers[session.id] ?? {
        text: "",
        attachments: [],
        model,
        effort,
        mode,
        permissionMode,
      };
      const composer = modeOverride ? { ...storedComposer, mode: modeOverride } : storedComposer;

      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return false;
      const cwd = session.cwd || get().workspace;
      // 只有编辑器提交能消费其 crash buffer；队列、自动化和 Inspector 的
      // 内部发送不得顺手删除用户尚未发送的附件草稿。
      if (!shouldRetainDraftBufferUntilSessionReady(session.id) && submission) {
        void clearDraftBuffer(cwd).catch(() => {});
      } else if (shouldRetainDraftBufferUntilSessionReady(session.id)) {
        void saveDraftBuffer(cwd, trimmed, attachments).catch(() => {});
      }

      // Promote a local draft into a real ACP session on first send only.
      // Keep global controls in sync, then hand off to newSession which replaces
      // the draft with a pending shell — no activeId=null flash in between.
      // Do NOT wipe composer/buffer yet: session/new may reject (CLI/auth/ACP).
      if (isDraftSessionId(session.id)) {
        set({
          model: composer.model,
          effort: composer.effort,
          mode: modeOverride ?? composer.mode,
          permissionMode: composer.permissionMode,
        });
        void get().newSession({ text: trimmed, attachments }).catch(() => {});
        return true;
      }
      if (!sessionAcceptsNewPrimaryPrompt({ status: session.status, blocks: session.blocks })) {
        // Host 队列派发只允许领取当前空闲会话；竞态变忙时保留原行，
        // 不能把同一个 queue id 再复制成一条新提示。
        if (queueItemId) return false;
        const queue = get().promptQueues[session.id] ?? [];
        const duplicate = queue.some((item) => item.text.trim() === trimmed && trimmed.length > 0);
        if (duplicate) return false;
        const nextComposers = {
          ...sessionComposers,
          [session.id]: commitComposerSubmission(composer, submission),
        };
        const queued: QueuedPrompt = {
          id: uid(),
          text: trimmed,
          attachments,
          model: composer.model,
          effort: composer.effort,
          mode: composer.mode,
          permissionMode: composer.permissionMode,
          createdAt: Date.now(),
        };
        persistSessionComposers(nextComposers);
        const promptQueues = { ...get().promptQueues, [session.id]: [...queue, queued] };
        set({
          sessionComposers: nextComposers,
          promptQueues,
        });
        savePromptQueues(promptQueues);
        return true;
      }
      userStoppedSessions.delete(session.id);
      markPromptInFlight(session.id);
      const internalWorkflowControl = /^\/workflow\s+(?:pause|resume|stop)\s+\S+(?:\s|$)/i.test(trimmed);
      const titleText = trimmed || attachments.map((attachment) => attachment.name).join(", ");
      const nextIndex = get().sessionIndex.map((m) =>
        m.id === session.id
          ? {
              ...m,
              ...(m.title === "Untitled mission" && !internalWorkflowControl ? { title: titleText.slice(0, 56) } : {}),
              lastStatus: "running" as const,
              completionUnread: false,
            }
          : m,
      );
      persistSessionCatalog(nextIndex);

      const nextComposers = {
        ...sessionComposers,
        [session.id]: commitComposerSubmission(composer, submission),
      };
      persistSessionComposers(nextComposers);
      set({
        sessions: {
          ...sessions,
          [session.id]: {
            ...session,
            status: "running",
            title: session.title === "Untitled mission" && !internalWorkflowControl
              ? titleText.slice(0, 56)
              : session.title,
            blocks: internalWorkflowControl
              ? session.blocks
              : [
                  ...session.blocks,
                  {
                    type: "user",
                    id: uid(),
                    text: trimmed,
                    attachments: attachments.map(({ id, kind, name, mime, size }) => ({ id, kind, name, mime, size })),
                    ts: Date.now(),
                  },
                ],
          },
        },
        sessionIndex: nextIndex,
        sessionComposers: nextComposers,
        ...(activeId === session.id && modeOverride ? { mode: modeOverride } : {}),
      });

      // 队列保存的是入队时的权限意图，不能在数小时后反向扩大当前 Host 授权。
      // Host 会把该意图与当前 host_prefs 取更严格者。
      if (!queueItemId) bridge.setPermissionMode(composer.permissionMode);
      void bridge.prompt(session.id, trimmed, {
        model: composer.model,
        effort: composer.effort,
        mode: composer.mode,
        permissionMode: composer.permissionMode,
        attachments,
        ...(queueItemId ? { queueItemId } : {}),
      });
      return true;
    },

    async interjectPrompt(text, attachments = [], targetSessionId, submission) {
      const state = get();
      const sessionId = targetSessionId ?? state.activeId;
      if (!sessionId) return false;
      const session = state.sessions[sessionId];
      if (!session || state.providerSwitching || state.restoringSessionId === sessionId) return false;
      if (session.status !== "running") return get().sendPrompt(text, attachments, sessionId, undefined, submission);
      const composer = state.sessionComposers[sessionId] ?? {
        text: "",
        attachments: [],
        model: state.model,
        effort: state.effort,
        mode: state.mode,
        permissionMode: state.permissionMode,
      };
      try {
        const accepted = await bridge.interject(sessionId, text, {
          model: composer.model,
          effort: composer.effort,
          mode: composer.mode,
          attachments,
        });
        if (accepted) {
          const latestComposers = get().sessionComposers;
          const nextComposers = {
            ...latestComposers,
            [sessionId]: commitComposerSubmission(latestComposers[sessionId] ?? composer, submission),
          };
          persistSessionComposers(nextComposers);
          set({ sessionComposers: nextComposers });
          return true;
        }
        const queue = get().promptQueues[sessionId] ?? [];
        const queued: QueuedPrompt = {
          id: uid(), text: text.trim(), attachments,
          model: composer.model, effort: composer.effort, mode: composer.mode,
          permissionMode: composer.permissionMode, createdAt: Date.now(),
        };
        const promptQueues = { ...get().promptQueues, [sessionId]: [queued, ...queue] };
        set({ promptQueues });
        savePromptQueues(promptQueues);
        const latestComposers = get().sessionComposers;
        const nextComposers = {
          ...latestComposers,
          [sessionId]: commitComposerSubmission(latestComposers[sessionId] ?? composer, submission),
        };
        persistSessionComposers(nextComposers);
        set({ sessionComposers: nextComposers });
        return true;
      } catch (error) {
        set({ startupError: `插话失败：${errorText(error)}` });
        return false;
      }
    },

    removeQueuedPrompt(sessionId, queueId) {
      const queue = get().promptQueues[sessionId] ?? [];
      if (queue.some((item) => item.id === queueId && item.state === "sending")) return;
      const promptQueues = { ...get().promptQueues, [sessionId]: queue.filter((item) => item.id !== queueId) };
      set({ promptQueues });
      savePromptQueues(promptQueues);
    },

    updateQueuedPrompt(sessionId, queueId, text) {
      const queue = get().promptQueues[sessionId] ?? [];
      if (queue.some((item) => item.id === queueId && item.state === "sending")) return;
      const promptQueues = {
          ...get().promptQueues,
          [sessionId]: queue.map((item) => item.id === queueId ? { ...item, text } : item),
      };
      set({ promptQueues });
      savePromptQueues(promptQueues);
    },

    moveQueuedPrompt(sessionId, queueId, direction) {
      const queue = get().promptQueues[sessionId] ?? [];
      if (queue.some((item) => item.id === queueId && item.state === "sending")) return;
      const index = queue.findIndex((item) => item.id === queueId);
      if (queue[index + direction]?.state === "sending") return;
      const promptQueues = { ...get().promptQueues, [sessionId]: moveQueueEntry(queue, index, direction) };
      set({ promptQueues });
      savePromptQueues(promptQueues);
    },

    moveQueuedAttachment(sessionId, queueId, attachmentId, direction) {
      const queue = get().promptQueues[sessionId] ?? [];
      if (queue.some((item) => item.id === queueId && item.state === "sending")) return;
      const promptQueues = {
          ...get().promptQueues,
          [sessionId]: queue.map((item) => {
            if (item.id !== queueId) return item;
            const index = item.attachments.findIndex((attachment) => attachment.id === attachmentId);
            return { ...item, attachments: moveQueueEntry(item.attachments, index, direction) };
          }),
      };
      set({ promptQueues });
      savePromptQueues(promptQueues);
    },

    resumePromptQueue(sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      suppressedQueueDrain.delete(id);
      set({
        queueDrainParked: nextQueueDrainParked(get().queueDrainParked, id, false),
      });
      window.setTimeout(() => drainPromptQueue(id), 0);
    },

    clearPromptQueue(sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      suppressedQueueDrain.delete(id);
      const sending = (get().promptQueues[id] ?? []).filter((item) => item.state === "sending");
      const promptQueues = { ...get().promptQueues, [id]: sending };
      set({
        promptQueues,
        queueDrainParked: nextQueueDrainParked(get().queueDrainParked, id, false),
      });
      savePromptQueues(promptQueues);
    },

    stop() {
      const { activeId, promptQueues, queueDrainParked, sessions } = get();
      if (activeId) {
        const hasQueuedPrompts = (promptQueues[activeId] ?? []).length > 0;
        if (hasQueuedPrompts) suppressedQueueDrain.add(activeId);
        else suppressedQueueDrain.delete(activeId);
        userStoppedSessions.add(activeId);
        set({ queueDrainParked: nextQueueDrainParked(queueDrainParked, activeId, hasQueuedPrompts) });
        bridge.cancel(activeId);
        const session = sessions[activeId];
        if (session) {
          const returned = promptReturnedSessions.has(activeId);
          set({
            sessions: {
              ...get().sessions,
              [activeId]: {
                ...session,
                status: returned ? "idle" : "stopping",
                updatedAt: Date.now(),
                blocks: returned ? settleLiveProcessBlocks(session.blocks) : session.blocks,
              },
            },
          });
        }
      }
    },

    emergencyStopComputer() {
      const { activeId } = get();
      if (activeId) void bridge.emergencyStopComputer(activeId);
    },

    compact() {
      const { activeId, sessions } = get();
      if (activeId && sessions[activeId] && isSessionTerminal(sessions[activeId].status)) {
        void bridge.compact(activeId);
      }
    },

    async listRewindPoints() {
      const { activeId, sessions } = get();
      if (!activeId || !sessions[activeId] || !isSessionTerminal(sessions[activeId].status)) return [];
      return bridge.listRewindPoints(activeId);
    },

    async previewRewind(targetPromptIndex, mode) {
      const { activeId, sessions } = get();
      if (!activeId || !sessions[activeId] || !isSessionTerminal(sessions[activeId].status)) throw new Error("请等待当前请求完成后再回退");
      return bridge.rewind(activeId, targetPromptIndex, mode, false);
    },

    async executeRewind(point, mode) {
      const { activeId, sessions, sessionComposers } = get();
      if (!activeId || !sessions[activeId] || !isSessionTerminal(sessions[activeId].status)) throw new Error("请等待当前请求完成后再回退");
      // 用户已经写下的草稿优先于回退结果；没有未发送草稿时则恢复官方
      // rewind 返回的原始 prompt。不能只清掉分支却留下空输入框，否则
      // “回退并编辑”会造成用户可见的请求丢失。
      const draftBeforeRewind = sessionComposers[activeId]?.text ?? "";
      const result = await bridge.rewind(activeId, point.prompt_index, mode, true);
      if (!result.success) {
        throw new Error(result.error || `回退存在 ${result.conflicts.length} 个文件冲突`);
      }
      if (mode !== "files_only") {
        // The extension confirms the rewind before session/load has replayed
        // the shortened transcript. Remove stale UI blocks immediately, so
        // later turns never remain visible while the reload is in flight.
        const state = get();
        const session = state.sessions[activeId];
        const nextWorkflows = { ...state.workflows };
        delete nextWorkflows[activeId];
        if (session) {
          set({
            sessions: {
              ...state.sessions,
              [activeId]: {
                ...session,
                blocks: blocksBeforePrompt(session.blocks, point.prompt_index),
                status: "idle",
              },
            },
            workflows: nextWorkflows,
            planPreviewOpen: false,
            previewOpen: false,
          });
          persistWorkflowRuns(nextWorkflows);
        }
      }
      // `rewind/execute` is synchronous and already mutates the live ACP
      // session. Reloading here races the CLI's stale session/load journal,
      // which can resurrect the branch we just removed. Keep the atomically
      // pruned local snapshot as the visible source of truth instead.
      if (mode === "files_only") await bridge.loadSession(activeId);
      if (mode !== "files_only") {
        get().setDraft(draftBeforeRewind || result.prompt_text?.trim() || point.prompt_preview || "");
      }
      return result;
    },

    resolvePermission(blockId, option, feedback) {
      const { activeId, sessions } = get();
      if (activeId) {
        bridge.respondPermission(activeId, blockId, option, feedback);
        const block = sessions[activeId]?.blocks.find((candidate) => candidate.id === blockId);
        if (block?.type === "permission" && block.req.purpose === "plan" && (option !== "deny" || !feedback?.trim())) {
          set({ planPreviewOpen: false });
        }
      }
    },

    resolveQuestion(blockId, response) {
      const { activeId } = get();
      if (activeId) bridge.respondQuestion(activeId, blockId, response);
    },

    setModel: (model) => {
      const { activeId, sessions, sessionComposers, pendingSessionModels, effort, mode, permissionMode } = get();
      if (!activeId) {
        localStorage.setItem("grok.model", model);
        return set({ model });
      }
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const session = sessions[activeId];
      if (session && !isSessionTerminal(session.status)) {
        const nextPending = { ...pendingSessionModels };
        if (model === current.model) delete nextPending[activeId];
        else nextPending[activeId] = model;
        set({ pendingSessionModels: nextPending });
        return;
      }
      localStorage.setItem("grok.model", model);
      const next = { ...sessionComposers, [activeId]: { ...current, model } };
      persistSessionComposers(next);
      set({ model, sessionComposers: next });
    },
    setEffort: (effort) => {
      const { activeId, sessionComposers, model, mode, permissionMode } = get();
      localStorage.setItem("grok.effort", effort);
      if (!activeId) return set({ effort });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, effort } };
      persistSessionComposers(next);
      set({ effort, sessionComposers: next });
    },
    setMode: (mode) => {
      const { activeId, sessionComposers, model, effort, permissionMode } = get();
      if (!activeId) return set({ mode });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, mode } };
      persistSessionComposers(next);
      set({ mode, sessionComposers: next });
      void bridge.setSessionMode(activeId, mode).catch((error) => {
        set({ startupError: errorText(error) });
      });
    },
    setPermissionMode: (permissionMode) => {
      const targetSessionId = get().activeId;
      void enqueueHostPrefsMutation(async () => {
        try {
          const prefs = await invoke<HostPrefsProjection>("host_prefs_set_permission_mode", { mode: permissionMode });
          applyHostPrefs(prefs, targetSessionId);
        } catch (cause) {
          publishRuntimeError(cause, {
            domain: "environment",
            code: "HOST_PREFS_WRITE_FAILED",
            message: "权限模式未能保存到 Host",
            recoverable: true,
            action: "检查应用数据目录后重试；当前权限不会扩大",
          });
        }
      });
    },
    setComputerUseEnabled(enabled) {
      const targetSessionId = get().activeId;
      void enqueueHostPrefsMutation(async () => {
        const previousHostMode = readStoredPermissionMode(localStorage.getItem("grok.permissionMode"));
        try {
          const prefs = await invoke<HostPrefsProjection>("host_prefs_set_computer_use", { enabled });
          applyHostPrefs(prefs, targetSessionId, prefs.permissionMode !== previousHostMode);
        } catch (cause) {
          publishRuntimeError(cause, {
            domain: "environment",
            code: "HOST_PREFS_WRITE_FAILED",
            message: "Computer Use 设置未能保存到 Host",
            recoverable: true,
            action: "检查应用数据目录后重试；Host 不会采用未保存的设置",
          });
        }
      });
    },
    setBrowserUseEnabled(enabled) {
      const targetSessionId = get().activeId;
      void enqueueHostPrefsMutation(async () => {
        try {
          const prefs = await invoke<HostPrefsProjection>("host_prefs_set_browser_use", { enabled });
          applyHostPrefs(prefs, targetSessionId, false);
        } catch (cause) {
          publishRuntimeError(cause, {
            domain: "environment",
            code: "HOST_PREFS_WRITE_FAILED",
            message: "Browser Use 设置未能保存到 Host",
            recoverable: true,
            action: "检查应用数据目录后重试；Host 不会采用未保存的设置",
          });
        }
      });
    },
    setDraft(text) {
      const { activeId, sessionComposers, model, effort, mode, permissionMode, sessions, workspace } = get();
      if (!activeId) return;
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, text } };
      persistSessionComposers(next);
      set({ sessionComposers: next });
      // Crash buffer for unsent prompts (draft or idle session composer).
      const session = sessions[activeId];
      const cwd = session?.cwd || workspace;
      if (isDraftSessionId(activeId) || !session || isSessionTerminal(session.status)) {
        void saveDraftBuffer(cwd, text, current.attachments).catch(() => {});
      }
    },
    setComposerAttachments(attachments) {
      const { activeId, sessionComposers, model, effort, mode, permissionMode, sessions, workspace } = get();
      if (!activeId) return;
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, attachments } };
      set({ sessionComposers: next });
      const session = sessions[activeId];
      const cwd = session?.cwd || workspace;
      if (isDraftSessionId(activeId) || !session || isSessionTerminal(session.status)) {
        void saveDraftBuffer(cwd, current.text, attachments).catch(() => {});
      }
    },
    flushDurableState() {
      const state = get();
      flushAllPendingSessionJournals(state.sessions);
      if (catalogPersistTimer !== undefined) {
        window.clearTimeout(catalogPersistTimer);
        catalogPersistTimer = undefined;
      }
      if (pendingCatalog) {
        persistSessionCatalog(pendingCatalog);
        pendingCatalog = undefined;
      }
      if (composerPersistTimer !== undefined) {
        window.clearTimeout(composerPersistTimer);
        composerPersistTimer = undefined;
      }
      if (pendingComposerStates) {
        const serializable = Object.fromEntries(
          Object.entries(pendingComposerStates).map(([id, { attachments: _attachments, ...rest }]) => [id, rest]),
        );
        localStorage.setItem(SESSION_COMPOSERS_KEY, JSON.stringify(serializable));
        pendingComposerStates = undefined;
      }
      // Active composer crash buffer (text + attachments when budget allows).
      const activeId = state.activeId;
      if (activeId) {
        const composer = state.sessionComposers[activeId];
        const text = composer?.text ?? "";
        const attachments = composer?.attachments ?? [];
        const cwd = state.sessions[activeId]?.cwd || state.workspace;
        if (isDraftSessionId(activeId) || isSessionTerminal(state.sessions[activeId]?.status ?? "idle")) {
          void saveDraftBuffer(cwd, text, attachments).catch(() => {});
        }
      }
      flushDraftPersistence();
    },
    setInspectorTab: (inspectorTab) => set({ inspectorTab, inspectorOpen: true, terminalOpen: false, previewOpen: false, planPreviewOpen: false }),
    setPlanPreviewOpen: (planPreviewOpen) => set({ planPreviewOpen, ...(planPreviewOpen ? { previewOpen: false, inspectorOpen: false, terminalOpen: false } : {}) }),
    toggleInspector: () => set((state) => state.inspectorOpen
      ? { inspectorOpen: false }
      : { inspectorOpen: true, terminalOpen: false, previewOpen: false, planPreviewOpen: false }),
    toggleTerminal: () => set((state) => state.terminalOpen
      ? { terminalOpen: false }
      : { terminalOpen: true, inspectorOpen: false, previewOpen: false, planPreviewOpen: false }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    async refreshHistory() {
      if (historySyncPromise) return historySyncPromise;
      const task = (async () => {
        set({ historySyncing: true, historyError: null });
        try {
          const imported = await bridge.listSessions();
          const sessionIndex = mergeSessions(get().sessionIndex, imported);
          finishLegacyProjectArchiveMigration(sessionIndex);
          const projects = mergeDiscoveredProjects(get().projects, imported);
          set({
            sessionIndex,
            projects,
            historySyncing: false,
            historyCount: imported.length,
            historySyncedAt: Date.now(),
          });
        } catch (error) {
          set({
            historySyncing: false,
            historyError: errorText(error),
          });
        }
      })();
      historySyncPromise = task;
      try {
        await task;
      } finally {
        historySyncPromise = undefined;
      }
    },
  };
});
