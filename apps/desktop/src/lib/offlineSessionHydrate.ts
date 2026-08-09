import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionMeta } from "../bridge/types";
import { loadSessionCache } from "./sessionCache";
import { sanitizeSessionForOpen } from "./sessionOpenPolicy";

type SessionDiskPreview = {
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  truncated: boolean;
};

function sessionFromDiskPreview(meta: SessionMeta, preview: SessionDiskPreview): Session {
  return {
    ...meta,
    blocks: preview.messages.map((message, index) => ({
      type: message.role,
      id: `preview-${meta.id}-${index}`,
      text: message.text,
      ts: meta.createdAt + index,
    })),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      contextUsed: 0,
      contextMax: 0,
      turns: 0,
    },
    status: "idle",
    preview: true,
  };
}

/**
 * When ACP catalogue no longer knows a sidebar mission (stale id / other CLI),
 * still try local UI cache + on-disk chat_history.jsonl so open is not empty.
 */
export async function hydrateSessionOffline(id: string, meta: SessionMeta): Promise<Session | null> {
  const cached = await loadSessionCache(id);
  if (cached && cached.blocks.length > 0) {
    return { ...cached, ...sanitizeSessionForOpen(cached) };
  }
  try {
    const preview = await invoke<SessionDiskPreview | null>("preview_session_from_disk", { id });
    if (preview?.messages?.length) {
      return sessionFromDiskPreview(meta, preview);
    }
  } catch {
    // disk missing
  }
  return null;
}

/** Prefer the payload with more transcript body. */
export function preferRicherSession(current: Session | undefined, incoming: Session): Session {
  if (!current) return incoming;
  if (current.blocks.length > incoming.blocks.length && !incoming.preview) return current;
  if (current.blocks.length > incoming.blocks.length && incoming.preview) return current;
  if (!current.preview && incoming.preview && current.blocks.length > 0) return current;
  return incoming;
}
