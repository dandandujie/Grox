import type {
  Activity, AppEntry, AppEvent, AppState, Attachment, Bootstrap, Bot, BotPatch, CreateBotInput,
  CommandResult, ComposioLink, ComposioTool, CreateGroupInput, FilePreview, FolderListing, Group, GroupPatch, Message, Option, PhoneInfo, Routine, RoutineInput, RoutinePatch, SecretStatus, SendResult,
  APIInfo, MCPServer, MCPServerInput, MCPServerPatch, MemoryForgetResult, MemoryState, MemoryTidyResult, MemoryTopic, Preset, PresetInput, PresetPatch, Settings, Skill,
  TeamImportResult, Thread, Webhook, WebhookInfo, WebhookInput, WebhookPatch,
} from "@/lib/bridge";
import fixture from "@/mock/bootstrap.json";

type Timer = {
  timeout: ReturnType<typeof setTimeout> | null;
  botId: string;
  threadId: string;
  messageId: string;
};

const uid = (prefix: string) =>
  prefix + "-" + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2));

const clone = <T,>(value: T): T => structuredClone(value);

function nowISO(): string {
  return new Date().toISOString();
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 54 ? oneLine.slice(0, 51) + "…" : oneLine;
}

/**
 * A small in-memory backend for opening the built frontend in a browser.
 * The desktop app talks to Go instead; this exists so the visual layer can
 * be reviewed without a window.
 */
export class MockBackend {
  private bootData = clone(fixture) as unknown as Bootstrap;
  private state: AppState = (() => {
    const state = clone(this.bootData.state);
    state.webhooks = state.webhooks ?? [];
    return state;
  })();
  private secrets: SecretStatus = clone(this.bootData.secrets);
  private listeners = new Set<(event: AppEvent) => void>();
  private timers = new Map<string, Timer>();
  private attachmentBytes = new Map<string, string>();

