/* ─────────────────────────────────────────────────────────────────────────
   Central store. Owns session state, applies bridge events, exposes actions.
   The UI never touches the bridge directly.
   ───────────────────────────────────────────────────────────────────────── */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import { MODELS } from "../bridge/types";
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
} from "../bridge/types";
import { DEMO_CWD } from "../demo/data";

export type View = "home" | "session";
export type InspectorTab = "files" | "tasks" | "preview" | "usage";

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

  model: string;
  models: ModelInfo[];
  modelsUpdatedAt: number;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
  sessionComposers: Record<string, SessionComposerState>;

  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  paletteOpen: boolean;
  settingsOpen: boolean;
  historySyncing: boolean;
  historyCount: number;
  historyError: string | null;
  historySyncedAt: number;

  init(): Promise<void>;
  goHome(): void;
  openSession(id: string): Promise<void>;
  newSession(): Promise<void>;
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

  sendPrompt(text: string, attachments?: PromptAttachment[]): void;
  stop(): void;
  compact(): void;
  listRewindPoints(): Promise<RewindPoint[]>;
  previewRewind(targetPromptIndex: number, mode: RewindMode): Promise<RewindResult>;
  executeRewind(point: RewindPoint, mode: RewindMode): Promise<RewindResult>;
  resolvePermission(blockId: string, option: PermissionOption): void;
  resolveQuestion(blockId: string, response: QuestionResponse): void;

  setModel(model: string): void;
  setEffort(effort: Effort): void;
  setMode(mode: AgentMode): void;
  setPermissionMode(mode: PermissionMode): void;
  setDraft(text: string): void;
  setComposerAttachments(attachments: PromptAttachment[]): void;
  setInspectorTab(tab: InspectorTab): void;
  toggleInspector(): void;
  setPaletteOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  refreshHistory(): Promise<void>;
}

const uid = () => crypto.randomUUID();
const SESSION_COMPOSERS_KEY = "grox.sessionComposers.v1";
let catalogPersistTimer: number | undefined;
let pendingCatalog: SessionMeta[] | undefined;
let composerPersistTimer: number | undefined;
let pendingComposerStates: Record<string, SessionComposerState> | undefined;
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

