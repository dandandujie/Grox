import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import type {
  AppEvent, AppEntry, AppState, Attachment, Bootstrap, Bot, BotPatch, CreateBotInput, CreateGroupInput,
  Group, GroupPatch, Message, PhoneInfo, Routine, RoutineInput, RoutinePatch, SecretStatus, Settings, Thread,
} from "@/lib/bridge";
import type { Backend } from "@/lib/bridge";
import { speak } from "@/lib/speech";

export type View = "chat" | "routines" | "apps";
export type Panel = "profile" | "skills" | "memory" | "computer" | "activity";
export type SettingsSection = "general" | "connections" | "engines" | "mcp" | "computer" | "phone" | "automation" | "departments" | "voice" | "data" | "about";

export interface ToastItem {
  id: string;
  kind: "info" | "success" | "error";
  title: string;
  body?: string;
}

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export interface UIState {
  view: View;
  activeBotId: string;
  activeGroupId: string;
  activeThreadId: string;
  panel: Panel | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  modelPickerOpen: boolean;
  newBotOpen: boolean;
  newRoutineOpen: boolean;
  editingRoutineId: string | null;
  newChannelOpen: boolean;
  callOpen: boolean;
  callMuted: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  sidebarSearch: string;
  contextMenu: { botId: string; x: number; y: number } | null;
  threadMenuOpen: boolean;
  sidebarWidth: number;
  mobileSidebarOpen: boolean;
}

