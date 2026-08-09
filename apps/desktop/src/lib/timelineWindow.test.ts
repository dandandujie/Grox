import { describe, expect, it } from "vitest";
import {
  TIMELINE_TURN_WINDOW_INITIAL,
  visibleCountToIncludeIndex,
  visibleTurnSlice,
} from "./timelineWindow";

describe("visibleTurnSlice", () => {
  it("mounts all turns when under the window", () => {
    const turns = [1, 2, 3];
    expect(visibleTurnSlice(turns, 40)).toEqual({
      hiddenCount: 0,
      visibleTurns: [1, 2, 3],
    });
  });

  it("keeps a hard DOM upper bound for long sessions", () => {
    const turns = Array.from({ length: 80 }, (_, i) => i);
    const { hiddenCount, visibleTurns } = visibleTurnSlice(turns, TIMELINE_TURN_WINDOW_INITIAL);
    expect(hiddenCount).toBe(40);
    expect(visibleTurns).toHaveLength(TIMELINE_TURN_WINDOW_INITIAL);
    expect(visibleTurns[0]).toBe(40);
    expect(visibleTurns.at(-1)).toBe(79);
  });
});

describe("visibleCountToIncludeIndex", () => {
  it("expands the window so a rail jump can mount an older turn", () => {
    expect(visibleCountToIncludeIndex(80, 5, 40)).toBe(75);
    expect(visibleCountToIncludeIndex(80, 70, 40)).toBe(40);
  });
});
