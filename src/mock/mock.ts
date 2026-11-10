import type {
  Activity, AppEntry, AppEvent, AppState, Bootstrap, Bot, BotPatch, CreateBotInput,
  Message, Option, Routine, RoutineInput, RoutinePatch, SecretStatus, SendResult,
  Settings, Thread,
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
  private state: AppState = clone(this.bootData.state);
  private secrets: SecretStatus = clone(this.bootData.secrets);
  private listeners = new Set<(event: AppEvent) => void>();
  private timers = new Map<string, Timer>();

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

  private emitMessage(botId: string, threadId: string, message: Message): void {
    this.emit({ type: "message", revision: this.state.revision, botId, threadId, messageId: message.id, message: clone(message) });
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
    const bot = this.bot(botId);
    const thread = this.thread(bot, threadId);
    if (thread.busy) throw new Error(`${bot.name} is still working on the last message`);
    const now = nowISO();
    const userMessage: Message = {
      id: uid("msg"), role: "user", kind: "text", text, pending: false, error: false, createdAt: now, updatedAt: now,
    };
    thread.messages.push(userMessage);
    if (["", "New conversation", "New task"].includes(thread.title)) thread.title = titleFrom(text);
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
