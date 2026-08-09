/**
 * Hybrid timeline windowing: native scroller + hard cap on mounted turns.
 * Virtuoso re-ranges on tall expand and yanks scrollTop; a plain full map of
 * every turn reintroduces unbounded DOM. This keeps a finite mounted set while
 * scroll remains a normal overflow container.
 */

export const TIMELINE_TURN_WINDOW_INITIAL = 40;
export const TIMELINE_TURN_WINDOW_STEP = 30;

export function visibleTurnSlice<T>(turns: readonly T[], visibleCount: number): {
  hiddenCount: number;
  visibleTurns: T[];
} {
  const cap = Math.max(1, visibleCount);
  const hiddenCount = Math.max(0, turns.length - cap);
  return {
    hiddenCount,
    visibleTurns: hiddenCount > 0 ? turns.slice(hiddenCount) : [...turns],
  };
}

/** Expand the window so `index` (absolute turn index) is included from the end. */
export function visibleCountToIncludeIndex(
  totalTurns: number,
  absoluteIndex: number,
  currentVisible: number,
): number {
  if (absoluteIndex < 0 || absoluteIndex >= totalTurns) return currentVisible;
  const fromEnd = totalTurns - absoluteIndex;
  return Math.max(currentVisible, fromEnd);
}
