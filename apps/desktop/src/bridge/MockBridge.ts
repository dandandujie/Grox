/* ─────────────────────────────────────────────────────────────────────────
   MockBridge — a scripted Grok agent, offline.

   Plays a full agentic turn (thinking → plan → read → search → edit →
   permission-gated terminal → streaming summary → usage) so every UI state
   of the shell is exercisable without the CLI present. The first prompt of
   a fresh session runs the showcase; later prompts get short generic turns.
   ───────────────────────────────────────────────────────────────────────── */

import type { GrokBridge } from "./GrokBridge";
import { MODELS } from "./types";
import type {
  BridgeEvent,
  AgentMode,
  PermissionOption,
  PermissionMode,
  PromptOptions,
  QuestionResponse,
  Session,
  SessionBlock,
  SessionMeta,
  ToolCall,
  Usage,
  ConfigDocument,
  ProviderConfig,
  ProviderProfileSummary,
  SaveProviderProfile,
  RewindMode,
  RewindResult,
} from "./types";
import { seedSessions } from "../demo/data";
import { DEMO_CWD } from "../demo/data";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => crypto.randomUUID();
const jitter = (ms: number) => ms * (0.7 + Math.random() * 0.6);

export class MockBridge implements GrokBridge {
  readonly kind = "mock" as const;

  private listeners = new Set<(e: BridgeEvent) => void>();
  private sessions = new Map<string, Session>();
  private turns = new Map<string, AbortController>();
  private permissionWaiters = new Map<string, (o: PermissionOption) => void>();
  private workspace = DEMO_CWD;
  private permissionMode: PermissionMode = "default";
  private providerProfiles: ProviderProfileSummary[] = [];
  private activeProviderProfileId: string | undefined;
  private configDrafts: Record<ConfigDocument["id"], string> = {
    config: "# Grox mock config\nmodel = \"grok-build\"\n",
    "system-prompt": "You are Grox, a focused desktop coding agent.\n",
    agents: "# Project instructions\n\nKeep changes focused and verifiable.\n",
  };

  /** Dev hook: ?auto=1 resolves permission gates with "allow_once". */
  private autoApprove = new URLSearchParams(window.location.search).has("auto");

  constructor() {
    for (const s of seedSessions()) this.sessions.set(s.id, s);
  }

