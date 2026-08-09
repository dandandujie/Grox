import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../bridge/types";
import { isSessionHistoryPending, sessionShellFromMeta } from "./sessionShell";

const meta: SessionMeta = {
  id: "sess-1",
  title: "Continue Previous Coding Session",
  cwd: "C:/Work/spoof",
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
  lastStatus: "idle",
};

describe("sessionShellFromMeta", () => {
  it("builds a preview shell so open never leaves sessions[id] empty", () => {
    const shell = sessionShellFromMeta(meta);
    expect(shell.id).toBe("sess-1");
    expect(shell.blocks).toEqual([]);
    expect(shell.preview).toBe(true);
    expect(shell.status).toBe("idle");
    expect(isSessionHistoryPending(shell)).toBe(true);
  });

  it("is no longer pending once blocks arrive", () => {
    const shell = sessionShellFromMeta(meta);
    expect(isSessionHistoryPending({
      ...shell,
      preview: true,
      blocks: [{ type: "user", id: "u1", text: "hi", ts: 1 }],
    })).toBe(false);
  });
});
