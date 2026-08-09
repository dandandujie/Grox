import { describe, expect, it } from "vitest";
import { initialProcessOpen, nextProcessOpenOnCompleteChange } from "./processFold";

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