interface AppContextValue {
  backend: Backend;
  boot: Bootstrap;
  state: AppState;
  providers: Bootstrap["providers"];
  apps: AppEntry[];
  engines: Bootstrap["engines"];
  secrets: SecretStatus;
  phone: PhoneInfo;
  setPhoneEnabled: (enabled: boolean) => Promise<void>;
  connectApp: (appId: string) => Promise<void>;
  disconnectApp: (appId: string) => Promise<void>;
  refreshApps: () => Promise<void>;
  activeBot: Bot | undefined;
  activeGroup: Group | undefined;
  activeThread: Thread | undefined;
  ui: UIState;
  toast: (toast: Omit<ToastItem, "id">) => void;
  toasts: ToastItem[];
  dismissToast: (id: string) => void;
  confirm: ConfirmRequest | null;
  requestConfirm: (request: ConfirmRequest) => void;
  closeConfirm: () => void;
  setUI: (patch: Partial<UIState> | ((ui: UIState) => Partial<UIState>)) => void;
  selectBot: (botId: string, threadId?: string) => void;
  selectGroup: (groupId: string, threadId?: string) => void;
  openThread: (botId: string, threadId: string) => void;
  openGroupThread: (groupId: string, threadId: string) => void;
  newTask: () => void;
  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  uploadAttachment: (file: File) => Promise<Attachment | null>;
  stop: () => void;
  createBot: (input: CreateBotInput) => Promise<Bot | null>;
  createGroup: (input: CreateGroupInput) => Promise<Group | null>;
  updateGroup: (groupId: string, patch: GroupPatch) => Promise<void>;
  deleteGroup: (groupId: string) => void;
  updateBot: (botId: string, patch: BotPatch) => Promise<void>;
  duplicateBot: (botId: string) => Promise<void>;
  deleteBot: (botId: string) => void;
  renameThread: (threadId: string, title: string) => Promise<void>;
  deleteThread: (threadId: string) => void;
  markUnread: (botId: string, threadId: string) => Promise<void>;
  revealWorkingFolder: (botId: string) => Promise<void>;
  decide: (messageId: string, decision: string) => Promise<void>;
  answer: (messageId: string, answer: string) => Promise<void>;
  patchSettings: (patch: Partial<Settings>) => Promise<void>;
  saveSecret: (name: string, value: string) => Promise<boolean>;
  clearSecret: (name: string) => Promise<void>;
  refreshCatalog: () => Promise<void>;
  setConnection: (appId: string, connected: boolean) => Promise<void>;
  createRoutine: (input: RoutineInput) => Promise<Routine | null>;
  updateRoutine: (id: string, patch: RoutinePatch) => Promise<void>;
  deleteRoutine: (id: string) => Promise<void>;
  runRoutine: (id: string) => Promise<void>;
  exportWorkspace: () => Promise<void>;
  resetWorkspace: () => void;
  revealDataFolder: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function visibleBots(state: AppState): Bot[] {
  return state.bots.filter((bot) => !bot.hidden && !bot.archived);
}

function latestThread(bot: Bot, preferred?: string): Thread | undefined {
  if (preferred) {
    const found = bot.threads.find((thread) => thread.id === preferred);
    if (found) return found;
  }
  return [...bot.threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

function latestGroupThread(group: Group, preferred?: string): Thread | undefined {
  if (preferred) {
    const found = group.threads.find((thread) => thread.id === preferred);
    if (found) return found;
  }
  return [...group.threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

function withGroupThread(
  state: AppState,
  groupId: string,
  threadId: string,
  update: (thread: Thread) => Thread,
): AppState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id !== groupId
        ? group
        : { ...group, threads: group.threads.map((thread) => (thread.id === threadId ? update(thread) : thread)) },
    ),
  };
}

function upsertGroupMessage(state: AppState, groupId: string, threadId: string, message: Message): AppState {
  return withGroupThread(state, groupId, threadId, (thread) => {
    const exists = thread.messages.some((item) => item.id === message.id);
    return {
      ...thread,
      messages: exists ? thread.messages.map((item) => (item.id === message.id ? message : item)) : [...thread.messages, message],
      updatedAt: message.updatedAt || thread.updatedAt,
    };
  });
}

function withThread(
  state: AppState,
  botId: string,
  threadId: string,
  update: (thread: Thread) => Thread,
): AppState {
  return {
    ...state,
    bots: state.bots.map((bot) =>
      bot.id !== botId
        ? bot
        : { ...bot, threads: bot.threads.map((thread) => (thread.id === threadId ? update(thread) : thread)) },
    ),
  };
}

function upsertMessage(state: AppState, botId: string, threadId: string, message: AppState["bots"][number]["threads"][number]["messages"][number]): AppState {
  return withThread(state, botId, threadId, (thread) => {
    const exists = thread.messages.some((item) => item.id === message.id);
    return {
      ...thread,
      messages: exists
        ? thread.messages.map((item) => (item.id === message.id ? message : item))
        : [...thread.messages, message],
      updatedAt: message.updatedAt || thread.updatedAt,
      busy: thread.busy,
    };
  });
}

function appendDelta(state: AppState, event: AppEvent): AppState {
  const delta = event.delta;
  const messageId = event.messageId;
  if (!event.threadId || !messageId || !delta) return state;
  const update = (thread: Thread): Thread => {
    const now = new Date().toISOString();
    const exists = thread.messages.some((message) => message.id === messageId);
    const messages = exists
      ? thread.messages.map((message) =>
          message.id === messageId
            ? { ...message, text: message.text + delta, pending: true, updatedAt: now }
            : message,
        )
      : [
          ...thread.messages,
          {
            id: messageId, role: "bot", kind: "text", text: delta, pending: true,
            error: false, createdAt: now, updatedAt: now,
          },
        ];
    return { ...thread, messages, busy: true, status: "Writing", updatedAt: now };
  };
  if (event.groupId) return withGroupThread(state, event.groupId, event.threadId, update);
  if (!event.botId) return state;
  return withThread(state, event.botId, event.threadId, update);
}

function applyTurn(state: AppState, event: AppEvent): AppState {
  const turn = event.turn;
  if (!turn) return state;
  const update = (thread: Thread): Thread => ({
    ...thread,
    busy: turn.busy,
    status: turn.busy ? turn.status ?? thread.status : "",
  });
  if (event.groupId || turn.groupId) return withGroupThread(state, turn.groupId || event.groupId || "", turn.threadId, update);
  return withThread(state, turn.botId, turn.threadId, update);
}

function initialUI(boot: Bootstrap): UIState {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const bots = visibleBots(boot.state);
  const groups = boot.state.groups ?? [];
  const requestedBot = params.get("bot");
  const requestedGroup = params.get("group");
  let activeGroup = groups.find((group) => group.id === requestedGroup);
  if (!activeGroup && !requestedBot && !requestedGroup) {
    activeGroup = groups.find((group) => group.id === boot.state.activeGroupId);
  }
  const activeBot = activeGroup ? undefined : (bots.find((bot) => bot.id === requestedBot) ?? bots.find((bot) => bot.id === boot.state.activeBotId) ?? bots[0]);
  const requestedThread = params.get("thread");
  const thread = activeGroup
    ? latestGroupThread(activeGroup, requestedThread ?? (boot.state.activeGroupId === activeGroup.id ? boot.state.activeThreadId : undefined))
    : (activeBot?.threads.find((item) => item.id === requestedThread) ?? activeBot?.threads.find((item) => item.id === boot.state.activeThreadId) ?? activeBot?.threads[0]);
  const settingsParam = params.get("settings");
  const settingsSections = ["general", "connections", "engines", "mcp", "computer", "phone", "voice", "data", "about"];
  const panelParam = params.get("panel");
  const viewParam = params.get("view");
  return {
    view: viewParam === "routines" || viewParam === "apps" ? viewParam : "chat",
    activeBotId: activeBot?.id ?? "",
    activeGroupId: activeGroup?.id ?? "",
    activeThreadId: thread?.id ?? "",
    panel: panelParam === "profile" || panelParam === "skills" || panelParam === "memory" || panelParam === "computer" || panelParam === "activity" ? panelParam : null,
    settingsOpen: settingsParam !== null,
    settingsSection: (settingsSections.includes(settingsParam ?? "") ? settingsParam : "general") as SettingsSection,
    modelPickerOpen: params.get("modelPicker") === "1",
    newBotOpen: params.get("newBot") === "1",
    newRoutineOpen: params.get("newRoutine") === "1",
    editingRoutineId: params.get("routine"),
    newChannelOpen: params.get("newChannel") === "1",
    callOpen: params.get("call") === "1",
    callMuted: false,
    paletteOpen: params.get("palette") === "1",
    shortcutsOpen: params.get("shortcuts") === "1",
    sidebarSearch: params.get("search") ?? "",
    contextMenu: null,
    threadMenuOpen: params.get("threads") === "1",
    sidebarWidth: boot.state.settings.sidebarWidth || 312,
    mobileSidebarOpen: false,
  };
}

export function AppProvider({ backend, boot, children }: { backend: Backend; boot: Bootstrap; children: ReactNode }) {
  const [state, setState] = useState<AppState>(boot.state);
  const [providers, setProviders] = useState(boot.providers);
  const [engines, setEngines] = useState(boot.engines);
  const [secrets, setSecrets] = useState(boot.secrets);
  const [phone, setPhone] = useState<PhoneInfo>(boot.phone ?? { enabled: false, url: "", token: "", port: 0, connected: 0 });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const toastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const stateRef = useRef(state);
  const spokenMessages = useRef(new Set<string>());
  const uiRef = useRef<UIState | null>(null);
  useEffect(() => { stateRef.current = state; }, [state]);
  const [ui, setUIState] = useState<UIState>(() => initialUI(boot));
  useEffect(() => { uiRef.current = ui; }, [ui]);

  const setUI = useCallback((patch: Partial<UIState> | ((ui: UIState) => Partial<UIState>)) => {
    setUIState((previous) => ({ ...previous, ...(typeof patch === "function" ? patch(previous) : patch) }));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
  }, []);

  const toast = useCallback((input: Omit<ToastItem, "id">) => {
    const id = "toast-" + Math.random().toString(16).slice(2);
    setToasts((previous) => [...previous.slice(-3), { ...input, id }]);
    const timer = setTimeout(() => {
      setToasts((previous) => previous.filter((item) => item.id !== id));
      toastTimers.current.delete(id);
    }, input.kind === "error" ? 8000 : 4800);
    toastTimers.current.set(id, timer);
  }, []);

  const fail = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    toast({ kind: "error", title: "Something went wrong", body: message });
  }, [toast]);

