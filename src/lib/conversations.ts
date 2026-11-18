import type { AppState, Thread } from "@/lib/bridge";

export type Conversation = {
  owner: { kind: "bot" | "group"; id: string; name: string };
  thread: Thread;
};

export function conversations(state: AppState): Conversation[] {
  const direct = state.bots.filter((bot) => !bot.hidden && !bot.archived).flatMap((bot) =>
    bot.threads.map((thread): Conversation => ({ owner: { kind: "bot", id: bot.id, name: bot.name }, thread })));
  const channels = state.groups.flatMap((group) =>
    group.threads.map((thread): Conversation => ({ owner: { kind: "group", id: group.id, name: `# ${group.name}` }, thread })));
  return [...direct, ...channels].sort((left, right) => Date.parse(right.thread.updatedAt) - Date.parse(left.thread.updatedAt));
}

export function unfinishedReply(thread: Thread | undefined) {
  const last = thread?.messages?.at(-1);
  return !thread?.busy && last?.role === "bot" && (last.error || last.status === "stopped") ? last : undefined;
}

export function conversationStatus(thread: Thread) {
  const pending = [...(thread.messages ?? [])].reverse().find((message) => message.status === "pending" && (message.kind === "approval" || message.kind === "options"));
  if (pending) return pending.kind === "approval" ? "Approval needed" : "Answer needed";
  if (thread.busy) return "Working";
  const unfinished = unfinishedReply(thread);
  if (unfinished) return unfinished.error ? "Failed" : "Stopped";
  return thread.unread > 0 ? "Unread" : "";
}
