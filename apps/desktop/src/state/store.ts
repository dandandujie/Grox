/* ─────────────────────────────────────────────────────────────────────────
   Central store. Owns session state, applies bridge events, exposes actions.
   The UI never touches the bridge directly.
   ───────────────────────────────────────────────────────────────────────── */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import { EFFORTS, isSessionTerminal, MODELS } from "../bridge/types";
import { notifyDesktop } from "../lib/notify";
import type {
  AgentMode,
  AccountInfo,
  AuthState,
  BillingInfo,
  BridgeEvent,
  Effort,
  PermissionOption,
  PermissionMode,
  QuestionResponse,
  ModelInfo,
  ModelState,
  PromptAttachment,
  ProviderStatus,
  Session,
  SessionBlock,
  SessionMeta,
  ToolCall,
  DiffHunk,
  PreviewFile,
  ProjectPreview,
  ProviderConfig,
  ProviderProfileSummary,
  SaveProviderProfile,
  FetchProviderModels,
  GrokRuntimeInfo,
  WorkspaceEntry,
  RewindMode,
  RewindPoint,
  RewindResult,
  SlashCommand,
  WorkflowRun,
  RuntimeNotice,
} from "../bridge/types";
import { DEMO_CWD } from "../demo/data";
import {
  clearDraftBuffer,
  flushAllPendingSessionCaches,
  flushSessionCache,
  loadDraftBuffer,
  loadSessionCache,
  removeSessionCache,
  saveDraftBuffer,
  scheduleSaveSessionCache,
  scrubSessionCacheOrphans,
} from "../lib/sessionCache";
import { readStoredPermissionMode } from "../lib/permissionMode";
import { shouldDrainLocalQueue } from "../lib/queueTurnPolicy";
import { mergeProjectSessionsPure } from "../lib/sessionCatalogMerge";
import { isLiveBusyStatus, mergeOfflineWithLive } from "../lib/offlineMerge";
import {
  reconcileIncomingStatus,
  statusAfterGateResolve,
} from "../lib/sessionGate";
import {
  consumeShellUpgradeRescan,
  sanitizeSessionForOpen,
  shouldCloseDetachedSession,
  shouldForceOfflineRescan,
} from "../lib/sessionOpenPolicy";
import {
  filterQueueGhostsByLiveText,
  nextLocalDrainIndex,
  moveQueueEntry,
} from "../lib/promptQueue";
import { nextQueueDrainParked } from "../lib/queueParkPolicy";
import {
  isComputerUseOperatorEnabled,
  setComputerUseHostEnvEnabled,
  setComputerUseHostPrefsEnabled,
  setComputerUseOperatorEnabled,
} from "../lib/computerUse";
import {
  dedupeProjects,
  dismissProjectId,
  ensureProject as ensureProjectPure,
  isDraftSessionId,
  isEphemeralSessionId,
  maySurfaceProject,
  mergeDiscoveredProjects as mergeDiscoveredProjectsPure,
  projectId,
  samePath,
  undismissProjectId,
} from "../lib/projectCatalog";
import {
  buildDraftRestoreAfterSessionNewFailure,
  shouldRetainDraftBufferUntilSessionReady,
} from "../lib/draftLaunchRecovery";

export type View = "home" | "session";
export type InspectorTab = "files" | "tasks" | "preview" | "usage";

const isWorkflowTerminal = (status: string) =>
  ["complete", "failed", "cancelled", "interrupted"].includes(status);

// `hideFromScrollback` is a wire-level flag, so old clients may already have
// persisted internal workflow traffic as normal user blocks. Keep a
// state-layer guard as well: a draft update or a late session/load must never
// bring task-panel controls back into the timeline.
const isHiddenWorkflowControlPrompt = (block: SessionBlock) => {
  if (block.type !== "user") return false;
  const text = block.text.trim();
  return /^A background workflow stopped\. Review the workflow completion reminder, report the result to the user, and take any appropriate next action\.$/i.test(text)
    || /^\/workflow\s+(?:pause|resume|stop)\s+\S+(?:\s|$)/i.test(text);
};

function mergeWorkflowEvents(previous: WorkflowRun["events"], incoming: WorkflowRun["events"]): WorkflowRun["events"] {
  const merged = [...previous, ...incoming];
  const unique = new Map<string, WorkflowRun["events"][number]>();
  for (const entry of merged) {
    const key = `${entry.timestamp ?? ""}\u0000${entry.event}\u0000${entry.detail ?? ""}`;
    unique.set(key, entry);
  }
  return [...unique.values()].slice(-64);
}

function mergeWorkflowRun(previous: WorkflowRun | undefined, incoming: WorkflowRun): WorkflowRun {
  if (!previous) return incoming;
  const traces = incoming.agentTraces
    ? [...new Map([
      ...(previous.agentTraces ?? []).map((trace) => [trace.childSessionId, trace] as const),
      ...incoming.agentTraces.map((trace) => [trace.childSessionId, trace] as const),
    ]).values()]
    : previous.agentTraces;
  return {
    ...previous,
    ...incoming,
    // Some versions omit unchanged arrays/fields on an update. Preserve the
    // last complete snapshot, while accumulating the public progress journal.
    phases: incoming.phases.length > 0 ? incoming.phases : previous.phases,
    agents: incoming.agents.length > 0 ? incoming.agents : previous.agents,
    events: mergeWorkflowEvents(previous.events, incoming.events),
    ...(traces ? { agentTraces: traces } : {}),
  };
}

export interface ProjectMeta {
  id: string;
  path: string;
  name: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  lastOpenedAt: number;
}

interface SessionFlags {
  pinned?: boolean;
  archived?: boolean;
  completionUnread?: boolean;
}

export interface SessionComposerState {
  text: string;
  attachments: PromptAttachment[];
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: PromptAttachment[];
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
  createdAt: number;
  source?: "local" | "cli";
  state?: "queued" | "interjected" | "sending";
  heldByCli?: boolean;
}

