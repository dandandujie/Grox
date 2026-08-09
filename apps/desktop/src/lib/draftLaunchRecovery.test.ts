import { describe, expect, it } from "vitest";
import type { PromptAttachment, Session } from "../bridge/types";
import {
  buildDraftRestoreAfterSessionNewFailure,
  shouldRetainDraftBufferUntilSessionReady,
} from "./draftLaunchRecovery";

const attachment = (name: string): PromptAttachment => ({
  id: `att-${name}`,
  kind: "text",
  name,
  mime: "text/plain",
  size: 4,
  text: "body",
});

const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  contextUsed: 0,
  contextMax: 0,
  turns: 0,
};

const pendingShell = (id: string): Session => ({
  id,
  title: "正在创建任务",
  cwd: "C:/Work/Repo",
  createdAt: 1,
  updatedAt: 1,
  model: "grok-build",
  blocks: [{ type: "user", id: "u1", text: "hello", ts: 1 }],
  usage: emptyUsage,
  status: "idle",
});

describe("shouldRetainDraftBufferUntilSessionReady", () => {
  it("retains only for local draft shells", () => {
    expect(shouldRetainDraftBufferUntilSessionReady("draft-abc")).toBe(true);
    expect(shouldRetainDraftBufferUntilSessionReady("pending-abc")).toBe(false);
    expect(shouldRetainDraftBufferUntilSessionReady("sess-1")).toBe(false);
  });
});

describe("buildDraftRestoreAfterSessionNewFailure", () => {
  it("restores draft text + attachments after session/new rejection", () => {
    const pendingId = "pending-xyz";
    const draftId = "draft-restored";
    const launch = {
      text: "ship the fix",
      attachments: [attachment("notes.txt")],
    };
    const result = buildDraftRestoreAfterSessionNewFailure({
      pendingId,
      draftId,
      workspace: "C:/Work/Repo",
      launch,
      sessions: {
        [pendingId]: pendingShell(pendingId),
        "draft-old": pendingShell("draft-old"),
      },
      sessionComposers: {
        [pendingId]: {
          text: "",
          attachments: [],
          model: "grok-build",
          effort: "high",
          mode: "agent",
          permissionMode: "default",
        },
      },
      controls: {
        model: "grok-build",
        effort: "high",
        mode: "agent",
        permissionMode: "default",
      },
      now: 42,
    });

    expect(result.activeId).toBe(draftId);
    expect(result.view).toBe("session");
    expect(result.sessions[pendingId]).toBeUndefined();
    expect(result.sessions["draft-old"]).toBeUndefined();
    expect(result.sessions[draftId]).toMatchObject({
      id: draftId,
      cwd: "C:/Work/Repo",
      status: "idle",
      blocks: [],
    });
    expect(result.sessionComposers[draftId]).toEqual({
      text: "ship the fix",
      attachments: launch.attachments,
      model: "grok-build",
      effort: "high",
      mode: "agent",
      permissionMode: "default",
    });
    expect(result.draftText).toBe("ship the fix");
    expect(result.draftAttachments).toEqual(launch.attachments);
  });

  it("still rebuilds an empty draft when launch payload was already cleared", () => {
    const result = buildDraftRestoreAfterSessionNewFailure({
      pendingId: "pending-1",
      draftId: "draft-1",
      workspace: "/tmp/ws",
      launch: undefined,
      sessions: { "pending-1": pendingShell("pending-1") },
      sessionComposers: {},
      controls: {
        model: "m",
        effort: "low",
        mode: "agent",
        permissionMode: "default",
      },
      now: 7,
    });
    expect(result.draftText).toBe("");
    expect(result.draftAttachments).toEqual([]);
    expect(result.sessions["draft-1"]?.status).toBe("idle");
  });
});