  subscribe(cb: (e: BridgeEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(e: BridgeEvent) {
    if ("sessionId" in e) {
      const session = this.sessions.get(e.sessionId);
      if (session) {
        switch (e.type) {
          case "session_meta":
            Object.assign(session, e.patch);
            break;
          case "block_add":
            if (!session.blocks.some((block) => block.id === e.block.id)) {
              session.blocks.push(structuredClone(e.block));
            }
            break;
          case "block_patch": {
            const block = session.blocks.find((item) => item.id === e.blockId);
            if (block) Object.assign(block, e.patch);
            break;
          }
          case "tool_patch": {
            const block = session.blocks.find((item) => item.id === e.blockId);
            if (block?.type === "tool") Object.assign(block.call, e.call);
            break;
          }
          case "plan_patch": {
            const block = session.blocks.find((item) => item.id === e.blockId);
            if (block?.type === "plan") block.steps = structuredClone(e.steps);
            break;
          }
          case "assistant_append":
          case "thinking_append": {
            const block = session.blocks.find((item) => item.id === e.blockId);
            if (block?.type === "assistant" || block?.type === "thinking") block.text += e.delta;
            break;
          }
          case "status":
            session.status = e.status;
            break;
          case "usage":
            session.usage = structuredClone(e.usage);
            break;
        }
      }
    }
    for (const cb of this.listeners) cb(e);
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    return [...this.sessions.values()]
      .filter((session) => !cwd || session.cwd.replace(/\\/g, "/").toLowerCase() === cwd.replace(/\\/g, "/").toLowerCase())
      .map(({ blocks: _b, usage: _u, status: _s, ...meta }) => meta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getWorkspace(): Promise<string> {
    return this.workspace;
  }

  async setWorkspace(cwd: string): Promise<void> {
    this.workspace = cwd;
  }

  async getAuthState() {
    return { required: false, inProgress: false };
  }

  async authenticate(): Promise<void> {}

  async logout(): Promise<void> {}

  async getAccountInfo() {
    return {
      authenticated: true,
      email: "demo@grox.local",
      firstName: "Grok",
      lastName: "Builder",
      subscriptionTier: "SuperGrok",
    };
  }

  async getBillingInfo() {
    return {
      subscriptionTier: "SuperGrok",
      creditUsagePercent: 24,
      periodType: "weekly",
      onDemandEnabled: false,
    };
  }

  async getProviderStatus() {
    return { kind: "oauth" as const, hasApiKey: false };
  }

  async configureProvider(_config: ProviderConfig): Promise<void> {}

  async listProviderProfiles() {
    return { activeId: this.activeProviderProfileId, profiles: [...this.providerProfiles] };
  }

  async saveProviderProfile(config: SaveProviderProfile): Promise<ProviderProfileSummary> {
    const profile: ProviderProfileSummary = {
      id: config.id ?? crypto.randomUUID(),
      name: config.name,
      apiKey: config.apiKey ?? "",
      hasApiKey: Boolean(config.apiKey),
      baseUrl: config.baseUrl,
      apiBackend: config.apiBackend,
      availableModels: ["grok-4.5", "grok-code-fast"],
      residentModels: config.residentModels,
    };
    this.providerProfiles = [profile, ...this.providerProfiles.filter((item) => item.id !== profile.id)];
    return profile;
  }

  async fetchProviderModels(): Promise<string[]> {
    return ["grok-4.5", "grok-code-fast", "grok-4.20-reasoning"];
  }

  async refreshProviderModels(id: string): Promise<ProviderProfileSummary> {
    const profile = this.providerProfiles.find((item) => item.id === id);
    if (!profile) throw new Error("供应商档案不存在");
    profile.availableModels = ["grok-4.5", "grok-code-fast", "grok-4.20-reasoning"];
    return { ...profile };
  }

  async activateProviderProfile(id: string): Promise<void> {
    this.activeProviderProfileId = id;
  }

  async deleteProviderProfile(id: string): Promise<void> {
    this.providerProfiles = this.providerProfiles.filter((item) => item.id !== id);
    if (this.activeProviderProfileId === id) this.activeProviderProfileId = undefined;
  }

  async readConfigDocuments(cwd: string): Promise<ConfigDocument[]> {
    return [
      { id: "config", label: "config.toml", path: `${cwd}/.grok/config.toml`, language: "toml" },
      { id: "system-prompt", label: "SYSTEM.md", path: `${cwd}/.grok/SYSTEM.md`, language: "markdown" },
      { id: "agents", label: "AGENTS.md", path: `${cwd}/AGENTS.md`, language: "markdown" },
    ].map((document) => ({ ...document, content: this.configDrafts[document.id as ConfigDocument["id"]], exists: true })) as ConfigDocument[];
  }

  async writeConfigDocument(document: ConfigDocument): Promise<ConfigDocument> {
    this.configDrafts[document.id] = document.content;
    return { ...document, exists: true };
  }

  async callExtension<T>(_method: string, _params?: unknown): Promise<T> {
    return {} as T;
  }

  async getModelState() {
    return { models: MODELS, currentId: "grok-build" };
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  async setSessionMode(sessionId: string, mode: AgentMode): Promise<void> {
    this.emit({ type: "mode_state", sessionId, mode });
  }

  async newSession(cwd: string): Promise<void> {
    const now = Date.now();
    const session: Session = {
      id: uid(),
      title: "Untitled mission",
      cwd,
      createdAt: now,
      updatedAt: now,
      model: "grok-build",
      blocks: [],
      usage: emptyUsage(),
      status: "idle",
    };
    this.sessions.set(session.id, session);
    this.emit({ type: "session_ready", session });
  }

  async loadSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) this.emit({ type: "session_ready", session: structuredClone(s) });
  }

  async renameSession(id: string, title: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.title = title;
  }

  async deleteSession(id: string): Promise<void> {
    this.cancel(id);
    this.sessions.delete(id);
  }

  cancel(sessionId: string): void {
    this.turns.get(sessionId)?.abort();
    this.turns.delete(sessionId);
    const waiter = this.permissionWaiters.get(sessionId);
    if (waiter) {
      this.permissionWaiters.delete(sessionId);
      waiter("deny");
    }
  }

  async compact(sessionId: string): Promise<void> {
    this.emit({
      type: "block_add",
      sessionId,
      block: {
        type: "system",
        id: uid(),
        text: "CONTEXT COMPACTED · MOCK",
        ts: Date.now(),
        kind: "compact",
      },
    });
  }

  async listRewindPoints(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return (session?.blocks.filter((block) => block.type === "user") ?? []).map((block, index) => ({
      prompt_index: index,
      created_at: new Date(block.ts).toISOString(),
      num_file_snapshots: 0,
      has_file_changes: false,
      prompt_preview: block.type === "user" ? block.text.slice(0, 120) : undefined,
    }));
  }

  async rewind(sessionId: string, targetPromptIndex: number, mode: RewindMode, force: boolean): Promise<RewindResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("会话不存在");
    const point = (await this.listRewindPoints(sessionId)).find((item) => item.prompt_index === targetPromptIndex);
    if (!point) throw new Error("回退节点不存在");
    if (!force) {
      return {
        success: false,
        target_prompt_index: targetPromptIndex,
        mode,
        reverted_files: [],
        clean_files: [],
        conflicts: [],
      };
    }
    let prompts = 0;
    session.blocks = session.blocks.filter((block) => {
      if (block.type === "user") prompts += 1;
      return prompts <= targetPromptIndex;
    });
    this.emit({ type: "session_ready", session: structuredClone(session) });
    return {
      success: true,
      target_prompt_index: targetPromptIndex,
      mode,
      reverted_files: [],
      clean_files: [],
      conflicts: [],
      prompt_text: mode === "files_only" ? undefined : point.prompt_preview,
    };
  }

  respondPermission(sessionId: string, _blockId: string, option: PermissionOption): void {
    const waiter = this.permissionWaiters.get(sessionId);
    if (waiter) {
      this.permissionWaiters.delete(sessionId);
      waiter(option);
    }
  }

  respondQuestion(
    _sessionId: string,
    _blockId: string,
    _response: QuestionResponse,
  ): void {}

  async prompt(sessionId: string, text: string, _opts: PromptOptions): Promise<void> {
    if (this.turns.has(sessionId)) return;
    const ac = new AbortController();
    this.turns.set(sessionId, ac);
    const session = this.sessions.get(sessionId);
    const firstTurn = !session?.blocks.some((b) => b.type === "assistant");
    if (session) {
      session.blocks.push({
        type: "user",
        id: uid(),
        text,
        attachments: _opts.attachments?.map(({ id, kind, name, mime, size }) => ({ id, kind, name, mime, size })),
        ts: Date.now(),
      });
      session.updatedAt = Date.now();
    }
    this.runTurn(sessionId, text, firstTurn, ac.signal)
      .catch((err) => {
        if ((err as DOMException)?.name !== "AbortError") {
          this.emit({ type: "error", sessionId, message: String(err) });
        }
      })
      .finally(() => {
        this.turns.delete(sessionId);
        this.emit({ type: "status", sessionId, status: "idle" });
      });
  }

  /* ── turn engine ─────────────────────────────────────────────────────── */

  private guard(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
  }
  private async tick(ms: number, signal: AbortSignal) {
    await sleep(jitter(ms));
    this.guard(signal);
  }

  private async streamText(
    sessionId: string,
    blockId: string,
    text: string,
    signal: AbortSignal,
    event: "assistant_append" | "thinking_append",
    cps = 900,
  ) {
    const words = text.split(/(?<=\s)/);
    for (const w of words) {
      this.emit({ type: event, sessionId, blockId, delta: w });
      await this.tick(Math.max(10, (w.length / cps) * 1000), signal);
    }
  }

  private async runTurn(
    sessionId: string,
    text: string,
    showcase: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    this.emit({ type: "status", sessionId, status: "running" });
    if (showcase) await this.showcaseTurn(sessionId, signal);
    else await this.genericTurn(sessionId, text, signal);
  }

  /** The full agentic showcase — exercises every block type in the shell. */
  private async showcaseTurn(sessionId: string, signal: AbortSignal) {
    const add = (block: SessionBlock) => this.emit({ type: "block_add", sessionId, block });

    // ── thinking ────────────────────────────────────────────────────────
    const thinkId = uid();
    const thinkStart = Date.now();
    add({ type: "thinking", id: thinkId, text: "", ts: thinkStart, live: true });
    await this.streamText(
      sessionId,
      thinkId,
      "Let me trace how requests flow through the middleware stack. Rate limiting needs to slot in after auth, before the handler — and the codebase already keeps per-client state somewhere. Checking how the http crate is wired.",
      signal,
      "thinking_append",
      1400,
    );
    this.guard(signal);
    this.emit({
      type: "block_patch",
      sessionId,
      blockId: thinkId,
      patch: { type: "thinking", live: false, elapsedMs: Date.now() - thinkStart } as Partial<SessionBlock>,
    });

    // ── plan ────────────────────────────────────────────────────────────
    const planId = uid();
    const steps = [
      { id: uid(), content: "Trace request flow through the http middleware stack", status: "in_progress" as const },
      { id: uid(), content: "Add token-bucket rate limiter middleware", status: "pending" as const },
      { id: uid(), content: "Wire config defaults and verify with cargo test", status: "pending" as const },
    ];
    add({ type: "plan", id: planId, steps, ts: Date.now() });
    await this.tick(650, signal);

    // ── tool: read ──────────────────────────────────────────────────────
    const readId = uid();
    const readCall: ToolCall = {
      id: uid(),
      kind: "read",
      title: "read_file",
      detail: "crates/codegen/xai-grok-http/src/middleware.rs",
      status: "running",
      startedAt: Date.now(),
    };
    add({ type: "tool", id: readId, call: readCall, ts: Date.now() });
    await this.tick(900, signal);
    this.emit({
      type: "tool_patch",
      sessionId,
      blockId: readId,
      call: {
        status: "done",
        endedAt: Date.now(),
        output: "84 lines · found Chain::then() composition point after auth_layer",
      },
    });
    await this.tick(350, signal);

    // ── tool: search ────────────────────────────────────────────────────
    const searchId = uid();
    add({
      type: "tool",
      id: searchId,
      call: {
        id: uid(),
        kind: "search",
        title: "search_code",
        detail: "\"RateLimit\" across workspace",
        status: "running",
        startedAt: Date.now(),
      },
      ts: Date.now(),
    });
    await this.tick(800, signal);
    this.emit({
      type: "tool_patch",
      sessionId,
      blockId: searchId,
      call: {
        status: "done",
        endedAt: Date.now(),
        output: "3 matches in 2 files",
        locations: [
          "crates/codegen/xai-grok-http/src/lib.rs:41",
          "crates/codegen/xai-grok-http/src/middleware.rs:12",
          "crates/common/xai-circuit-breaker/src/lib.rs:7",
        ],
      },
    });

    // plan step 1 done, step 2 in progress
    this.emit({
      type: "plan_patch",
      sessionId,
      blockId: planId,
      steps: [
        { ...steps[0], status: "completed" },
        { ...steps[1], status: "in_progress" },
        steps[2],
      ],
    });
    await this.tick(400, signal);

    // ── assistant interjection ──────────────────────────────────────────
    const noteId = uid();
    add({ type: "assistant", id: noteId, text: "", ts: Date.now(), streaming: true });
    await this.streamText(
      sessionId,
      noteId,
      "The middleware composes with `Chain::then()`, so a limiter drops in cleanly. There's a circuit breaker one crate down I can mirror for per-client buckets. Writing the middleware now.",
      signal,
      "assistant_append",
    );
    this.emit({
      type: "block_patch",
      sessionId,
      blockId: noteId,
      patch: { type: "assistant", streaming: false } as Partial<SessionBlock>,
    });
    await this.tick(300, signal);

    // ── tool: edit with diff ────────────────────────────────────────────
    const editId = uid();
    add({
      type: "tool",
      id: editId,
      call: {
        id: uid(),
        kind: "edit",
        title: "edit_file",
        detail: "crates/codegen/xai-grok-http/src/middleware.rs",
        status: "running",
        startedAt: Date.now(),
      },
      ts: Date.now(),
    });
    await this.tick(1100, signal);
    this.emit({
      type: "tool_patch",
      sessionId,
      blockId: editId,
      call: {
        status: "done",
        endedAt: Date.now(),
        diff: [
          {
            path: "crates/codegen/xai-grok-http/src/middleware.rs",
            added: 14,
            removed: 1,
            lines: [
              { kind: "ctx", text: "use crate::auth::AuthLayer;" },
              { kind: "del", text: "use crate::handler::Handler;" },
              { kind: "add", text: "use crate::handler::Handler;" },
              { kind: "add", text: "use xai_circuit_breaker::Bucket;" },
              { kind: "ctx", text: "" },
              { kind: "ctx", text: "pub fn chain() -> Chain {" },
              { kind: "add", text: "    /// Per-client token bucket: 120 req/min, burst 24." },
              { kind: "add", text: "    /// 429 + Retry-After when the bucket runs dry." },
              { kind: "add", text: "    let limiter = RateLimitLayer::new(" },
              { kind: "add", text: "        Bucket::new(120, Duration::from_secs(60))" },
              { kind: "add", text: "            .burst(24)" },
              { kind: "add", text: "            .key_by(|req| req.client_id())," },
              { kind: "add", text: "    );" },
              { kind: "ctx", text: "    Chain::new()" },
              { kind: "ctx", text: "        .then(AuthLayer::default())" },
              { kind: "add", text: "        .then(limiter)" },
              { kind: "add", text: "        .then(Handler::default())" },
            ],
          },
        ],
      },
    });

    this.emit({
      type: "plan_patch",
      sessionId,
      blockId: planId,
      steps: [
        { ...steps[0], status: "completed" },
        { ...steps[1], status: "completed" },
        { ...steps[2], status: "in_progress" },
      ],
    });
    await this.tick(450, signal);

    // ── permission-gated terminal ───────────────────────────────────────
    const termId = uid();
    const termCallId = uid();
    add({
      type: "tool",
      id: termId,
      call: {
        id: termCallId,
        kind: "terminal",
        title: "run_terminal_cmd",
        detail: "cargo test -p xai-grok-http rate_limit",
        status: "awaiting_permission",
        startedAt: Date.now(),
      },
      ts: Date.now(),
    });

    const permBlockId = uid();
    this.emit({ type: "status", sessionId, status: "awaiting_permission" });
    const option = await new Promise<PermissionOption>((resolve) => {
      this.permissionWaiters.set(sessionId, resolve);
      this.emit({
        type: "permission_request",
        sessionId,
        blockId: permBlockId,
        req: {
          id: uid(),
          toolCallId: termCallId,
          title: "Run shell command",
          description: "Grok wants to execute a command in the workspace shell.",
          payload: "cargo test -p xai-grok-http rate_limit",
          options: ["allow_once", "allow_always", "deny"],
        },
      });
      if (this.autoApprove || this.permissionMode === "bypass") {
        setTimeout(() => this.respondPermission(sessionId, permBlockId, "allow_once"), 300);
      }
    });
    this.emit({ type: "permission_resolved", sessionId, blockId: permBlockId, option });
    this.guard(signal);

    const allowed = option !== "deny";
    if (!allowed) {
      this.emit({
        type: "tool_patch",
        sessionId,
        blockId: termId,
        call: { status: "error", endedAt: Date.now(), output: "Denied by operator" },
      });
      this.emit({
        type: "plan_patch",
        sessionId,
        blockId: planId,
        steps: [
          { ...steps[0], status: "completed" },
          { ...steps[1], status: "completed" },
          { ...steps[2], status: "completed" },
        ],
      });
      const deniedId = uid();
      add({ type: "assistant", id: deniedId, text: "", ts: Date.now(), streaming: true });
      await this.streamText(
        sessionId,
        deniedId,
        "Understood — skipped the test run. The middleware is written and compiles against the circuit-breaker API, but it hasn't been verified. Run `cargo test -p xai-grok-http rate_limit` yourself when you're ready, or tell me to run it.",
        signal,
        "assistant_append",
      );
      this.emit({
        type: "block_patch",
        sessionId,
        blockId: deniedId,
        patch: { type: "assistant", streaming: false } as Partial<SessionBlock>,
      });
      this.emit({ type: "usage", sessionId, usage: showcaseUsage(false) });
      return;
    }

    this.emit({ type: "status", sessionId, status: "running" });
    this.emit({
      type: "tool_patch",
      sessionId,
      blockId: termId,
      call: {
        status: "running",
        terminal: { cmd: "cargo test -p xai-grok-http rate_limit", lines: [] },
      },
    });

    const termLines = [
      "   Compiling xai-grok-http v0.4.2 (/workspace/crates/codegen/xai-grok-http)",
      "    Finished `test` profile [unoptimized + debuginfo] target(s) in 4.12s",
      "     Running unittests src/lib.rs",
      "",
      "running 8 tests",
      "test middleware::rate_limit::allows_within_budget ... ok",
      "test middleware::rate_limit::burst_absorbs_spike ... ok",
      "test middleware::rate_limit::returns_429_when_exhausted ... ok",
      "test middleware::rate_limit::sets_retry_after_header ... ok",
      "test middleware::rate_limit::keys_by_client_id ... ok",
      "test middleware::rate_limit::bucket_refills ... ok",
      "test middleware::rate_limit::skips_health_probe ... ok",
      "test middleware::chain::order_is_auth_then_limit ... ok",
      "",
      "test result: ok. 8 passed; 0 failed; 0 ignored; measured; finished in 0.09s",
    ];
    const acc: string[] = [];
    for (const line of termLines) {
      acc.push(line);
      this.emit({
        type: "tool_patch",
        sessionId,
        blockId: termId,
        call: { terminal: { cmd: "cargo test -p xai-grok-http rate_limit", lines: [...acc] } },
      });
      await this.tick(line.startsWith("test ") ? 160 : 320, signal);
    }
    this.emit({
      type: "tool_patch",
      sessionId,
      blockId: termId,
      call: {
        status: "done",
        endedAt: Date.now(),
        terminal: { cmd: "cargo test -p xai-grok-http rate_limit", lines: acc, exitCode: 0 },
      },
    });

    this.emit({
      type: "plan_patch",
      sessionId,
      blockId: planId,
      steps: steps.map((s) => ({ ...s, status: "completed" as const })),
    });
    await this.tick(500, signal);

    // ── final summary ───────────────────────────────────────────────────
    const sumId = uid();
    add({ type: "assistant", id: sumId, text: "", ts: Date.now(), streaming: true });
    await this.streamText(
      sessionId,
      sumId,
      `Rate limiting is in, and the suite is green — **8 passed, 0 failed**.

What changed:

- **\`middleware.rs\`** — new \`RateLimitLayer\` slotted between auth and the handler, so unauthenticated traffic never touches a bucket.
- **Per-client token bucket** — 120 req/min with a 24-request burst, keyed by \`client_id\`, mirroring the circuit breaker's state model.
- **429 semantics** — exhausted buckets return \`429\` with a \`Retry-After\` header; health probes bypass the limiter.

Tuning lives in one place if you want different defaults:

\`\`\`rust
let limiter = RateLimitLayer::new(
    Bucket::new(120, Duration::from_secs(60))
        .burst(24)
        .key_by(|req| req.client_id()),
);
\`\`\`

One thing worth deciding later: bucket state is in-memory, so limits reset on restart. If you need multi-instance limiting, that wants a shared store.`,
      signal,
      "assistant_append",
      1600,
    );
    this.emit({
      type: "block_patch",
      sessionId,
      blockId: sumId,
      patch: { type: "assistant", streaming: false } as Partial<SessionBlock>,
    });
    this.emit({ type: "usage", sessionId, usage: showcaseUsage(true) });
  }

  /** Short generic turn for any prompt after the first. */
  private async genericTurn(sessionId: string, text: string, signal: AbortSignal) {
    const add = (block: SessionBlock) => this.emit({ type: "block_add", sessionId, block });

    const thinkId = uid();
    const thinkStart = Date.now();
    add({ type: "thinking", id: thinkId, text: "", ts: thinkStart, live: true });
    await this.streamText(
      sessionId,
      thinkId,
      "Working through the request against the current workspace state.",
      signal,
      "thinking_append",
      1600,
    );
    this.emit({
      type: "block_patch",
      sessionId,
      blockId: thinkId,
      patch: { type: "thinking", live: false, elapsedMs: Date.now() - thinkStart } as Partial<SessionBlock>,
    });
    await this.tick(350, signal);

    const replyId = uid();
    add({ type: "assistant", id: replyId, text: "", ts: Date.now(), streaming: true });
    const snippet = text.length > 120 ? text.slice(0, 120).trimEnd() + "…" : text;
    await this.streamText(
      sessionId,
      replyId,
      `On it — "${snippet}".

This shell is running against the **mock bridge**, so this turn is a canned response. Once the ACP backend lands (\`grok agent stdio\` behind the Tauri command layer), this same timeline streams live from the agent — thinking, tool calls, diffs, permissions and all.

Try \`/\` in the composer for commands, or \`⌘K\` to jump anywhere.`,
      signal,
      "assistant_append",
      1800,
    );
    this.emit({
      type: "block_patch",
      sessionId,
      blockId: replyId,
      patch: { type: "assistant", streaming: false } as Partial<SessionBlock>,
    });

    this.emit({
      type: "usage",
      sessionId,
      usage: {
        inputTokens: 6_212,
        outputTokens: 318,
        cacheReadTokens: 9_450,
        costUSD: 0.0016,
        contextUsed: 16_900,
        contextMax: 256_000,
        turns: 2,
      },
    });
  }
}

const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  contextUsed: 0,
  contextMax: 256_000,
  turns: 0,
});

const showcaseUsage = (verified: boolean): Usage => ({
  inputTokens: 72_410,
  outputTokens: 1_893,
  cacheReadTokens: 41_000,
  costUSD: verified ? 0.0127 : 0.0091,
  contextUsed: 81_320,
  contextMax: 256_000,
  turns: 7,
});
