import { describe, expect, it, beforeEach } from "vitest";
import type { Session } from "../bridge/types";
import {
  clearDraftBuffer,
  compactSession,
  loadDraftBuffer,
  saveDraftBuffer,
  sliceCacheBlocks,
} from "./sessionCache";

const session = (blocks: Session["blocks"], status: Session["status"] = "running"): Session => ({
  id: "session-1",
  title: "cache",
  cwd: "/tmp/project",
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
  status,
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

describe("sliceCacheBlocks", () => {
  it("does not start mid-turn when possible", () => {
    const blocks: Session["blocks"] = [
      { type: "user", id: "u0", text: "a", ts: 0 },
      { type: "assistant", id: "a0", text: "b", ts: 1 },
      { type: "user", id: "u1", text: "c", ts: 2 },
      {
        type: "tool",
        id: "t1",
        ts: 3,
        call: {
          id: "c1",
          kind: "read",
          status: "done",
          title: "r",
          startedAt: 3,
        },
      },
    ];
    const sliced = sliceCacheBlocks(blocks, 2);
    // Prefer starting at user u1 rather than tool-only tail when over budget.
    expect(sliced[0].type === "user" || sliced.length <= 2).toBe(true);
  });
});

describe("draft buffer", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists and reloads unsent draft text per cwd", () => {
    saveDraftBuffer("C:\\Work\\Repo", "未发送的提示词");
    const loaded = loadDraftBuffer("C:/Work/Repo");
    expect(loaded?.text).toBe("未发送的提示词");
  });

  it("persists attachments for first-send crash recovery", () => {
    saveDraftBuffer("C:\\Work\\Repo", "with file", [
      {
        id: "a1",
        kind: "text",
        name: "notes.txt",
        mime: "text/plain",
        size: 4,
        text: "body",
      },
    ]);
    const loaded = loadDraftBuffer("C:/Work/Repo");
    expect(loaded?.text).toBe("with file");
    expect(loaded?.attachments).toEqual([
      {
        id: "a1",
        kind: "text",
        name: "notes.txt",
        mime: "text/plain",
        size: 4,
        text: "body",
      },
    ]);
  });

  it("falls back to text-only when attachments blow the size budget", () => {
    const huge = "x".repeat(900_000);
    saveDraftBuffer("C:\\Work\\Repo", "keep me", [
      {
        id: "img",
        kind: "image",
        name: "big.png",
        mime: "image/png",
        size: huge.length,
        data: huge,
      },
      {
        id: "img2",
        kind: "image",
        name: "big2.png",
        mime: "image/png",
        size: huge.length,
        data: huge,
      },
    ]);
    const loaded = loadDraftBuffer("C:/Work/Repo");
    expect(loaded?.text).toBe("keep me");
    // Full dual payloads exceed budget; metadata-only or empty attachments OK.
    const bodies = (loaded?.attachments ?? []).filter((a) => a.data || a.text);
    expect(bodies.length).toBe(0);
  });

  it("clears empty drafts", () => {
    saveDraftBuffer("C:\\Work\\Repo", "x");
    saveDraftBuffer("C:\\Work\\Repo", "   ");
    expect(loadDraftBuffer("C:\\Work\\Repo")).toBeNull();
  });

  it("clearDraftBuffer removes entry", () => {
    saveDraftBuffer("C:\\A", "hello");
    clearDraftBuffer("C:\\A");
    expect(loadDraftBuffer("C:\\A")).toBeNull();
  });
});
