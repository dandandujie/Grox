import { describe, expect, it } from "vitest";
import type { SessionBlock } from "../bridge/types";
import {
  sessionAcceptsNewPrimaryPrompt,
  sessionLooksBusy,
  settleLiveProcessBlocks,
  settleLiveTextBlocks,
  shouldArmPostPromptSettle,
  shouldPromotePostPrompt,
} from "./sessionBusy";

const liveThought: SessionBlock = {
  type: "thinking",
  id: "th",
  text: "still going",
  ts: 1,
  live: true,
};

const doneThought: SessionBlock = {
  type: "thinking",
  id: "th",
  text: "done",
  ts: 1,
  live: false,
};

describe("sessionLooksBusy", () => {
  it("stays busy while the session status is running", () => {
    expect(sessionLooksBusy({ status: "running", blocks: [doneThought] })).toBe(true);
  });

  it("does not lock a finished conversation that left thinking.live set", () => {
    expect(sessionLooksBusy({ status: "idle", blocks: [liveThought] })).toBe(false);
    expect(sessionLooksBusy({ status: null, blocks: [liveThought] })).toBe(false);
  });
});

describe("sessionAcceptsNewPrimaryPrompt", () => {
  it("queues while the session is still running", () => {
    expect(sessionAcceptsNewPrimaryPrompt({ status: "running", blocks: [doneThought] })).toBe(false);
  });

  it("allows a new primary on a finished conversation even if a thought stayed live", () => {
    expect(sessionAcceptsNewPrimaryPrompt({ status: "idle", blocks: [liveThought] })).toBe(true);
    expect(sessionAcceptsNewPrimaryPrompt({ status: "failed", blocks: [doneThought] })).toBe(true);
  });
});

describe("shouldPromotePostPrompt", () => {
  it("promotes idle → running when late live text arrives after prompt return", () => {
    expect(shouldPromotePostPrompt({
      status: "idle",
      promptReturned: true,
      hasLiveText: true,
    })).toBe(true);
  });

  it("does not promote leftover tools or a real in-flight prompt", () => {
    expect(shouldPromotePostPrompt({
      status: "idle",
      promptReturned: true,
      hasLiveText: false,
    })).toBe(false);
    expect(shouldPromotePostPrompt({
      status: "idle",
      promptReturned: false,
      hasLiveText: true,
    })).toBe(false);
  });
});

describe("shouldArmPostPromptSettle", () => {
  it("arms while late thinking is still live so leftover 思考中 can settle", () => {
    expect(shouldArmPostPromptSettle({
      status: "running",
      promptReturned: true,
      hasLiveText: true,
    })).toBe(true);
  });

  it("arms a promoted continuation even after live text goes quiet", () => {
    expect(shouldArmPostPromptSettle({
      status: "running",
      promptReturned: true,
      hasLiveText: false,
    })).toBe(true);
  });

  it("does not arm a finished idle session or a real in-flight prompt", () => {
    expect(shouldArmPostPromptSettle({
      status: "idle",
      promptReturned: true,
      hasLiveText: false,
    })).toBe(false);
    expect(shouldArmPostPromptSettle({
      status: "running",
      promptReturned: false,
      hasLiveText: true,
    })).toBe(false);
  });
});

describe("settleLiveProcessBlocks", () => {
  it("closes live thinking, streaming answers, and open tools", () => {
    const settled = settleLiveProcessBlocks([
      liveThought,
      { type: "assistant", id: "a", text: "…", ts: 2, streaming: true },
      {
        type: "tool",
        id: "t",
        ts: 3,
        call: {
          id: "c1",
          kind: "execute",
          title: "run",
          status: "running",
          startedAt: 1,
        },
      },
    ]);
    expect(settled[0]).toMatchObject({ type: "thinking", live: false });
    expect(settled[1]).toMatchObject({ type: "assistant", streaming: false });
    expect(settled[2]).toMatchObject({ type: "tool", call: { status: "cancelled" } });
  });
});

describe("settleLiveTextBlocks", () => {
  it("closes thinking and streaming without cancelling background tools", () => {
    const settled = settleLiveTextBlocks([
      liveThought,
      {
        type: "tool",
        id: "t",
        ts: 3,
        call: {
          id: "c1",
          kind: "execute",
          title: "run",
          status: "running",
          startedAt: 1,
        },
      },
    ]);
    expect(settled[0]).toMatchObject({ type: "thinking", live: false });
    expect(settled[1]).toMatchObject({ type: "tool", call: { status: "running" } });
  });
});
