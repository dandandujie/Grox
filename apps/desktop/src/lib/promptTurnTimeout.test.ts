import { describe, expect, it } from "vitest";
import { FIRST_EVENT_STALL_MS, POST_BIND_FIRST_EVENT_MS } from "./firstEventWatch";
import {
  PROMPT_STALL_MS,
  PROMPT_TURN_ABSOLUTE_MS,
  PROMPT_TURN_IDLE_MS,
  isLiveTurnProgressUpdate,
  isOpenToolStatus,
  isPromptTurnTimeoutMessage,
  promptTurnTimeoutMessage,
  shouldExpirePromptTurn,
  shouldFirePromptStallWatchdog,
} from "./promptTurnTimeout";

const writtenAt = 1_000_000;

describe("shouldExpirePromptTurn", () => {
  it("does not kill a healthy long turn under 15 minutes (regression)", () => {
    // Old bug: fixed 15 * 60_000 from write. 16 min with continuous activity
    // and open tools must stay alive.
    const now = writtenAt + 16 * 60_000;
    expect(
      shouldExpirePromptTurn({
        now,
        writtenAt,
        lastActivityAt: now - 5_000,
        hasOpenTools: true,
      }),
    ).toBe("ok");
  });

  it("16m silent open-tool turn stays ok (exact 900s regression shape)", () => {
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + 16 * 60_000,
        writtenAt,
        lastActivityAt: writtenAt + 1_000,
        hasOpenTools: true,
      }),
    ).toBe("ok");
  });

  it("allows multi-hour workspace cargo test while tools are open", () => {
    const now = writtenAt + 2 * 60 * 60_000;
    expect(
      shouldExpirePromptTurn({
        now,
        writtenAt,
        lastActivityAt: writtenAt + 1_000,
        hasOpenTools: true,
      }),
    ).toBe("ok");
  });

  it("first-event stall when nothing arrives", () => {
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + 26_000,
        writtenAt,
        lastActivityAt: 0,
        hasOpenTools: false,
      }),
    ).toBe("first_event");
  });

  it("default firstEventMs tracks FIRST_EVENT_STALL_MS SSOT", () => {
    expect(FIRST_EVENT_STALL_MS).toBe(25_000);
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + FIRST_EVENT_STALL_MS,
        writtenAt,
        lastActivityAt: 0,
        hasOpenTools: false,
      }),
    ).toBe("first_event");
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + FIRST_EVENT_STALL_MS - 1,
        writtenAt,
        lastActivityAt: 0,
        hasOpenTools: false,
      }),
    ).toBe("ok");
  });

  it("custom firstEventMs extends post-bind budget (R3)", () => {
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + 26_000,
        writtenAt,
        lastActivityAt: 0,
        hasOpenTools: false,
        firstEventMs: POST_BIND_FIRST_EVENT_MS,
      }),
    ).toBe("ok");
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + POST_BIND_FIRST_EVENT_MS - 1,
        writtenAt,
        lastActivityAt: 0,
        hasOpenTools: false,
        firstEventMs: POST_BIND_FIRST_EVENT_MS,
      }),
    ).toBe("ok");
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + POST_BIND_FIRST_EVENT_MS,
        writtenAt,
        lastActivityAt: 0,
        hasOpenTools: false,
        firstEventMs: POST_BIND_FIRST_EVENT_MS,
      }),
    ).toBe("first_event");
  });

  it("stale pre-write activity does not count as first event", () => {
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + FIRST_EVENT_STALL_MS,
        writtenAt,
        lastActivityAt: writtenAt - 1,
        hasOpenTools: false,
      }),
    ).toBe("first_event");
  });

  it("idle after long silence with no open tools", () => {
    const last = writtenAt + 60_000;
    expect(
      shouldExpirePromptTurn({
        now: last + PROMPT_TURN_IDLE_MS + 1,
        writtenAt,
        lastActivityAt: last,
        hasOpenTools: false,
      }),
    ).toBe("idle");
  });

  it("open tools suppress idle even after long silence", () => {
    const last = writtenAt + 60_000;
    expect(
      shouldExpirePromptTurn({
        now: last + PROMPT_TURN_IDLE_MS + 1,
        writtenAt,
        lastActivityAt: last,
        hasOpenTools: true,
      }),
    ).toBe("ok");
  });

  it("open operator gates suppress idle (question/plan)", () => {
    const last = writtenAt + 60_000;
    expect(
      shouldExpirePromptTurn({
        now: last + PROMPT_TURN_IDLE_MS + 1,
        writtenAt,
        lastActivityAt: last,
        hasOpenTools: false,
        hasOpenGate: true,
      }),
    ).toBe("ok");
  });

  it("absolute ceiling always wins", () => {
    expect(
      shouldExpirePromptTurn({
        now: writtenAt + PROMPT_TURN_ABSOLUTE_MS + 1,
        writtenAt,
        lastActivityAt: writtenAt + PROMPT_TURN_ABSOLUTE_MS,
        hasOpenTools: true,
        hasOpenGate: true,
      }),
    ).toBe("absolute");
  });

  it("messages are operator-facing Chinese and derive first-event seconds", () => {
    expect(promptTurnTimeoutMessage("first_event")).toMatch(/自动终止/);
    expect(promptTurnTimeoutMessage("first_event")).toMatch(
      new RegExp(`${Math.round(FIRST_EVENT_STALL_MS / 1000)}s`),
    );
    expect(
      promptTurnTimeoutMessage("first_event", { firstEventMs: POST_BIND_FIRST_EVENT_MS }),
    ).toMatch(new RegExp(`${Math.round(POST_BIND_FIRST_EVENT_MS / 1000)}s`));
    expect(promptTurnTimeoutMessage("idle")).toMatch(/无新输出/);
    expect(promptTurnTimeoutMessage("absolute")).toMatch(/小时上限/);
  });

  it("timeout messages match store queueNotice / turnErrors surface (R2 P0)", () => {
    for (const reason of ["first_event", "idle", "absolute"] as const) {
      expect(isPromptTurnTimeoutMessage(promptTurnTimeoutMessage(reason))).toBe(true);
    }
    expect(
      isPromptTurnTimeoutMessage(
        promptTurnTimeoutMessage("first_event", { firstEventMs: POST_BIND_FIRST_EVENT_MS }),
      ),
    ).toBe(true);
    expect(isPromptTurnTimeoutMessage("回合已取消")).toBe(false);
    expect(isPromptTurnTimeoutMessage("队列提交已取消")).toBe(false);
  });
});