  private emit(event: AppEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitState(): void {
    this.state.revision += 1;
    this.state.updatedAt = nowISO();
    this.emit({ type: "state", revision: this.state.revision, state: clone(this.state) });
  }

  private emitTurn(botId: string, threadId: string, busy: boolean, status: string, engine = "Grox Demo"): void {
    this.emit({ type: "turn", revision: this.state.revision, botId, threadId, turn: { botId, threadId, busy, status, engine } });
  }

  private emitMessage(botId: string, threadId: string, message: Message, groupId?: string): void {
    this.emit({ type: "message", revision: this.state.revision, botId, groupId, threadId, messageId: message.id, message: clone(message) });
  }

  private bot(id: string): Bot {
    const bot = this.state.bots.find((b) => b.id === id);
    if (!bot) throw new Error("Bot not found");
    return bot;
  }

  private thread(bot: Bot, id: string): Thread {
    const thread = bot.threads.find((t) => t.id === id);
    if (!thread) throw new Error("Conversation not found");
    return thread;
  }

  private group(id: string): Group {
    const group = this.state.groups.find((item) => item.id === id);
    if (!group) throw new Error("Channel not found");
    return group;
  }

  private groupThread(group: Group, id: string): Thread {
    const thread = group.threads.find((item) => item.id === id);
    if (!thread) throw new Error("Conversation not found");
    return thread;
  }

  private apps(): AppEntry[] {
    return this.bootData.apps.map((app) => {
      const connection = this.state.connections[app.id];
      return { ...app, connected: connection?.connected ?? false, account: connection?.account };
    });
  }

  private boot(): Bootstrap {
    return {
      ...clone(this.bootData),
      state: clone(this.state),
      apps: this.apps(),
      secrets: clone(this.secrets),
    };
  }

  async bootstrap(): Promise<Bootstrap> {
    return this.boot();
  }

  async refreshCatalog(): Promise<Bootstrap> {
    return this.boot();
  }

  async createBot(input: CreateBotInput): Promise<Bot> {
    const now = nowISO();
    const botId = uid("bot");
    const threadId = uid("thread");
    const greeting = `Hey — I'm ${input.name || "your new bot"}.${input.title ? " I look after " + input.title.toLowerCase() + "." : ""}\n\nAsk me anything, or open **Agent profile** to shape how I work. I am ready when you are.`;
    const thread: Thread = {
      id: threadId, botId, title: "New conversation", kind: "chat", pinned: false, unread: 0,
      busy: false, createdAt: now, updatedAt: now,
      messages: [{ id: uid("msg"), role: "bot", kind: "text", text: greeting, pending: false, error: false, createdAt: now, updatedAt: now }],
    };
    const bot: Bot = {
      id: botId, name: input.name || "New bot", title: input.title || "", description: input.description || "",
      soul: input.soul || "", color: input.color || "green", mascotShape: "cursor", expression: "idle",
      modelId: input.modelId || "grox-demo", approval: "ask", notifications: true, speakReplies: false,
      pinned: false, hidden: false, archived: false, createdAt: now, updatedAt: now, lastActiveAt: now, threads: [thread],
    };
    this.state.bots.push(bot);
    this.state.activeBotId = botId;
    this.state.activeThreadId = threadId;
    this.emitState();
    return clone(bot);
  }

  async updateBot(botId: string, patch: BotPatch): Promise<Bot> {
    const bot = this.bot(botId);
    Object.assign(bot, patch);
    bot.updatedAt = nowISO();
    this.emitState();
    return clone(bot);
  }

  async duplicateBot(id: string): Promise<Bot> {
    const source = this.bot(id);
    const now = nowISO();
    const copy = clone(source);
    copy.id = uid("bot");
    copy.name = source.name + " copy";
    copy.pinned = false;
    copy.createdAt = now;
    copy.updatedAt = now;
    copy.lastActiveAt = now;
    copy.threads = source.threads.map((thread) => ({
      ...clone(thread), id: uid("thread"), botId: copy.id, unread: 0, busy: false, createdAt: now, updatedAt: now,
      messages: thread.messages.map((message) => ({ ...clone(message), id: uid("msg"), pending: false, createdAt: now, updatedAt: now })),
    }));
    this.state.bots.push(copy);
    this.state.activeBotId = copy.id;
    this.state.activeThreadId = copy.threads[0]?.id ?? "";
    this.emitState();
    return clone(copy);
  }

  async deleteBot(id: string): Promise<void> {
    this.state.bots = this.state.bots.filter((bot) => bot.id !== id);
    if (this.state.activeBotId === id) {
      const next = this.state.bots.find((bot) => !bot.hidden);
      this.state.activeBotId = next?.id ?? "";
      this.state.activeThreadId = next?.threads[0]?.id ?? "";
    }
    this.emitState();
  }

  async createThread(botId: string, title: string): Promise<Thread> {
    const bot = this.bot(botId);
    const now = nowISO();
    const thread: Thread = {
      id: uid("thread"), botId, title: title || "New conversation", kind: "chat", pinned: false,
      unread: 0, busy: false, createdAt: now, updatedAt: now, messages: [],
    };
    bot.threads.unshift(thread);
    this.state.activeBotId = botId;
    this.state.activeThreadId = thread.id;
    this.emitState();
    return clone(thread);
  }

  async updateThread(botId: string, threadId: string, title: string): Promise<Thread> {
    const thread = this.thread(this.bot(botId), threadId);
    thread.title = title;
    thread.updatedAt = nowISO();
    this.emitState();
    return clone(thread);
  }

  async deleteThread(botId: string, threadId: string): Promise<void> {
    const bot = this.bot(botId);
    bot.threads = bot.threads.filter((thread) => thread.id !== threadId);
    if (this.state.activeThreadId === threadId) this.state.activeThreadId = bot.threads[0]?.id ?? "";
    this.emitState();
  }

  async select(botId: string, threadId: string): Promise<void> {
    const bot = this.bot(botId);
    this.state.activeBotId = botId;
    if (threadId) {
      this.thread(bot, threadId).unread = 0;
      this.state.activeThreadId = threadId;
    }
    this.emitState();
  }

  async markRead(botId: string, threadId: string): Promise<void> {
    const thread = this.thread(this.bot(botId), threadId);
    thread.unread = 0;
    this.emitState();
  }

  async markUnread(botId: string, threadId: string): Promise<void> {
    const thread = this.thread(this.bot(botId), threadId);
    if (thread.unread < 1) thread.unread = 1;
    this.emitState();
  }

  async revealWorkingFolder(_botId: string): Promise<string> {
    return "Home folder";
  }

  async send(botId: string, threadId: string, text: string): Promise<SendResult> {
    return this.sendWithAttachments(botId, threadId, text, []);
  }

  async sendWithAttachments(botId: string, threadId: string, text: string, attachments: Attachment[]): Promise<SendResult> {
    const bot = this.bot(botId);
    const thread = this.thread(bot, threadId);
    if (thread.busy) throw new Error(`${bot.name} is still working on the last message`);
    const now = nowISO();
    const userMessage: Message = {
      id: uid("msg"), role: "user", kind: "text", text, attachments, pending: false, error: false, createdAt: now, updatedAt: now,
    };
    thread.messages.push(userMessage);
    if (text && ["", "New conversation", "New task"].includes(thread.title)) thread.title = titleFrom(text);
    thread.updatedAt = now;
    thread.unread = 0;
    bot.lastActiveAt = now;
    this.state.activeBotId = botId;
    this.state.activeThreadId = threadId;
    this.emitState();
    this.startReply(bot, thread, text);
    return { botId, threadId, messageId: userMessage.id };
  }

  private startReply(bot: Bot, thread: Thread, prompt: string): void {
    thread.busy = true;
    thread.status = "Thinking";
    const engine = "Grox Demo";
    this.emitTurn(bot.id, thread.id, true, "Thinking", engine);
    const timer: Timer = { timeout: null, botId: bot.id, threadId: thread.id, messageId: "" };
    this.timers.set(thread.id, timer);
    timer.timeout = setTimeout(() => {
      const now = nowISO();
      const message: Message = {
        id: uid("msg"), role: "bot", kind: "text", text: "", pending: true, error: false,
        engine, model: "Grox Demo", createdAt: now, updatedAt: now,
      };
      thread.messages.push(message);
      timer.messageId = message.id;
      this.emitMessage(bot.id, thread.id, message);
      const reply = this.replyFor(bot, prompt);
      const chunks = streamChunks(reply.text);
      let index = 0;
      const tick = () => {
        if (!this.timers.has(thread.id)) return;
        if (index >= chunks.length) {
          this.finishReply(bot, thread, message, reply);
          return;
        }
        const chunk = chunks[index++]!;
        message.text += chunk;
        message.updatedAt = nowISO();
        thread.updatedAt = message.updatedAt;
        this.emit({ type: "delta", revision: this.state.revision, botId: bot.id, threadId: thread.id, messageId: message.id, delta: chunk });
        timer.timeout = setTimeout(tick, 18);
      };
      timer.timeout = setTimeout(tick, 120);
    }, 300);
  }

  private finishReply(bot: Bot, thread: Thread, message: Message, reply: Reply): void {
    message.pending = false;
    message.updatedAt = nowISO();
    thread.busy = false;
    thread.status = "";
    thread.updatedAt = message.updatedAt;
    bot.lastActiveAt = message.updatedAt;
    this.timers.delete(thread.id);
    this.emitMessage(bot.id, thread.id, message);
    this.emitTurn(bot.id, thread.id, false, "");
    if (reply.approval) {
      const approvalMessage: Message = {
        id: uid("msg"), role: "bot", kind: "approval", text: "", status: "pending", pending: false,
        error: false, approval: reply.approval, createdAt: nowISO(), updatedAt: nowISO(),
      };
      thread.messages.push(approvalMessage);
      this.emitMessage(bot.id, thread.id, approvalMessage);
    }
    if (reply.options) {
      const optionsMessage: Message = {
        id: uid("msg"), role: "bot", kind: "options", text: reply.options.text, status: "pending",
        pending: false, error: false, options: reply.options.options, createdAt: nowISO(), updatedAt: nowISO(),
      };
      thread.messages.push(optionsMessage);
      this.emitMessage(bot.id, thread.id, optionsMessage);
    }
    this.emitState();
  }

  async stop(botId: string, threadId: string): Promise<void> {
    const bot = this.bot(botId);
    const thread = this.thread(bot, threadId);
    const timer = this.timers.get(threadId);
    if (timer?.timeout) clearTimeout(timer.timeout);
    this.timers.delete(threadId);
    const message = thread.messages.find((item) => item.id === timer?.messageId);
    if (message) {
      message.pending = false;
      if (!message.text.trim()) message.text = "_Stopped._";
      this.emitMessage(botId, threadId, message);
    }
    thread.busy = false;
    thread.status = "";
    this.emitTurn(botId, threadId, false, "");
    this.emitState();
  }

  async decide(botId: string, threadId: string, messageId: string, decision: string): Promise<void> {
    const bot = this.bot(botId);
    const thread = this.thread(bot, threadId);
    const message = thread.messages.find((item) => item.id === messageId);
    if (!message?.approval) throw new Error("Approval not found");
    message.status = decision === "deny" ? "denied" : decision === "always" ? "always" : "allowed";
    message.approval.decision = message.status;
    message.approval.decidedAt = nowISO();
    if (decision === "always") bot.approval = "auto";
    this.emitMessage(botId, threadId, message);
    this.emitState();
    const prompt = decision === "deny" ? "I denied the command." : "The command was allowed. Tell me the result.";
    this.startReply(bot, thread, prompt);
  }

  async answer(botId: string, threadId: string, messageId: string, answer: string): Promise<void> {
    const bot = this.bot(botId);
    const thread = this.thread(bot, threadId);
    const message = thread.messages.find((item) => item.id === messageId);
    if (!message || message.kind !== "options") throw new Error("Question not found");
    const option = message.options?.find((item) => item.id === answer || item.label === answer);
    const label = option?.label ?? answer;
    message.status = "answered";
    const now = nowISO();
    thread.messages.push({ id: uid("msg"), role: "user", kind: "text", text: label, pending: false, error: false, createdAt: now, updatedAt: now });
    thread.updatedAt = now;
    this.emitMessage(botId, threadId, message);
    this.emitState();
    this.startReply(bot, thread, "My answer: " + label + (option?.description ? ". " + option.description : ""));
  }

  async createGroup(input: CreateGroupInput): Promise<Group> {
    const now = nowISO();
    const members = input.memberIds.filter((id) => this.state.bots.some((bot) => bot.id === id));
    if (members.length === 0) throw new Error("Add at least one bot to the channel");
    const lead = members.includes(input.leadId) ? input.leadId : (members[0] ?? "");
    const leadBot = this.state.bots.find((bot) => bot.id === lead);
    const threadId = uid("thread");
    const groupId = uid("group");
    const greeting: Message = {
      id: uid("msg"), role: "bot", kind: "text", senderId: lead, senderName: leadBot?.name ?? "Bot",
      text: `Hey — ${leadBot?.name ?? "I"} here. This is the ${input.name} channel.

Mention a bot with **@Name**, or just ask and the lead will take it.`,
      pending: false, error: false, createdAt: now, updatedAt: now,
    };
    const thread: Thread = {
      id: threadId, botId: "", title: "New conversation", kind: "group", pinned: false, unread: 0,
      busy: false, createdAt: now, updatedAt: now, messages: [greeting],
    };
    const group: Group = {
      id: groupId, name: input.name || "New channel", description: input.description || "", color: input.color || "purple",
      memberIds: members, leadId: lead, pinned: false, unread: 0, createdAt: now, updatedAt: now, threads: [thread],
    };
    this.state.groups.push(group);
    this.state.activeGroupId = groupId;
    this.state.activeBotId = "";
    this.state.activeThreadId = threadId;
    this.emitState();
    return clone(group);
  }

  async updateGroup(groupId: string, patch: GroupPatch): Promise<Group> {
    const group = this.group(groupId);
    Object.assign(group, patch);
    if (patch.memberIds) group.memberIds = patch.memberIds.filter((id) => this.state.bots.some((bot) => bot.id === id));
    if (!group.memberIds.includes(group.leadId) && group.memberIds.length > 0) group.leadId = group.memberIds[0] ?? "";
    group.updatedAt = nowISO();
    this.emitState();
    return clone(group);
  }

  async deleteGroup(groupId: string): Promise<void> {
    this.state.groups = this.state.groups.filter((group) => group.id !== groupId);
    if (this.state.activeGroupId === groupId) {
      this.state.activeGroupId = "";
      this.state.activeThreadId = "";
    }
    this.emitState();
  }

  async createGroupThread(groupId: string, title: string): Promise<Thread> {
    const group = this.group(groupId);
    const now = nowISO();
    const thread: Thread = { id: uid("thread"), botId: "", title: title || "New conversation", kind: "group", pinned: false, unread: 0, busy: false, createdAt: now, updatedAt: now, messages: [] };
    group.threads = [thread, ...group.threads];
    group.updatedAt = now;
    this.state.activeGroupId = groupId;
    this.state.activeBotId = "";
    this.state.activeThreadId = thread.id;
    this.emitState();
    return clone(thread);
  }

  async updateGroupThread(groupId: string, threadId: string, title: string): Promise<Thread> {
    const thread = this.groupThread(this.group(groupId), threadId);
    thread.title = title;
    thread.updatedAt = nowISO();
    this.emitState();
    return clone(thread);
  }

  async deleteGroupThread(groupId: string, threadId: string): Promise<void> {
    const group = this.group(groupId);
    group.threads = group.threads.filter((thread) => thread.id !== threadId);
    if (group.threads.length === 0) {
      const now = nowISO();
      group.threads = [{ id: uid("thread"), botId: "", title: "New conversation", kind: "group", pinned: false, unread: 0, busy: false, createdAt: now, updatedAt: now, messages: [] }];
    }
    if (this.state.activeGroupId === groupId && this.state.activeThreadId === threadId) this.state.activeThreadId = group.threads[0]?.id ?? "";
    this.emitState();
  }

  async selectGroup(groupId: string, threadId: string): Promise<void> {
    const group = this.group(groupId);
    this.groupThread(group, threadId);
    group.unread = 0;
    this.state.activeGroupId = groupId;
    this.state.activeBotId = "";
    this.state.activeThreadId = threadId;
    this.emitState();
  }

  async markGroupRead(groupId: string): Promise<void> {
    const group = this.group(groupId);
    group.unread = 0;
    this.emitState();
  }

  async sendGroup(groupId: string, threadId: string, text: string): Promise<SendResult> {
    return this.sendGroupWithAttachments(groupId, threadId, text, []);
  }

  async sendGroupWithAttachments(groupId: string, threadId: string, text: string, attachments: Attachment[]): Promise<SendResult> {
    const group = this.group(groupId);
    const thread = this.groupThread(group, threadId);
    const now = nowISO();
    const user: Message = { id: uid("msg"), role: "user", kind: "text", text, attachments, pending: false, error: false, createdAt: now, updatedAt: now };
    thread.messages.push(user);
    if (text && (thread.title === "" || thread.title === "New conversation")) thread.title = titleFrom(text);
    const lower = text.toLowerCase();
    const responderId = group.memberIds.find((id) => {
      const member = this.state.bots.find((bot) => bot.id === id);
      return member ? lower.includes("@" + member.name.toLowerCase()) : false;
    }) ?? group.leadId ?? group.memberIds[0];
    const responder = this.state.bots.find((bot) => bot.id === responderId);
    if (!responder) throw new Error("This channel has no bots");
    const reply = this.replyFor(responder, text);
    const answer: Message = {
      id: uid("msg"), role: "bot", kind: "text", text: reply.text, senderId: responder.id, senderName: responder.name,
      options: reply.options?.options, approval: reply.approval, status: reply.options || reply.approval ? "pending" : "",
      pending: false, error: false, createdAt: now, updatedAt: now,
    };
    thread.messages.push(answer);
    thread.updatedAt = now;
    group.updatedAt = now;
    group.unread = 0;
    this.state.activeGroupId = groupId;
    this.state.activeBotId = "";
    this.state.activeThreadId = threadId;
    this.emitState();
    this.emitMessage(responder.id, threadId, answer, groupId);
    return { botId: responder.id, groupId, threadId, messageId: user.id };
  }

  async stopGroup(_groupId: string, _threadId: string): Promise<void> {
    // Browser preview replies are not long-running.
  }

  async decideGroup(groupId: string, threadId: string, messageId: string, decision: string): Promise<void> {
    const group = this.group(groupId);
    const thread = this.groupThread(group, threadId);
    const message = thread.messages.find((item) => item.id === messageId);
    if (!message || !message.approval) return;
    message.status = decision === "deny" ? "denied" : decision === "always" ? "always" : "allowed";
    message.approval.decision = decision;
    message.updatedAt = nowISO();
    this.emitState();
  }

  async answerGroup(groupId: string, threadId: string, messageId: string, answer: string): Promise<void> {
    const group = this.group(groupId);
    const thread = this.groupThread(group, threadId);
    const message = thread.messages.find((item) => item.id === messageId);
    if (!message) return;
    message.status = "answered";
    message.updatedAt = nowISO();
    thread.messages.push({ id: uid("msg"), role: "user", kind: "text", text: answer, pending: false, error: false, createdAt: nowISO(), updatedAt: nowISO() });
    this.emitState();
  }

  async listComputerFiles(_botId: string, path: string): Promise<FolderListing> {
    const root = "/Users/you/Documents/Launch";
    const current = path || root;
    const entries = current.endsWith("assets")
      ? [{ name: "hero.png", path: current + "/hero.png", dir: false, size: 184320, modified: nowISO(), mime: "image/png" }]
      : [
          { name: "assets", path: root + "/assets", dir: true, size: 0, modified: nowISO(), mime: "" },
          { name: "notes.md", path: root + "/notes.md", dir: false, size: 2410, modified: nowISO(), mime: "text/markdown" },
          { name: "launch-plan.md", path: root + "/launch-plan.md", dir: false, size: 8120, modified: nowISO(), mime: "text/markdown" },
        ];
    return { root, path: current, entries };
  }

  async readComputerFile(_botId: string, path: string): Promise<FilePreview> {
    if (path.endsWith(".png")) throw new Error("Image previews need the desktop app.");
    return {
      path, name: path.split("/").pop() ?? "notes.md", kind: "text", mime: "text/markdown", size: 2410, truncated: false,
      text: "# Launch notes\n\nThe browser preview uses a small sample folder. In the desktop app this is a real read of the bot's working directory.\n\n- Build is green\n- Legal review is open\n- Pricing page is copy-complete\n",
    };
  }

  async openComputerPath(_botId: string, _path: string): Promise<void> {
    // No system file manager in the browser preview.
  }

  async runComputerCommand(_botId: string, command: string): Promise<CommandResult> {
    return {
      command, stdout: `(browser preview) ${command}
In the desktop app this runs in the bot's working folder.`, stderr: "", exitCode: 0, durationMs: 12,
    };
  }

  async connectComposioApp(_appId: string): Promise<ComposioLink> {
    throw new Error("Add a Composio key in the desktop app to connect an account.");
  }

  async disconnectComposioApp(_appId: string): Promise<void> {
    throw new Error("Add a Composio key in the desktop app first.");
  }

  async refreshComposioConnections(): Promise<number> {
    throw new Error("Add a Composio key in the desktop app first.");
  }

  async listComposioTools(): Promise<ComposioTool[]> {
    return [];
  }

  async executeComposioTool(_slug: string, _args: Record<string, unknown>): Promise<unknown> {
    throw new Error("Live tools need the desktop app and a Composio key.");
  }

  async setPhoneEnabled(enabled: boolean): Promise<PhoneInfo> {
    return {
      enabled, url: enabled ? "http://192.168.1.20:4870/p/phone-demo" : "", token: enabled ? "phone-demo" : "",
      error: "", port: enabled ? 4870 : 0, connected: 0,
    };
  }

  private memory = new Map<string, { content: string; revision: string }>();

  private memoryTopics = new Map<string, { content: string; revision: string }>();

  async readMemoryTopic(botId: string, name: string): Promise<MemoryTopic> {
    const stored = this.memoryTopics.get(botId + ":" + name);
    if (!stored) throw new Error("Topic not found");
    return {
      name, title: name, description: "Preview topic", bytes: stored.content.length,
      content: stored.content, revision: stored.revision, updatedAt: nowISO(),
    };
  }

  async saveMemoryTopic(botId: string, name: string, content: string, revision: string): Promise<MemoryTopic> {
    const key = botId + ":" + name;
    const stored = this.memoryTopics.get(key);
    if (stored && stored.revision !== revision) throw new Error("Topic changed on disk while you were editing; reload and try again");
    this.memoryTopics.set(key, { content, revision: "preview-" + Date.now() });
    return this.readMemoryTopic(botId, name);
  }

  async readMemoryLog(_botId: string, _date: string): Promise<string> {
    throw new Error("Daily logs are only available in the desktop app.");
  }

  async deleteMemoryTopic(botId: string, name: string): Promise<void> {
    this.memoryTopics.delete(botId + ":" + name);
  }

  async forgetMemory(_botId: string, _query: string): Promise<MemoryForgetResult> {
    return { removed: 0, archived: 0 };
  }

  async tidyMemory(botId: string): Promise<MemoryTidyResult> {
    const state = await this.getMemory(botId);
    return { archived: 0, lines: state.lines, bytes: state.bytes, within: true };
  }

  async getMemory(botId: string): Promise<MemoryState> {
    const bot = this.bot(botId);
    const stored = this.memory.get(botId) ?? {
      content: "# Memory\n\n- The browser preview keeps this note locally.\n- Enable memory in the desktop app to load real MEMORY.md notes into a turn.\n",
      revision: "preview-1",
    };
    this.memory.set(botId, stored);
    const lines = stored.content.trim() ? stored.content.trim().split("\n").length : 0;
    return {
      botId,
      enabled: !bot.memoryOff,
      content: stored.content,
      path: "memory/" + botId + "/MEMORY.md",
      revision: stored.revision,
      bytes: new TextEncoder().encode(stored.content).length,
      lines,
      loadedBytes: new TextEncoder().encode(stored.content).length,
      loadedLines: lines,
      limitBytes: 24 * 1024,
      limitLines: 200,
      topics: [],
    };
  }

  async saveMemory(botId: string, content: string, revision: string): Promise<MemoryState> {
    const stored = this.memory.get(botId) ?? { content: "", revision: "" };
    if (stored.revision && stored.revision !== revision) throw new Error("memory changed on disk while you were editing; reload and try again");
    this.memory.set(botId, { content, revision: "preview-" + Date.now() });
    return this.getMemory(botId);
  }

  async setMemoryEnabled(botId: string, enabled: boolean): Promise<Bot> {
    const bot = this.bot(botId);
    bot.memoryOff = !enabled;
    bot.updatedAt = nowISO();
    this.emitState();
    return clone(bot);
  }

  async getAPIInfo(): Promise<APIInfo> {
    return { enabled: false, tokenConfigured: false };
  }

  async setAPIEnabled(enabled: boolean): Promise<APIInfo> {
    if (enabled) throw new Error("The automation API is only available in the desktop app.");
    return { enabled: false, tokenConfigured: false };
  }

  async rotateAPIToken(): Promise<APIInfo> {
    throw new Error("The automation API is only available in the desktop app.");
  }

  async replayWebhookDelivery(_deliveryId: string): Promise<string> {
    throw new Error("Webhooks are only available in the desktop app.");
  }

  async exportTeam(_groupId: string): Promise<string> {
    throw new Error("Team packages are exported by the desktop app.");
  }

  async importTeam(_raw: string): Promise<TeamImportResult> {
    throw new Error("Team packages are imported by the desktop app.");
  }

  async listPresets(): Promise<Preset[]> {
    return clone(this.state.presets ?? []);
  }

  async createPreset(input: PresetInput): Promise<Preset> {
    const now = nowISO();
    const preset: Preset = {
      id: uid("preset"), name: input.name, title: input.title, description: input.description,
      soul: input.soul, color: input.color, createdAt: now, updatedAt: now,
    };
    this.state.presets = [...(this.state.presets ?? []), preset];
    this.emitState();
    return clone(preset);
  }

  async updatePreset(id: string, patch: PresetPatch): Promise<Preset> {
    const preset = (this.state.presets ?? []).find((item) => item.id === id);
    if (!preset) throw new Error("Preset not found");
    Object.assign(preset, patch, { updatedAt: nowISO() });
    this.emitState();
    return clone(preset);
  }

  async deletePreset(id: string): Promise<void> {
    this.state.presets = (this.state.presets ?? []).filter((item) => item.id !== id);
    this.emitState();
  }

  async listMCPServers(): Promise<MCPServer[]> {
    return [];
  }

  async createMCPServer(_input: MCPServerInput): Promise<MCPServer> {
    throw new Error("Remote MCP servers are configured in the desktop app.");
  }

  async updateMCPServer(_id: string, _patch: MCPServerPatch): Promise<MCPServer> {
    throw new Error("Remote MCP servers are configured in the desktop app.");
  }

  async deleteMCPServer(_id: string): Promise<void> {
    throw new Error("Remote MCP servers are configured in the desktop app.");
  }

  async getWebhookInfo(): Promise<WebhookInfo> {
    return {
      baseUrl: "",
      error: "The loopback webhook receiver starts in the desktop app. The browser preview does not open ports.",
      items: clone(this.state.webhooks ?? []),
    };
  }

  async createWebhook(_input: WebhookInput): Promise<Webhook> {
    throw new Error("Webhooks are only available in the desktop app.");
  }

  async updateWebhook(_id: string, _patch: WebhookPatch): Promise<Webhook> {
    throw new Error("Webhooks are only available in the desktop app.");
  }

  async deleteWebhook(_id: string): Promise<void> {
    throw new Error("Webhooks are only available in the desktop app.");
  }

  async listSkills(botId: string): Promise<Skill[]> {
    const bot = this.bot(botId);
    const enabled = new Set((bot.skills ?? []).filter((item) => item.enabled).map((item) => item.id));
    return [
      {
        id: "launch-report",
        name: "Launch report",
        description: "Turn a launch checklist into a short, sourced status brief.",
        source: "Preview",
        path: "skills/launch-report/SKILL.md",
        bytes: 248,
        enabled: enabled.has("launch-report"),
        updatedAt: nowISO(),
      },
      {
        id: "code-review",
        name: "Code review",
        description: "Review the diff before commenting; rank findings by risk.",
        source: "Preview",
        path: "skills/code-review/SKILL.md",
        bytes: 196,
        enabled: enabled.has("code-review"),
        updatedAt: nowISO(),
      },
    ];
  }

  async readSkill(botId: string, skillId: string): Promise<Skill> {
    const skills = await this.listSkills(botId);
    const skill = skills.find((item) => item.id === skillId);
    if (!skill) throw new Error("Skill not found");
    return {
      ...skill,
      body: "---\nname: " + skill.name + "\ndescription: " + skill.description + "\n---\n\n# " + skill.name + "\n\nThis is the browser preview skill. The desktop app reads real SKILL.md files from the workspace.",
    };
  }

  async setSkillEnabled(botId: string, skillId: string, enabled: boolean): Promise<Bot> {
    const bot = this.bot(botId);
    const next = (bot.skills ?? []).filter((item) => item.id !== skillId);
    if (enabled) next.push({ id: skillId, enabled: true });
    bot.skills = next;
    bot.updatedAt = nowISO();
    this.emitState();
    return clone(bot);
  }

  async testRemoteComputer(_botId: string): Promise<string> {
    throw new Error("Remote SSH is only available in the desktop app.");
  }

  async captureComputerScreen(_botId?: string): Promise<string> {
    throw new Error("Screen capture is only available in the desktop app.");
  }

  async createRoutine(input: RoutineInput): Promise<Routine> {
    const now = nowISO();
    const routine: Routine = {
      id: uid("routine"), botId: input.botId, name: input.name, prompt: input.prompt,
      cadence: input.cadence || "daily", timeOfDay: input.timeOfDay || "09:00", weekday: input.weekday || 1,
      enabled: input.enabled, nextRun: nextRun(input.cadence, input.timeOfDay), lastStatus: "",
      createdAt: now, updatedAt: now,
    };
    this.state.routines.push(routine);
    this.emitState();
    return clone(routine);
  }

  async updateRoutine(id: string, patch: RoutinePatch): Promise<Routine> {
    const routine = this.state.routines.find((item) => item.id === id);
    if (!routine) throw new Error("Routine not found");
    Object.assign(routine, patch);
    routine.nextRun = nextRun(routine.cadence, routine.timeOfDay);
    routine.updatedAt = nowISO();
    this.emitState();
    return clone(routine);
  }

  async deleteRoutine(id: string): Promise<void> {
    this.state.routines = this.state.routines.filter((routine) => routine.id !== id);
    this.emitState();
  }

  async runRoutine(id: string): Promise<SendResult> {
    const routine = this.state.routines.find((item) => item.id === id);
    if (!routine) throw new Error("Routine not found");
    const bot = this.bot(routine.botId);
    const now = nowISO();
    const thread: Thread = {
      id: uid("thread"), botId: bot.id, title: routine.name + " · " + new Date().toLocaleDateString("en", { month: "short", day: "numeric" }),
      kind: "task", pinned: false, unread: 0, busy: false, createdAt: now, updatedAt: now,
      messages: [{ id: uid("msg"), role: "user", kind: "text", text: routine.prompt, pending: false, error: false, createdAt: now, updatedAt: now }],
    };
    bot.threads.unshift(thread);
    this.state.activeBotId = bot.id;
    this.state.activeThreadId = thread.id;
    this.state.runs.unshift({ id: uid("run"), routineId: routine.id, botId: bot.id, threadId: thread.id, title: routine.name, status: "completed", startedAt: now, finishedAt: now, summary: "Preview run" });
    routine.lastRun = now;
    routine.nextRun = nextRun(routine.cadence, routine.timeOfDay);
    this.emitState();
    this.startReply(bot, thread, routine.prompt);
    return { botId: bot.id, threadId: thread.id, messageId: thread.messages[0]!.id };
  }

  async setConnection(appId: string, connected: boolean): Promise<AppEntry> {
    const app = this.bootData.apps.find((item) => item.id === appId);
    if (!app) throw new Error("App not found");
    this.state.connections[appId] = { id: appId, connected, account: connected ? "Connected in preview" : "", connectedAt: connected ? nowISO() : "" };
    this.emitState();
    return { ...app, connected, account: connected ? "Connected in preview" : "" };
  }

  async updateSettings(settings: Settings): Promise<Settings> {
    this.state.settings = { ...this.state.settings, ...settings };
    this.emitState();
    return clone(this.state.settings);
  }

  async setSecret(name: string, _value: string): Promise<SecretStatus> {
    this.secrets.configured[name] = true;
    this.secrets.hints[name] = "••••preview";
    return clone(this.secrets);
  }

  async clearSecret(name: string): Promise<SecretStatus> {
    delete this.secrets.configured[name];
    delete this.secrets.hints[name];
    return clone(this.secrets);
  }

  async exportWorkspace(): Promise<string> {
    return "~/Downloads/grox-workspace-preview.json";
  }

  async resetWorkspace(): Promise<void> {
    this.state = clone(this.bootData.state);
    this.state.revision += 1;
    this.emitState();
  }

  async revealDataFolder(): Promise<void> {
    // The preview has no folder to reveal.
  }

  async saveAttachment(name: string, mimeType: string, dataBase64: string): Promise<Attachment> {
    const clean = dataBase64.includes(",") ? dataBase64.slice(dataBase64.indexOf(",") + 1) : dataBase64;
    const id = uid("att");
    this.attachmentBytes.set(id, clean);
    return {
      id, name: name || "attachment", mime: mimeType || "application/octet-stream",
      kind: (mimeType || "").startsWith("image/") ? "image" : "file",
      size: Math.floor((clean.length * 3) / 4), createdAt: nowISO(),
    };
  }

  async readAttachment(id: string): Promise<string> {
    const value = this.attachmentBytes.get(id);
    if (!value) throw new Error("Attachment not found");
    return value;
  }

  async openAttachment(_id: string): Promise<void> {
    // The preview is already inline; the browser preview has no system viewer.
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private replyFor(bot: Bot, prompt: string): Reply {
    const lower = prompt.toLowerCase();
    const run = /\b(run|shell|terminal|delete|remove|archive|send|deploy|deploy)\b/.test(lower);
    if (run && bot.approval === "ask") {
      return {
        text: "I can do that, but it changes something outside this chat. Here is the smallest command that gets it done:\n\n**gmail archive --older-than 7d**\n\nApprove it and I will run the real step.",
        approval: {
          title: "Run this command?",
          command: "gmail archive --older-than 7d",
          reason: "The demo engine asks before touching your files or inbox.",
          risk: "You can approve once or allow this bot to decide next time",
        },
      };
    }
    if (/(which|choose|priorit|decide|what should)/.test(lower)) {
      return {
        text: "There is a real tradeoff here. Pick the answer that is closest; we can expand from there.",
        options: {
          text: "What should this week optimize for?",
          options: [
            { id: "a", label: "Ship the smallest useful version", description: "Cut scope, get feedback sooner." },
            { id: "b", label: "Protect the date", description: "Keep the commitment, trade features." },
            { id: "c", label: "Protect the team's focus", description: "One priority, everything else waits." },
            { id: "d", label: "A bit of everything", description: "Keep all threads moving; accept slower progress." },
          ],
        },
      };
    }
    if (/(plan|launch|week|todo|organize)/.test(lower)) {
      return {
        text: `Here is a plan I would actually run.

**Outcome**
${prompt.trim().replace(/\.$/, "")}

**This week**
- **Today** — write the one-sentence decision and name the owner.
- **Tuesday** — cut the list to the work that changes the outcome.
- **Thursday** — review what is real, not what was reported as done.
- **Friday** — ship the smallest useful version and capture what was learned.

**Watch for**
The plan fails if every item still belongs to you. Pick one thing to hand over before the week starts.

Want me to turn this into a task list with dates?`,
      };
    }
    if (/(hi|hello|hey)\b/.test(lower)) {
      return { text: `Hey. I am ${bot.name}${bot.title ? " — " + bot.title : ""}.

I am running in the browser preview. Open the desktop app to connect a real model. In the meantime, ask me to plan something, or open **Settings → Engines**.

What are we working on?` };
    }
    return {
      text: `I have enough to start, but I want to be precise about the outcome.

**${prompt.trim().replace(/\.$/, "")}**

- **What I would do first:** write down the one decision this work should change, and the date it needs to change by.
- **What I need from you:** the constraint that matters most — scope, time, or quality.
- **What I will return:** a short plan with owners, the first real action, and the unknowns I could not resolve.

This is the browser preview, so connect a model in **Settings → Engines** to put a real agent behind ${bot.name}.

What is the constraint?`,
    };
  }
}

type Reply = {
  text: string;
  approval?: { title: string; command: string; reason: string; risk: string };
  options?: { text: string; options: Option[] };
};

function streamChunks(text: string): string[] {
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let buffer = "";
  let count = 0;
  for (const word of words) {
    buffer += word;
    if (/^\s+$/.test(word)) count++;
    if (count >= 5) {
      chunks.push(buffer);
      buffer = "";
      count = 0;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [text];
}

function nextRun(cadence: string, time: string): string {
  const [hours, minutes] = (time || "09:00").split(":").map((part) => Number(part));
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number.isFinite(hours) ? hours! : 9, Number.isFinite(minutes) ? minutes! : 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  if (cadence === "weekdays") {
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}