  useEffect(() => {
    const unsubscribe = backend.subscribe((event) => {
      if (event.type === "state" && event.state) {
        setState(event.state);
        return;
      }
      if (event.type === "message" && event.message && event.threadId) {
        setState((previous) => event.groupId
          ? upsertGroupMessage(previous, event.groupId!, event.threadId!, event.message!)
          : (event.botId ? upsertMessage(previous, event.botId, event.threadId!, event.message!) : previous));
        const bot = stateRef.current.bots.find((item) => item.id === event.botId);
        if ((bot?.speakReplies || uiRef.current?.callOpen) && !uiRef.current?.callMuted
          && event.message.role === "bot" && !event.message.pending && event.message.text.trim()
          && !spokenMessages.current.has(event.message.id) && "speechSynthesis" in window) {
          spokenMessages.current.add(event.message.id);
          speak(event.message.text, bot?.voice || stateRef.current.settings.voiceName);
        }
        return;
      }
      if (event.type === "delta") {
        setState((previous) => appendDelta(previous, event));
        return;
      }
      if (event.type === "turn") {
        setState((previous) => applyTurn(previous, event));
        if (event.turn && !event.turn.busy && document.hidden && stateRef.current.settings.notifications) {
          const bot = stateRef.current.bots.find((item) => item.id === event.turn!.botId);
          const thread = bot?.threads.find((item) => item.id === event.turn!.threadId);
          if (bot && "Notification" in window && Notification.permission === "granted") {
            try {
              new Notification(bot.name + " finished", { body: thread?.title || "A task is ready.", silent: true });
            } catch { /* no notification surface in this webview */ }
          }
        }
        return;
      }
      if (event.type === "toast" && event.toast) {
        toast({ kind: event.toast.kind as ToastItem["kind"], title: event.toast.title, body: event.toast.body });
      }
    });
    return unsubscribe;
  }, [backend, toast]);

