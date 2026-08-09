/**
 * Process-panel fold policy (Codex-style).
 *
 * While a turn is live, the operator needs the thinking / tool trail open.
 * Once the turn settles, collapse into the one-line "已处理" summary so the
 * final answer stays on screen. Manual expand after completion is allowed;
 * only the live→complete transition force-collapses.
 */

export function initialProcessOpen(complete: boolean): boolean {
  return !complete;
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
