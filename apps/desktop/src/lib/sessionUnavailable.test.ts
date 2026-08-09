import { describe, expect, it } from "vitest";
import type { Session } from "../bridge/types";
import {
  deadSessionCopy,
  extractUnavailableSessionId,
  isDeadSessionView,
  isUnavailableSessionError,
} from "./sessionUnavailable";

const session = (blocks: Session["blocks"]): Session => ({
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
});

describe("sessionUnavailable", () => {
  it("detects Chinese and English missing-session errors", () => {
    expect(isUnavailableSessionError("找不到会话：abc-123")).toBe(true);
    expect(isUnavailableSessionError("Session not found: abc")).toBe(true);
    expect(isUnavailableSessionError("network timeout")).toBe(false);
  });

  it("extracts session id from error text", () => {
    expect(extractUnavailableSessionId("找不到会话：019fdc55-86c3-78b3-92f7-07770206e3cb"))
      .toBe("019fdc55-86c3-78b3-92f7-07770206e3cb");
  });

  it("treats open-fail-only shells as dead views", () => {
    expect(isDeadSessionView(session([{
      type: "system",
      id: "open-fail-s1",
      text: "找不到会话：s1",
      ts: 1,
      kind: "error",
    }]))).toBe(true);
    expect(isDeadSessionView(session([
      { type: "user", id: "u1", text: "hi", ts: 1 },
      {
        type: "system",
        id: "open-fail-s1",
        text: "找不到会话：s1",
        ts: 2,
        kind: "error",
      },
    ]))).toBe(false);
  });

  it("has zh/en copy for the empty dead state", () => {
    expect(deadSessionCopy("zh-CN", "x").remove).toContain("移除");
    expect(deadSessionCopy("en", "x").remove).toMatch(/Remove/i);
  });
});
