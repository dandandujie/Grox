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
  WorkspaceEntry,
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

  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  paletteOpen: boolean;
  settingsOpen: boolean;

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
  setAccountSetupOpen(open: boolean): void;
  refreshWorkspaceFiles(): Promise<void>;
  refreshWorkspaceDiffs(): Promise<void>;
  refreshProjectPreview(autoOpen?: boolean): Promise<void>;
  setProjectPreviewUrl(url: string): void;
  openPreview(path: string): Promise<void>;
  closePreview(): void;

  sendPrompt(text: string, attachments?: PromptAttachment[]): void;
  stop(): void;
  compact(): void;
  resolvePermission(blockId: string, option: PermissionOption): void;
  resolveQuestion(blockId: string, response: QuestionResponse): void;

  setModel(model: string): void;
  setEffort(effort: Effort): void;
  setMode(mode: AgentMode): void;
  setPermissionMode(mode: PermissionMode): void;
  setInspectorTab(tab: InspectorTab): void;
  toggleInspector(): void;
  setPaletteOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
}

const uid = () => crypto.randomUUID();

function loadJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
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

/* StrictMode mounts effects twice in dev — subscribe once, ever. */
let bridgeSubscribed = false;
let workspaceWatchTimer: number | undefined;
let workspaceWatchTick = 0;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (workspaceWatchTimer !== undefined) window.clearInterval(workspaceWatchTimer);
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

    const withSession = (sessionId: string, fn: (s: Session) => Session) => {
      const s = sessions[sessionId];
      if (!s) return;
      const next = { ...fn(s), updatedAt: Date.now() };
      const nextIndex = sessionIndex.map((m) =>
        m.id === sessionId ? { ...m, updatedAt: next.updatedAt } : m,
      );
      persistSessionCatalog(nextIndex);
      set({
        sessions: { ...sessions, [sessionId]: next },
        sessionIndex: nextIndex,
      });
    };

    switch (e.type) {
      case "auth_state":
        set({ auth: e.state });
        break;
      case "model_state":
        set(resolveModelState(e.state));
        break;
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
        set({
          sessions: { ...sessions, [e.session.id]: e.session },
          sessionIndex: nextIndex,
          projects,
          workspace: e.session.cwd,
          activeProjectId: projectId(e.session.cwd),
          activeId: e.session.id,
          view: "session",
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
        }));
        break;
      case "tool_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: patchTool(s.blocks, e.blockId, e.call),
        }));
        break;
      case "plan_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && b.type === "plan" ? { ...b, steps: e.steps } : b,
          ),
        }));
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
        }));
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
        withSession(e.sessionId, (s) => ({ ...s, usage: e.usage }));
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

    inspectorOpen: true,
    inspectorTab: "files",
    paletteOpen: false,
    settingsOpen: false,

    async init() {
      if (bridgeSubscribed) return;
      bridgeSubscribed = true;
      bridge.subscribe(applyEvent);
      try {
        const workspace = await bridge.getWorkspace();
        const projects = ensureProject(get().projects, workspace);
        const projectPaths = [...new Set(projects.map((project) => project.path))];
        const [catalogues, auth, modelState, provider] = await Promise.all([
          Promise.all(projectPaths.map(async (path) => {
            try {
              return { path, metas: await bridge.listSessions(path) };
            } catch {
              return { path, metas: null };
            }
          })),
          bridge.getAuthState(),
          bridge.getModelState(),
          bridge.getProviderStatus(),
        ]);
        let sessionIndex = decorateSessions(loadJson<SessionMeta[]>("grox.sessionCatalog", []));
        for (const catalogue of catalogues) {
          if (catalogue.metas) {
            sessionIndex = mergeProjectSessions(sessionIndex, catalogue.path, catalogue.metas);
          }
        }
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
        void get().refreshWorkspaceFiles();
        void get().refreshWorkspaceDiffs();
        void get().refreshProjectPreview(true);
        void get().refreshAccount();
        if (workspaceWatchTimer === undefined) {
          workspaceWatchTimer = window.setInterval(() => {
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
      const has = get().sessions[id];
      set({ activeId: id, view: "session" });
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
      void get().refreshProjectPreview(true);
    },

    async authenticate() {
      try {
        await bridge.authenticate();
        set({ auth: await bridge.getAuthState(), startupError: null });
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
      set(resolveModelState(state));
    },

    async configureProvider(config) {
      const wasComplete = localStorage.getItem("grox.accountSetupComplete") === "1";
      localStorage.setItem("grox.accountSetupComplete", "1");
      set({ accountSetupOpen: false });
      try {
        await bridge.configureProvider(config);
        void get().refreshAccount();
      } catch (error) {
        if (!wasComplete) localStorage.removeItem("grox.accountSetupComplete");
        set({ accountSetupOpen: !wasComplete });
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

    async refreshProjectPreview(autoOpen = false) {
      if (bridge.kind === "mock") {
        set({ projectPreview: { status: "none" } });
        return;
      }
      try {
        const projectPreview = await invoke<ProjectPreview>("start_project_preview", {
          cwd: get().workspace,
        });
        const shouldOpen = autoOpen && (projectPreview.status === "starting" || projectPreview.status === "ready");
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
        const previewFile = await invoke<PreviewFile>("read_preview_file", {
          cwd: get().workspace,
          path,
        });
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
      const { sessionIndex, sessions, activeId } = get();
      const rest = { ...sessions };
      delete rest[id];
      const nextIndex = sessionIndex.filter((m) => m.id !== id);
      persistSessionCatalog(nextIndex);
      set({
        sessionIndex: nextIndex,
        sessions: rest,
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
      const { activeId, sessions, model, effort, mode } = get();
      const session = activeId ? sessions[activeId] : null;
      if (!session || session.status !== "idle") return;

      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const titleText = trimmed || attachments.map((attachment) => attachment.name).join(", ");
      const nextIndex = get().sessionIndex.map((m) =>
        m.id === session.id && m.title === "Untitled mission"
          ? { ...m, title: titleText.slice(0, 56) }
          : m,
      );
      persistSessionCatalog(nextIndex);

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
      });

      void bridge.prompt(session.id, trimmed, { model, effort, mode, attachments });
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

    resolvePermission(blockId, option) {
      const { activeId } = get();
      if (activeId) bridge.respondPermission(activeId, blockId, option);
    },

    resolveQuestion(blockId, response) {
      const { activeId } = get();
      if (activeId) bridge.respondQuestion(activeId, blockId, response);
    },

    setModel: (model) => {
      localStorage.setItem("grok.model", model);
      set({ model });
    },
    setEffort: (effort) => {
      localStorage.setItem("grok.effort", effort);
      set({ effort });
    },
    setMode: (mode) => set({ mode }),
    setPermissionMode: (permissionMode) => {
      localStorage.setItem("grok.permissionMode", permissionMode);
      bridge.setPermissionMode(permissionMode);
      set({ permissionMode });
    },
    setInspectorTab: (inspectorTab) => set({ inspectorTab, inspectorOpen: true }),
    toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  };
});
