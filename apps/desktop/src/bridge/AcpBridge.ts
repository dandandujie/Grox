/* Real Grok Build bridge over ACP / newline-delimited JSON-RPC 2.0. */

import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GrokBridge } from "./GrokBridge";
import { MODELS } from "./types";
import type {
  AccountInfo,
  AgentMode,
  AuthState,
  BillingInfo,
  BridgeEvent,
  DiffHunk,
  PermissionOption,
  PermissionMode,
  PlanStep,
  PromptOptions,
  QuestionItem,
  QuestionResponse,
  GrokRuntimeInfo,
  ModelState,
  Session,
  SessionBlock,
  SessionMeta,
  TerminalIO,
  ToolCall,
  ToolKind,
  ToolStatus,
  Usage,
  ConfigDocument,
  ProviderConfig,
  ProviderProfileSummary,
  ProviderProfilesState,
  ProviderStatus,
  PromptAttachment,
  SaveProviderProfile,
  RewindMode,
  RewindPoint,
  RewindResult,
} from "./types";

export const ACP_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetModel: "session/set_model",
  requestPermission: "session/request_permission",
  sessionList: "x.ai/session/list",
  sessionInfo: "x.ai/session/info",
  sessionRename: "x.ai/session/rename",
  sessionDelete: "x.ai/session/delete",
  fsList: "x.ai/fs/list",
  fsRead: "x.ai/fs/read_file",
  gitStatus: "x.ai/git/status",
  gitDiffs: "x.ai/git/diffs",
  sessionFork: "x.ai/session/fork",
  compact: "x.ai/compact_conversation",
  promptHistory: "x.ai/prompt_history",
} as const;

/** No session-scoped traffic for this long during a turn = wedged upstream. */
const PROMPT_STALL_MS = 5 * 60_000;

type JsonObject = Record<string, unknown>;
type RpcId = string | number;

interface JsonRpcMessage extends JsonObject {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface DesktopEnvironment {
  defaultWorkspace: string;
  grokCommand: string;
}

interface ExitPayload {
  code?: number | null;
  reason: "exited" | "killed";
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
  timeoutId?: number;
}

interface ContentCursor {
  assistantId?: string;
  thinkingId?: string;
  thinkingStartedAt?: number;
  userId?: string;
  userText?: string;
  userPromptIndex?: number;
  userOpen?: boolean;
  planId?: string;
  toolBlocks: Map<string, string>;
}

interface PendingInteraction {
  rpcId: RpcId;
  sessionId: string;
  blockId: string;
  kind: "permission" | "plan" | "question";
  optionIds: Partial<Record<PermissionOption, string>>;
  questions?: QuestionItem[];
}

class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

const uid = () => crypto.randomUUID();

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  contextUsed: 0,
  contextMax: 0,
  turns: 0,
};

const STREAM_FLUSH_MS = 32;
const TOOL_FLUSH_MS = 60;
const MAX_TOOL_TEXT = 128 * 1024;
const MAX_JSON_NODES = 5_000;
const MAX_JSON_ARRAY_ITEMS = 200;
const MAX_TERMINAL_LINES = 2_000;

function truncateText(value: string, limit = MAX_TOOL_TEXT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [Grox 已截断过长输出，共 ${value.length.toLocaleString()} 字符]`;
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function errorText(value: unknown): string {
  const object = record(value);
  return (
    string(object?.message) ??
    string(object?.data) ??
    (value instanceof Error ? value.message : String(value))
  );
}

function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return truncateText(value);
  let visited = 0;
  try {
    return truncateText(JSON.stringify(value, (_key, child: unknown) => {
      visited += 1;
      if (visited > MAX_JSON_NODES) return "[Grox: object truncated]";
      if (typeof child === "string") return truncateText(child, 16 * 1024);
      if (Array.isArray(child) && child.length > MAX_JSON_ARRAY_ITEMS) {
        return [...child.slice(0, MAX_JSON_ARRAY_ITEMS), `[Grox: ${child.length - MAX_JSON_ARRAY_ITEMS} more items]`];
      }
      return child;
    }, 2));
  } catch {
    return truncateText(String(value));
  }
}

function contentText(value: unknown): string {
  let output = "";
  let truncated = false;
  const append = (part: unknown, depth: number) => {
    if (output.length >= MAX_TOOL_TEXT || depth > 16) {
      truncated = true;
      return;
    }
    if (typeof part === "string") {
      const remaining = MAX_TOOL_TEXT - output.length;
      output += part.slice(0, remaining);
      if (part.length > remaining) truncated = true;
      return;
    }
    if (Array.isArray(part)) {
      for (const child of part) {
        append(child, depth + 1);
        if (truncated) break;
      }
      return;
    }
    const object = record(part);
    if (!object) return;
    if (typeof object.text === "string") append(object.text, depth + 1);
    else if (object.content !== undefined) append(object.content, depth + 1);
  };
  append(value, 0);
  return truncated ? `${output}\n… [Grox 已截断过长内容]` : output;
}

function attachmentUri(attachment: PromptAttachment): string {
  const safeName = attachment.name.replace(/[\\/#?]/g, "_") || "attachment";
  return `file://${safeName}`;
}

function promptContent(text: string, attachments: PromptAttachment[]): JsonObject[] {
  const blocks: JsonObject[] = [{ type: "text", text }];
  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.data) {
      blocks.push({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mime,
        uri: attachmentUri(attachment),
      });
      continue;
    }
    if (attachment.kind === "text" && attachment.text !== undefined) {
      blocks.push({
        type: "resource",
        resource: {
          uri: attachmentUri(attachment),
          mimeType: attachment.mime,
          text: attachment.text,
        },
      });
      continue;
    }
    if (attachment.kind === "binary" && attachment.data) {
      blocks.push({
        type: "resource",
        resource: {
          uri: attachmentUri(attachment),
          mimeType: attachment.mime,
          blob: attachment.data,
        },
      });
    }
  }
  return blocks;
}

function wireMethod(method: string): string {
  return method.startsWith("x.ai/") ? `_${method}` : method;
}

function normalizeInboundExtension(message: JsonRpcMessage): JsonRpcMessage {
  if (!message.method?.startsWith("_x.ai/")) return message;
  const envelope = record(message.params);
  const nestedMethod = string(envelope?.method);
  if (nestedMethod?.startsWith("x.ai/") && envelope && "params" in envelope) {
    return { ...message, method: nestedMethod, params: envelope.params };
  }
  return { ...message, method: message.method.slice(1) };
}

function byteText(value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.every((entry) => Number.isInteger(entry))) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(value as number[]));
  } catch {
    return undefined;
  }
}

