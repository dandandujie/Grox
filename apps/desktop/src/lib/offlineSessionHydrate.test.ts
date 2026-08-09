import { describe, expect, it } from "vitest";
import type { Session } from "../bridge/types";
import { preferRicherSession } from "./offlineSessionHydrate";

const base = (blocks: Session["blocks"], preview?: boolean): Session => ({
  id: "s1",
  title: "t",
  cwd: "/tmp",
  createdAt: 1,
  updatedAt: 2,
  model: "m",
  blocks,
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
  preview,
});

describe("preferRicherSession", () => {
  it("keeps a fuller live session over a thin preview", () => {
    const live = base([
      { type: "user", id: "u1", text: "a", ts: 1 },
      { type: "assistant", id: "a1", text: "b", ts: 2 },
    ]);
    const preview = base([{ type: "user", id: "u0", text: "x", ts: 1 }], true);
    expect(preferRicherSession(live, preview)).toBe(live);
  });

  it("accepts incoming when current is empty shell", () => {
    const shell = base([], true);
    const incoming = base([{ type: "user", id: "u1", text: "hi", ts: 1 }], true);
    expect(preferRicherSession(shell, incoming).blocks).toHaveLength(1);
  });
});