  const visible = useMemo(() => visibleBots(state), [state]);
  const activeGroup = useMemo(
    () => state.groups.find((group) => group.id === ui.activeGroupId),
    [state.groups, ui.activeGroupId],
  );
  const activeBot = useMemo(
    () => (activeGroup ? undefined : (visible.find((bot) => bot.id === ui.activeBotId) ?? visible[0])),
    [activeGroup, visible, ui.activeBotId],
  );
  const activeThread = useMemo(
    () => (activeGroup
      ? latestGroupThread(activeGroup, activeGroup.id === ui.activeGroupId ? ui.activeThreadId : undefined)
      : (activeBot ? latestThread(activeBot, activeBot.id === ui.activeBotId ? ui.activeThreadId : undefined) : undefined)),
    [activeGroup, activeBot, ui.activeThreadId, ui.activeBotId],
  );

  useEffect(() => {
    if (activeGroup) {
      if (activeGroup.id !== ui.activeGroupId) {
        setUI({ activeGroupId: activeGroup.id, activeBotId: "", activeThreadId: latestGroupThread(activeGroup)?.id ?? "" });
        return;
      }
      if (activeThread && activeThread.id !== ui.activeThreadId) {
        setUI({ activeThreadId: activeThread.id });
      }
      return;
    }
    if (ui.activeGroupId) setUI({ activeGroupId: "" });
    if (!activeBot) {
      if (ui.activeBotId) setUI({ activeBotId: "", activeThreadId: "" });
      return;
    }
    if (activeBot.id !== ui.activeBotId) {
      setUI({ activeBotId: activeBot.id, activeThreadId: latestThread(activeBot)?.id ?? "" });
      return;
    }
    if (activeThread && activeThread.id !== ui.activeThreadId) {
      setUI({ activeThreadId: activeThread.id });
    }
  }, [activeGroup, activeThread, activeBot, ui.activeGroupId, ui.activeBotId, ui.activeThreadId, setUI]);

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const params = new URLSearchParams(window.location.search);
    const theme = params.get("theme");
    if (theme && ["midnight", "daylight", "atelier", "foundry"].includes(theme)) {
      const settings = { ...state.settings, theme };
      setState((previous) => ({ ...previous, settings }));
      void backend.updateSettings(settings).catch(() => undefined);
    }
    if (activeGroup && activeThread) {
      void backend.selectGroup(activeGroup.id, activeThread.id).catch(() => undefined);
      const draft = params.get("send");
      if (draft) {
        setTimeout(() => { void backend.sendGroup(activeGroup.id, activeThread.id, draft).catch(fail); }, 900);
      }
    } else if (activeBot && activeThread) {
      void backend.select(activeBot.id, activeThread.id).catch(() => undefined);
      const draft = params.get("send");
      if (draft) {
        setTimeout(() => { void backend.send(activeBot.id, activeThread.id, draft).catch(fail); }, 900);
      }
    }
    // This runs once for the first paint only; the deep-link parameters are
    // also a useful way to open a specific bot or panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apps = useMemo<AppEntry[]>(
    () =>
      boot.apps.map((app) => {
        const connection = state.connections[app.id];
        return { ...app, connected: connection?.connected ?? false, account: connection?.account };
      }),
    [boot.apps, state.connections],
  );

  const selectBot = useCallback((botId: string, threadId?: string) => {
    const bot = state.bots.find((item) => item.id === botId);
    if (!bot) return;
    let target = threadId;
    if (!target) {
      target = bot.id === ui.activeBotId ? latestThread(bot, ui.activeThreadId)?.id : latestThread(bot)?.id;
    }
    if (!target) {
      void backend.createThread(botId, "New conversation").then((thread) => {
        setUI({ activeBotId: botId, activeThreadId: thread.id, view: "chat", mobileSidebarOpen: false });
      }).catch(fail);
      return;
    }
    setUI({ activeBotId: botId, activeGroupId: "", activeThreadId: target, view: "chat", mobileSidebarOpen: false, threadMenuOpen: false });
    setState((previous) => ({
      ...previous,
      activeBotId: botId,
      activeGroupId: "",
      activeThreadId: target,
      bots: previous.bots.map((item) =>
        item.id === botId
          ? { ...item, threads: item.threads.map((thread) => (thread.id === target ? { ...thread, unread: 0 } : thread)) }
          : item,
      ),
    }));
    void backend.select(botId, target).catch(fail);
  }, [backend, fail, state.bots, ui.activeBotId, ui.activeThreadId, setUI]);

  const openThread = useCallback((botId: string, threadId: string) => {
    setUI({ view: "chat", panel: null });
    selectBot(botId, threadId);
  }, [selectBot, setUI]);

  const selectGroup = useCallback((groupId: string, threadId?: string) => {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) return;
    let target = threadId;
    if (!target) target = group.id === ui.activeGroupId ? latestGroupThread(group, ui.activeThreadId)?.id : latestGroupThread(group)?.id;
    if (!target) {
      void backend.createGroupThread(groupId, "New conversation").then((thread) => {
        setUI({ activeGroupId: groupId, activeBotId: "", activeThreadId: thread.id, view: "chat", mobileSidebarOpen: false });
      }).catch(fail);
      return;
    }
    setUI({ activeGroupId: groupId, activeBotId: "", activeThreadId: target, view: "chat", mobileSidebarOpen: false, threadMenuOpen: false });
    setState((previous) => ({
      ...previous,
      activeGroupId: groupId,
      activeBotId: "",
      activeThreadId: target,
      groups: previous.groups.map((item) => item.id === groupId
        ? { ...item, unread: 0, threads: item.threads.map((thread) => thread.id === target ? { ...thread, unread: 0 } : thread) }
        : item),
    }));
    void backend.selectGroup(groupId, target).catch(fail);
  }, [backend, fail, state.groups, ui.activeGroupId, ui.activeThreadId, setUI]);

  const openGroupThread = useCallback((groupId: string, threadId: string) => {
    setUI({ view: "chat", panel: null });
    selectGroup(groupId, threadId);
  }, [selectGroup, setUI]);

  const newTask = useCallback(() => {
    if (activeGroup) {
      void backend.createGroupThread(activeGroup.id, "New task").then((thread) => {
        setUI({ activeGroupId: activeGroup.id, activeBotId: "", activeThreadId: thread.id, view: "chat", threadMenuOpen: false });
      }).catch(fail);
      return;
    }
    if (!activeBot) return;
    void backend.createThread(activeBot.id, "New task").then((thread) => {
      setUI({ activeBotId: activeBot.id, activeGroupId: "", activeThreadId: thread.id, view: "chat", threadMenuOpen: false });
    }).catch(fail);
  }, [activeBot, activeGroup, backend, fail, setUI]);

  const send = useCallback(async (text: string, attachments: Attachment[] = []) => {
    if (!activeThread || (!activeBot && !activeGroup)) return;
    if (!text.trim() && attachments.length === 0) return;
    try {
      if (activeGroup) {
        if (attachments.length > 0) await backend.sendGroupWithAttachments(activeGroup.id, activeThread.id, text, attachments);
        else await backend.sendGroup(activeGroup.id, activeThread.id, text);
      } else if (activeBot) {
        if (attachments.length > 0) await backend.sendWithAttachments(activeBot.id, activeThread.id, text, attachments);
        else await backend.send(activeBot.id, activeThread.id, text);
      }
    } catch (error) {
      fail(error);
    }
  }, [activeBot, activeGroup, activeThread, backend, fail]);

  const uploadAttachment = useCallback(async (file: File) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("The file could not be read"));
        reader.readAsDataURL(file);
      });
      return await backend.saveAttachment(file.name, file.type || "application/octet-stream", dataUrl);
    } catch (error) {
      fail(error);
      return null;
    }
  }, [backend, fail]);

  const stop = useCallback(() => {
    if (!activeThread) return;
    if (activeGroup) void backend.stopGroup(activeGroup.id, activeThread.id).catch(fail);
    else if (activeBot) void backend.stop(activeBot.id, activeThread.id).catch(fail);
  }, [activeBot, activeGroup, activeThread, backend, fail]);

  const createBot = useCallback(async (input: CreateBotInput) => {
    try {
      const bot = await backend.createBot(input);
      setState((previous) => ({
        ...previous,
        bots: previous.bots.some((item) => item.id === bot.id)
          ? previous.bots.map((item) => (item.id === bot.id ? bot : item))
          : [...previous.bots, bot],
        activeBotId: bot.id,
        activeThreadId: bot.threads[0]?.id ?? "",
      }));
      setUI({ activeBotId: bot.id, activeThreadId: bot.threads[0]?.id ?? "", newBotOpen: false, view: "chat" });
      toast({ kind: "success", title: bot.name + " is ready", body: "Say hi, or shape the bot in Agent profile." });
      return bot;
    } catch (error) {
      fail(error);
      return null;
    }
  }, [backend, fail, toast, setUI]);

  const createGroup = useCallback(async (input: CreateGroupInput) => {
    try {
      const group = await backend.createGroup(input);
      setState((previous) => ({
        ...previous,
        groups: previous.groups.some((item) => item.id === group.id)
          ? previous.groups.map((item) => item.id === group.id ? group : item)
          : [...previous.groups, group],
        activeGroupId: group.id,
        activeBotId: "",
        activeThreadId: group.threads[0]?.id ?? "",
      }));
      setUI({ activeGroupId: group.id, activeBotId: "", activeThreadId: group.threads[0]?.id ?? "", newChannelOpen: false, view: "chat" });
      toast({ kind: "success", title: group.name + " is open", body: "Mention a bot with @Name, or let the lead answer." });
      return group;
    } catch (error) {
      fail(error);
      return null;
    }
  }, [backend, fail, toast, setUI]);

  const updateGroup = useCallback(async (groupId: string, patch: GroupPatch) => {
    setState((previous) => ({
      ...previous,
      groups: previous.groups.map((group) => group.id === groupId ? { ...group, ...patch } : group),
    }));
    try {
      const group = await backend.updateGroup(groupId, patch);
      setState((previous) => ({ ...previous, groups: previous.groups.map((item) => item.id === group.id ? group : item) }));
    } catch (error) {
      fail(error);
    }
  }, [backend, fail]);

  const updateBot = useCallback(async (botId: string, patch: BotPatch) => {
    setState((previous) => ({
      ...previous,
      bots: previous.bots.map((bot) => (bot.id === botId ? { ...bot, ...patch } : bot)),
    }));
    try {
      const bot = await backend.updateBot(botId, patch);
      setState((previous) => ({ ...previous, bots: previous.bots.map((item) => (item.id === bot.id ? bot : item)) }));
    } catch (error) {
      fail(error);
    }
  }, [backend, fail]);

  const duplicateBot = useCallback(async (botId: string) => {
    try {
      const bot = await backend.duplicateBot(botId);
      setState((previous) => ({
        ...previous,
        bots: previous.bots.some((item) => item.id === bot.id)
          ? previous.bots.map((item) => (item.id === bot.id ? bot : item))
          : [...previous.bots, bot],
      }));
      setUI({ activeBotId: bot.id, activeThreadId: bot.threads[0]?.id ?? "", contextMenu: null });
      toast({ kind: "success", title: "Duplicated " + bot.name });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast, setUI]);

  const requestConfirm = useCallback((request: ConfirmRequest) => setConfirm(request), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);

  const deleteGroup = useCallback((groupId: string) => {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) return;
    requestConfirm({
      title: "Delete " + group.name + "?",
      body: "This channel and every message in it will be removed. The bots and their direct chats stay.",
      confirmLabel: "Delete channel",
      danger: true,
      onConfirm: () => {
        void backend.deleteGroup(groupId).then(() => {
          setState((previous) => ({
            ...previous,
            groups: previous.groups.filter((item) => item.id !== groupId),
            activeGroupId: previous.activeGroupId === groupId ? "" : previous.activeGroupId,
          }));
          setUI({ activeGroupId: "", activeThreadId: "", contextMenu: null });
          toast({ kind: "info", title: group.name + " was deleted" });
        }).catch(fail);
        setConfirm(null);
      },
    });
  }, [backend, fail, requestConfirm, setConfirm, setUI, state.groups, toast]);

  const deleteBot = useCallback((botId: string) => {
    const bot = state.bots.find((item) => item.id === botId);
    if (!bot) return;
    requestConfirm({
      title: "Delete " + bot.name + "?",
      body: "Every conversation with this bot, including its tasks, will be removed. This cannot be undone.",
      confirmLabel: "Delete bot",
      danger: true,
      onConfirm: () => {
        void backend.deleteBot(botId).then(() => {
          setState((previous) => ({ ...previous, bots: previous.bots.filter((item) => item.id !== botId) }));
          toast({ kind: "info", title: bot.name + " was deleted" });
        }).catch(fail);
        setConfirm(null);
        setUI({ contextMenu: null });
      },
    });
  }, [backend, fail, requestConfirm, state.bots, toast, setUI]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    try {
      if (activeGroup) {
        const thread = await backend.updateGroupThread(activeGroup.id, threadId, title);
        setState((previous) => ({
          ...previous,
          groups: previous.groups.map((group) => group.id !== activeGroup.id ? group : {
            ...group, threads: group.threads.map((item) => item.id === thread.id ? thread : item),
          }),
        }));
        return;
      }
      if (!activeBot) return;
      const thread = await backend.updateThread(activeBot.id, threadId, title);
      setState((previous) => ({
        ...previous,
        bots: previous.bots.map((bot) => bot.id !== activeBot.id ? bot : {
          ...bot, threads: bot.threads.map((item) => item.id === thread.id ? thread : item),
        }),
      }));
    } catch (error) {
      fail(error);
    }
  }, [activeBot, activeGroup, backend, fail]);

  const deleteThread = useCallback((threadId: string) => {
    if (activeGroup) {
      const groupThread = activeGroup.threads.find((item) => item.id === threadId);
      requestConfirm({
        title: "Delete this conversation?",
        body: groupThread?.title ? '"' + groupThread.title + '" and its transcript will be removed.' : "This transcript will be removed.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          void backend.deleteGroupThread(activeGroup.id, threadId).then(() => {
            setState((previous) => ({
              ...previous,
              groups: previous.groups.map((group) => group.id !== activeGroup.id ? group : {
                ...group, threads: group.threads.filter((item) => item.id !== threadId),
              }),
            }));
            if (ui.activeThreadId === threadId) {
              const next = activeGroup.threads.find((item) => item.id !== threadId);
              setUI({ activeThreadId: next?.id ?? "", threadMenuOpen: false });
            }
          }).catch(fail);
          setConfirm(null);
        },
      });
      return;
    }
    if (!activeBot) return;
    const thread = activeBot.threads.find((item) => item.id === threadId);
    requestConfirm({
      title: "Delete this conversation?",
      body: thread?.title ? '"' + thread.title + '" and its transcript will be removed.' : "This transcript will be removed.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        void backend.deleteThread(activeBot.id, threadId).then(() => {
          setState((previous) => ({
            ...previous,
            bots: previous.bots.map((bot) => bot.id !== activeBot.id ? bot : {
              ...bot, threads: bot.threads.filter((item) => item.id !== threadId),
            }),
          }));
          if (ui.activeThreadId === threadId) {
            const next = activeBot.threads.find((item) => item.id !== threadId);
            setUI({ activeThreadId: next?.id ?? "", threadMenuOpen: false });
            if (next) void backend.select(activeBot.id, next.id);
          }
        }).catch(fail);
        setConfirm(null);
      },
    });
  }, [activeBot, activeGroup, backend, fail, requestConfirm, setConfirm, setUI, ui.activeThreadId]);

  const markUnread = useCallback(async (botId: string, threadId: string) => {
    setState((previous) => ({
      ...previous,
      bots: previous.bots.map((bot) => bot.id !== botId ? bot : {
        ...bot, threads: bot.threads.map((thread) => thread.id === threadId ? { ...thread, unread: Math.max(1, thread.unread) } : thread),
      }),
    }));
    try {
      await backend.markUnread(botId, threadId);
    } catch (error) {
      fail(error);
    }
  }, [backend, fail]);

  const revealWorkingFolder = useCallback(async (botId: string) => {
    try {
      const path = await backend.revealWorkingFolder(botId);
      toast({ kind: "success", title: "Opened the working folder", body: path });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const decide = useCallback(async (messageId: string, decision: string) => {
    if (!activeThread) return;
    try {
      if (activeGroup) await backend.decideGroup(activeGroup.id, activeThread.id, messageId, decision);
      else if (activeBot) await backend.decide(activeBot.id, activeThread.id, messageId, decision);
    } catch (error) {
      fail(error);
    }
  }, [activeBot, activeGroup, activeThread, backend, fail]);

  const answer = useCallback(async (messageId: string, value: string) => {
    if (!activeThread) return;
    try {
      if (activeGroup) await backend.answerGroup(activeGroup.id, activeThread.id, messageId, value);
      else if (activeBot) await backend.answer(activeBot.id, activeThread.id, messageId, value);
    } catch (error) {
      fail(error);
    }
  }, [activeBot, activeGroup, activeThread, backend, fail]);

  const connectApp = useCallback(async (appId: string) => {
    try {
      const link = await backend.connectComposioApp(appId);
      if (link.url) {
        toast({ kind: "info", title: "Finish connecting in your browser", body: "Authorize the app, then press Refresh connections." });
      } else {
        toast({ kind: "info", title: "Connection started", body: "Finish the OAuth flow, then refresh." });
      }
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const disconnectApp = useCallback(async (appId: string) => {
    try {
      await backend.disconnectComposioApp(appId);
      toast({ kind: "info", title: "Disconnected" });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const refreshApps = useCallback(async () => {
    try {
      const count = await backend.refreshComposioConnections();
      toast({ kind: "success", title: count + " connected app" + (count === 1 ? "" : "s"), body: "The connection list is up to date." });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const setPhoneEnabled = useCallback(async (enabled: boolean) => {
    try {
      const info = await backend.setPhoneEnabled(enabled);
      setPhone(info);
      toast({ kind: enabled ? "success" : "info", title: enabled ? "Phone link is live" : "Phone link is off", body: enabled ? "Open the address on a phone on the same Wi-Fi." : undefined });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...state.settings, ...patch };
    setState((previous) => ({ ...previous, settings: next }));
    try {
      const saved = await backend.updateSettings(next);
      setState((previous) => ({ ...previous, settings: saved }));
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, state.settings]);

  const refreshCatalog = useCallback(async () => {
    try {
      const fresh = await backend.refreshCatalog();
      setProviders(fresh.providers);
      setEngines(fresh.engines);
      setSecrets(fresh.secrets);
      setPhone(fresh.phone);
      setState(fresh.state);
    } catch (error) {
      fail(error);
    }
  }, [backend, fail]);

  const saveSecret = useCallback(async (name: string, value: string) => {
    try {
      const status = await backend.setSecret(name, value);
      setSecrets(status);
      const fresh = await backend.refreshCatalog();
      setProviders(fresh.providers);
      setEngines(fresh.engines);
      setSecrets(fresh.secrets);
      toast({ kind: "success", title: "Key saved", body: "The provider fleet reloaded." });
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }, [backend, fail, toast]);

  const clearSecret = useCallback(async (name: string) => {
    try {
      const status = await backend.clearSecret(name);
      setSecrets(status);
      const fresh = await backend.refreshCatalog();
      setProviders(fresh.providers);
      setEngines(fresh.engines);
      setSecrets(fresh.secrets);
      toast({ kind: "info", title: "Key cleared" });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const setConnection = useCallback(async (appId: string, connected: boolean) => {
    try {
      const entry = await backend.setConnection(appId, connected);
      setState((previous) => ({
        ...previous,
        connections: {
          ...previous.connections,
          [appId]: { id: appId, connected, account: entry.account ?? "", connectedAt: new Date().toISOString() },
        },
      }));
      toast({ kind: "success", title: connected ? entry.name + " connected" : entry.name + " disconnected", body: connected ? "Bots can use it in their next task." : undefined });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const createRoutine = useCallback(async (input: RoutineInput) => {
    try {
      const routine = await backend.createRoutine(input);
      setState((previous) => ({ ...previous, routines: [...previous.routines, routine] }));
      toast({ kind: "success", title: "Routine created" });
      return routine;
    } catch (error) {
      fail(error);
      return null;
    }
  }, [backend, fail, toast]);

  const updateRoutine = useCallback(async (id: string, patch: RoutinePatch) => {
    try {
      const routine = await backend.updateRoutine(id, patch);
      setState((previous) => ({ ...previous, routines: previous.routines.map((item) => item.id === id ? routine : item) }));
    } catch (error) {
      fail(error);
    }
  }, [backend, fail]);

  const deleteRoutine = useCallback(async (id: string) => {
    try {
      await backend.deleteRoutine(id);
      setState((previous) => ({ ...previous, routines: previous.routines.filter((item) => item.id !== id) }));
      toast({ kind: "info", title: "Routine deleted" });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const runRoutine = useCallback(async (id: string) => {
    const routine = state.routines.find((item) => item.id === id);
    try {
      const result = await backend.runRoutine(id);
      setUI({ activeBotId: result.botId, activeThreadId: result.threadId, view: "chat", newRoutineOpen: false });
      toast({ kind: "success", title: routine?.name ? routine.name + " is running" : "Routine is running" });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, state.routines, toast, setUI]);

  const exportWorkspace = useCallback(async () => {
    try {
      const path = await backend.exportWorkspace();
      toast({ kind: "success", title: "Workspace exported", body: path });
    } catch (error) {
      fail(error);
    }
  }, [backend, fail, toast]);

  const resetWorkspace = useCallback(() => {
    requestConfirm({
      title: "Reset this workspace?",
      body: "Bots, conversations and routines will be replaced with the first-run team. API keys are kept.",
      confirmLabel: "Reset everything",
      danger: true,
      onConfirm: () => {
        void backend.resetWorkspace().then(() => {
          window.location.reload();
        }).catch(fail);
      },
    });
  }, [backend, fail, requestConfirm]);

  const revealDataFolder = useCallback(() => {
    void backend.revealDataFolder().catch(fail);
  }, [backend, fail]);

  const value: AppContextValue = {
    backend, boot, state, providers, apps, engines, secrets, phone, setPhoneEnabled, connectApp, disconnectApp, refreshApps, activeBot, activeGroup, activeThread, ui,
    toast, toasts, dismissToast, confirm, requestConfirm, closeConfirm, setUI,
    selectBot, selectGroup, openThread, openGroupThread, newTask, send, uploadAttachment, stop, createBot, updateBot, duplicateBot, deleteBot,
    createGroup, updateGroup, deleteGroup,
    renameThread, deleteThread, markUnread, revealWorkingFolder, decide, answer, patchSettings, saveSecret, clearSecret, refreshCatalog,
    setConnection, createRoutine, updateRoutine, deleteRoutine, runRoutine, exportWorkspace, resetWorkspace, revealDataFolder,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}

export function botUnread(bot: Bot): number {
  return bot.threads.reduce((sum, thread) => sum + (thread.unread || 0), 0);
}