function extractTerminal(
  kind: ToolKind,
  title: unknown,
  rawInput: unknown,
  rawOutput: unknown,
  content: unknown,
): TerminalIO | undefined {
  const input = record(rawInput);
  const output = record(rawOutput);
  const outputType = string(output?.type)?.toLowerCase();
  if (kind !== "terminal" && kind !== "execute" && outputType !== "bash" && outputType !== "shell") return undefined;

  const command =
    string(output?.command) ??
    string(input?.command) ??
    string(input?.cmd) ??
    string(title) ??
    "command";
  const text =
    string(output?.output_for_prompt) ??
    string(output?.outputForPrompt) ??
    byteText(output?.output) ??
    contentText(content);
  const exitCode = number(output?.exit_code) ?? number(output?.exitCode);
  let lines = text ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : [];
  if (lines.length > MAX_TERMINAL_LINES) {
    const omitted = lines.length - MAX_TERMINAL_LINES;
    lines = [
      ...lines.slice(0, 1_400),
      `… [Grox 已省略 ${omitted.toLocaleString()} 行终端输出]`,
      ...lines.slice(-600),
    ];
  }
  return {
    cmd: command,
    lines,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function parseTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function emptySession(meta: SessionMeta): Session {
  return { ...meta, blocks: [], usage: { ...EMPTY_USAGE }, status: "idle" };
}

const TOOL_KINDS = new Set<ToolKind>([
  "read", "edit", "delete", "list_dir", "write", "move", "search", "lsp", "execute",
  "plan", "web_search", "web_fetch", "background_task_action", "wait_tasks_action",
  "kill_task_action", "list", "skill", "memory_search", "memory_get", "task", "enter_plan",
  "exit_plan", "ask_user", "image_gen", "video_gen", "image_to_video", "reference_to_video",
  "deploy_app", "search_tool", "use_tool", "monitor", "goal_update", "terminal", "web",
  "think", "switch_mode", "other",
]);

function mapToolKind(kindValue: unknown, titleValue: unknown): ToolKind {
  const exact = (string(kindValue) ?? "").toLowerCase();
  if (TOOL_KINDS.has(exact as ToolKind)) return exact as ToolKind;
  if (exact === "fetch") return "web_fetch";
  const source = `${exact} ${string(titleValue) ?? ""}`.toLowerCase();
  if (/\b(read|view|cat)\b/.test(source)) return "read";
  if (/\b(delete|remove|unlink)\b/.test(source)) return "delete";
  if (/\b(move|rename)\b/.test(source)) return "move";
  if (/\b(edit|write|patch|replace)\b/.test(source)) return "edit";
  if (/\b(execute|terminal|shell|bash|command|process)\b/.test(source)) return "execute";
  if (/\b(web|fetch|browser|url)\b/.test(source)) return "web_fetch";
  if (/\b(search|grep|find|glob)\b/.test(source)) return "search";
  if (/\b(task|agent|todo|plan)\b/.test(source)) return "task";
  if (/\b(think|reason)\b/.test(source)) return "think";
  return "other";
}

function mapToolStatus(value: unknown): ToolStatus {
  switch ((string(value) ?? "").toLowerCase()) {
    case "pending":
      return "pending";
    case "in_progress":
    case "running":
      return "running";
    case "awaiting_permission":
    case "awaiting_approval":
      return "awaiting_permission";
    case "completed":
    case "done":
    case "success":
      return "done";
    case "failed":
    case "error":
      return "error";
    case "cancelled":
    case "canceled":
    case "rejected":
      return "cancelled";
    default:
      return "running";
  }
}

function diffHunk(path: string, oldText: string, newText: string): DiffHunk {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const before = oldLines.slice(Math.max(0, prefix - 3), prefix);
  const after = suffix > 0 ? oldLines.slice(oldLines.length - Math.min(3, suffix)) : [];
  return {
    path,
    lines: [
      ...before.map((text) => ({ kind: "ctx" as const, text })),
      ...removed.map((text) => ({ kind: "del" as const, text })),
      ...added.map((text) => ({ kind: "add" as const, text })),
      ...after.map((text) => ({ kind: "ctx" as const, text })),
    ],
    added: added.length,
    removed: removed.length,
  };
}

function extractDiffs(value: unknown): DiffHunk[] | undefined {
  const diffs: DiffHunk[] = [];
  const seen = new Set<string>();
  walkJson(value, (object) => {
    const oldText = string(object.oldText) ?? string(object.old_text);
    const newText = string(object.newText) ?? string(object.new_text);
    if (string(object.type) !== "diff" && oldText === undefined && newText === undefined) return;
    const path = string(object.path) ?? string(object.filePath) ?? string(object.file_path) ?? "unknown";
    const signature = `${path}\0${oldText ?? ""}\0${newText ?? ""}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    diffs.push(diffHunk(path, oldText ?? "", newText ?? ""));
  });
  return diffs.length > 0 ? diffs : undefined;
}

function extractImages(value: unknown): ToolCall["images"] {
  const images: NonNullable<ToolCall["images"]> = [];
  const seen = new Set<string>();
  walkJson(value, (object) => {
    if (string(object.type) !== "image") return;
    const data = string(object.data);
    const mime = string(object.mimeType) ?? string(object.mime_type);
    const signature = data && mime ? `${mime}:${data.slice(0, 96)}:${data.length}` : undefined;
    if (data && mime && signature && !seen.has(signature)) {
      seen.add(signature);
      images.push({ data, mime });
    }
  });
  return images.length > 0 ? images : undefined;
}

function walkJson(
  value: unknown,
  visit: (object: JsonObject) => void,
  depth = 0,
  budget = { remaining: MAX_JSON_NODES },
): void {
  if (depth > 8 || budget.remaining <= 0) return;
  budget.remaining -= 1;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, MAX_JSON_ARRAY_ITEMS)) {
      walkJson(child, visit, depth + 1, budget);
      if (budget.remaining <= 0) break;
    }
    return;
  }
  const object = record(value);
  if (!object) return;
  visit(object);
  for (const child of Object.values(object)) {
    walkJson(child, visit, depth + 1, budget);
    if (budget.remaining <= 0) break;
  }
}

function extractLocations(...values: unknown[]): string[] | undefined {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    const path = string(value)?.replace(/^file:\/\//, "").trim();
    if (!path || path.length > 500 || /[\r\n]/.test(path) || /^(https?|data):/i.test(path)) return;
    paths.add(path);
  };
  for (const value of values) {
    walkJson(value, (object) => {
      for (const [key, child] of Object.entries(object)) {
        if (/^(path|file|file_?path|filepath|old_?path|new_?path|directory|cwd|uri)$/i.test(key)) add(child);
        if (/^(paths|files|locations)$/i.test(key)) {
          for (const item of array(child)) add(item);
        }
      }
    });
  }
  return paths.size > 0 ? [...paths].slice(0, 40) : undefined;
}

function toolOutputText(rawOutput: unknown, content: unknown): string | undefined {
  return jsonText(rawOutput) ?? (contentText(content).trim() || undefined);
}

function mapPlanSteps(value: unknown): PlanStep[] {
  return array(value).map((entry, index) => {
    const object = record(entry) ?? {};
    const rawStatus = string(object.status) ?? "pending";
    const status: PlanStep["status"] =
      rawStatus === "completed" || rawStatus === "done"
        ? "completed"
        : rawStatus === "in_progress" || rawStatus === "running"
          ? "in_progress"
          : "pending";
    return {
      id: string(object.id) ?? `plan-step-${index}`,
      content: string(object.content) ?? string(object.title) ?? `Step ${index + 1}`,
      status,
    };
  });
}

function applyToSession(session: Session, event: BridgeEvent): Session {
  if ("sessionId" in event && event.sessionId !== session.id) return session;
  const patchBlock = (blockId: string, patch: Partial<SessionBlock>) =>
    session.blocks.map((block) =>
      block.id === blockId ? ({ ...block, ...patch } as SessionBlock) : block,
    );

  switch (event.type) {
    case "auth_state":
    case "model_state":
    case "mode_state":
      return session;
    case "session_meta":
      return { ...session, ...event.patch };
    case "block_add":
      return { ...session, blocks: [...session.blocks, event.block] };
    case "block_patch":
      return { ...session, blocks: patchBlock(event.blockId, event.patch) };
    case "assistant_append":
    case "thinking_append":
      return {
        ...session,
        blocks: session.blocks.map((block) =>
          block.id === event.blockId &&
          (block.type === "assistant" || block.type === "thinking")
            ? { ...block, text: block.text + event.delta }
            : block,
        ),
      };
    case "tool_patch":
      return {
        ...session,
        blocks: session.blocks.map((block) =>
          block.id === event.blockId && block.type === "tool"
            ? { ...block, call: { ...block.call, ...event.call } }
            : block,
        ),
      };
    case "plan_patch":
      return {
        ...session,
        blocks: session.blocks.map((block) =>
          block.id === event.blockId && block.type === "plan"
            ? { ...block, steps: event.steps }
            : block,
        ),
      };
    case "permission_request":
      return {
        ...session,
        status: "awaiting_permission",
        blocks: [
          ...session.blocks,
          { type: "permission", id: event.blockId, req: event.req, ts: Date.now() },
        ],
      };
    case "permission_resolved":
      return {
        ...session,
        status: "running",
        blocks: session.blocks.map((block) =>
          block.id === event.blockId && block.type === "permission"
            ? { ...block, resolved: event.option }
            : block,
        ),
      };
    case "question_request":
      return {
        ...session,
        status: "awaiting_input",
        blocks: [
          ...session.blocks,
          { type: "question", id: event.blockId, req: event.req, ts: Date.now() },
        ],
      };
    case "question_resolved":
      return {
        ...session,
        status: "running",
        blocks: session.blocks.map((block) =>
          block.id === event.blockId && block.type === "question"
            ? { ...block, response: event.response }
            : block,
        ),
      };
    case "status":
      return { ...session, status: event.status };
    case "usage":
      return { ...session, usage: event.usage };
    case "error":
      return {
        ...session,
        status: "idle",
        blocks: [
          ...session.blocks,
          { type: "system", id: uid(), text: event.message, ts: Date.now(), kind: "error" },
        ],
      };
    case "session_ready":
      return event.session;
  }
}

export class AcpBridge implements GrokBridge {
  readonly kind = "acp" as const;

  private listeners = new Set<(event: BridgeEvent) => void>();
  private pending = new Map<RpcId, PendingRequest>();
  private interactions = new Map<string, PendingInteraction>();
  private cursors = new Map<string, ContentCursor>();
  private catalogue = new Map<string, SessionMeta>();
  private replaying = new Map<string, Session>();
  private usage = new Map<string, Usage>();
  private sessionOptions = new Map<string, PromptOptions>();
  private knownSessions = new Set<string>();
  private lastActivity = new Map<string, number>();
  private unlisten: UnlistenFn[] = [];
  private streamAppends = new Map<string, Extract<BridgeEvent, { type: "assistant_append" | "thinking_append" }>>();
  private streamFlushTimer: number | undefined;
  private toolPatches = new Map<string, Extract<BridgeEvent, { type: "tool_patch" }>>();
  private toolFlushTimer: number | undefined;
  private diagnostics: string[] = [];
  private requestId = 0;
  private authMethodId: string | undefined;
  private authState: AuthState = { required: false, inProgress: false };
  private modelState: ModelState = { models: MODELS, currentId: MODELS[0].id };
  private permissionMode: PermissionMode =
    localStorage.getItem("grok.permissionMode") === "auto"
      ? "auto"
      : localStorage.getItem("grok.permissionMode") === "bypass"
        ? "bypass"
        : "default";
  private workspace = "";
  private ready: Promise<void>;

  constructor() {
    this.ready = this.connect();
    void this.ready.then(() => {
      if (localStorage.getItem("grox.pendingOAuth") !== "1") return;
      localStorage.removeItem("grox.pendingOAuth");
      void this.authenticate().catch(() => {
        // authenticate() already publishes the actionable error through auth_state.
      });
    });
  }

  subscribe(callback: (event: BridgeEvent) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private setAuthState(patch: Partial<AuthState>) {
    this.authState = { ...this.authState, ...patch };
    this.emit({ type: "auth_state", state: { ...this.authState } });
  }

  private emit(event: BridgeEvent) {
    if ("sessionId" in event) {
      const replay = this.replaying.get(event.sessionId);
      if (replay) {
        this.replaying.set(event.sessionId, applyToSession(replay, event));
        return;
      }
    }
    for (const callback of this.listeners) callback(event);
  }

  private queueStreamAppend(event: Extract<BridgeEvent, { type: "assistant_append" | "thinking_append" }>) {
    const key = `${event.type}:${event.sessionId}:${event.blockId}`;
    const pending = this.streamAppends.get(key);
    this.streamAppends.set(key, pending ? { ...pending, delta: pending.delta + event.delta } : event);
    if (this.streamFlushTimer === undefined) {
      this.streamFlushTimer = window.setTimeout(() => this.flushStreamAppends(), STREAM_FLUSH_MS);
    }
  }

  private flushStreamAppends(sessionId?: string) {
    if (this.streamFlushTimer !== undefined) {
      window.clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = undefined;
    }
    for (const [key, event] of this.streamAppends) {
      if (sessionId && event.sessionId !== sessionId) continue;
      this.streamAppends.delete(key);
      this.emit(event);
    }
    if (this.streamAppends.size > 0) {
      this.streamFlushTimer = window.setTimeout(() => this.flushStreamAppends(), STREAM_FLUSH_MS);
    }
  }

  private queueToolPatch(event: Extract<BridgeEvent, { type: "tool_patch" }>) {
    const key = `${event.sessionId}:${event.blockId}`;
    const pending = this.toolPatches.get(key);
    this.toolPatches.set(key, pending ? { ...event, call: { ...pending.call, ...event.call } } : event);
    if (this.toolFlushTimer === undefined) {
      this.toolFlushTimer = window.setTimeout(() => this.flushToolPatches(), TOOL_FLUSH_MS);
    }
  }

  private flushToolPatches(sessionId?: string) {
    if (this.toolFlushTimer !== undefined) {
      window.clearTimeout(this.toolFlushTimer);
      this.toolFlushTimer = undefined;
    }
    for (const [key, event] of this.toolPatches) {
      if (sessionId && event.sessionId !== sessionId) continue;
      this.toolPatches.delete(key);
      this.emit(event);
    }
    if (this.toolPatches.size > 0) {
      this.toolFlushTimer = window.setTimeout(() => this.flushToolPatches(), TOOL_FLUSH_MS);
    }
  }

  private cursor(sessionId: string): ContentCursor {
    let cursor = this.cursors.get(sessionId);
    if (!cursor) {
      cursor = { toolBlocks: new Map() };
      this.cursors.set(sessionId, cursor);
    }
    return cursor;
  }

  private async connect(): Promise<void> {
    const environment = await invoke<DesktopEnvironment>("desktop_environment");
    this.workspace = localStorage.getItem("grok.workspace") ?? environment.defaultWorkspace;

    this.unlisten.push(
      await listen<string>("acp-event", ({ payload }) => this.onLine(payload)),
      await listen<string>("acp-stderr", ({ payload }) => {
        this.diagnostics.push(payload);
        this.diagnostics = this.diagnostics.slice(-20);
      }),
      await listen<ExitPayload>("acp-exit", ({ payload }) => this.onExit(payload)),
    );

    await this.initializeAgent();
  }

  private async initializeAgent(): Promise<void> {
    // Diagnostics belong to one concrete child process. Keeping stderr from a
    // process replaced during a Tauri hot reload produces misleading errors.
    this.diagnostics = [];
    await invoke("acp_spawn", { cwd: this.workspace });
    // The inference proxy gates on the client version, so never assert a
    // hardcoded one: report the actual CLI version whenever it is detectable.
    const clientVersion = await this.detectCliVersion();
    const response = await this.requestRaw(ACP_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "grox-desktop",
        title: "Grox Desktop",
        version: clientVersion ?? (await getVersion().catch(() => "0.2.0")),
      },
      _meta: {
        clientIdentifier: "grok-desktop",
        clientType: "desktop",
        ...(clientVersion ? { clientVersion } : {}),
      },
    }, 15_000);
    this.captureModelState(response);
    await this.configureAuthentication(response);
  }

  /** Best-effort version of the spawned `grok` CLI ("grok 0.2.106 (abc) [stable]" → "0.2.106"). */
  private async detectCliVersion(): Promise<string | undefined> {
    try {
      const runtime = await invoke<GrokRuntimeInfo>("grok_runtime_info");
      return runtime.version
        ?.split(/\s+/)
        .find((token) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(token));
    } catch {
      return undefined;
    }
  }

  private async restartAgent(): Promise<void> {
    this.flushStreamAppends();
    this.flushToolPatches();
    const error = new Error("模型服务已切换，请重新发送尚未完成的请求");
    for (const request of this.pending.values()) {
      if (request.timeoutId !== undefined) window.clearTimeout(request.timeoutId);
      request.reject(error);
    }
    this.pending.clear();
    this.interactions.clear();
    this.cursors.clear();
    this.sessionOptions.clear();
    this.knownSessions.clear();
    this.authMethodId = undefined;
    this.modelState = { models: MODELS, currentId: MODELS[0].id };
    const next = this.initializeAgent();
    this.ready = next;
    await next;
  }

  private async configureAuthentication(responseValue: unknown) {
    const response = record(responseValue);
    const methods = array(response?.authMethods).map((value) => record(value) ?? {});
    if (methods.length === 0) {
      // Per ACP semantics an empty authMethods list means the agent needs no
      // authentication — treating it as "required" wedges the UI with no
      // usable recovery path (the OAuth button has no method id to call).
      this.setAuthState({ required: false, inProgress: false, error: undefined });
      return;
    }

    const first = methods[0];
    const firstId = string(first.id);
    const firstInteractive = firstId === "grok.com" || firstId === "oidc";
    const meta = record(response?._meta);
    const defaultId = string(meta?.defaultAuthMethodId);
    this.authMethodId = firstInteractive
      ? firstId
      : defaultId && methods.some((method) => string(method.id) === defaultId)
        ? defaultId
        : firstId;

    if (firstInteractive) {
      this.setAuthState({
        required: true,
        inProgress: false,
        label: string(first.name) ?? "Sign in to Grok",
        error: undefined,
      });
      return;
    }

    try {
      await this.requestRaw("authenticate", { methodId: this.authMethodId });
      this.setAuthState({ required: false, inProgress: false, error: undefined });
    } catch (error) {
      const interactive = methods.find((method) => {
        const id = string(method.id);
        return id === "grok.com" || id === "oidc";
      });
      this.authMethodId = string(interactive?.id);
      this.setAuthState({
        required: Boolean(this.authMethodId),
        inProgress: false,
        label: string(interactive?.name) ?? "Sign in to Grok",
        error: this.authMethodId ? undefined : errorText(error),
      });
    }
  }

  private onExit(payload: ExitPayload) {
    if (payload.reason === "killed") return;
    this.flushStreamAppends();
    this.flushToolPatches();
    const diagnostic = this.diagnostics
      .filter((line) => {
        const value = line.trim();
        return (
          value.length > 0 &&
          !value.startsWith("Usage:") &&
          !value.startsWith("For more information, try")
        );
      })
      .slice(-6)
      .join(" ");
    const message = `Grok Agent 已退出${payload.code == null ? "" : `（代码 ${payload.code}）`}${
      diagnostic ? `：${diagnostic}` : ""
    }`;
    for (const request of this.pending.values()) {
      if (request.timeoutId !== undefined) window.clearTimeout(request.timeoutId);
      request.reject(new Error(message));
    }
    this.pending.clear();
    for (const sessionId of this.knownSessions) {
      this.emit({ type: "error", sessionId, message });
    }
  }

  private onLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = normalizeInboundExtension(JSON.parse(line) as JsonRpcMessage);
    } catch {
      this.diagnostics.push(`无效 ACP JSON：${line.slice(0, 500)}`);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
      if (message.error !== undefined) {
        const error = record(message.error);
        pending.reject(
          new AcpRpcError(
            pending.method,
            number(error?.code),
            string(error?.message) ?? `ACP 请求失败：${pending.method}`,
            error?.data,
          ),
        );
      } else {
        const extension = pending.method.startsWith("x.ai/")
          ? record(message.result)
          : undefined;
        if (extension && "error" in extension && extension.error != null) {
          pending.reject(
            new AcpRpcError(
              pending.method,
              number(record(extension.error)?.code),
              errorText(extension.error),
              extension.error,
            ),
          );
        } else if (extension && "result" in extension) {
          pending.resolve(extension.result);
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Any session-scoped traffic (updates, permission prompts, ...) proves the
    // agent is still alive; the prompt watchdog keys off this timestamp.
    const activitySession = string(record(message.params)?.sessionId);
    if (activitySession) this.lastActivity.set(activitySession, Date.now());

    if (message.method && message.id !== undefined) {
      this.onServerRequest(message);
      return;
    }
    if (message.method) this.onNotification(message.method, message.params);
  }

  private onServerRequest(message: JsonRpcMessage) {
    if (message.method === ACP_METHODS.requestPermission) {
      this.handlePermission(message.id!, message.params);
      return;
    }
    if (message.method === "x.ai/exit_plan_mode") {
      this.handlePlanApproval(message.id!, message.params);
      return;
    }
    if (message.method === "x.ai/ask_user_question") {
      this.handleQuestion(message.id!, message.params);
      return;
    }
    void this.sendRaw({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unsupported client method: ${message.method}` },
    });
  }

  private onNotification(method: string, paramsValue: unknown) {
    if (method === "session/update" || method === "x.ai/session/update") {
      const params = record(paramsValue);
      const sessionId = string(params?.sessionId);
      if (sessionId) this.handleSessionUpdate(sessionId, params?.update);
      return;
    }
    if (method === "x.ai/session_notification") {
      const params = record(paramsValue);
      const sessionId = string(params?.sessionId);
      if (sessionId) this.handleXaiUpdate(sessionId, params?.update);
      return;
    }
    if (method === "x.ai/models/update") {
      this.captureModelState(paramsValue);
      return;
    }
    if (method === "x.ai/session/prompt_complete") {
      const params = record(paramsValue);
      const sessionId = string(params?.sessionId);
      if (sessionId) this.finishTurn(sessionId, record(params?.usage));
    }
  }

  private handleSessionUpdate(sessionId: string, updateValue: unknown) {
    const update = record(updateValue);
    if (!update) return;
    const type = string(update.sessionUpdate);
    const cursor = this.cursor(sessionId);

    switch (type) {
      case "user_message_chunk": {
        if (!this.replaying.has(sessionId)) return;
        const delta = contentText(update.content);
        const promptIndex = number(record(update._meta)?.promptIndex);
        const userId = cursor.userId;
        const beginsNewPrompt =
          !userId ||
          !cursor.userOpen ||
          (promptIndex !== undefined &&
            cursor.userPromptIndex !== undefined &&
            promptIndex !== cursor.userPromptIndex);
        if (beginsNewPrompt) {
          const nextUserId = uid();
          cursor.userId = nextUserId;
          cursor.userText = delta;
          this.emit({
            type: "block_add",
            sessionId,
            block: { type: "user", id: nextUserId, text: delta, ts: Date.now() },
          });
        } else {
          cursor.userText = `${cursor.userText ?? ""}${delta}`;
          this.emit({
            type: "block_patch",
            sessionId,
            blockId: userId,
            patch: { type: "user", text: cursor.userText } as Partial<SessionBlock>,
          });
        }
        cursor.userOpen = true;
        if (promptIndex !== undefined) cursor.userPromptIndex = promptIndex;
        cursor.assistantId = undefined;
        cursor.thinkingId = undefined;
        cursor.thinkingStartedAt = undefined;
        return;
      }
      case "agent_message_chunk": {
        this.closeUser(sessionId);
        this.closeThinking(sessionId);
        const delta = contentText(update.content);
        if (!cursor.assistantId) {
          cursor.assistantId = uid();
          this.emit({
            type: "block_add",
            sessionId,
            block: {
              type: "assistant",
              id: cursor.assistantId,
              text: "",
              ts: Date.now(),
              streaming: true,
            },
          });
        }
        this.queueStreamAppend({ type: "assistant_append", sessionId, blockId: cursor.assistantId, delta });
        return;
      }
      case "agent_thought_chunk": {
        this.closeUser(sessionId);
        this.closeAssistant(sessionId);
        const delta = contentText(update.content);
        if (!cursor.thinkingId) {
          cursor.thinkingId = uid();
          cursor.thinkingStartedAt = Date.now();
          this.emit({
            type: "block_add",
            sessionId,
            block: {
              type: "thinking",
              id: cursor.thinkingId,
              text: "",
              ts: Date.now(),
              live: true,
            },
          });
        }
        this.queueStreamAppend({ type: "thinking_append", sessionId, blockId: cursor.thinkingId, delta });
        return;
      }
      case "current_mode_update": {
        const modeId = string(update.currentModeId);
        const mode: AgentMode = modeId === "plan" ? "plan" : modeId === "ask" ? "ask" : "agent";
        this.emit({ type: "mode_state", sessionId, mode });
        return;
      }
      case "tool_call":
        this.closeUser(sessionId);
        this.addTool(sessionId, update);
        return;
      case "tool_call_update":
        this.patchTool(sessionId, update);
        return;
      case "plan": {
        this.closeUser(sessionId);
        const steps = mapPlanSteps(update.entries);
        if (!cursor.planId) {
          cursor.planId = uid();
          this.emit({
            type: "block_add",
            sessionId,
            block: { type: "plan", id: cursor.planId, steps, ts: Date.now() },
          });
        } else {
          this.emit({ type: "plan_patch", sessionId, blockId: cursor.planId, steps });
        }
        return;
      }
      case "turn_completed":
        this.finishTurn(sessionId, record(update.usage));
        return;
      default:
        return;
    }
  }

  private addTool(sessionId: string, update: JsonObject) {
    const cursor = this.cursor(sessionId);
    this.closeThinking(sessionId);
    this.closeAssistant(sessionId);
    const toolCallId = string(update.toolCallId) ?? uid();
    const blockId = cursor.toolBlocks.get(toolCallId) ?? uid();
    cursor.toolBlocks.set(toolCallId, blockId);
    const content = array(update.content);
    const kind = mapToolKind(update.kind, update.title);
    const call: ToolCall = {
      id: toolCallId,
      kind,
      rawKind: string(update.kind),
      title: string(update.title) ?? "tool",
      detail: string(update.detail),
      status: mapToolStatus(update.status),
      startedAt: Date.now(),
      input: jsonText(update.rawInput),
      output: toolOutputText(update.rawOutput, content),
      diff: extractDiffs([content, update.rawInput, update.rawOutput]),
      images: extractImages([content, update.rawOutput]),
      terminal: extractTerminal(
        kind,
        update.title,
        update.rawInput,
        update.rawOutput,
        content,
      ),
      locations: extractLocations(update.locations, update.rawInput, update.rawOutput, content),
    };
    this.emit({
      type: "block_add",
      sessionId,
      block: { type: "tool", id: blockId, call, ts: Date.now() },
    });
  }

  private patchTool(sessionId: string, update: JsonObject) {
    const cursor = this.cursor(sessionId);
    const toolCallId = string(update.toolCallId);
    if (!toolCallId) return;
    let blockId = cursor.toolBlocks.get(toolCallId);
    if (!blockId) {
      this.addTool(sessionId, update);
      blockId = cursor.toolBlocks.get(toolCallId);
      if (!blockId) return;
    }
    const status = mapToolStatus(update.status);
    const content = array(update.content);
    const terminal = extractTerminal(
      mapToolKind(update.kind, update.title),
      update.title,
      update.rawInput,
      update.rawOutput,
      content,
    );
    const kind = mapToolKind(update.kind, update.title);
    const locations = extractLocations(update.locations, update.rawInput, update.rawOutput, content);
    this.queueToolPatch({
      type: "tool_patch",
      sessionId,
      blockId,
      call: {
        ...(update.kind !== undefined || update.title !== undefined ? { kind } : {}),
        ...(update.kind !== undefined ? { rawKind: string(update.kind) } : {}),
        status,
        ...(status === "done" || status === "error" || status === "cancelled" ? { endedAt: Date.now() } : {}),
        ...(update.title !== undefined ? { title: string(update.title) } : {}),
        ...(update.detail !== undefined ? { detail: string(update.detail) } : {}),
        ...(update.rawInput !== undefined ? { input: jsonText(update.rawInput) } : {}),
        ...(update.rawOutput !== undefined || content.length > 0 ? { output: toolOutputText(update.rawOutput, content) } : {}),
        ...(content.length > 0 || update.rawInput !== undefined || update.rawOutput !== undefined
          ? { diff: extractDiffs([content, update.rawInput, update.rawOutput]) }
          : {}),
        ...(content.length > 0 || update.rawOutput !== undefined ? { images: extractImages([content, update.rawOutput]) } : {}),
        ...(terminal ? { terminal } : {}),
        ...(locations ? { locations } : {}),
      },
    });
  }

  private handleXaiUpdate(sessionId: string, updateValue: unknown) {
    const update = record(updateValue);
    if (!update) return;
    switch (string(update.sessionUpdate)) {
      case "turn_completed":
        this.finishTurn(sessionId, record(update.usage));
        break;
      case "auto_compact_started":
        this.emit({
          type: "block_add",
          sessionId,
          block: {
            type: "system",
            id: uid(),
            text: `CONTEXT COMPACTION · ${number(update.percentage) ?? 0}%`,
            ts: Date.now(),
            kind: "compact",
          },
        });
        break;
      case "auto_compact_failed":
      case "auto_recovery_exhausted":
        this.emit({
          type: "error",
          sessionId,
          message: string(update.error) ?? "Grok Agent 恢复失败",
        });
        break;
      case "retry_state": {
        const retry = record(update.retryState) ?? update;
        this.emit({
          type: "block_add",
          sessionId,
          block: {
            type: "system",
            id: uid(),
            text: `RETRY · ${string(retry.error) ?? string(retry.message) ?? "transient failure"}`,
            ts: Date.now(),
            kind: "info",
          },
        });
        break;
      }
      case "session_summary_generated": {
        const meta = this.catalogue.get(sessionId);
        const title = string(update.session_summary);
        if (meta && title) {
          this.catalogue.set(sessionId, { ...meta, title });
          this.emit({ type: "session_meta", sessionId, patch: { title } });
        }
        break;
      }
    }
  }

  private closeThinking(sessionId: string) {
    const cursor = this.cursor(sessionId);
    if (cursor.thinkingId) {
      this.flushStreamAppends(sessionId);
      this.emit({
        type: "block_patch",
        sessionId,
        blockId: cursor.thinkingId,
        patch: {
          type: "thinking",
          live: false,
          elapsedMs: cursor.thinkingStartedAt ? Date.now() - cursor.thinkingStartedAt : undefined,
        } as Partial<SessionBlock>,
      });
      cursor.thinkingId = undefined;
      cursor.thinkingStartedAt = undefined;
    }
  }

  private closeUser(sessionId: string) {
    const cursor = this.cursor(sessionId);
    cursor.userOpen = false;
    cursor.userId = undefined;
    cursor.userText = undefined;
  }

  private closeAssistant(sessionId: string) {
    const cursor = this.cursor(sessionId);
    if (cursor.assistantId) {
      this.flushStreamAppends(sessionId);
      this.emit({
        type: "block_patch",
        sessionId,
        blockId: cursor.assistantId,
        patch: { type: "assistant", streaming: false } as Partial<SessionBlock>,
      });
      cursor.assistantId = undefined;
    }
  }

  private finishTurn(sessionId: string, usageValue?: JsonObject) {
    this.closeUser(sessionId);
    this.closeThinking(sessionId);
    this.closeAssistant(sessionId);
    this.flushToolPatches(sessionId);
    if (usageValue) this.emitUsage(sessionId, usageValue);
    this.emit({ type: "status", sessionId, status: "idle" });
  }

  private emitUsage(sessionId: string, usageValue: JsonObject) {
    const previous = this.usage.get(sessionId) ?? { ...EMPTY_USAGE };
    const ticks = number(usageValue.costUsdTicks);
    const next: Usage = {
      ...previous,
      inputTokens: number(usageValue.inputTokens) ?? previous.inputTokens,
      outputTokens: number(usageValue.outputTokens) ?? previous.outputTokens,
      cacheReadTokens: number(usageValue.cachedReadTokens) ?? previous.cacheReadTokens,
      costUSD: ticks === undefined ? previous.costUSD : ticks / 10_000_000_000,
      turns: number(usageValue.numTurns) ?? previous.turns,
    };
    this.usage.set(sessionId, next);
    this.emit({ type: "usage", sessionId, usage: next });
  }

  private handlePermission(rpcId: RpcId, paramsValue: unknown) {
    const params = record(paramsValue) ?? {};
    const tool = record(params.toolCall) ?? {};
    const sessionId = string(params.sessionId);
    if (!sessionId) {
      void this.sendRaw({
        jsonrpc: "2.0",
        id: rpcId,
        result: { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    const toolCallId = string(tool.toolCallId) ?? string(params.toolCallId) ?? uid();
    const blockId = `permission-${toolCallId}`;
    const optionIds: PendingInteraction["optionIds"] = {};
    for (const rawOption of array(params.options)) {
      const option = record(rawOption) ?? {};
      const optionId = string(option.optionId);
      if (!optionId) continue;
      switch ((string(option.kind) ?? string(option.name) ?? "").toLowerCase()) {
        case "allow_once":
          optionIds.allow_once = optionId;
          break;
        case "allow_always":
          optionIds.allow_always = optionId;
          break;
        case "reject_once":
        case "reject_always":
        case "deny":
          optionIds.deny ??= optionId;
          break;
        default:
          // Unknown kind from a newer/mismatched agent build: fall back to
          // the option id so the card never collapses to a deny-only choice.
          if (/allow/.test(optionId)) optionIds.allow_once ??= optionId;
          else if (/reject|deny/.test(optionId)) optionIds.deny ??= optionId;
          break;
      }
    }
    const options = (["allow_once", "allow_always", "deny"] as PermissionOption[]).filter(
      (option) => optionIds[option] !== undefined || option === "deny",
    );
    this.interactions.set(blockId, {
      rpcId,
      sessionId,
      blockId,
      kind: "permission",
      optionIds,
    });
    this.emit({
      type: "permission_request",
      sessionId,
      blockId,
      req: {
        id: String(rpcId),
        toolCallId,
        title: string(tool.title) ?? "Tool approval",
        description: string(tool.kind) ?? "Grok requests permission to continue.",
        payload: jsonText(tool.rawInput),
        options,
      },
    });
  }

  private handlePlanApproval(rpcId: RpcId, paramsValue: unknown) {
    const params = record(paramsValue) ?? {};
    const sessionId = string(params.sessionId);
    if (!sessionId) {
      void this.sendRaw({ jsonrpc: "2.0", id: rpcId, result: { outcome: "abandoned" } });
      return;
    }
    const toolCallId = string(params.toolCallId) ?? uid();
    const blockId = `plan-approval-${toolCallId}`;
    this.interactions.set(blockId, {
      rpcId,
      sessionId,
      blockId,
      kind: "plan",
      optionIds: {},
    });
    this.emit({
      type: "permission_request",
      sessionId,
      blockId,
      req: {
        id: String(rpcId),
        toolCallId,
        title: "Approve execution plan",
        description: "Grok has finished planning and is waiting to enter agent mode.",
        payload: string(params.planContent),
        options: ["allow_once", "deny"],
      },
    });
  }

  private handleQuestion(rpcId: RpcId, paramsValue: unknown) {
    const params = record(paramsValue) ?? {};
    const sessionId = string(params.sessionId);
    const toolCallId = string(params.toolCallId) ?? uid();
    const questions: QuestionItem[] = [];
    for (const value of array(params.questions)) {
      const question = record(value);
      const prompt = string(question?.question);
      if (!question || !prompt) continue;
      const options: QuestionItem["options"] = [];
      for (const optionValue of array(question.options)) {
        const option = record(optionValue);
        const label = string(option?.label);
        if (!option || !label) continue;
        const preview = string(option.preview);
        options.push({
          label,
          description: string(option.description) ?? "",
          ...(preview ? { preview } : {}),
        });
      }
      questions.push({
        question: prompt,
        multiSelect: question.multiSelect === true || question.multi_select === true,
        options,
      });
    }

    if (!sessionId || questions.length === 0) {
      void this.sendRaw({ jsonrpc: "2.0", id: rpcId, result: { outcome: "cancelled" } });
      return;
    }

    const blockId = `question-${toolCallId}`;
    this.interactions.set(blockId, {
      rpcId,
      sessionId,
      blockId,
      kind: "question",
      optionIds: {},
      questions,
    });
    this.emit({
      type: "question_request",
      sessionId,
      blockId,
      req: {
        id: String(rpcId),
        toolCallId,
        questions,
        mode: string(params.mode) === "plan" ? "plan" : "default",
      },
    });
  }

  private async sendRaw(message: JsonRpcMessage): Promise<void> {
    await invoke("acp_send", { line: JSON.stringify(message) });
  }

  private requestRaw(method: string, params: unknown, timeoutMs = 30_000, onPending?: (id: RpcId) => void): Promise<unknown> {
    const id = ++this.requestId;
    onPending?.(id);
    return new Promise((resolve, reject) => {
      const timeoutId = timeoutMs > 0
        ? window.setTimeout(() => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            pending.reject(new Error(`Grok Agent 请求超时：${method}`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, method, timeoutId });
      void this.sendRaw({ jsonrpc: "2.0", id, method: wireMethod(method), params }).catch((cause) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
    });
  }

  private async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    await this.ready;
    return this.requestRaw(method, params, timeoutMs);
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.ready;
    await this.sendRaw({ jsonrpc: "2.0", method: wireMethod(method), params });
  }

  private captureModelState(responseValue: unknown) {
    const response = record(responseValue);
    const meta = record(response?._meta);
    const state =
      record(response?.models) ??
      record(meta?.modelState) ??
      (response?.availableModels !== undefined ? response : undefined);
    if (!state) return;
    const models = array(state.availableModels)
      .map((value) => {
        const model = record(value);
        const id = string(model?.modelId);
        if (!model || !id) return undefined;
        return {
          id,
          label: string(model.name) ?? id,
          tagline: string(model.description) ?? "Available through Grok Agent",
        };
      })
      .filter((model): model is ModelState["models"][number] => Boolean(model));
    const currentId = string(state.currentModelId) ?? this.modelState.currentId;
    this.modelState = {
      models: models.length > 0 ? models : this.modelState.models,
      currentId,
    };
    this.emit({ type: "model_state", state: this.modelState });
  }

  private metaFromRow(rowValue: unknown, fallbackCwd = this.workspace): SessionMeta | undefined {
    const row = record(rowValue);
    const id = string(row?.sessionId);
    if (!row || !id) return undefined;
    const title =
      string(row.title) ??
      string(row.summary) ??
      string(row.firstPrompt) ??
      "Untitled mission";
    return {
      id,
      title,
      cwd: string(row.cwd) ?? fallbackCwd,
      createdAt: parseTimestamp(row.createdAt),
      updatedAt: parseTimestamp(row.lastActiveAt ?? row.updatedAt),
      model: string(row.modelId) ?? "grok-build",
      parentId: string(row.parentSessionId),
    };
  }

  async getAuthState(): Promise<AuthState> {
    await this.ready;
    return { ...this.authState };
  }

  async getModelState(): Promise<ModelState> {
    await this.ready;
    return { ...this.modelState, models: [...this.modelState.models] };
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    localStorage.setItem("grok.permissionMode", mode);
    void this.notify("x.ai/yolo_mode_changed", {
      clientIdentifier: "grok-desktop",
      permission_mode:
        mode === "bypass" ? "always-approve" : mode === "auto" ? "auto" : "default",
      yolo_mode: mode === "bypass",
      auto_mode: mode === "auto",
    }).catch((error) => {
      for (const sessionId of this.knownSessions) {
        this.emit({ type: "error", sessionId, message: errorText(error) });
      }
    });
  }

  private sessionPermissionMeta() {
    return {
      clientIdentifier: "grok-desktop",
      yoloMode: this.permissionMode === "bypass",
      autoMode: this.permissionMode === "auto",
    };
  }

  private async sessionMeta(cwd: string) {
    let systemPromptOverride: string | undefined;
    try {
      const documents = await invoke<ConfigDocument[]>("read_config_documents", { cwd });
      systemPromptOverride = documents
        .find((document) => document.id === "system-prompt")
        ?.content.trim();
    } catch {
      // A missing optional prompt document must never block session creation.
    }
    return {
      ...this.sessionPermissionMeta(),
      ...(systemPromptOverride ? { systemPromptOverride } : {}),
    };
  }

  async authenticate(): Promise<void> {
    await this.ready;
    if (!this.authMethodId) throw new Error("Grok Agent 没有可用的交互认证方式");
    if (this.authState.inProgress) return;
    this.setAuthState({ required: true, inProgress: true, error: undefined });
    const requestSeq = Date.now();
    try {
      const auth = this.requestRaw("authenticate", {
        methodId: this.authMethodId,
        _meta: { use_oauth: true, force_interactive: true, request_seq: requestSeq },
      }, 5 * 60_000).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      let authUrl: string | undefined;
      for (let attempt = 0; attempt < 60 && !authUrl; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        const urlResponse = record(await this.requestRaw("x.ai/auth/get_url", {}));
        authUrl = string(urlResponse?.auth_url) ?? string(urlResponse?.authUrl);
      }
      if (!authUrl) throw new Error("Grok Agent 未返回登录链接，请重试");
      await invoke("open_external", { url: authUrl });
      const authResult = await auth;
      if (authResult.error) throw authResult.error;
      this.setAuthState({ required: false, inProgress: false, error: undefined });
    } catch (error) {
      void this.requestRaw("x.ai/auth/cancel", { request_seq: requestSeq }).catch(() => {});
      this.setAuthState({ required: true, inProgress: false, error: errorText(error) });
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.callExtension("x.ai/auth/logout", {});
    await invoke("configure_provider", { request: { kind: "oauth" } });
    await this.restartAgent();
  }

  async getAccountInfo(): Promise<AccountInfo> {
    await this.ready;
    let authInfo: JsonObject = {};
    let subscription: JsonObject = {};
    try {
      authInfo = record(await this.requestRaw("x.ai/auth/info", {})) ?? {};
    } catch {
      // API-key and unauthenticated deployments may not expose profile data.
    }
    try {
      subscription = record(await this.requestRaw("x.ai/auth/check_subscription", {})) ?? {};
    } catch {
      // Subscription metadata is OAuth-only.
    }
    const meta = record(subscription.meta) ?? {};
    return {
      authenticated: Boolean(subscription.authenticated) || !this.authState.required,
      methodId: string(authInfo.methodId),
      email: string(authInfo.email) ?? string(meta.email),
      firstName: string(authInfo.firstName),
      lastName: string(authInfo.lastName),
      profileImageUrl: string(authInfo.profileImageUrl),
      teamName: string(authInfo.teamName) ?? string(meta.team_name),
      organizationName: string(authInfo.organizationName),
      subscriptionTier: string(meta.subscription_tier) ?? string(meta.subscriptionTier),
    };
  }

  async getBillingInfo(): Promise<BillingInfo> {
    const raw = record(await this.callExtension<unknown>("x.ai/billing", {})) ?? {};
    const config = record(raw.config) ?? raw;
    const period = record(config.currentPeriod) ?? record(config.current_period) ?? {};
    return {
      subscriptionTier: string(raw.subscriptionTier) ?? string(raw.subscription_tier),
      creditUsagePercent: number(config.creditUsagePercent) ?? number(config.credit_usage_percent),
      periodType: string(period.type),
      periodStart: string(period.start),
      periodEnd: string(period.end),
      onDemandEnabled: Boolean(raw.onDemandEnabled ?? raw.on_demand_enabled),
      onDemandCap: number(config.onDemandCap) ?? number(config.on_demand_cap),
      onDemandUsed: number(config.onDemandUsed) ?? number(config.on_demand_used),
      prepaidBalance: number(config.prepaidBalance) ?? number(config.prepaid_balance),
    };
  }

  async getProviderStatus(): Promise<ProviderStatus> {
    return invoke<ProviderStatus>("read_provider_status");
  }

  async configureProvider(config: ProviderConfig): Promise<void> {
    await invoke("configure_provider", { request: config });
    await this.restartAgent();
    if (config.kind === "oauth" && this.authState.required) await this.authenticate();
  }

  async listProviderProfiles(): Promise<ProviderProfilesState> {
    return invoke<ProviderProfilesState>("list_provider_profiles");
  }

  async saveProviderProfile(config: SaveProviderProfile): Promise<ProviderProfileSummary> {
    return invoke<ProviderProfileSummary>("save_provider_profile", { request: config });
  }

  async refreshProviderModels(id: string): Promise<ProviderProfileSummary> {
    return invoke<ProviderProfileSummary>("refresh_provider_models", { id });
  }

  async activateProviderProfile(id: string): Promise<void> {
    await invoke("activate_provider_profile", { id });
    await this.restartAgent();
  }

  async setSessionMode(sessionId: string, mode: AgentMode): Promise<void> {
    await this.requestRaw(ACP_METHODS.sessionSetMode, {
      sessionId,
      modeId: mode === "agent" ? "default" : mode,
    });
    const current = this.sessionOptions.get(sessionId);
    if (current) this.sessionOptions.set(sessionId, { ...current, mode });
  }

  async deleteProviderProfile(id: string): Promise<void> {
    const active = (await this.listProviderProfiles()).activeId === id;
    await invoke("delete_provider_profile", { id });
    if (active) await this.restartAgent();
  }

  async readConfigDocuments(cwd: string): Promise<ConfigDocument[]> {
    return invoke<ConfigDocument[]>("read_config_documents", { cwd });
  }

  async writeConfigDocument(document: ConfigDocument): Promise<ConfigDocument> {
    return invoke<ConfigDocument>("write_config_document", {
      request: { id: document.id, cwd: this.workspace, content: document.content },
    });
  }

  async callExtension<T>(method: string, params: unknown = {}): Promise<T> {
    if (!method.startsWith("x.ai/")) throw new Error("只允许调用 x.ai 扩展");
    return (await this.request(method, params)) as T;
  }

  async getWorkspace(): Promise<string> {
    await this.ready;
    return this.workspace;
  }

  async setWorkspace(cwd: string): Promise<void> {
    await this.ready;
    const validated = await invoke<string>("validate_workspace", { cwd });
    this.workspace = validated;
    localStorage.setItem("grok.workspace", validated);
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const collected = new Map<string, SessionMeta>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const responseValue = await this.request(ACP_METHODS.sessionList, {
        ...(cwd ? { cwd } : {}),
        limit: 100,
        ...(cursor ? { cursor } : {}),
        _meta: { "x.ai/facetFilters": { kind: ["build"] } },
      });
      const response = record(responseValue);
      for (const row of array(response?.sessions)) {
        const meta = this.metaFromRow(row, cwd ?? this.workspace);
        if (meta) collected.set(meta.id, meta);
      }
      cursor = string(response?.nextCursor);
      if (!cursor) break;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    const sessions = [...collected.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const meta of sessions) this.catalogue.set(meta.id, meta);
    return sessions;
  }

  async newSession(cwd: string): Promise<void> {
    const metaRequest = await this.sessionMeta(cwd);
    const responseValue = await this.request(ACP_METHODS.sessionNew, {
      cwd,
      mcpServers: [],
      _meta: metaRequest,
    });
    const response = record(responseValue);
    const sessionId = string(response?.sessionId);
    if (!sessionId) throw new Error("session/new 未返回 sessionId");
    this.captureModelState(response);
    const detail = record(record(response?._meta)?.["x.ai/sessionDetail"]);
    const now = Date.now();
    const meta: SessionMeta = {
      id: sessionId,
      title: string(detail?.title) ?? "Untitled mission",
      cwd,
      createdAt: now,
      updatedAt: now,
      model: string(detail?.modelId) ?? localStorage.getItem("grok.model") ?? "grok-build",
    };
    this.knownSessions.add(sessionId);
    this.catalogue.set(sessionId, meta);
    this.cursors.set(sessionId, { toolBlocks: new Map() });
    this.usage.set(sessionId, { ...EMPTY_USAGE });
    this.emit({ type: "session_ready", session: emptySession(meta) });
  }

  async loadSession(id: string): Promise<void> {
    let meta = this.catalogue.get(id);
    if (!meta) {
      await this.listSessions();
      meta = this.catalogue.get(id);
    }
    if (!meta) throw new Error(`找不到会话：${id}`);

    this.cursors.set(id, { toolBlocks: new Map() });
    this.replaying.set(id, emptySession(meta));
    try {
      const metaRequest = await this.sessionMeta(meta.cwd);
      const response = await this.request(ACP_METHODS.sessionLoad, {
        sessionId: id,
        cwd: meta.cwd,
        mcpServers: [],
        _meta: metaRequest,
      }, 2 * 60_000);
      this.flushStreamAppends(id);
      this.flushToolPatches(id);
      this.captureModelState(response);
      await this.refreshSessionInfo(id);
      const replayed = this.replaying.get(id) ?? emptySession(meta);
      const finalized: Session = {
        ...replayed,
        usage: this.usage.get(id) ?? replayed.usage,
        status: "idle",
        blocks: replayed.blocks.map((block) =>
          block.type === "assistant"
            ? { ...block, streaming: false }
            : block.type === "thinking"
              ? { ...block, live: false }
              : block,
        ),
      };
      this.replaying.delete(id);
      this.knownSessions.add(id);
      this.emit({ type: "session_ready", session: finalized });
    } catch (error) {
      this.replaying.delete(id);
      throw error;
    }
  }

  async prompt(sessionId: string, text: string, options: PromptOptions): Promise<void> {
    await this.ready;
    this.knownSessions.add(sessionId);
    this.closeUser(sessionId);
    this.emit({ type: "status", sessionId, status: "running" });
    try {
      const previous = this.sessionOptions.get(sessionId);
      if (!previous || previous.model !== options.model || previous.effort !== options.effort) {
        await this.requestRaw(ACP_METHODS.sessionSetModel, {
          sessionId,
          modelId: options.model,
          _meta: { reasoningEffort: options.effort },
        });
      }
      if (!previous || previous.mode !== options.mode) {
        await this.requestRaw(ACP_METHODS.sessionSetMode, {
          sessionId,
          modeId: options.mode === "agent" ? "default" : options.mode,
        });
      }
      this.sessionOptions.set(sessionId, {
        model: options.model,
        effort: options.effort,
        mode: options.mode,
      });

      let promptRpcId: RpcId | undefined;
      const promptRequest = this.requestRaw(ACP_METHODS.sessionPrompt, {
        sessionId,
        prompt: promptContent(text, options.attachments ?? []),
      }, 0, (id) => {
        promptRpcId = id;
      });
      // session/prompt intentionally has no fixed timeout (long turns stream
      // for many minutes), but a completely silent agent means a wedged
      // upstream gateway or a dead socket — surface that instead of leaving
      // the session spinning forever.
      this.lastActivity.set(sessionId, Date.now());
      const watchdog = window.setInterval(() => {
        const silentFor = Date.now() - (this.lastActivity.get(sessionId) ?? 0);
        if (silentFor <= PROMPT_STALL_MS || promptRpcId === undefined) return;
        const pending = this.pending.get(promptRpcId);
        if (!pending) return;
        this.pending.delete(promptRpcId);
        pending.reject(
          new Error("Grok Agent 长时间没有任何响应：上游服务可能无返回。请检查网络、模型或供应商配置后重试。"),
        );
        this.cancel(sessionId);
      }, 15_000);
      let responseValue: unknown;
      try {
        responseValue = await promptRequest;
      } finally {
        window.clearInterval(watchdog);
      }
      const response = record(responseValue);
      const meta = record(response?._meta);
      const promptUsage = record(meta?.usage);
      if (promptUsage) this.emitUsage(sessionId, promptUsage);
      await this.refreshSessionInfo(sessionId);
    } catch (error) {
      this.emit({ type: "error", sessionId, message: errorText(error) });
    } finally {
      this.finishTurn(sessionId);
    }
  }

  cancel(sessionId: string): void {
    for (const [blockId, interaction] of this.interactions) {
      if (interaction.sessionId !== sessionId) continue;
      this.interactions.delete(blockId);
      const result =
        interaction.kind === "permission"
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: "cancelled" };
      void this.sendRaw({ jsonrpc: "2.0", id: interaction.rpcId, result });
    }
    void this.notify(ACP_METHODS.sessionCancel, {
      sessionId,
      _meta: { trigger: "user", cancelSubagents: true },
    }).catch((error) => {
      this.emit({ type: "error", sessionId, message: errorText(error) });
    });
  }

  async compact(sessionId: string): Promise<void> {
    try {
      await this.request(ACP_METHODS.compact, { sessionId });
      this.emit({
        type: "block_add",
        sessionId,
        block: {
          type: "system",
          id: uid(),
          text: "CONTEXT COMPACTED",
          ts: Date.now(),
          kind: "compact",
        },
      });
      await this.refreshSessionInfo(sessionId);
    } catch (error) {
      this.emit({ type: "error", sessionId, message: errorText(error) });
    }
  }

  async listRewindPoints(sessionId: string): Promise<RewindPoint[]> {
    const response = record(await this.callExtension<unknown>("x.ai/rewind/points", { session_id: sessionId }));
    return array(response?.rewind_points) as RewindPoint[];
  }

  async rewind(sessionId: string, targetPromptIndex: number, mode: RewindMode, force: boolean): Promise<RewindResult> {
    return this.callExtension<RewindResult>("x.ai/rewind/execute", {
      session_id: sessionId,
      target_prompt_index: targetPromptIndex,
      force,
      mode,
    });
  }

  respondPermission(sessionId: string, blockId: string, option: PermissionOption): void {
    const pending = this.interactions.get(blockId);
    if (!pending || pending.sessionId !== sessionId) return;
    this.interactions.delete(blockId);

    let result: unknown;
    if (pending.kind === "plan") {
      result = { outcome: option === "deny" ? "cancelled" : "approved" };
    } else {
      const optionId = pending.optionIds[option];
      result = optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    void this.sendRaw({ jsonrpc: "2.0", id: pending.rpcId, result }).catch((error) => {
      this.emit({ type: "error", sessionId, message: errorText(error) });
    });
    this.emit({ type: "permission_resolved", sessionId, blockId, option });
  }

  respondQuestion(sessionId: string, blockId: string, response: QuestionResponse): void {
    const pending = this.interactions.get(blockId);
    if (!pending || pending.sessionId !== sessionId || pending.kind !== "question") return;
    this.interactions.delete(blockId);

    let result: unknown;
    if (response.outcome === "accepted") {
      const annotations: Record<string, { preview?: string; notes?: string }> = {};
      for (const question of pending.questions ?? []) {
        const selected = response.answers[question.question] ?? [];
        const preview = question.multiSelect
          ? undefined
          : question.options.find((option) => option.label === selected[0])?.preview;
        const notes = response.notes[question.question]?.trim() || undefined;
        if (preview || notes) annotations[question.question] = { preview, notes };
      }
      result = {
        outcome: "accepted",
        answers: response.answers,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      };
    } else if (response.outcome === "cancelled") {
      result = { outcome: "cancelled" };
    } else {
      result = { outcome: response.outcome, partial_answers: response.partialAnswers };
    }

    void this.sendRaw({ jsonrpc: "2.0", id: pending.rpcId, result }).catch((error) => {
      this.emit({ type: "error", sessionId, message: errorText(error) });
    });
    this.emit({ type: "question_resolved", sessionId, blockId, response });
  }

  async renameSession(id: string, title: string): Promise<void> {
    const meta = this.catalogue.get(id);
    await this.request(ACP_METHODS.sessionRename, {
      sessionId: id,
      title,
      cwd: meta?.cwd ?? this.workspace,
      kind: "build",
    });
    if (meta) this.catalogue.set(id, { ...meta, title });
  }

  async deleteSession(id: string): Promise<void> {
    const meta = this.catalogue.get(id);
    this.cancel(id);
    await this.request(ACP_METHODS.sessionDelete, {
      sessionId: id,
      cwd: meta?.cwd ?? this.workspace,
      kind: "build",
    });
    this.catalogue.delete(id);
    this.knownSessions.delete(id);
    this.cursors.delete(id);
    this.usage.delete(id);
  }

  private async refreshSessionInfo(sessionId: string): Promise<void> {
    try {
      const responseValue = await this.requestRaw(ACP_METHODS.sessionInfo, { sessionId });
      const response = record(responseValue);
      const context = record(response?.context);
      const previous = this.usage.get(sessionId) ?? { ...EMPTY_USAGE };
      const next: Usage = {
        ...previous,
        contextUsed: number(context?.used) ?? previous.contextUsed,
        contextMax: number(context?.total) ?? previous.contextMax,
        turns: number(response?.turns) ?? previous.turns,
      };
      this.usage.set(sessionId, next);
      this.emit({ type: "usage", sessionId, usage: next });
    } catch {
      // Older agents may not expose the extension. Prompt usage still works.
    }
  }
}