interface DesktopState {
  ready: boolean;
  startupError: string | null;
  runtimeNotices: RuntimeNotice[];
  auth: AuthState;
  bridgeKind: "mock" | "acp";
  workspace: string;
  view: View;
  projects: ProjectMeta[];
  activeProjectId: string | null;

  sessionIndex: SessionMeta[];
  sessions: Record<string, Session>;
  activeId: string | null;
  account: AccountInfo | null;
  billing: BillingInfo | null;
  provider: ProviderStatus;
  providerProfiles: ProviderProfileSummary[];
  activeProviderProfileId?: string;
  providerSwitching: boolean;
  /** The new provider is ready while its active transcript attaches. */
  restoringSessionId: string | null;
  runtime: GrokRuntimeInfo | null;
  runtimeBusy: boolean;
  accountLoading: boolean;
  accountSetupOpen: boolean;

  workspaceFiles: WorkspaceEntry[];
  workspaceDiffs: DiffHunk[];
  workspaceDiffReady: boolean;
  projectPreview: ProjectPreview;
  previewOpen: boolean;
  previewFile: PreviewFile | null;
  previewLoading: boolean;
  previewError: string | null;
  planPreviewOpen: boolean;
  slashCommands: Record<string, SlashCommand[]>;
  workflows: Record<string, WorkflowRun[]>;

  model: string;
  models: ModelInfo[];
  modelsUpdatedAt: number;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
  computerUseEnabled: boolean;
  browserUseEnabled: boolean;
  sessionComposers: Record<string, SessionComposerState>;
  promptQueues: Record<string, QueuedPrompt[]>;
  /** UI mirror of suppressNextIdleDrain (Stop parks auto-drain). */
  queueDrainParked: Record<string, boolean>;
  /** Model choices made during a turn, applied only when that turn settles. */
  pendingSessionModels: Record<string, string>;

  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  terminalOpen: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  historySyncing: boolean;
  historyCount: number;
  historyError: string | null;
  historySyncedAt: number;

  init(): Promise<void>;
  dismissRuntimeNotice(id: string): void;
  goHome(): void;
  openSession(id: string): Promise<void>;
  newSession(launch?: { text: string; attachments?: PromptAttachment[] }): Promise<void>;
  newProject(): Promise<void>;
  openProject(id: string): Promise<void>;
  renameProject(id: string, name: string): void;
  pinProject(id: string): void;
  archiveProject(id: string): void;
  removeProject(id: string): void;
  openProjectInExplorer(id?: string): Promise<void>;
  createProjectWorktree(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): void;
  pinSession(id: string): void;
  archiveSession(id: string): void;
  markSessionUnread(id: string): void;
  copySessionValue(id: string, value: "cwd" | "id" | "link"): Promise<void>;
  continueSessionInNewChat(id: string): Promise<void>;
  continueSessionInNewWorktree(id: string): Promise<void>;
  openSessionInNewWindow(id: string): Promise<void>;
  /** `restoreProject`: explicit add (folder picker) may undismiss a removed project. */
  setWorkspace(cwd: string, options?: { restoreProject?: boolean }): Promise<void>;
  authenticate(): Promise<void>;
  logout(): Promise<void>;
  refreshAccount(): Promise<void>;
  refreshModels(): Promise<void>;
  configureProvider(config: ProviderConfig): Promise<void>;
  refreshProviderProfiles(): Promise<void>;
  saveProviderProfile(config: SaveProviderProfile): Promise<ProviderProfileSummary>;
  fetchProviderModels(config: FetchProviderModels): Promise<string[]>;
  refreshProviderModels(id: string): Promise<ProviderProfileSummary>;
  activateProviderProfile(id: string): Promise<void>;
  deleteProviderProfile(id: string): Promise<void>;
  refreshRuntime(): Promise<void>;
  installOfficialRuntime(): Promise<void>;
  setAccountSetupOpen(open: boolean): void;
  refreshWorkspaceFiles(): Promise<void>;
  refreshWorkspaceDiffs(): Promise<void>;
  refreshProjectPreview(start?: boolean): Promise<void>;
  setProjectPreviewUrl(url: string): void;
  openPreview(path: string): Promise<void>;
  closePreview(): void;

  /**
   * Queue a turn for one session. A target is used by the composer while it
   * asynchronously prepares path-based image attachments, so switching tasks
   * during that read cannot redirect or erase the original draft.
   */
  sendPrompt(text: string, attachments?: PromptAttachment[], targetSessionId?: string, modeOverride?: AgentMode): boolean;
  interjectPrompt(text: string, attachments?: PromptAttachment[], targetSessionId?: string): Promise<boolean>;
  removeQueuedPrompt(sessionId: string, queueId: string): void;
  updateQueuedPrompt(sessionId: string, queueId: string, text: string): void;
  moveQueuedPrompt(sessionId: string, queueId: string, direction: -1 | 1): void;
  moveQueuedAttachment(sessionId: string, queueId: string, attachmentId: string, direction: -1 | 1): void;
  clearPromptQueue(sessionId?: string): void;
  stop(): void;
  emergencyStopComputer(): void;
  compact(): void;
  listRewindPoints(): Promise<RewindPoint[]>;
  previewRewind(targetPromptIndex: number, mode: RewindMode): Promise<RewindResult>;
  executeRewind(point: RewindPoint, mode: RewindMode): Promise<RewindResult>;
  resolvePermission(blockId: string, option: PermissionOption, feedback?: string): void;
  resolveQuestion(blockId: string, response: QuestionResponse): void;

