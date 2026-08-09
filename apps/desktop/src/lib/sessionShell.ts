import type { Session, SessionMeta, SessionStatus, Usage } from "../bridge/types";

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  contextUsed: 0,
  contextMax: 0,
  turns: 0,
};

/**
 * Immediate paint shell for openSession when the mission is not yet in memory.
 * Prevents the black "RESTORING MISSION" dead-end when cache/ACP is slow or fails.
 * `preview: true` marks the shell so Timeline can show a loading state until blocks arrive.
 */
export function sessionShellFromMeta(meta: SessionMeta, status: SessionStatus = "idle"): Session {
  return {
    id: meta.id,
    title: meta.title,
    summary: meta.summary,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    model: meta.model,
    lastStatus: meta.lastStatus,
    completionUnread: meta.completionUnread,
    parentId: meta.parentId,
    demo: meta.demo,
    pinned: meta.pinned,
    archived: meta.archived,
    blocks: [],
    usage: EMPTY_USAGE,
    status,
    preview: true,
  };
}

export function isSessionHistoryPending(session: Session | null | undefined): boolean {
  return Boolean(session?.preview && session.blocks.length === 0);
}
