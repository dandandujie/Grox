/* ─────────────────────────────────────────────────────────────────────────
   ACP type mirror — the frontend's data model.
   Shapes intentionally mirror what `grok agent stdio` emits over JSON-RPC
   (see crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md) so AcpBridge can bind wire events
   to this model 1:1. MockBridge produces the same shapes.
   ───────────────────────────────────────────────────────────────────────── */

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "list_dir"
  | "write"
  | "move"
  | "search"
  | "lsp"
  | "execute"
  | "plan"
  | "web_search"
  | "web_fetch"
  | "background_task_action"
  | "wait_tasks_action"
  | "kill_task_action"
  | "list"
  | "skill"
  | "memory_search"
  | "memory_get"
  | "task"
  | "enter_plan"
  | "exit_plan"
  | "ask_user"
  | "image_gen"
  | "video_gen"
  | "image_to_video"
  | "reference_to_video"
  | "deploy_app"
  | "search_tool"
  | "use_tool"
  | "monitor"
  | "goal_update"
  /** Legacy aliases emitted by older Grok builds and the demo bridge. */
  | "terminal"
  | "web"
  | "think"
  | "switch_mode"
  | "other";

export type ToolStatus =
  | "pending"
  | "running"
  | "awaiting_permission"
  | "done"
  | "cancelled"
  | "error";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

export interface DiffHunk {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export interface TerminalIO {
  cmd: string;
  lines: string[];
  exitCode?: number;
}

export interface ToolCall {
  id: string;
  kind: ToolKind;
  /** Exact wire value. Kept so new Grok tools remain inspectable before the UI is upgraded. */
  rawKind?: string;
  /** short human title, e.g. "read_file — src/middleware/api.rs" */
  title: string;
  detail?: string;
  status: ToolStatus;
  startedAt: number;
  endedAt?: number;
  input?: string;
  output?: string;
  diff?: DiffHunk[];
  terminal?: TerminalIO;
  locations?: string[];
  images?: { mime: string; data: string }[];
}

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  id: string;
  content: string;
  status: PlanStepStatus;
}

export type PermissionOption = "allow_once" | "allow_always" | "deny";

export interface PermissionRequest {
  id: string;
  toolCallId: string;
  title: string;
  description: string;
  payload?: string;
  options: PermissionOption[];
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionItem {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionRequest {
  id: string;
  toolCallId: string;
  questions: QuestionItem[];
  mode: "default" | "plan";
}

export type QuestionAnswers = Record<string, string[]>;
export type QuestionNotes = Record<string, string>;

export type QuestionResponse =
  | { outcome: "accepted"; answers: QuestionAnswers; notes: QuestionNotes }
  | { outcome: "chat_about_this"; partialAnswers: Record<string, string> }
  | { outcome: "skip_interview"; partialAnswers: Record<string, string> }
  | { outcome: "cancelled" };

export type SessionBlock =
  | { type: "user"; id: string; text: string; attachments?: PromptAttachmentSummary[]; ts: number }
  | { type: "assistant"; id: string; text: string; ts: number; streaming?: boolean }
  | { type: "thinking"; id: string; text: string; ts: number; live?: boolean; elapsedMs?: number }
  | { type: "tool"; id: string; call: ToolCall; ts: number }
  | { type: "plan"; id: string; steps: PlanStep[]; ts: number }
  | { type: "permission"; id: string; req: PermissionRequest; resolved?: PermissionOption; ts: number }
  | { type: "question"; id: string; req: QuestionRequest; response?: QuestionResponse; ts: number }
  | { type: "system"; id: string; text: string; ts: number; kind: "info" | "compact" | "rewind" | "error" };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  contextUsed: number;
  contextMax: number;
  turns: number;
}

export type SessionStatus = "idle" | "running" | "awaiting_permission" | "awaiting_input";

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  parentId?: string;
  /** true for sessions fabricated by MockBridge for the demo workspace */
  demo?: boolean;
  pinned?: boolean;
  archived?: boolean;
}

export interface Session extends SessionMeta {
  blocks: SessionBlock[];
  usage: Usage;
  status: SessionStatus;
}

export type AgentMode = "agent" | "plan" | "ask";

export interface ModelInfo {
  id: string;
  label: string;
  tagline: string;
}

export interface ModelState {
  models: ModelInfo[];
  currentId: string;
}

export interface AuthState {
  required: boolean;
  inProgress: boolean;
  label?: string;
  error?: string;
}

export interface AccountInfo {
  authenticated: boolean;
  methodId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  profileImageUrl?: string;
  teamName?: string;
  organizationName?: string;
  subscriptionTier?: string;
}