function mergeProjectSessions(
  existing: SessionMeta[],
  cwd: string,
  incoming: SessionMeta[],
): SessionMeta[] {
  const incomingIds = new Set(incoming.map((meta) => meta.id));
  const merged = [
    ...decorateSessions(incoming),
    ...existing.filter((meta) => !samePath(meta.cwd, cwd) && !incomingIds.has(meta.id)),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  persistSessionCatalog(merged);
  return merged;
}

function mergeAllSessions(existing: SessionMeta[], incoming: SessionMeta[]): SessionMeta[] {
  const incomingIds = new Set(incoming.map((meta) => meta.id));
  const merged = [
    ...decorateSessions(incoming),
    ...existing.filter((meta) => !incomingIds.has(meta.id)),
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

/* StrictMode mounts effects twice in dev — subscribe once, ever. */
let bridgeSubscribed = false;
let workspaceWatchTimer: number | undefined;
let workspaceWatchTick = 0;

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

export const useDesktop = create<DesktopState>((set, get) => {
  const applyEvent = (e: BridgeEvent) => {
    const { sessions, sessionIndex } = get();

    const withSession = (sessionId: string, fn: (s: Session) => Session, touchCatalogue = true) => {
      const state = get();
      const s = state.sessions[sessionId];
      if (!s) return;
      const next = { ...fn(s), updatedAt: Date.now() };
      if (!touchCatalogue) {
        set({ sessions: { ...state.sessions, [sessionId]: next } });
        return;
      }
      const nextIndex = state.sessionIndex.map((m) =>
        m.id === sessionId ? { ...m, updatedAt: next.updatedAt } : m,
      );
      scheduleSessionCatalog(nextIndex);
      set({
        sessions: { ...state.sessions, [sessionId]: next },
        sessionIndex: nextIndex,
      });
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
        const { blocks: _b, usage: _u, status: _st, ...meta } = e.session;
        const nextIndex = [
          decorateSessions([meta])[0],
          ...sessionIndex.filter((m) => m.id !== e.session.id),
        ];
        const projects = ensureProject(get().projects, e.session.cwd);
        persistSessionCatalog(nextIndex);
        const state = get();
        const existingComposer = state.sessionComposers[e.session.id];
        const composer: SessionComposerState = existingComposer ?? {
          text: "",
          attachments: [],
          model: state.models.some((item) => item.id === e.session.model)
            ? e.session.model
            : state.model,
          effort: state.effort,
          mode: state.mode,
          permissionMode: state.permissionMode,
        };
        const sessionComposers = { ...state.sessionComposers, [e.session.id]: composer };
        persistSessionComposers(sessionComposers);
        bridge.setPermissionMode(composer.permissionMode);
        set({
          sessions: { ...sessions, [e.session.id]: e.session },
          sessionIndex: nextIndex,
          projects,
          workspace: e.session.cwd,
          activeProjectId: projectId(e.session.cwd),
          activeId: e.session.id,
          view: "session",
          model: composer.model,
          effort: composer.effort,
          mode: composer.mode,
          permissionMode: composer.permissionMode,
          sessionComposers,
        });
        break;
      }
      case "block_add":
        withSession(e.sessionId, (s) => ({ ...s, blocks: [...s.blocks, e.block] }));
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
        withSession(e.sessionId, (s) => ({ ...s, status: e.status }));
        break;
      case "usage":
        withSession(e.sessionId, (s) => ({ ...s, usage: e.usage }), false);
        break;
      case "error":
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "idle",
          blocks: [
            ...s.blocks,
            { type: "system", id: uid(), text: e.message, ts: Date.now(), kind: "error" },
          ],
        }));
        break;
    }
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
    sessionComposers: loadSessionComposers(),

    inspectorOpen: true,
    inspectorTab: "files",
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
      const meta = get().sessionIndex.find((entry) => entry.id === id);
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

    async newSession() {
      try {
        await bridge.newSession(get().workspace);
        set({ startupError: null });
      } catch (error) {
        set({ startupError: error instanceof Error ? error.message : String(error) });
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
      const sessionIndex = mergeProjectSessions(get().sessionIndex, workspace, fetchedSessions);
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
        if (Object.values(get().sessions).some((session) => session.status !== "idle")) {
          throw new Error("请先终止正在执行的任务，再切换模型服务");
        }
        const activeId = get().activeId;
        set({ providerSwitching: true });
        await bridge.configureProvider(config);
        await get().refreshProviderProfiles();
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
        if (activeId) await bridge.loadSession(activeId);
        set({ providerSwitching: false, startupError: null });
      } catch (error) {
        if (!wasComplete) localStorage.removeItem("grox.accountSetupComplete");
        set({ accountSetupOpen: !wasComplete, providerSwitching: false });
        throw error;
      }
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
      if (wasActive) await bridge.activateProviderProfile(profile.id);
      await get().refreshProviderProfiles();
      if (get().activeProviderProfileId === profile.id) await get().refreshModels();
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
      if (Object.values(get().sessions).some((session) => session.status !== "idle")) {
        throw new Error("请先终止正在执行的任务，再切换模型服务");
      }
      const activeId = get().activeId;
      set({ providerSwitching: true });
      try {
        await bridge.activateProviderProfile(id);
        await get().refreshProviderProfiles();
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
        if (activeId) await bridge.loadSession(activeId);
        set({ providerSwitching: false, startupError: null });
      } catch (error) {
        set({ providerSwitching: false });
        throw error;
      }
    },

    async deleteProviderProfile(id) {
      const wasActive = get().activeProviderProfileId === id;
      const activeId = get().activeId;
      await bridge.deleteProviderProfile(id);
      await get().refreshProviderProfiles();
      if (wasActive) {
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
        if (activeId) await bridge.loadSession(activeId);
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
      set({ previewOpen: true, previewLoading: true, previewError: null });
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
      const { sessionIndex, sessions, activeId, sessionComposers } = get();
      const rest = { ...sessions };
      delete rest[id];
      const nextComposers = { ...sessionComposers };
      delete nextComposers[id];
      persistSessionComposers(nextComposers);
      const nextIndex = sessionIndex.filter((m) => m.id !== id);
      persistSessionCatalog(nextIndex);
      set({
        sessionIndex: nextIndex,
        sessions: rest,
        sessionComposers: nextComposers,
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

    sendPrompt(text, attachments = []) {
      const { activeId, sessions, model, effort, mode, permissionMode, sessionComposers } = get();
      const session = activeId ? sessions[activeId] : null;
      if (!session || session.status !== "idle") return;
      const composer = sessionComposers[session.id] ?? {
        text: "",
        attachments: [],
        model,
        effort,
        mode,
        permissionMode,
      };

      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const titleText = trimmed || attachments.map((attachment) => attachment.name).join(", ");
      const nextIndex = get().sessionIndex.map((m) =>
        m.id === session.id && m.title === "Untitled mission"
          ? { ...m, title: titleText.slice(0, 56) }
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
            title: session.title === "Untitled mission" ? titleText.slice(0, 56) : session.title,
            blocks: [
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
      });

      bridge.setPermissionMode(composer.permissionMode);
      void bridge.prompt(session.id, trimmed, {
        model: composer.model,
        effort: composer.effort,
        mode: composer.mode,
        attachments,
      });
    },

    stop() {
      const { activeId } = get();
      if (activeId) bridge.cancel(activeId);
    },

    compact() {
      const { activeId, sessions } = get();
      if (activeId && sessions[activeId]?.status === "idle") {
        void bridge.compact(activeId);
      }
    },

    async listRewindPoints() {
      const { activeId, sessions } = get();
      if (!activeId || sessions[activeId]?.status !== "idle") return [];
      return bridge.listRewindPoints(activeId);
    },

    async previewRewind(targetPromptIndex, mode) {
      const { activeId, sessions } = get();
      if (!activeId || sessions[activeId]?.status !== "idle") throw new Error("请等待当前请求完成后再回退");
      return bridge.rewind(activeId, targetPromptIndex, mode, false);
    },

    async executeRewind(point, mode) {
      const { activeId, sessions } = get();
      if (!activeId || sessions[activeId]?.status !== "idle") throw new Error("请等待当前请求完成后再回退");
      const result = await bridge.rewind(activeId, point.prompt_index, mode, true);
      if (!result.success) {
        throw new Error(result.error || `回退存在 ${result.conflicts.length} 个文件冲突`);
      }
      await bridge.loadSession(activeId);
      if (mode !== "files_only") get().setDraft(result.prompt_text ?? point.prompt_preview ?? "");
      return result;
    },

    resolvePermission(blockId, option) {
      const { activeId } = get();
      if (activeId) bridge.respondPermission(activeId, blockId, option);
    },

    resolveQuestion(blockId, response) {
      const { activeId } = get();
      if (activeId) bridge.respondQuestion(activeId, blockId, response);
    },

    setModel: (model) => {
      const { activeId, sessionComposers, effort, mode, permissionMode } = get();
      localStorage.setItem("grok.model", model);
      if (!activeId) return set({ model });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
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
      const { activeId, sessionComposers, model, effort, mode } = get();
      localStorage.setItem("grok.permissionMode", permissionMode);
      bridge.setPermissionMode(permissionMode);
      if (!activeId) return set({ permissionMode });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, permissionMode } };
      persistSessionComposers(next);
      set({ permissionMode, sessionComposers: next });
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
    toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    async refreshHistory() {
      if (historySyncPromise) return historySyncPromise;
      const task = (async () => {
        set({ historySyncing: true, historyError: null });
        try {
          const imported = await bridge.listSessions();
          const sessionIndex = mergeAllSessions(get().sessionIndex, imported);
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
