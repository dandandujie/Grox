import type {
  AgentMode, AuthState, Effort, FetchProviderModels,
  GrokRuntimeInfo, ModelInfo, PermissionMode, PermissionOption,
  PromptAttachment, ProviderConfig, ProviderProfileSummary, QuestionResponse,
  RewindMode, RewindPoint, RewindResult, RuntimeConnectionState, RuntimeNotice, RuntimeOccupancy,
  SaveProviderProfile, Session, SessionMeta, SlashCommand, WorkflowRun,
} from "../bridge/types";
import type { Automation } from "../lib/automations";
import type { ComposerSubmission } from "../lib/composerSubmission";
import type { PersistedQueuedPrompt } from "../lib/promptQueuePersistence";
import type { ViewNavigationIntent } from "../lib/viewNavigation";
import type { CapabilityState } from "./capabilityTypes";

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

export interface SessionComposerState {
  text: string;
  attachments: PromptAttachment[];
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
}

export type QueuedPrompt = PersistedQueuedPrompt;

export interface DesktopState extends CapabilityState {
  ready: boolean;
  startupError: string | null;
  runtimeNotices: RuntimeNotice[];
  runtimeConnection: RuntimeConnectionState;
  runtimeOccupancy: RuntimeOccupancy;
  auth: AuthState;
  bridgeKind: "mock" | "acp";
  workspace: string;
  view: View;
  projects: ProjectMeta[];
  activeProjectId: string | null;
  sessionIndex: SessionMeta[];
  sessions: Record<string, Session>;
  activeId: string | null;
  restoringSessionId: string | null;
  runtime: GrokRuntimeInfo | null;
  runtimeBusy: boolean;
  accountSetupOpen: boolean;
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
  queueDrainParked: Record<string, boolean>;
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
  loadCapabilities(): Promise<void>;
  dismissRuntimeNotice(id: string): void;
  goHome(): void;
  openSession(id: string): Promise<void>;
  newSession(launch?: { text: string; attachments?: PromptAttachment[] }): Promise<void>;
  newProject(): Promise<void>;
  openProject(id: string): Promise<void>;
  renameProject(id: string, name: string): void;
  pinProject(id: string): void;
  archiveProject(id: string): Promise<void>;
  removeProject(id: string): Promise<void>;
  openProjectInExplorer(id?: string): Promise<void>;
  createProjectWorktree(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  removeSessionFromSidebar(id: string): Promise<void>;
  renameSession(id: string, title: string): void;
  pinSession(id: string): void;
  archiveSession(id: string): void;
  markSessionUnread(id: string): void;
  copySessionValue(id: string, value: "cwd" | "id" | "link"): Promise<void>;
  continueSessionInNewChat(id: string): Promise<void>;
  continueSessionInNewWorktree(id: string): Promise<void>;
  setWorkspace(cwd: string, options?: { restoreProject?: boolean; navigation?: ViewNavigationIntent }): Promise<void>;
  authenticate(): Promise<void>;
  cancelAuthentication(): Promise<void>;
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
  saveAutomation(automation: Automation): void;
  deleteAutomation(id: string): void;
  setAutomationEnabled(id: string, enabled: boolean): void;
  runAutomation(id: string): Promise<void>;
  clearAutomationRunHistory(): void;
  setAccountSetupOpen(open: boolean): void;
  refreshWorkspaceFiles(): Promise<void>;
  refreshWorkspaceDiffs(): Promise<void>;
  refreshProjectPreview(start?: boolean): Promise<void>;
  setProjectPreviewUrl(url: string): void;
  openPreview(path: string): Promise<void>;
  closePreview(): void;
  sendPrompt(text: string, attachments?: PromptAttachment[], targetSessionId?: string, modeOverride?: AgentMode, submission?: ComposerSubmission, queueItemId?: string): boolean;
  interjectPrompt(text: string, attachments?: PromptAttachment[], targetSessionId?: string, submission?: ComposerSubmission): Promise<boolean>;
  removeQueuedPrompt(sessionId: string, queueId: string): void;
  updateQueuedPrompt(sessionId: string, queueId: string, text: string): void;
  moveQueuedPrompt(sessionId: string, queueId: string, direction: -1 | 1): void;
  moveQueuedAttachment(sessionId: string, queueId: string, attachmentId: string, direction: -1 | 1): void;
  resumePromptQueue(sessionId?: string): void;
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
