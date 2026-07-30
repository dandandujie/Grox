/* ─────────────────────────────────────────────────────────────────────────
   Central store. Owns session state, applies bridge events, exposes actions.
   The UI never touches the bridge directly.
   ───────────────────────────────────────────────────────────────────────── */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import { isSessionTerminal, MODELS } from "../bridge/types";
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
} from "../bridge/types";
import { DEMO_CWD } from "../demo/data";

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
}

export interface SessionComposerState {
  text: string;
  attachments: PromptAttachment[];
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
}

interface DesktopState {
  ready: boolean;
  startupError: string | null;
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
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): void;
  pinSession(id: string): void;
  archiveSession(id: string): void;
  setWorkspace(cwd: string): Promise<void>;
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
    Object.entries(stored).map(([id, state]) => [id, { ...state, attachments: [] }]),
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

const projectId = (path: string) => path.replace(/[\\/]+$/, "").toLocaleLowerCase();
const projectName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
const samePath = (left: string, right: string) => projectId(left) === projectId(right);

function ensureProject(projects: ProjectMeta[], path: string): ProjectMeta[] {
  const id = projectId(path);
  const now = Date.now();
  const current = projects.find((project) => project.id === id);
  const next = current
    ? projects.map((project) =>
        project.id === id ? { ...project, path, lastOpenedAt: now } : project,
      )
    : [
        ...projects,
        {
          id,
          path,
          name: projectName(path),
          pinned: false,
          archived: false,
          createdAt: now,
          lastOpenedAt: now,
        },
      ];
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
  const incomingIds = new Set(incoming.map((meta) => meta.id));
  const merged = [
    ...decorateSessions(incoming),
    ...existing.filter(
      (meta) =>
        !incomingIds.has(meta.id) &&
        (cwd === undefined || !samePath(meta.cwd, cwd)),
    ),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  persistSessionCatalog(merged);
  return merged;
}

function mergeDiscoveredProjects(projects: ProjectMeta[], sessions: SessionMeta[]): ProjectMeta[] {
  const next = [...projects];
  const known = new Set(next.map((project) => project.id));
  for (const session of sessions) {
    const id = projectId(session.cwd);
    if (!session.cwd.trim() || known.has(id)) continue;
    known.add(id);
    next.push({
      id,
      path: session.cwd,
      name: projectName(session.cwd),
      pinned: false,
      archived: false,
      createdAt: session.createdAt,
      lastOpenedAt: session.updatedAt,
    });
  }
  if (next.length !== projects.length) localStorage.setItem("grox.projects", JSON.stringify(next));
  return next;
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
  }, 750);
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
    if (block.type === "user") promptIndex += 1;
    return promptIndex < targetPromptIndex;
  });
}

