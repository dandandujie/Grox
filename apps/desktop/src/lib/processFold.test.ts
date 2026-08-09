import { afterEach, describe, expect, it } from "vitest";
import {
  clearProcessOpenMemory,
  initialProcessOpen,
  nextProcessOpenOnCompleteChange,
  readProcessOpen,
  rememberProcessOpen,
  resolveInitialProcessOpen,
} from "./processFold";

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
