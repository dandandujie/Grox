import type {
  AppEntry, AppState, Attachment, Bootstrap, Bot, BotPatch, CommandResult, ComposioLink, ComposioTool, CreateBotInput, CreateGroupInput,
  Event as AppEvent, FilePreview, FolderListing, Group, GroupPatch, PhoneInfo,
  APIInfo, MCPServer, MCPServerInput, MCPServerPatch, MemoryForgetResult, MemoryState, MemoryTidyResult, MemoryTopic, Preset, PresetInput, PresetPatch, Routine, RoutineInput, RoutinePatch,
  SecretStatus, SendResult, Settings, Skill, Thread, TeamImportResult, Webhook, WebhookInfo, WebhookInput, WebhookPatch,
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
  createGroup(input: CreateGroupInput): Promise<Group>;
  updateGroup(groupId: string, patch: GroupPatch): Promise<Group>;
  deleteGroup(groupId: string): Promise<void>;
  createGroupThread(groupId: string, title: string): Promise<Thread>;
  updateGroupThread(groupId: string, threadId: string, title: string): Promise<Thread>;
  deleteGroupThread(groupId: string, threadId: string): Promise<void>;
  selectGroup(groupId: string, threadId: string): Promise<void>;
  markGroupRead(groupId: string): Promise<void>;
  sendGroup(groupId: string, threadId: string, text: string): Promise<SendResult>;
  sendGroupWithAttachments(groupId: string, threadId: string, text: string, attachments: Attachment[]): Promise<SendResult>;
  stopGroup(groupId: string, threadId: string): Promise<void>;
  decideGroup(groupId: string, threadId: string, messageId: string, decision: string): Promise<void>;
  answerGroup(groupId: string, threadId: string, messageId: string, answer: string): Promise<void>;
  saveAttachment(name: string, mimeType: string, dataBase64: string): Promise<Attachment>;
  readAttachment(id: string): Promise<string>;
  openAttachment(id: string): Promise<void>;
  sendWithAttachments(botId: string, threadId: string, text: string, attachments: Attachment[]): Promise<SendResult>;
  revealWorkingFolder(botId: string): Promise<string>;
  listComputerFiles(botId: string, path: string): Promise<FolderListing>;
  readComputerFile(botId: string, path: string): Promise<FilePreview>;
  openComputerPath(botId: string, path: string): Promise<void>;
  runComputerCommand(botId: string, command: string): Promise<CommandResult>;
  captureComputerScreen(botId: string): Promise<string>;
  testRemoteComputer(botId: string): Promise<string>;
  listSkills(botId: string): Promise<Skill[]>;
  readSkill(botId: string, skillId: string): Promise<Skill>;
  setSkillEnabled(botId: string, skillId: string, enabled: boolean): Promise<Bot>;
  getMemory(botId: string): Promise<MemoryState>;
  saveMemory(botId: string, content: string, revision: string): Promise<MemoryState>;
  setMemoryEnabled(botId: string, enabled: boolean): Promise<Bot>;
  tidyMemory(botId: string): Promise<MemoryTidyResult>;
  readMemoryTopic(botId: string, name: string): Promise<MemoryTopic>;
  saveMemoryTopic(botId: string, name: string, content: string, revision: string): Promise<MemoryTopic>;
  deleteMemoryTopic(botId: string, name: string): Promise<void>;
  readMemoryLog(botId: string, date: string): Promise<string>;
  forgetMemory(botId: string, query: string): Promise<MemoryForgetResult>;
  getWebhookInfo(): Promise<WebhookInfo>;
  createWebhook(input: WebhookInput): Promise<Webhook>;
  updateWebhook(id: string, patch: WebhookPatch): Promise<Webhook>;
  deleteWebhook(id: string): Promise<void>;
  replayWebhookDelivery(deliveryId: string): Promise<string>;
  getAPIInfo(): Promise<APIInfo>;
  setAPIEnabled(enabled: boolean): Promise<APIInfo>;
  rotateAPIToken(): Promise<APIInfo>;
  exportTeam(groupId: string): Promise<string>;
  importTeam(raw: string): Promise<TeamImportResult>;
  listMCPServers(): Promise<MCPServer[]>;
  createMCPServer(input: MCPServerInput): Promise<MCPServer>;
  updateMCPServer(id: string, patch: MCPServerPatch): Promise<MCPServer>;
  deleteMCPServer(id: string): Promise<void>;
  listPresets(): Promise<Preset[]>;
  createPreset(input: PresetInput): Promise<Preset>;
  updatePreset(id: string, patch: PresetPatch): Promise<Preset>;
  deletePreset(id: string): Promise<void>;
  setPhoneEnabled(enabled: boolean): Promise<PhoneInfo>;
  connectComposioApp(appId: string): Promise<ComposioLink>;
  disconnectComposioApp(appId: string): Promise<void>;
  refreshComposioConnections(): Promise<number>;
  listComposioTools(): Promise<ComposioTool[]>;
  executeComposioTool(slug: string, args: Record<string, unknown>): Promise<unknown>;
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
  Activity, AppEntry, AppState, Attachment, Bootstrap, Bot, BotPatch, CreateBotInput, Approval,
  CommandResult, ComposioLink, ComposioTool, Connection, CreateGroupInput, EngineInfo, FilePreview, FolderListing, Group, GroupPatch, Message, Model, Option, Provider, Routine,
  APIInfo, MCPServer, MCPServerInput, MCPServerPatch, MemoryForgetResult, MemoryState, MemoryTidyResult, MemoryTopic, PhoneInfo, Preset, PresetInput, PresetPatch, RoutineInput,
  RoutinePatch, Run, SecretStatus, SendResult, Settings, Skill, Thread, Toast, Turn, TeamImportResult,
  Webhook, WebhookInfo, WebhookInput, WebhookPatch,
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
