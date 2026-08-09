import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionBlock } from "../bridge/types";
import { isSessionTerminal } from "../bridge/types";

const MAX_CACHED_BLOCKS = 160;
const MAX_BODY_TEXT = 24_000;
const MAX_TOOL_TEXT = 8_000;
/** Live streaming debounce — short enough that a hard crash loses little UI cache. */
const LIVE_SAVE_DEBOUNCE_MS = 250;
/** Completed turns flush immediately (0). */
const TERMINAL_SAVE_DEBOUNCE_MS = 0;

const truncate = (value: string | undefined, limit: number) => {
  if (value == null || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[缓存已截断]`;
};

function freezeBlock(block: SessionBlock): SessionBlock {
  if (block.type === "assistant") return { ...block, streaming: false, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "thinking") return { ...block, live: false, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "user") return { ...block, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "tool") return {
    ...block,
    call: {
      ...block.call,
      status: block.call.status === "running" || block.call.status === "pending" ? "done" : block.call.status,
      input: truncate(block.call.input, MAX_TOOL_TEXT),
      output: truncate(block.call.output, MAX_TOOL_TEXT),
      images: undefined,
      terminal: block.call.terminal ? { ...block.call.terminal, lines: block.call.terminal.lines.slice(-80) } : undefined,
    },
  };
  if (block.type === "system") return { ...block, text: truncate(block.text, MAX_TOOL_TEXT) ?? "" };
  return block;
}

/**
 * Take the last N blocks but never start mid-turn.
 * Evidence: raw slice(-160) can begin on a tool mid-stream and seam badly on reopen.
 */
export function sliceCacheBlocks(
  blocks: readonly SessionBlock[],
  max = MAX_CACHED_BLOCKS,
): SessionBlock[] {
  if (blocks.length <= max) return [...blocks];
  let start = blocks.length - max;
  for (let i = start; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b.type === "user" && !("interjected" in b && b.interjected)) {
      start = i;
      break;
    }
    if (i === 0) start = 0;
  }
  if (blocks.length - start > max * 2) {
    start = blocks.length - max;
  }
  return blocks.slice(start);
}

export function compactSession(session: Session): Session {
  return {
    ...session,
    status: "idle",
    preview: true,
    blocks: sliceCacheBlocks(session.blocks, MAX_CACHED_BLOCKS).map(freezeBlock),
  };
}

export async function loadSessionCache(id: string): Promise<Session | null> {
  try {
    const raw = await invoke<string | null>("read_session_cache", { id });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (parsed.id !== id || !Array.isArray(parsed.blocks)) return null;
    return compactSession(parsed);
  } catch {
    return null;
  }
}

const timers = new Map<string, number>();
/** Latest payload per id waiting for disk (survives debounce cancellation). */
const pendingPayloads = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();

function writePayload(id: string, content: string): Promise<void> {
  pendingPayloads.set(id, content);
  const prior = inFlight.get(id) ?? Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(async () => {
      const latest = pendingPayloads.get(id);
      if (latest === undefined) return;
      // Drop if a newer payload replaced this one while we waited.
      if (latest !== content && pendingPayloads.get(id) !== content) {
        // Still write the absolute latest once.
      }
      const toWrite = pendingPayloads.get(id);
      if (toWrite === undefined) return;
      pendingPayloads.delete(id);
      await invoke("write_session_cache", { id, content: toWrite });
    })
    .catch(() => {
      // Best-effort cache; CLI disk history remains authoritative.
    })
    .finally(() => {
      if (inFlight.get(id) === next) inFlight.delete(id);
    });
  inFlight.set(id, next);
  return next;
}

/**
 * Schedule a durable UI snapshot. Terminal sessions flush immediately so a
 * BSOD right after turn completion still has a cache of the finished transcript.
 */
export function scheduleSaveSessionCache(session: Session): void {
  if (!session.id || session.blocks.length === 0) return;
  if (session.id.startsWith("draft-") || session.id.startsWith("pending-")) return;

  const content = JSON.stringify(compactSession(session));
  const delay = isSessionTerminal(session.status) ? TERMINAL_SAVE_DEBOUNCE_MS : LIVE_SAVE_DEBOUNCE_MS;

  const previous = timers.get(session.id);
  if (previous !== undefined) window.clearTimeout(previous);

  if (delay <= 0) {
    timers.delete(session.id);
    void writePayload(session.id, content);
    return;
  }

  timers.set(session.id, window.setTimeout(() => {
    timers.delete(session.id);
    void writePayload(session.id, content);
  }, delay));
}

/** Force any debounced snapshot for one session to disk now. */
export function flushSessionCache(session: Session): void {
  if (!session.id || session.blocks.length === 0) return;
  if (session.id.startsWith("draft-") || session.id.startsWith("pending-")) return;
  const previous = timers.get(session.id);
  if (previous !== undefined) window.clearTimeout(previous);
  timers.delete(session.id);
  void writePayload(session.id, JSON.stringify(compactSession(session)));
}

/**
 * Flush every pending debounce using the last scheduled payload map and any
 * timers. Call on visibility hidden / pagehide for crash-window shrinkage.
 */
export function flushAllPendingSessionCaches(
  sessions: Record<string, Session>,
): void {
  for (const [id, timer] of [...timers.entries()]) {
    window.clearTimeout(timer);
    timers.delete(id);
    const session = sessions[id];
    if (session && session.blocks.length > 0) {
      void writePayload(id, JSON.stringify(compactSession(session)));
    }
  }
}

export function removeSessionCache(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(id);
  pendingPayloads.delete(id);
  void invoke("delete_session_cache", { id }).catch(() => {});
}

export async function scrubSessionCacheOrphans(): Promise<number> {
  try {
    return await invoke<number>("scrub_session_cache_orphans");
  } catch {
    return 0;
  }
}

// ── Draft composer crash buffer ─────────────────────────────────────────
// Unsent draft text/attachments never reach CLI disk. Persist a local copy so
// BSOD mid-compose or a failed first-send (session/new) can restore after reboot.

const DRAFT_BUFFER_KEY = "grox.draftBuffer.v1";
/** Soft cap for the entire draftBuffer map payload (localStorage quota). */
const DRAFT_BUFFER_MAX_CHARS = 1_500_000;

export type DraftAttachment = {
  id: string;
  kind: "image" | "text" | "binary";
  name: string;
  mime: string;
  size: number;
  text?: string;
  data?: string;
};

export type DraftBuffer = {
  cwd: string;
  text: string;
  /** Full payloads when they fit; otherwise empty after size fallback. */
  attachments?: DraftAttachment[];
  updatedAt: number;
};

export function saveDraftBuffer(
  cwd: string,
  text: string,
  attachments: DraftAttachment[] = [],
): void {
  const trimmed = text.trimEnd();
  if (!trimmed && attachments.length === 0) {
    clearDraftBuffer(cwd);
    return;
  }
  try {
    const all = loadAllDraftBuffers();
    const key = normalizeDraftCwd(cwd);
    const updatedAt = Date.now();
    // Prefer full recovery (text + attachment bodies). If over budget, keep
    // text and strip heavy payloads; if still over, text only.
    const candidates: DraftBuffer[] = [
      { cwd, text: trimmed, attachments, updatedAt },
      {
        cwd,
        text: trimmed,
        attachments: attachments.map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          mime: item.mime,
          size: item.size,
        })),
        updatedAt,
      },
      { cwd, text: trimmed, attachments: [], updatedAt },
    ];
    let chosen = candidates[candidates.length - 1]!;
    for (const candidate of candidates) {
      all[key] = candidate;
      if (JSON.stringify(all).length <= DRAFT_BUFFER_MAX_CHARS) {
        chosen = candidate;
        break;
      }
    }
    all[key] = chosen;
    localStorage.setItem(DRAFT_BUFFER_KEY, JSON.stringify(all));
  } catch {
    // quota / private mode — best-effort text-only retry
    try {
      const all = loadAllDraftBuffers();
      if (trimmed) {
        all[normalizeDraftCwd(cwd)] = { cwd, text: trimmed, attachments: [], updatedAt: Date.now() };
        localStorage.setItem(DRAFT_BUFFER_KEY, JSON.stringify(all));
      }
    } catch {
      // ignore
    }
  }
}

export function loadDraftBuffer(cwd: string): DraftBuffer | null {
  try {
    const entry = loadAllDraftBuffers()[normalizeDraftCwd(cwd)];
    if (!entry || typeof entry.text !== "string") return null;
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    if (!entry.text.trim() && attachments.length === 0) return null;
    // Drop stale buffers older than 7 days.
    if (Date.now() - (entry.updatedAt || 0) > 7 * 24 * 60 * 60 * 1000) {
      clearDraftBuffer(cwd);
      return null;
    }
    return {
      cwd: entry.cwd,
      text: entry.text,
      attachments,
      updatedAt: entry.updatedAt,
    };
  } catch {
    return null;
  }
}

export function clearDraftBuffer(cwd: string): void {
  try {
    const all = loadAllDraftBuffers();
    delete all[normalizeDraftCwd(cwd)];
    localStorage.setItem(DRAFT_BUFFER_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

function normalizeDraftCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function loadAllDraftBuffers(): Record<string, DraftBuffer> {
  try {
    const raw = localStorage.getItem(DRAFT_BUFFER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DraftBuffer>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
