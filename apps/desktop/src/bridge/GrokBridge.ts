/* ─────────────────────────────────────────────────────────────────────────
   GrokBridge — the seam between the shell and the agent runtime.

   Two implementations:
   • MockBridge — scripted, offline, drives every UI state for design/demo.
   • AcpBridge  — binds to `grok agent stdio` (JSON-RPC / ACP) via Tauri.

   The store only ever talks to this interface. Swapping bridges is a
   one-line change in bridge/index.ts.
   ───────────────────────────────────────────────────────────────────────── */

import type {
  AccountInfo,
  AuthState,
  BillingInfo,
  BridgeEvent,
  AgentMode,
  ConfigDocument,
  PermissionOption,
  PermissionMode,
  PromptOptions,
  QuestionResponse,
  ModelState,
  SessionMeta,
  ProviderConfig,
  ProviderProfileSummary,
  ProviderProfilesState,
  ProviderStatus,
  SaveProviderProfile,
  FetchProviderModels,
  RewindMode,
  RewindPoint,
  RewindResult,
} from "./types";

export interface GrokBridge {
  readonly kind: "mock" | "acp";

  /** Subscribe to agent events. Returns an unsubscribe fn. */
  subscribe(cb: (e: BridgeEvent) => void): () => void;

  /** Session catalogue (recent first). */
  listSessions(cwd?: string): Promise<SessionMeta[]>;

  /** Active workspace used by new sessions and the catalogue. */
  getWorkspace(): Promise<string>;
  setWorkspace(cwd: string): Promise<void>;

  /** Authentication state and interactive browser login. */
  getAuthState(): Promise<AuthState>;
  authenticate(): Promise<void>;
  logout(): Promise<void>;
  getAccountInfo(): Promise<AccountInfo>;
  getBillingInfo(): Promise<BillingInfo>;
  getProviderStatus(): Promise<ProviderStatus>;
  configureProvider(config: ProviderConfig): Promise<void>;
  listProviderProfiles(): Promise<ProviderProfilesState>;
  saveProviderProfile(config: SaveProviderProfile): Promise<ProviderProfileSummary>;
  fetchProviderModels(config: FetchProviderModels): Promise<string[]>;
  refreshProviderModels(id: string): Promise<ProviderProfileSummary>;
  activateProviderProfile(id: string): Promise<void>;
  deleteProviderProfile(id: string): Promise<void>;

  /** Local Grok configuration documents kept in two-way sync by the shell. */
  readConfigDocuments(cwd: string): Promise<ConfigDocument[]>;
  writeConfigDocument(document: ConfigDocument): Promise<ConfigDocument>;

  /** Typed access to Grok Build x.ai extensions used by visual settings. */
  callExtension<T>(method: string, params?: unknown): Promise<T>;

  /** Models currently offered by the connected agent. */
  getModelState(): Promise<ModelState>;

  /** Change permission policy for existing and future sessions. */
  setPermissionMode(mode: PermissionMode): void;

  /** Change the real Grok Build harness mode for an existing session. */
  setSessionMode(sessionId: string, mode: AgentMode): Promise<void>;

  /** ACP: session/new — emits session_ready. */
  newSession(cwd: string): Promise<void>;

  /** ACP: session/load — emits session_ready with the restored transcript. */
  loadSession(id: string): Promise<void>;

  /** ACP: session/prompt — streams events until the turn settles. */
  prompt(sessionId: string, text: string, opts: PromptOptions): Promise<void>;

  /** ACP: session/cancel — abort the in-flight turn. */
  cancel(sessionId: string): void;

  /** Compact the active conversation context. */
  compact(sessionId: string): Promise<void>;

  /** Official Grok Build rewind checkpoints and execution. */
  listRewindPoints(sessionId: string): Promise<RewindPoint[]>;
  rewind(sessionId: string, targetPromptIndex: number, mode: RewindMode, force: boolean): Promise<RewindResult>;

  /** Resolve a pending permission card (ACP: session/request_permission). */
  respondPermission(
    sessionId: string,
    blockId: string,
    option: PermissionOption,
    feedback?: string,
  ): void;

  /** Resolve a structured x.ai/ask_user_question interaction. */
  respondQuestion(sessionId: string, blockId: string, response: QuestionResponse): void;

  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