  setModel(model: string): void;
  setEffort(effort: Effort): void;
  setMode(mode: AgentMode): void;
  setPermissionMode(mode: PermissionMode): void;
  setComputerUseEnabled(enabled: boolean): void;
  setBrowserUseEnabled(enabled: boolean): void;
  setDraft(text: string): void;
  /** Flush UI session cache + catalog for crash durability (visibility/pagehide). */
  flushDurableState(): void;
  setComposerAttachments(attachments: PromptAttachment[]): void;
  setInspectorTab(tab: InspectorTab): void;
  setPlanPreviewOpen(open: boolean): void;
  toggleInspector(): void;
  toggleTerminal(): void;
  setPaletteOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  refreshHistory(): Promise<void>;
}

const uid = () => crypto.randomUUID();
const suppressedQueueDrain = new Set<string>();
/** Upgrade generation: force background load once per session after shell bump. */
let upgradeForceOfflineRescan = false;
const upgradeForceRescanned = new Set<string>();
const SESSION_COMPOSERS_KEY = "grox.sessionComposers.v1";
const WORKFLOW_RUNS_KEY = "grox.workflowRuns.v1";
let catalogPersistTimer: number | undefined;
let pendingCatalog: SessionMeta[] | undefined;
let composerPersistTimer: number | undefined;
let pendingComposerStates: Record<string, SessionComposerState> | undefined;
let workflowPersistTimer: number | undefined;
let pendingWorkflowRuns: Record<string, WorkflowRun[]> | undefined;
let historySyncPromise: Promise<void> | undefined;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function loadSessionComposers(): Record<string, SessionComposerState> {
  const stored = loadJson<Record<string, Omit<SessionComposerState, "attachments">>>(
    SESSION_COMPOSERS_KEY,
    {},
  );
  return Object.fromEntries(
    Object.entries(stored).map(([id, state]) => [id, {
      ...state,
      effort: EFFORTS.find((effort) => effort === state.effort) ?? "high",
      attachments: [],
    }]),
  );
}

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

function loadWorkflowRuns(): Record<string, WorkflowRun[]> {
  const stored = loadJson<Record<string, WorkflowRun[]>>(WORKFLOW_RUNS_KEY, {});
  return Object.fromEntries(
    Object.entries(stored).map(([sessionId, runs]) => [sessionId, (Array.isArray(runs) ? runs : []).map((run) => ({
      ...run,
      phases: Array.isArray(run.phases) ? run.phases : [],
      agents: Array.isArray(run.agents) ? run.agents : [],
      events: Array.isArray(run.events) ? run.events : [],
      agentTraces: Array.isArray(run.agentTraces)
        ? run.agentTraces.map((trace) => ({ ...trace, entries: Array.isArray(trace.entries) ? trace.entries : [] }))
        : [],
    }))]),
  );
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

function loadProjects(): ProjectMeta[] {
  const loaded = dedupeProjects(loadJson<ProjectMeta[]>("grox.projects", []));
  localStorage.setItem("grox.projects", JSON.stringify(loaded));
  return loaded;
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
  return metas.map((meta) => ({ ...meta, ...flags[meta.id] }));
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
  // When scoped to a cwd (project open / setWorkspace), keep same-cwd offline
  // catalog rows the CLI did not return — otherwise "project +" hides history.
  const merged = cwd
    ? (mergeProjectSessionsPure(
        existing,
        samePath,
        cwd,
        decorateSessions(incoming),
        new Set(),
      ) as SessionMeta[])
    : (() => {
        const incomingIds = new Set(incoming.map((meta) => meta.id));
        return [
          ...decorateSessions(incoming),
          ...existing.filter((meta) => !incomingIds.has(meta.id)),
        ].sort((a, b) => b.updatedAt - a.updatedAt);
      })();
  persistSessionCatalog(merged);
  return merged;
}

function mergeDiscoveredProjects(projects: ProjectMeta[], sessions: SessionMeta[]): ProjectMeta[] {
  const next = mergeDiscoveredProjectsPure(
    projects,
    sessions,
    loadDismissedProjects(),
  ) as ProjectMeta[];
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

function patchLines(path: string, patch: string, additions = 0, deletions = 0): DiffHunk {
  const lines = patch
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.startsWith("diff --git") && !line.startsWith("index ") && !line.startsWith("@@") && !line.startsWith("--- ") && !line.startsWith("+++ "))
    .map((line) => ({
      kind: line.startsWith("+") ? "add" as const : line.startsWith("-") ? "del" as const : "ctx" as const,
      text: /^[ +\-]/.test(line) ? line.slice(1) : line,
    }));
  return {
    path,
    lines,
    added: additions || lines.filter((line) => line.kind === "add").length,
    removed: deletions || lines.filter((line) => line.kind === "del").length,
  };
}

function mapGitDiffs(value: unknown): DiffHunk[] {
  const envelope = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const resultValue = envelope.result ?? value;
  const result = resultValue && typeof resultValue === "object" ? resultValue as Record<string, unknown> : {};
  const files = Array.isArray(result.files) ? result.files : [];
  return files.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const file = entry as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "unknown";
    const patch = typeof file.patch === "string" ? file.patch : "";
    if (!patch && typeof file.oldText !== "string" && typeof file.newText !== "string") return [];
    if (patch) return [patchLines(path, patch, Number(file.additions) || 0, Number(file.deletions) || 0)];
    const oldText = typeof file.oldText === "string" ? file.oldText : "";
    const newText = typeof file.newText === "string" ? file.newText : "";
    const synthetic = `${oldText.split("\n").map((line) => `-${line}`).join("\n")}\n${newText.split("\n").map((line) => `+${line}`).join("\n")}`;
    return [patchLines(path, synthetic, Number(file.additions) || 0, Number(file.deletions) || 0)];
  });
}

function setSessionFlag(id: string, patch: SessionFlags) {
  const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
  flags[id] = { ...flags[id], ...patch };
  localStorage.setItem("grox.sessionFlags", JSON.stringify(flags));
}

