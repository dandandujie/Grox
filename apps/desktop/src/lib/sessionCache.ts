import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionBlock } from "../bridge/types";

const MAX_CACHED_BLOCKS = 160;
const MAX_BODY_TEXT = 24_000;
const MAX_TOOL_TEXT = 8_000;

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

export function compactSession(session: Session): Session {
  return {
    ...session,
    status: "idle",
    preview: true,
    blocks: session.blocks.slice(-MAX_CACHED_BLOCKS).map(freezeBlock),
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

export function scheduleSaveSessionCache(session: Session): void {
  if (!session.id || session.blocks.length === 0) return;
  const previous = timers.get(session.id);
  if (previous !== undefined) window.clearTimeout(previous);
  timers.set(session.id, window.setTimeout(() => {
    timers.delete(session.id);
    const content = JSON.stringify(compactSession(session));
    void invoke("write_session_cache", { id: session.id, content }).catch(() => {});
  }, 800));
}

export function removeSessionCache(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(id);
  void invoke("delete_session_cache", { id }).catch(() => {});
}
