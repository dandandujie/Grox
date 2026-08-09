/**
 * Process-panel fold policy (Codex-style).
 *
 * While a turn is live, the operator needs the thinking / tool trail open.
 * Once the turn settles, collapse into the one-line "已处理" summary so the
 * final answer stays on screen. Manual expand after completion is allowed;
 * only the live→complete transition force-collapses.
 *
 * Virtuoso recycles row components when they leave the viewport. Local
 * `useState(initialProcessOpen)` alone would re-collapse every remount and
 * thrash scroll (expand → scroll → remount → collapse → jump). Remember the
 * operator's last open/closed choice per turn for the lifetime of this
 * renderer process.
 */

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
