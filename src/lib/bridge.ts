import type {
  AppEntry, AppState, Bootstrap, Bot, BotPatch, CreateBotInput, Event as AppEvent,
  Routine, RoutineInput, RoutinePatch, SecretStatus, SendResult, Settings, Thread,
} from "@/mygo";

export interface Backend {
  bootstrap(): Promise<Bootstrap>;
  refreshCatalog(): Promise<Bootstrap>;
  createBot(input: CreateBotInput): Promise<Bot>;
  updateBot(botId: string, patch: BotPatch): Promise<Bot>;
  duplicateBot(id: string): Promise<Bot>;
  deleteBot(id: string): Promise<void>;
  createThread(botId: string, title: string): Promise<Thread>;
  updateThread(botId: string, threadId: string, title: string): Promise<Thread>;
  deleteThread(botId: string, threadId: string): Promise<void>;
  select(botId: string, threadId: string): Promise<void>;
  markRead(botId: string, threadId: string): Promise<void>;
  markUnread(botId: string, threadId: string): Promise<void>;
  revealWorkingFolder(botId: string): Promise<string>;
  send(botId: string, threadId: string, text: string): Promise<SendResult>;
  stop(botId: string, threadId: string): Promise<void>;
  decide(botId: string, threadId: string, messageId: string, decision: string): Promise<void>;
  answer(botId: string, threadId: string, messageId: string, answer: string): Promise<void>;
  createRoutine(input: RoutineInput): Promise<Routine>;
  updateRoutine(id: string, patch: RoutinePatch): Promise<Routine>;
  deleteRoutine(id: string): Promise<void>;
  runRoutine(id: string): Promise<SendResult>;
  setConnection(appId: string, connected: boolean): Promise<AppEntry>;
  updateSettings(settings: Settings): Promise<Settings>;
  setSecret(name: string, value: string): Promise<SecretStatus>;
  clearSecret(name: string): Promise<SecretStatus>;
  exportWorkspace(): Promise<string>;
  resetWorkspace(): Promise<void>;
  revealDataFolder(): Promise<void>;
  subscribe(listener: (event: AppEvent) => void): () => void;
}

export type {
  Activity, AppEntry, AppState, Bootstrap, Bot, BotPatch, CreateBotInput, Approval,
  Connection, EngineInfo, Message, Model, Option, Provider, Routine, RoutineInput, RoutinePatch,
  Run, SecretStatus, SendResult, Settings, Thread, Toast, Turn,
} from "@/mygo";
export type { Event as AppEvent } from "@/mygo";

/** True when the page is running inside a MyGo window. */
export function isMyGo(): boolean {
  return typeof globalThis === "object" && Boolean((globalThis as { mygo?: unknown }).mygo);
}

/** Loads the real Go bridge, or the in-browser preview when opened in a tab. */
export async function createBackend(): Promise<Backend> {
  if (isMyGo()) {
    const mod = await import("@/mygo");
    return {
      ...mod.Grox,
      subscribe(listener) {
        return mod.events.app.on(listener);
      },
    } as Backend;
  }
  const { MockBackend } = await import("@/mock/mock");
  return new MockBackend();
}
