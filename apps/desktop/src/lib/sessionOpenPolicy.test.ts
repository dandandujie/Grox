import { describe, expect, it, beforeEach } from "vitest";
import {
  SHELL_VERSION_STORAGE_KEY,
  consumeShellUpgradeRescan,
  sanitizeSessionForOpen,
  shouldCloseDetachedSession,
  shouldForceOfflineRescan,
} from "./sessionOpenPolicy";

describe("consumeShellUpgradeRescan", () => {
  beforeEach(() => {
    localStorage.removeItem(SHELL_VERSION_STORAGE_KEY);
  });

  it("returns true on first pin and stores version", () => {
    expect(consumeShellUpgradeRescan("0.2.13")).toBe(true);
    expect(localStorage.getItem(SHELL_VERSION_STORAGE_KEY)).toBe("0.2.13");
  });

  it("returns false when version unchanged", () => {
    localStorage.setItem(SHELL_VERSION_STORAGE_KEY, "0.2.13");
    expect(consumeShellUpgradeRescan("0.2.13")).toBe(false);
  });

  it("returns true on upgrade 0.2.12 → 0.2.13", () => {
    localStorage.setItem(SHELL_VERSION_STORAGE_KEY, "0.2.12");
    expect(consumeShellUpgradeRescan("0.2.13")).toBe(true);
    expect(localStorage.getItem(SHELL_VERSION_STORAGE_KEY)).toBe("0.2.13");
  });
});

describe("shouldForceOfflineRescan (0.2.30 per-session)", () => {
  it("forces when upgrade active and session not yet force-rescanned", () => {
    expect(
      shouldForceOfflineRescan({
        upgradeRescanActive: true,
        sessionAlreadyForceRescanned: false,
      }),
    ).toBe(true);
  });

  it("does not force the same session twice in one upgrade generation", () => {
    expect(
      shouldForceOfflineRescan({
        upgradeRescanActive: true,
        sessionAlreadyForceRescanned: true,
      }),
    ).toBe(false);
  });

  it("does not force when upgrade generation is inactive", () => {
    expect(
      shouldForceOfflineRescan({
        upgradeRescanActive: false,
        sessionAlreadyForceRescanned: false,
      }),
    ).toBe(false);
  });

  it("multi-open: each session forced once; not process-wide forever (0.2.30)", () => {
    // Mirrors store upgradeForceRescanned + markOfflineHistoryComplete.
    const upgradeActive = true;
    const rescanned = new Set<string>();
    const force = (id: string) =>
      shouldForceOfflineRescan({
        upgradeRescanActive: upgradeActive,
        sessionAlreadyForceRescanned: rescanned.has(id),
      });
    const markDone = (id: string) => {
      if (upgradeActive) rescanned.add(id);
    };

    expect(force("sess-a")).toBe(true);
    markDone("sess-a");
    // A already done; B still needs force; re-open A must not force again.
    expect(force("sess-a")).toBe(false);
    expect(force("sess-b")).toBe(true);
    markDone("sess-b");
    expect(force("sess-b")).toBe(false);
    expect(force("sess-c")).toBe(true);
  });

  it("ignores deprecated alreadyComplete when session not yet force-rescanned", () => {
    // 0.2.29 process-wide used alreadyComplete; 0.2.30 ignores it.
    expect(
      shouldForceOfflineRescan({
        upgradeRescanActive: true,
        sessionAlreadyForceRescanned: false,
        alreadyComplete: true,
      }),
    ).toBe(true);
  });
});

describe("sanitizeSessionForOpen", () => {
  it("always paints idle", () => {
    expect(sanitizeSessionForOpen({ status: "running", blocks: [] }).status).toBe("idle");
  });
});

describe("shouldCloseDetachedSession", () => {
  it("closes an idle attachment when navigating away", () => {
    expect(shouldCloseDetachedSession({ currentId: "sess-a", nextId: "sess-b", status: "idle" })).toBe(true);
  });

  it("keeps running and same-session attachments alive", () => {
    expect(shouldCloseDetachedSession({ currentId: "sess-a", nextId: "sess-b", status: "running" })).toBe(false);
    expect(shouldCloseDetachedSession({ currentId: "sess-a", nextId: "sess-a", status: "idle" })).toBe(false);
  });

  it("does not close local draft or pending shells", () => {
    expect(shouldCloseDetachedSession({ currentId: "draft-abc", nextId: null, status: "idle" })).toBe(false);
    expect(shouldCloseDetachedSession({ currentId: "pending-abc", nextId: null, status: "idle" })).toBe(false);
  });
});
