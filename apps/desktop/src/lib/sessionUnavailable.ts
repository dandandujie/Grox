import type { Session, SessionBlock } from "../bridge/types";

/** ACP / open paths that mean the CLI catalogue no longer has this mission. */
export function isUnavailableSessionError(text: string): boolean {
  const t = text.trim();
  return (
    /找不到会话/.test(t)
    || /session not found/i.test(t)
    || /unknown session/i.test(t)
    || /no such session/i.test(t)
  );
}

export function extractUnavailableSessionId(text: string): string | null {
  const match = text.match(/找不到会话[：:]\s*([^\s，。]+)/)
    ?? text.match(/session not found[：:\s]+([^\s,]+)/i);
  return match?.[1]?.trim() || null;
}

/**
 * Open painted a shell that only carries a "session missing" system error —
 * no recoverable transcript body.
 */
export function isDeadSessionView(session: Session | null | undefined): boolean {
  if (!session || session.blocks.length === 0) return false;
  const substantive = session.blocks.filter((block) => !isOpenFailNoise(block));
  if (substantive.length > 0) return false;
  return session.blocks.some(
    (block) => block.type === "system" && block.kind === "error" && isUnavailableSessionError(block.text),
  );
}

function isOpenFailNoise(block: SessionBlock): boolean {
  return block.type === "system" && block.kind === "error" && (
    isUnavailableSessionError(block.text)
    || block.id.startsWith("open-fail-")
  );
}

export function deadSessionCopy(language: "zh-CN" | "en", sessionId: string): {
  title: string;
  body: string;
  detail: string;
  remove: string;
  home: string;
} {
  if (language === "zh-CN") {
    return {
      title: "此会话已失效",
      body: "当前 Grok CLI 中已找不到对应任务，本机缓存与磁盘历史也没有可恢复的正文。侧栏条目可能是旧目录残留。",
      detail: `会话 ID：${sessionId}`,
      remove: "从侧栏移除",
      home: "返回首页",
    };
  }
  return {
    title: "Session no longer available",
    body: "The active Grok CLI no longer lists this mission, and no local cache or on-disk history could be restored. The sidebar row is likely a stale catalog entry.",
    detail: `Session ID: ${sessionId}`,
    remove: "Remove from sidebar",
    home: "Back to home",
  };
}