function resolveModelState(state: ModelState) {
  const models = state.models.length > 0 ? state.models : MODELS;
  const saved = localStorage.getItem("grok.model");
  const model =
    (saved && models.some((item) => item.id === saved) ? saved : undefined) ??
    (models.some((item) => item.id === state.currentId) ? state.currentId : models[0].id);
  localStorage.setItem("grok.model", model);
  return { models, model, modelsUpdatedAt: Date.now() };
}

function providerModelState(state: ModelState, profile?: ProviderProfileSummary): ModelState {
  if (!profile || profile.residentModels.length === 0) return state;
  return {
    currentId: profile.residentModels.includes(state.currentId) ? state.currentId : profile.residentModels[0],
    models: profile.residentModels.map((id) => state.models.find((item) => item.id === id) ?? {
      id,
      label: id,
      tagline: profile.name,
    }),
  };
}

function providerDefaultModel(profile?: ProviderProfileSummary) {
  return profile?.residentModels[0] ?? profile?.availableModels[0];
}

/* StrictMode mounts effects twice in dev — subscribe once, ever. */
let bridgeSubscribed = false;
let workspaceWatchTimer: number | undefined;
let workspaceWatchTick = 0;
let pendingLaunch: { text: string; attachments: PromptAttachment[] } | undefined;
let providerRestoreGeneration = 0;

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

function patchBlock(
  blocks: SessionBlock[],
  blockId: string,
  patch: Partial<SessionBlock>,
): SessionBlock[] {
  return blocks.map((b) => (b.id === blockId ? ({ ...b, ...patch } as SessionBlock) : b));
}

function patchTool(
  blocks: SessionBlock[],
  blockId: string,
  call: Partial<ToolCall>,
): SessionBlock[] {
  return blocks.map((b) =>
    b.id === blockId && b.type === "tool"
      ? { ...b, call: { ...b.call, ...call } as ToolCall }
      : b,
  );
}

/** Keep only the transcript strictly before the rewind target turn. */
function blocksBeforePrompt(blocks: SessionBlock[], targetPromptIndex: number): SessionBlock[] {
  let promptIndex = -1;
  return blocks.filter((block) => {
    if (isHiddenWorkflowControlPrompt(block)) return false;
    if (block.type === "user" && !block.interjected) promptIndex += 1;
    return promptIndex < targetPromptIndex;
  });
}

