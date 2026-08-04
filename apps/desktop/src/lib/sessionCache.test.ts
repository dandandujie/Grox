import { describe, expect, it } from "vitest";
import type { Session } from "../bridge/types";
import { compactSession } from "./sessionCache";

const session = (blocks: Session["blocks"]): Session => ({
  id: "session-1",
  title: "cache",
  cwd: "/tmp/project",
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
  status: "running",
  blocks,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, contextUsed: 0, contextMax: 0, turns: 0 },
});

describe("compactSession", () => {
  it("缓存不会恢复为运行中，也不会保存流式状态", () => {
    const result = compactSession(session([{ type: "assistant", id: "a", text: "hello", ts: 1, streaming: true }]));
    expect(result.status).toBe("idle");
    expect(result.preview).toBe(true);
    expect(result.blocks[0]).toMatchObject({ type: "assistant", streaming: false });
  });

  it("只保留最后 160 个块", () => {
    const blocks = Array.from({ length: 170 }, (_, index) => ({ type: "user" as const, id: String(index), text: String(index), ts: index }));
    const result = compactSession(session(blocks));
    expect(result.blocks).toHaveLength(160);
    expect(result.blocks[0].id).toBe("10");
  });
});
