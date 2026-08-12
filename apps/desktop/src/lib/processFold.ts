/**
 * Process-panel fold policy (Codex-style).
 *
 * While a turn is live, the operator needs the thinking / tool trail open.
 * Once the turn settles, collapse into the one-line "已处理" summary so the
 * final answer stays on screen. Manual expand after completion is allowed;
 * only the live→complete transition force-collapses.
 *
 * `session/prompt` returning idle is not enough: ACP can still emit thought
 * chunks and tool updates after that (background notifications). Folding on
 * status alone shows "思考中" inside a completed summary while new content
 * is still arriving. Live thinking / streaming answers / open tools keep
 * the trail unfolded.
 *
 * Virtuoso recycles row components when they leave the viewport. Local
 * `useState(initialProcessOpen)` alone would re-collapse every remount and
 * thrash scroll (expand → scroll → remount → collapse → jump). Remember the
 * operator's last open/closed choice per turn for the lifetime of this
 * renderer process.
 */

import type { SessionBlock } from "../bridge/types";
import { isOpenToolStatus } from "./promptTurnTimeout";

const processOpenByTurn = new Map<string, boolean>();

export function processOpenMemoryKey(sessionId: string, turnId: string): string {
  return `${sessionId}\0${turnId}`;
}

export function rememberProcessOpen(sessionId: string, turnId: string, open: boolean): void {
  processOpenByTurn.set(processOpenMemoryKey(sessionId, turnId), open);
}

export function readProcessOpen(sessionId: string, turnId: string): boolean | undefined {
  return processOpenByTurn.get(processOpenMemoryKey(sessionId, turnId));
}

/** Test / session-teardown helper — not needed on the hot path. */
export function clearProcessOpenMemory(sessionId?: string): void {
  if (sessionId === undefined) {
    processOpenByTurn.clear();
    return;
  }
  const prefix = `${sessionId}\0`;
  for (const key of processOpenByTurn.keys()) {
    if (key.startsWith(prefix)) processOpenByTurn.delete(key);
  }
}

export function initialProcessOpen(complete: boolean): boolean {
  return !complete;
}

/**
 * Prefer the operator's remembered choice; otherwise Codex default
 * (open while live, closed once complete).
 */
export function resolveInitialProcessOpen(
  sessionId: string,
  turnId: string,
  complete: boolean,
): boolean {
  const remembered = readProcessOpen(sessionId, turnId);
  if (remembered !== undefined) return remembered;
  return initialProcessOpen(complete);
}

/**
 * Decide the next open state when `complete` flips.
 * - live: force open
 * - just finished: force closed
 * - already complete (no transition): keep current manual state
 */
export function nextProcessOpenOnCompleteChange(args: {
  wasComplete: boolean;
  complete: boolean;
  currentOpen: boolean;
}): boolean {
  if (!args.complete) return true;
  if (!args.wasComplete && args.complete) return false;
  return args.currentOpen;
}

export function blockIsLiveProcess(block: SessionBlock): boolean {
  if (block.type === "thinking") return Boolean(block.live);
  if (block.type === "assistant") return Boolean(block.streaming);
  if (block.type === "tool") return isOpenToolStatus(block.call.status);
  return false;
}

export function turnHasLiveProcess(blocks: readonly SessionBlock[]): boolean {
  return blocks.some(blockIsLiveProcess);
}

/** Thinking / streaming only — leftover running tools must not reopen a finished turn. */
export function turnHasLiveText(blocks: readonly SessionBlock[]): boolean {
  return blocks.some((block) =>
    (block.type === "thinking" && Boolean(block.live))
    || (block.type === "assistant" && Boolean(block.streaming)),
  );
}

/** Completed process trails must never keep the "思考中" spinner. */
export function thinkingIsLive(
  block: Pick<Extract<SessionBlock, { type: "thinking" }>, "live">,
  processing?: boolean,
): boolean {
  if (processing === false) return false;
  return Boolean(block.live);
}

/**
 * Completed conversations always fold, even if a thinking block still has
 * leftover live=true. The last turn stays open only while the session is
 * still running.
 */
export function isProcessFoldComplete(args: {
  active: boolean;
  sessionTerminal: boolean;
}): boolean {
  return !args.active || args.sessionTerminal;
}