describe("isOpenToolStatus", () => {
  it("treats pending/running/awaiting_permission as open", () => {
    expect(isOpenToolStatus("pending")).toBe(true);
    expect(isOpenToolStatus("running")).toBe(true);
    expect(isOpenToolStatus("awaiting_permission")).toBe(true);
  });

  it("treats terminal statuses as closed", () => {
    expect(isOpenToolStatus("done")).toBe(false);
    expect(isOpenToolStatus("error")).toBe(false);
    expect(isOpenToolStatus("cancelled")).toBe(false);
  });
});

describe("isLiveTurnProgressUpdate", () => {
  it("counts thought/tool/assistant/plan as progress", () => {
    expect(isLiveTurnProgressUpdate("agent_message_chunk")).toBe(true);
    expect(isLiveTurnProgressUpdate("agent_thought_chunk")).toBe(true);
    expect(isLiveTurnProgressUpdate("tool_call")).toBe(true);
    expect(isLiveTurnProgressUpdate("tool_call_update")).toBe(true);
    expect(isLiveTurnProgressUpdate("plan")).toBe(true);
  });

  it("excludes user echo and mode-only updates (R2 first-event purity)", () => {
    expect(isLiveTurnProgressUpdate("user_message_chunk")).toBe(false);
    expect(isLiveTurnProgressUpdate("current_mode_update")).toBe(false);
    expect(isLiveTurnProgressUpdate(undefined)).toBe(false);
  });
});

describe("shouldFirePromptStallWatchdog", () => {
  it("kills a 5-minute silent turn with no open tools (dead socket)", () => {
    expect(
      shouldFirePromptStallWatchdog({
        silentForMs: PROMPT_STALL_MS + 1,
        elapsedMs: PROMPT_STALL_MS + 1,
        hasOpenTools: false,
      }),
    ).toBe("stall");
  });

  it("does not kill just under the stall budget", () => {
    expect(
      shouldFirePromptStallWatchdog({
        silentForMs: PROMPT_STALL_MS,
        elapsedMs: PROMPT_STALL_MS,
        hasOpenTools: false,
      }),
    ).toBe("ok");
  });

  it("keeps a 20–40 minute sealed LRC alive while the tool is still running", () => {
    // Screenshot 2026-08-13: tool card "执行中", agent waiting on LRC,
    // Grox stall-cancelled the turn and painted 上游服务可能无返回.
    expect(
      shouldFirePromptStallWatchdog({
        silentForMs: 20 * 60_000,
        elapsedMs: 25 * 60_000,
        hasOpenTools: true,
      }),
    ).toBe("ok");
    expect(
      shouldFirePromptStallWatchdog({
        silentForMs: 40 * 60_000,
        elapsedMs: 45 * 60_000,
        hasOpenTools: true,
      }),
    ).toBe("ok");
  });

  it("open operator gates suppress stall the same way open tools do", () => {
    expect(
      shouldFirePromptStallWatchdog({
        silentForMs: PROMPT_STALL_MS + 1,
        elapsedMs: PROMPT_STALL_MS + 1,
        hasOpenTools: false,
        hasOpenGate: true,
      }),
    ).toBe("ok");
  });

  it("absolute ceiling still kills a zombie open tool", () => {
    expect(
      shouldFirePromptStallWatchdog({
        silentForMs: PROMPT_TURN_ABSOLUTE_MS + 1,
        elapsedMs: PROMPT_TURN_ABSOLUTE_MS + 1,
        hasOpenTools: true,
        hasOpenGate: true,
      }),
    ).toBe("absolute");
  });
});