export const useDesktop = create<DesktopState>((set, get) => {
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
      scheduleSessionCatalog(nextIndex);
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
        const readySession = {
          ...e.session,
          blocks: e.session.blocks.filter((block) => !isHiddenWorkflowControlPrompt(block)),
        };
        const { blocks: _b, usage: _u, status: _st, ...meta } = readySession;
        const launch = pendingLaunch;
        pendingLaunch = undefined;
        const optimistic = Object.values(sessions).find((item) => item.id.startsWith("pending-"));
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
        const nextIndex = [
          {
            ...decorateSessions([meta])[0],
            lastStatus: nextSession.status,
            completionUnread: previousMeta?.completionUnread ?? false,
          },
          ...sessionIndex.filter((m) => m.id !== readySession.id),
        ];
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
        const sessionComposers = { ...state.sessionComposers, [readySession.id]: composer };
        persistSessionComposers(sessionComposers);
        bridge.setPermissionMode(composer.permissionMode);
        const nextSessions = Object.fromEntries(
          Object.entries(sessions).filter(([id]) => !id.startsWith("pending-")),
        );
        set({
          sessions: { ...nextSessions, [readySession.id]: nextSession },
          sessionIndex: nextIndex,
          projects,
          workspace: readySession.cwd,
          activeProjectId: projectId(readySession.cwd),
          activeId: readySession.id,
          view: "session",
          model: composer.model,
          effort: composer.effort,
          mode: composer.mode,
          permissionMode: composer.permissionMode,
          sessionComposers,
        });
        if (launch) {
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
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "running",
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && b.type === "permission"
              ? { ...b, resolved: e.option }
              : b,
          ),
        }));
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
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "running",
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && b.type === "question"
              ? { ...b, response: e.response }
              : b,
          ),
        }));
        break;
      case "status":
        withSession(
          e.sessionId,
          (s) => ({ ...s, status: e.status }),
          true,
          e.status === "idle" ? get().activeId !== e.sessionId : e.status === "running" ? false : undefined,
        );
        break;
      case "usage":
        withSession(e.sessionId, (s) => ({ ...s, usage: e.usage }), false);
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

  // Changing provider replaces the ACP child. Reattach the visible session
  // only after that replacement, and lock the composer during the short load
  // so the first request cannot target a dead child process.
  const restoreActiveSessionAfterProviderSwitch = () => {
    const { activeId, sessions } = get();
    if (!activeId || activeId.startsWith("pending-") || !sessions[activeId]) {
      set({ restoringSessionId: null });
      return;
    }
    const generation = ++providerRestoreGeneration;
    set({ restoringSessionId: activeId });
    void bridge.loadSession(activeId).then(
      () => {
        if (generation === providerRestoreGeneration) set({ restoringSessionId: null });
      },
      (error) => {
        if (generation !== providerRestoreGeneration) return;
        set({
          restoringSessionId: null,
          startupError: `模型服务已切换，但当前会话同步失败：${error instanceof Error ? error.message : String(error)}`,
        });
      },
    );
  };

  return {
    ready: false,
    startupError: null,
    auth: { required: false, inProgress: false },
    bridgeKind: bridge.kind,
    workspace: DEMO_CWD,
    view: "home",
    projects: loadJson<ProjectMeta[]>("grox.projects", []),
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
    effort: (localStorage.getItem("grok.effort") as Effort) ?? "high",
    mode: "agent",
    permissionMode:
      localStorage.getItem("grok.permissionMode") === "auto"
        ? "auto"
        : localStorage.getItem("grok.permissionMode") === "bypass"
          ? "bypass"
          : "default",
    computerUseEnabled: localStorage.getItem("grox.computerUseEnabled") !== "0",
    browserUseEnabled: localStorage.getItem("grox.browserUseEnabled") !== "0",
    sessionComposers: loadSessionComposers(),
    pendingSessionModels: {},

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
      try {
        const runtime = bridge.kind === "acp"
          ? await invoke<GrokRuntimeInfo>("grok_runtime_info")
          : null;
        set({
          runtime,
          accountSetupOpen: get().accountSetupOpen || Boolean(runtime?.selectionRequired),
        });
        const workspace = await bridge.getWorkspace();
        const projects = ensureProject(get().projects, workspace);
        const [auth, modelState, provider] = await Promise.all([
          bridge.getAuthState(),
          bridge.getModelState(),
          bridge.getProviderStatus(),
        ]);
        const sessionIndex = decorateSessions(loadJson<SessionMeta[]>("grox.sessionCatalog", []));
        set({
          workspace,
          projects,
          activeProjectId: projectId(workspace),
          sessionIndex,
          auth,
          ...resolveModelState(modelState),
          provider,
          ready: true,
          startupError: null,
        });
        window.setTimeout(() => {
          if (get().auth.inProgress) return;
          void get().refreshWorkspaceFiles();
          void get().refreshProjectPreview(false);
          if (get().view === "session") void get().refreshWorkspaceDiffs();
        }, 750);
        if (!auth.required) void get().refreshAccount();
        void get().refreshProviderProfiles();
        window.setTimeout(() => {
          if (!get().auth.inProgress && get().historySyncedAt === 0) void get().refreshHistory();
        }, 500);
        if (workspaceWatchTimer === undefined) {
          workspaceWatchTimer = window.setInterval(() => {
            if (document.visibilityState !== "visible" || get().auth.inProgress || get().view !== "session") return;
            workspaceWatchTick += 1;
            void get().refreshWorkspaceDiffs();
            if (workspaceWatchTick % 3 === 0) void get().refreshWorkspaceFiles();
            if (get().projectPreview.status === "starting") void get().refreshProjectPreview();
          }, 2_000);
        }
      } catch (error) {
        set({
          ready: true,
          startupError: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      // Dev deep links: ?open=<sessionId> opens a mission,
      // ?prompt=<text> launches a fresh one. Runs once (guard above).
      const params = new URLSearchParams(window.location.search);
      const open = params.get("open");
      const prompt = params.get("prompt");
      if (open) void get().openSession(open);
      else if (prompt) {
        await get().newSession();
        get().sendPrompt(prompt);
      }
    },

    goHome: () => set({ view: "home", activeId: null }),

    async openSession(id) {
      const beforeOpen = get();
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
      const has = state.sessions[id];
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
      if (!has) await bridge.loadSession(id);
    },

    async newSession(launch) {
      pendingLaunch = launch
        ? { text: launch.text, attachments: launch.attachments ?? [] }
        : undefined;
      const pendingId = `pending-${uid()}`;
      const now = Date.now();
      set((state) => ({
        view: "session",
        activeId: pendingId,
        sessions: {
          ...state.sessions,
          [pendingId]: {
            id: pendingId,
            title: "正在创建任务",
            cwd: state.workspace,
            createdAt: now,
            updatedAt: now,
            model: state.model,
            blocks: launch
              ? [{
                  type: "user" as const,
                  id: uid(),
                  text: launch.text,
                  attachments: (launch.attachments ?? []).map(({ id, kind, name, mime, size }) => ({ id, kind, name, mime, size })),
                  ts: now,
                }]
              : [],
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
        pendingLaunch = undefined;
        set((state) => {
          const sessions = { ...state.sessions };
          delete sessions[pendingId];
          return {
            sessions,
            activeId: null,
            view: "home",
            startupError: error instanceof Error ? error.message : String(error),
          };
        });
      }
    },

    async newProject() {
      try {
        const cwd = await invoke<string | null>("pick_workspace");
        if (!cwd) return;
        await get().setWorkspace(cwd);
        await get().newSession();
      } catch (error) {
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    async openProject(id) {
      const project = get().projects.find((entry) => entry.id === id);
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
      const projects = get().projects.filter((project) => project.id !== id);
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      set({ projects, ...(get().activeProjectId === id ? { activeProjectId: null } : {}) });
    },

    async openProjectInExplorer(id) {
      const project = id
        ? get().projects.find((entry) => entry.id === id)
        : get().projects.find((entry) => entry.id === get().activeProjectId);
      await invoke("open_in_explorer", { cwd: project?.path ?? get().workspace, path: null });
    },

    async setWorkspace(cwd) {
      await bridge.setWorkspace(cwd);
      const workspace = await bridge.getWorkspace();
      const fetchedSessions = await bridge.listSessions(workspace);
      const sessionIndex = mergeSessions(get().sessionIndex, fetchedSessions, workspace);
      const projects = ensureProject(get().projects, workspace);
      set({
        workspace,
        projects,
        activeProjectId: projectId(workspace),
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

    sendPrompt(text, attachments = [], targetSessionId, modeOverride) {
      const { activeId, sessions, model, effort, mode, permissionMode, sessionComposers, providerSwitching, restoringSessionId } = get();
      const sessionId = targetSessionId ?? activeId;
      if (providerSwitching || restoringSessionId === sessionId) return false;
      const session = sessionId ? sessions[sessionId] : null;
      if (!session || !isSessionTerminal(session.status)) return false;
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

    stop() {
      const { activeId } = get();
      if (activeId) bridge.cancel(activeId);
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
        set({ permissionMode: "default" });
      }
      bridge.setComputerUseEnabled(enabled);
      set({ computerUseEnabled: enabled });
    },
    setBrowserUseEnabled(enabled) {
      bridge.setBrowserUseEnabled(enabled);
      set({ browserUseEnabled: enabled });
    },
    setDraft(text) {
      const { activeId, sessionComposers, model, effort, mode, permissionMode } = get();
      if (!activeId) return;
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, text } };
      persistSessionComposers(next);
      set({ sessionComposers: next });
    },
    setComposerAttachments(attachments) {
      const { activeId, sessionComposers, model, effort, mode, permissionMode } = get();
      if (!activeId) return;
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      set({ sessionComposers: { ...sessionComposers, [activeId]: { ...current, attachments } } });
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