export const useDesktop = create<DesktopState>((set, get) => {
  const drainPromptQueue = (sessionId: string) => {
    const state = get();
    const session = state.sessions[sessionId];
    let queue = state.promptQueues[sessionId] ?? [];
    // Ghost filter: drop rows whose text already matches last primary user.
    const lastUser = [...session?.blocks ?? []].reverse().find(
      (b) => b.type === "user" && !("interjected" in b && b.interjected),
    );
    const liveText = lastUser && lastUser.type === "user" ? lastUser.text : null;
    queue = filterQueueGhostsByLiveText(queue, liveText);
    if (queue.length !== (state.promptQueues[sessionId] ?? []).length) {
      set({ promptQueues: { ...state.promptQueues, [sessionId]: queue } });
    }
    if (!session || !shouldDrainLocalQueue({
      status: session.status,
      providerSwitching: state.providerSwitching,
      restoring: state.restoringSessionId === sessionId,
      suppressed: suppressedQueueDrain.has(sessionId),
      queueLength: queue.length,
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
    const rest = [...queue.slice(0, drainAt), ...queue.slice(drainAt + 1)];
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
    set({
      promptQueues: { ...state.promptQueues, [sessionId]: rest },
      sessionComposers,
    });
    const accepted = get().sendPrompt(next.text, next.attachments, sessionId, next.mode);
    if (!accepted) {
      const current = get().promptQueues[sessionId] ?? [];
      set({ promptQueues: { ...get().promptQueues, [sessionId]: [next, ...current] } });
    }
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
      if (isSessionTerminal(next.status)) flushSessionCache(next);
      else scheduleSaveSessionCache(next);
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
            ? { inspectorOpen: true, inspectorTab: "tasks" as InspectorTab }
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
        const filteredSession = {
          ...e.session,
          blocks: e.session.blocks.filter((block) => !isHiddenWorkflowControlPrompt(block)),
          preview: e.preview === true,
        };
        const existing = sessions[filteredSession.id];
        scheduleSaveSessionCache(filteredSession);
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
          ? existing
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
        const { blocks: _b, usage: _u, status: _st, preview: _preview, ...meta } = readySession;
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
        const previousMeta = sessionIndex.find((item) => item.id === readySession.id);
        const indexedMeta = {
          ...decorateSessions([meta])[0],
          lastStatus: nextSession.status,
          completionUnread: previousMeta?.completionUnread ?? false,
        };
        const nextIndex = e.background && previousMeta
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
        if (!e.background || remainsActive) bridge.setPermissionMode(composer.permissionMode);
        const nextSessions = e.background
          ? sessions
          : Object.fromEntries(Object.entries(sessions).filter(([id]) => !isEphemeralSessionId(id)));
        const readyProjectId = projects.some((project) => samePath(project.path, readySession.cwd))
          ? projectId(readySession.cwd)
          : null;
        set({
          sessions: { ...nextSessions, [readySession.id]: nextSession },
          sessionIndex: nextIndex,
          projects,
          sessionComposers,
          ...(!e.background ? {
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
          clearDraftBuffer(readySession.cwd);
          void bridge.prompt(readySession.id, launch.text, {
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            attachments: launch.attachments,
          });
        }
        break;
      }
      case "block_add":
        if (isHiddenWorkflowControlPrompt(e.block)) break;
        withSession(e.sessionId, (s) => ({ ...s, blocks: [...s.blocks, e.block] }));
        if (e.block.type === "plan" && get().activeId === e.sessionId) {
          set({ planPreviewOpen: true, previewOpen: false });
        }
        break;
      case "block_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: patchBlock(s.blocks, e.blockId, e.patch),
        }), false);
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
          set({ planPreviewOpen: true, previewOpen: false });
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
        withSession(
          e.sessionId,
          (s) => ({
            ...s,
            status: reconcileIncomingStatus(s.blocks, s.status, e.status),
          }),
          true,
          e.status === "idle" ? get().activeId !== e.sessionId : e.status === "running" ? false : undefined,
        );
        if (e.status === "idle") window.setTimeout(() => drainPromptQueue(e.sessionId), 0);
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
        withSession(
          e.sessionId,
          (s) => ({
            ...s,
            status: "failed",
            blocks: [
              ...s.blocks,
              { type: "system", id: uid(), text: e.message, ts: Date.now(), kind: "error" },
            ],
          }),
          true,
          false,
        );
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
    if (!activeId || activeId.startsWith("pending-") || !sessions[activeId]) {
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
          startupError: `模型服务已切换，但当前会话同步失败：${error instanceof Error ? error.message : String(error)}`,
        });
        resumePromptQueues();
      },
    );
  };

  return {
    ready: false,
    startupError: null,
    runtimeNotices: [],
    auth: { required: false, inProgress: false },
    bridgeKind: bridge.kind,
    workspace: DEMO_CWD,
    view: "home",
    projects: loadProjects(),
    activeProjectId: null,
    sessionIndex: [],
    sessions: {},
    activeId: null,
    account: null,
    billing: null,
    provider: { kind: "oauth", hasApiKey: false },
    providerProfiles: [],
    activeProviderProfileId: undefined,
    providerSwitching: false,
    restoringSessionId: null,
    runtime: null,
    runtimeBusy: false,
    accountLoading: false,
    accountSetupOpen:
      localStorage.getItem("grox.accountSetupComplete") !== "1" && bridge.kind !== "mock",
    workspaceFiles: [],
    workspaceDiffs: [],
    workspaceDiffReady: false,
    projectPreview: { status: "idle" },
    previewOpen: false,
    previewFile: null,
    previewLoading: false,
    previewError: null,
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
    promptQueues: {},
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

    async init() {
      if (bridgeSubscribed) return;
      bridgeSubscribed = true;
      bridge.subscribe(applyEvent);

      // ── Phase 0: paint the shell from local cache only ─────────────────
      // Critical: do NOT await CLI spawn / initialize in this turn. An
      // await here keeps the microtask queue busy for 2–3s and starves
      // React paint + pointer events even after ready:true is set.
      const sessionIndex = decorateSessions(loadJson<SessionMeta[]>("grox.sessionCatalog", []));
      const cachedWorkspace = (() => {
        try {
          return localStorage.getItem("grok.workspace")?.trim() || "";
        } catch {
          return "";
        }
      })();
      if (cachedWorkspace) {
        const projects = ensureProject(get().projects, cachedWorkspace);
        set({
          workspace: cachedWorkspace,
          projects,
          activeProjectId: projectId(cachedWorkspace),
          sessionIndex,
          ready: true,
        });
      } else {
        set({ sessionIndex, ready: true });
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
            void invoke("host_prefs_migrate_computer_use", { feEnabled: feCu }).catch(() => {});

            const [hostPrefs, envOn, env] = await Promise.all([
              invoke<{ computerUseEnabled?: boolean }>("host_prefs_get").catch(() => null),
              invoke<boolean>("computer_use_env_enabled").catch(() => false),
              invoke<{ appVersion?: string }>("desktop_environment").catch(() => null),
            ]);
            if (hostPrefs && typeof hostPrefs.computerUseEnabled === "boolean") {
              setComputerUseHostPrefsEnabled(hostPrefs.computerUseEnabled);
            }
            setComputerUseHostEnvEnabled(Boolean(envOn));
            if (env?.appVersion && consumeShellUpgradeRescan(env.appVersion)) {
              upgradeForceOfflineRescan = true;
              upgradeForceRescanned.clear();
            }
            set({ computerUseEnabled: isComputerUseOperatorEnabled() });
          } catch {
            // Host prefs are non-fatal.
          }
        })();
      }, 0);

      // ── Phase 2: agent boot only after idle (or immediately for deep links).
      // Keep the shell fully interactive for ~2s before any acp_spawn work.
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
            void get().refreshProviderProfiles();

            window.setTimeout(() => {
              if (get().auth.inProgress) return;
              void get().refreshWorkspaceFiles();
              void get().refreshProjectPreview(false);
              if (get().view === "session") void get().refreshWorkspaceDiffs();
            }, 1_500);

            window.setTimeout(() => {
              void scrubSessionCacheOrphans();
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
            else if (prompt) void get().newSession({ text: prompt });
          } catch (error) {
            set({
              ready: true,
              startupError: error instanceof Error ? error.message : String(error),
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
      });
    },

    async openSession(id) {
      const beforeOpen = get();
      const currentId = beforeOpen.activeId;
      const current = currentId ? beforeOpen.sessions[currentId] : undefined;
      if (shouldCloseDetachedSession({ currentId, nextId: id, status: current?.status })) {
        void bridge.closeSession(currentId!).catch(() => {});
      }
      const meta = beforeOpen.sessionIndex.find((entry) => entry.id === id);
      if (meta?.completionUnread) {
        const sessionIndex = beforeOpen.sessionIndex.map((entry) =>
          entry.id === id ? { ...entry, completionUnread: false } : entry,
        );
        persistSessionCatalog(sessionIndex);
        set({ sessionIndex });
      }
      if (meta && !samePath(meta.cwd, get().workspace)) await get().setWorkspace(meta.cwd);
      const state = get();
      const existing = state.sessions[id];
      const composer = state.sessionComposers[id];
      if (composer) bridge.setPermissionMode(composer.permissionMode);
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
      const forceRescan = shouldForceOfflineRescan({
        upgradeRescanActive: upgradeForceOfflineRescan,
        sessionAlreadyForceRescanned: upgradeForceRescanned.has(id),
      });
      if (!existing) {
        void loadSessionCache(id).then((cached) => {
          if (!cached) return;
          const latest = get();
          if (latest.sessions[id]) return;
          const painted = {
            ...cached,
            ...sanitizeSessionForOpen(cached),
          };
          set({ sessions: { ...latest.sessions, [id]: painted } });
        });
      }
      // Upgrade generation: always re-bind full history once per session.
      if (!existing || existing.preview || forceRescan) {
        if (forceRescan) upgradeForceRescanned.add(id);
        void bridge.loadSession(id, { background: true }).catch((error) => {
          set({ startupError: `会话后台同步失败：${error instanceof Error ? error.message : String(error)}` });
        });
      }
    },

    async newSession(launch) {
      const beforeNew = get();
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
        const now = Date.now();
        const workspace = get().workspace;
        const recovered = loadDraftBuffer(workspace);
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
          saveDraftBuffer(workspace, restored.draftText, restored.draftAttachments);
        }
        persistSessionComposers(restored.sessionComposers);
        set({
          sessions: restored.sessions,
          sessionComposers: restored.sessionComposers,
          activeId: restored.activeId,
          view: restored.view,
          startupError: error instanceof Error ? error.message : String(error),
        });
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
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    async openProject(id) {
      const project = get().projects.find(
        (entry) => entry.id === id || samePath(entry.path, id) || entry.id === projectId(id),
      );
      if (project) await get().setWorkspace(project.path);
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

    archiveProject(id) {
      const projects = get().projects.map((project) =>
        project.id === id ? { ...project, archived: !project.archived } : project,
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      set({ projects });
    },

    removeProject(id) {
      const target = get().projects.find((project) => project.id === id || samePath(project.path, id));
      const path = target?.path ?? id;
      const dismissId = target ? projectId(target.path) : projectId(id);
      if (dismissId) {
        persistDismissedProjects(dismissProjectId(loadDismissedProjects(), dismissId));
      }
      const projects = get().projects.filter(
        (project) => project.id !== id && project.id !== dismissId && !samePath(project.path, id),
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));

      // Keep sessions durable on disk, but move them out of the live sidebar into
      // the archive manager so "remove" does not create invisible orphans.
      const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
      const sessionIndex = get().sessionIndex.map((meta) => {
        if (!samePath(meta.cwd, path)) return meta;
        flags[meta.id] = { ...flags[meta.id], archived: true };
        return { ...meta, archived: true };
      });
      localStorage.setItem("grox.sessionFlags", JSON.stringify(flags));
      persistSessionCatalog(sessionIndex);

      const activeId = get().activeId;
      const activeSession = activeId ? get().sessions[activeId] : undefined;
      const leaveActive = Boolean(activeSession && samePath(activeSession.cwd, path));

      set({
        projects,
        sessionIndex,
        ...(get().activeProjectId === id || get().activeProjectId === dismissId
          ? { activeProjectId: null }
          : {}),
        ...(leaveActive ? { activeId: null, view: "home" as View } : {}),
      });
    },

    async openProjectInExplorer(id) {
      const project = id
        ? get().projects.find((entry) => entry.id === id)
        : get().projects.find((entry) => entry.id === get().activeProjectId);
      await invoke("open_in_explorer", { cwd: project?.path ?? get().workspace, path: null });
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
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    async setWorkspace(cwd, options) {
      await bridge.setWorkspace(cwd);
      const workspace = await bridge.getWorkspace();
      const fetchedSessions = await bridge.listSessions(workspace);
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
        set({
          auth: await bridge.getAuthState(),
          startupError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async logout() {
      await bridge.logout();
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
        set({ provider, providerSwitching: false, startupError: null });
        restoreActiveSessionAfterProviderSwitch();
      } catch (error) {
        set({
          providerSwitching: false,
          startupError: `模型服务切换失败：${error instanceof Error ? error.message : String(error)}`,
        });
        throw error;
      }
      void get().refreshAccount().catch((error) => {
        set({ startupError: error instanceof Error ? error.message : String(error) });
      });
    },

    async refreshProviderProfiles() {
      const result = await bridge.listProviderProfiles();
      set({ providerProfiles: result.profiles, activeProviderProfileId: result.activeId });
    },

    async saveProviderProfile(config) {
      const wasActive = Boolean(config.id && get().activeProviderProfileId === config.id);
      let profile = await bridge.saveProviderProfile(config);
      try {
        profile = await bridge.refreshProviderModels(profile.id);
      } catch (error) {
        set({ startupError: `供应商已保存，但模型列表获取失败：${error instanceof Error ? error.message : String(error)}` });
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
        set({ providerSwitching: false, startupError: null });
        restoreActiveSessionAfterProviderSwitch();
      } catch (error) {
        set({ providerSwitching: false });
        throw error;
      }
      void Promise.all([get().refreshAccount(), get().refreshModels()]).catch((error) => {
        set({ startupError: error instanceof Error ? error.message : String(error) });
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
          startupError: error instanceof Error ? error.message : String(error),
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

    setAccountSetupOpen: (accountSetupOpen) => set({ accountSetupOpen }),

    async refreshWorkspaceFiles() {
      try {
        const workspaceFiles = await invoke<WorkspaceEntry[]>("list_workspace_files", {
          cwd: get().workspace,
        });
        set({ workspaceFiles });
      } catch (error) {
        set({ previewError: error instanceof Error ? error.message : String(error) });
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
      if (bridge.kind === "mock") {
        set({ projectPreview: { status: "none" } });
        return;
      }
      try {
        const projectPreview = await invoke<ProjectPreview>("start_project_preview", {
          cwd: get().workspace,
          start,
        });
        const shouldOpen = start && (projectPreview.status === "starting" || projectPreview.status === "ready");
        set({
          projectPreview,
          ...(shouldOpen ? { inspectorOpen: true, inspectorTab: "preview" as InspectorTab } : {}),
        });
      } catch (error) {
        set({
          projectPreview: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },

    setProjectPreviewUrl(url) {
      set({ projectPreview: { ...get().projectPreview, status: "ready", url } });
    },

    async openPreview(path) {
      set({ previewOpen: true, planPreviewOpen: false, previewLoading: true, previewError: null });
      try {
        let previewFile = await invoke<PreviewFile>("read_preview_file", {
          cwd: get().workspace,
          path,
        });
        if (previewFile.kind === "html") {
          const url = await invoke<string>("start_file_preview", {
            cwd: get().workspace,
            path,
          });
          previewFile = { ...previewFile, url };
        }
        set({ previewFile, previewLoading: false });
      } catch (error) {
        set({
          previewFile: null,
          previewLoading: false,
          previewError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    closePreview: () => set({ previewOpen: false, previewFile: null, previewError: null }),

    async deleteSession(id) {
      await bridge.deleteSession(id);
      removeSessionCache(id);
      const { sessionIndex, sessions, activeId, sessionComposers, workflows } = get();
      const rest = { ...sessions };
      delete rest[id];
      const nextComposers = { ...sessionComposers };
      delete nextComposers[id];
      const nextWorkflows = { ...workflows };
      delete nextWorkflows[id];
      const pendingSessionModels = { ...get().pendingSessionModels };
      delete pendingSessionModels[id];
      persistSessionComposers(nextComposers);
      persistWorkflowRuns(nextWorkflows);
      const nextIndex = sessionIndex.filter((m) => m.id !== id);
      persistSessionCatalog(nextIndex);
      set({
        sessionIndex: nextIndex,
        sessions: rest,
        sessionComposers: nextComposers,
        workflows: nextWorkflows,
        pendingSessionModels,
        ...(activeId === id ? { activeId: null, view: "home" as View } : {}),
      });
    },

    renameSession(id, title) {
      void bridge.renameSession(id, title);
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
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    async continueSessionInNewChat(id) {
      const meta = get().sessionIndex.find((entry) => entry.id === id);
      if (!meta) return;
      const session = get().sessions[id];
      const lastUser = [...(session?.blocks ?? [])].reverse().find((block) => block.type === "user");
      const lastAssistant = [...(session?.blocks ?? [])].reverse().find((block) => block.type === "assistant");
      const userText = lastUser?.type === "user" ? lastUser.text : meta.title;
      const assistantText = lastAssistant?.type === "assistant" ? lastAssistant.text.slice(-1200) : "";
      const text = [
        "请在新会话中继续处理下面这个任务，并保留必要的上下文。",
        `原始请求：${userText}`,
        assistantText ? `上一会话的最新回复：${assistantText}` : "",
      ].filter(Boolean).join("\n\n");
      try {
        if (!samePath(meta.cwd, get().workspace)) await get().setWorkspace(meta.cwd);
        await get().newSession({ text });
      } catch (error) {
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    async continueSessionInNewWorktree(id) {
      const meta = get().sessionIndex.find((entry) => entry.id === id);
      if (!meta) return;
      try {
        const path = await invoke<string>("create_permanent_worktree", { cwd: meta.cwd });
        const session = get().sessions[id];
        const lastUser = [...(session?.blocks ?? [])].reverse().find((block) => block.type === "user");
        const text = `请在这个新的工作树中继续处理任务：${lastUser?.type === "user" ? lastUser.text : meta.title}`;
        await get().setWorkspace(path);
        await get().newSession({ text });
      } catch (error) {
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    async openSessionInNewWindow(id) {
      const meta = get().sessionIndex.find((entry) => entry.id === id);
      if (!meta) return;
      try {
        const url = new URL(window.location.href);
        url.search = "";
        url.hash = "";
        url.searchParams.set("open", id);
        if ("__TAURI_INTERNALS__" in window) {
          const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
          const label = `session-${id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 28)}-${Date.now()}`;
          const child = new WebviewWindow(label, {
            url: url.toString(),
            title: meta.title,
            width: 1180,
            height: 780,
            minWidth: 860,
            minHeight: 560,
            resizable: true,
          });
          child.once("tauri://error", (event) => {
            set({ startupError: String(event.payload ?? "无法打开新窗口") });
          });
        } else {
          window.open(url.toString(), "_blank", "noopener,noreferrer");
        }
      } catch (error) {
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    sendPrompt(text, attachments = [], targetSessionId, modeOverride) {
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
      // Real sessions: text is durable via CLI. Draft first-send must keep the
      // crash buffer (text + attachments) until session_ready.
      if (!shouldRetainDraftBufferUntilSessionReady(session.id)) {
        clearDraftBuffer(cwd);
      } else {
        saveDraftBuffer(cwd, trimmed, attachments);
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
        void get().newSession({ text: trimmed, attachments });
        return true;
      }
      if (!isSessionTerminal(session.status)) {
        const queue = get().promptQueues[session.id] ?? [];
        const duplicate = queue.some((item) => item.text.trim() === trimmed && trimmed.length > 0);
        if (duplicate) return false;
        const nextComposers = {
          ...sessionComposers,
          [session.id]: { ...composer, text: "", attachments: [] },
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
        set({
          sessionComposers: nextComposers,
          promptQueues: { ...get().promptQueues, [session.id]: [...queue, queued] },
        });
        return true;
      }
      suppressedQueueDrain.delete(session.id);
      if (get().queueDrainParked[session.id]) {
        set({
          queueDrainParked: nextQueueDrainParked(get().queueDrainParked, session.id, false),
        });
      }
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
        [session.id]: { ...composer, text: "", attachments: [] },
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

      bridge.setPermissionMode(composer.permissionMode);
      void bridge.prompt(session.id, trimmed, {
        model: composer.model,
        effort: composer.effort,
        mode: composer.mode,
        attachments,
      });
      return true;
    },

    async interjectPrompt(text, attachments = [], targetSessionId) {
      const state = get();
      const sessionId = targetSessionId ?? state.activeId;
      if (!sessionId) return false;
      const session = state.sessions[sessionId];
      if (!session || state.providerSwitching || state.restoringSessionId === sessionId) return false;
      if (session.status !== "running") return get().sendPrompt(text, attachments, sessionId);
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
          const nextComposers = {
            ...get().sessionComposers,
            [sessionId]: { ...composer, text: "", attachments: [] },
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
        set({ promptQueues: { ...get().promptQueues, [sessionId]: [queued, ...queue] } });
        const nextComposers = {
          ...get().sessionComposers,
          [sessionId]: { ...composer, text: "", attachments: [] },
        };
        persistSessionComposers(nextComposers);
        set({ sessionComposers: nextComposers });
        return true;
      } catch (error) {
        set({ startupError: `插话失败：${error instanceof Error ? error.message : String(error)}` });
        return false;
      }
    },

    removeQueuedPrompt(sessionId, queueId) {
      const queue = get().promptQueues[sessionId] ?? [];
      set({ promptQueues: { ...get().promptQueues, [sessionId]: queue.filter((item) => item.id !== queueId) } });
    },

    updateQueuedPrompt(sessionId, queueId, text) {
      const queue = get().promptQueues[sessionId] ?? [];
      set({
        promptQueues: {
          ...get().promptQueues,
          [sessionId]: queue.map((item) => item.id === queueId ? { ...item, text } : item),
        },
      });
    },

    moveQueuedPrompt(sessionId, queueId, direction) {
      const queue = get().promptQueues[sessionId] ?? [];
      const index = queue.findIndex((item) => item.id === queueId);
      set({ promptQueues: { ...get().promptQueues, [sessionId]: moveQueueEntry(queue, index, direction) } });
    },

    moveQueuedAttachment(sessionId, queueId, attachmentId, direction) {
      const queue = get().promptQueues[sessionId] ?? [];
      set({
        promptQueues: {
          ...get().promptQueues,
          [sessionId]: queue.map((item) => {
            if (item.id !== queueId) return item;
            const index = item.attachments.findIndex((attachment) => attachment.id === attachmentId);
            return { ...item, attachments: moveQueueEntry(item.attachments, index, direction) };
          }),
        },
      });
    },

    clearPromptQueue(sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      suppressedQueueDrain.delete(id);
      set({ promptQueues: { ...get().promptQueues, [id]: [] } });
    },

    stop() {
      const { activeId, queueDrainParked } = get();
      if (activeId) {
        suppressedQueueDrain.add(activeId);
        set({ queueDrainParked: nextQueueDrainParked(queueDrainParked, activeId, true) });
        bridge.cancel(activeId);
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
      // Rewind results can contain server-side workflow reminders instead of
      // the user's old prompt. A rewind must preserve the unsent composer as
      // it was (including an intentionally empty composer), never turn that
      // protocol text into a draft the user appears to have written.
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
      if (mode !== "files_only") get().setDraft(draftBeforeRewind);
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
        set({ startupError: error instanceof Error ? error.message : String(error) });
      });
    },
    setPermissionMode: (permissionMode) => {
      const { activeId, sessionComposers, model, effort, mode, computerUseEnabled } = get();
      if (permissionMode === "bypass") {
        const zh = document.documentElement.lang.startsWith("zh");
        const confirmed = window.confirm(
          zh
            ? "Bypass/YOLO 会跳过工具审批，仅应在完全可信环境使用。确定启用？"
            : "Bypass/YOLO skips tool approvals. Use only in fully trusted environments. Enable?",
        );
        if (!confirmed) return;
        if (computerUseEnabled) {
          bridge.setComputerUseEnabled(false);
          set({ computerUseEnabled: false });
        }
      }
      localStorage.setItem("grok.permissionMode", permissionMode);
      void invoke("host_prefs_set_permission_mode", { mode: permissionMode }).catch(() => {});
      bridge.setPermissionMode(permissionMode);
      if (!activeId) return set({ permissionMode });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, permissionMode } };
      persistSessionComposers(next);
      set({ permissionMode, sessionComposers: next });
    },
    setComputerUseEnabled(enabled) {
      const { permissionMode } = get();
      if (enabled && permissionMode === "bypass") {
        localStorage.setItem("grok.permissionMode", "default");
        bridge.setPermissionMode("default");
        void invoke("host_prefs_set_permission_mode", { mode: "default" }).catch(() => {});
        set({ permissionMode: "default" });
      }
      setComputerUseOperatorEnabled(enabled);
      void invoke("host_prefs_set_computer_use", { enabled }).catch(() => {});
      bridge.setComputerUseEnabled(enabled);
      set({ computerUseEnabled: isComputerUseOperatorEnabled() });
    },
    setBrowserUseEnabled(enabled) {
      bridge.setBrowserUseEnabled(enabled);
      set({ browserUseEnabled: enabled });
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
        saveDraftBuffer(cwd, text, current.attachments);
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
        saveDraftBuffer(cwd, current.text, attachments);
      }
    },
    flushDurableState() {
      const state = get();
      flushAllPendingSessionCaches(state.sessions);
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
          saveDraftBuffer(cwd, text, attachments);
        }
      }
    },
    setInspectorTab: (inspectorTab) => set({ inspectorTab, inspectorOpen: true }),
    setPlanPreviewOpen: (planPreviewOpen) => set({ planPreviewOpen, ...(planPreviewOpen ? { previewOpen: false } : {}) }),
    toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
    toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    async refreshHistory() {
      if (historySyncPromise) return historySyncPromise;
      const task = (async () => {
        set({ historySyncing: true, historyError: null });
        try {
          const imported = await bridge.listSessions();
          const sessionIndex = mergeSessions(get().sessionIndex, imported);
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
            historyError: error instanceof Error ? error.message : String(error),
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
