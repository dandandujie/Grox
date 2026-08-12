import { afterEach, describe, expect, it } from "vitest";
import type { SessionBlock } from "../bridge/types";
import {
  clearProcessOpenMemory,
  initialProcessOpen,
  isProcessFoldComplete,
  nextProcessOpenOnCompleteChange,
  readProcessOpen,
  rememberProcessOpen,
  resolveInitialProcessOpen,
  thinkingIsLive,
  turnHasLiveProcess,
  turnHasLiveText,
} from "./processFold";

const thinking = (live: boolean): SessionBlock => ({
  type: "thinking",
  id: "th",
  text: "working",
  ts: 1,
  live,
});

const assistant = (streaming = false): SessionBlock => ({
  type: "assistant",
  id: "a",
  text: "done",
  ts: 2,
  streaming,
});

const tool = (status: "running" | "done"): SessionBlock => ({
  type: "tool",
  id: "tool",
  ts: 3,
  call: {
    id: "c1",
    kind: "execute",
    title: "run",
    status,
    startedAt: 1,
  },
});

afterEach(() => {
  clearProcessOpenMemory();
});

describe("initialProcessOpen", () => {
  it("starts open only while the turn is live", () => {
    expect(initialProcessOpen(false)).toBe(true);
    expect(initialProcessOpen(true)).toBe(false);
  });
});

describe("nextProcessOpenOnCompleteChange", () => {
  it("keeps process open while live", () => {
    expect(nextProcessOpenOnCompleteChange({
      wasComplete: false,
      complete: false,
      currentOpen: false,
    })).toBe(true);
  });

  it("collapses when a live turn finishes (Codex-style)", () => {
    expect(nextProcessOpenOnCompleteChange({
      wasComplete: false,
      complete: true,
      currentOpen: true,
    })).toBe(false);
  });

  it("preserves manual expand after the turn is already complete", () => {
    expect(nextProcessOpenOnCompleteChange({
      wasComplete: true,
      complete: true,
      currentOpen: true,
    })).toBe(true);
    expect(nextProcessOpenOnCompleteChange({
      wasComplete: true,
      complete: true,
      currentOpen: false,
    })).toBe(false);
  });
});

describe("process open memory (Virtuoso remount safety)", () => {
  it("remembers manual expand across remount-style re-init", () => {
    rememberProcessOpen("s1", "t1", true);
    expect(resolveInitialProcessOpen("s1", "t1", true)).toBe(true);
    expect(readProcessOpen("s1", "t1")).toBe(true);
  });

  it("defaults to Codex policy when nothing remembered", () => {
    expect(resolveInitialProcessOpen("s1", "t-missing", true)).toBe(false);
    expect(resolveInitialProcessOpen("s1", "t-missing", false)).toBe(true);
  });

  it("isolates sessions and turns", () => {
    rememberProcessOpen("s1", "t1", true);
    rememberProcessOpen("s1", "t2", false);
    rememberProcessOpen("s2", "t1", false);
    expect(resolveInitialProcessOpen("s1", "t1", true)).toBe(true);
    expect(resolveInitialProcessOpen("s1", "t2", true)).toBe(false);
    expect(resolveInitialProcessOpen("s2", "t1", true)).toBe(false);
  });

  it("clearProcessOpenMemory drops one session or all", () => {
    rememberProcessOpen("s1", "t1", true);
    rememberProcessOpen("s2", "t1", true);
    clearProcessOpenMemory("s1");
    expect(readProcessOpen("s1", "t1")).toBeUndefined();
    expect(readProcessOpen("s2", "t1")).toBe(true);
    clearProcessOpenMemory();
    expect(readProcessOpen("s2", "t1")).toBeUndefined();
  });
});

describe("turnHasLiveProcess", () => {
  it("treats live thinking as still in process", () => {
    expect(turnHasLiveProcess([thinking(true), assistant()])).toBe(true);
    expect(turnHasLiveProcess([thinking(false), assistant()])).toBe(false);
  });

  it("treats a streaming answer or open tool as still in process", () => {
    expect(turnHasLiveProcess([assistant(true)])).toBe(true);
    expect(turnHasLiveProcess([tool("running"), assistant()])).toBe(true);
    expect(turnHasLiveProcess([tool("done"), assistant()])).toBe(false);
  });
});

describe("turnHasLiveText", () => {
  it("ignores leftover running tools after the answer is done", () => {
    expect(turnHasLiveText([thinking(true), assistant()])).toBe(true);
    expect(turnHasLiveText([assistant(true)])).toBe(true);
    expect(turnHasLiveText([tool("running"), thinking(false), assistant()])).toBe(false);
  });
});

describe("thinkingIsLive", () => {
  it("never looks live inside a completed process trail", () => {
    expect(thinkingIsLive({ live: true }, false)).toBe(false);
    expect(thinkingIsLive({ live: true }, true)).toBe(true);
    expect(thinkingIsLive({ live: false }, true)).toBe(false);
  });
});

describe("isProcessFoldComplete", () => {
  it("folds a finished conversation even if a thinking block kept live=true", () => {
    expect(isProcessFoldComplete({
      active: true,
      sessionTerminal: true,
    })).toBe(true);
  });

  it("stays open while the session is still running", () => {
    expect(isProcessFoldComplete({
      active: true,
      sessionTerminal: false,
    })).toBe(false);
  });

  it("folds a previous turn even if the session is still running", () => {
    expect(isProcessFoldComplete({
      active: false,
      sessionTerminal: false,
    })).toBe(true);
  });
});