export interface BillingInfo {
  subscriptionTier?: string;
  creditUsagePercent?: number;
  periodType?: "weekly" | "monthly" | string;
  periodStart?: string;
  periodEnd?: string;
  onDemandEnabled?: boolean;
  onDemandCap?: number;
  onDemandUsed?: number;
  prepaidBalance?: number;
}

export type ProviderKind = "oauth" | "official" | "compatible";
export type ProviderApiBackend = "auto" | "responses" | "chat_completions";

export interface ProviderConfig {
  kind: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderStatus {
  kind: ProviderKind;
  hasApiKey: boolean;
  baseUrl?: string;
}

export interface ProviderProfileSummary {
  id: string;
  name: string;
  hasApiKey: boolean;
  baseUrl: string;
  apiBackend: ProviderApiBackend;
  availableModels: string[];
  residentModels: string[];
}

export interface ProviderProfilesState {
  activeId?: string;
  profiles: ProviderProfileSummary[];
}

export interface SaveProviderProfile {
  id?: string;
  name: string;
  apiKey?: string;
  baseUrl: string;
  apiBackend: ProviderApiBackend;
  residentModels: string[];
}

export interface GrokRuntimeInfo {
  path: string;
  source: "system" | "override" | "missing";
  systemPath?: string;
  selectionRequired: boolean;
  version?: string;
  groxCommit: string;
}

export type RewindMode = "all" | "conversation_only" | "files_only";

export interface RewindPoint {
  prompt_index: number;
  created_at: string;
  num_file_snapshots: number;
  has_file_changes: boolean;
  prompt_preview?: string;
}

export interface RewindResult {
  success: boolean;
  target_prompt_index: number;
  mode: RewindMode;
  reverted_files: string[];
  clean_files: string[];
  conflicts: { path: string; conflict_type: string }[];
  prompt_text?: string;
  error?: string;
}

export type PromptAttachmentKind = "image" | "text" | "binary";

export interface PromptAttachment {
  id: string;
  kind: PromptAttachmentKind;
  name: string;
  mime: string;
  size: number;
  /** UTF-8 content for text resources. */
  text?: string;
  /** Base64 payload for images and binary resources. */
  data?: string;
}

export interface PromptAttachmentSummary {
  id: string;
  kind: PromptAttachmentKind;
  name: string;
  mime: string;
  size: number;
}

export interface ConfigDocument {
  id: "config" | "system-prompt" | "agents";
  label: string;
  path: string;
  content: string;
  exists: boolean;
  language: string;
}

export interface PreviewFile {
  path: string;
  name: string;
  kind: "markdown" | "html" | "image" | "text";
  mime: string;
  content: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  isDir: boolean;
}

export interface ProjectPreview {
  status: "idle" | "detected" | "starting" | "ready" | "none" | "error";
  url?: string;
  framework?: string;
  command?: string;
  root?: string;
  error?: string;
}

export const MODELS: ModelInfo[] = [
  { id: "grok-build", label: "GROK-BUILD", tagline: "Default coding model" },
  { id: "grok-code-fast", label: "GROK-CODE-FAST", tagline: "Speed-tuned coding" },
  { id: "grok-4", label: "GROK-4", tagline: "Flagship reasoning" },
];

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];
export type PermissionMode = "default" | "auto" | "bypass";

/** Events a bridge pushes into the store. Wire-level naming kept close to ACP. */
export type BridgeEvent =
  | { type: "auth_state"; state: AuthState }
  | { type: "model_state"; state: ModelState }
  | { type: "mode_state"; sessionId: string; mode: AgentMode }
  | { type: "session_ready"; session: Session }
  | { type: "session_meta"; sessionId: string; patch: Partial<SessionMeta> }
  | { type: "block_add"; sessionId: string; block: SessionBlock }
  | { type: "block_patch"; sessionId: string; blockId: string; patch: Partial<SessionBlock> }
  | { type: "tool_patch"; sessionId: string; blockId: string; call: Partial<ToolCall> }
  | { type: "plan_patch"; sessionId: string; blockId: string; steps: PlanStep[] }
  | { type: "assistant_append"; sessionId: string; blockId: string; delta: string }
  | { type: "thinking_append"; sessionId: string; blockId: string; delta: string }
  | { type: "permission_request"; sessionId: string; blockId: string; req: PermissionRequest }
  | { type: "permission_resolved"; sessionId: string; blockId: string; option: PermissionOption }
  | { type: "question_request"; sessionId: string; blockId: string; req: QuestionRequest }
  | { type: "question_resolved"; sessionId: string; blockId: string; response: QuestionResponse }
  | { type: "status"; sessionId: string; status: SessionStatus }
  | { type: "usage"; sessionId: string; usage: Usage }
  | { type: "error"; sessionId: string; message: string };

export interface PromptOptions {
  model: string;
  effort: Effort;
  mode: AgentMode;
  attachments?: PromptAttachment[];
}
