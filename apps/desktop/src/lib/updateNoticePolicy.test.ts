import { afterEach, describe, expect, it } from "vitest";
import {
  clearSkippedUpdateVersion,
  isSkippedUpdateVersion,
  normalizeReleaseVersion,
  readSkippedUpdateVersion,
  shouldAutoOpenUpdate,
  shouldResetSessionDismiss,
  writeSkippedUpdateVersion,
} from "./updateNoticePolicy";

afterEach(() => {
  clearSkippedUpdateVersion();
});

describe("normalizeReleaseVersion", () => {
  it("strips a leading v and surrounding space", () => {
    expect(normalizeReleaseVersion(" v0.3.1 ")).toBe("0.3.1");
    expect(normalizeReleaseVersion("V0.2.11")).toBe("0.2.11");
    expect(normalizeReleaseVersion("0.3.1")).toBe("0.3.1");
  });
});

describe("isSkippedUpdateVersion", () => {
  it("matches the skipped release regardless of a leading v", () => {
    expect(isSkippedUpdateVersion("0.3.1", "v0.3.1")).toBe(true);
    expect(isSkippedUpdateVersion("v0.3.1", "0.3.1")).toBe(true);
  });

  it("does not skip a newer release", () => {
    expect(isSkippedUpdateVersion("0.3.2", "0.3.1")).toBe(false);
    expect(isSkippedUpdateVersion("0.4.0", "0.3.1")).toBe(false);
  });

  it("treats an empty skip as not skipped", () => {
    expect(isSkippedUpdateVersion("0.3.1", null)).toBe(false);
    expect(isSkippedUpdateVersion("0.3.1", "")).toBe(false);
    expect(isSkippedUpdateVersion("0.3.1", "   ")).toBe(false);
  });
});

describe("shouldAutoOpenUpdate", () => {
  it("opens when a new version is available and nothing was dismissed", () => {
    expect(shouldAutoOpenUpdate({
      updateAvailable: true,
      latestVersion: "0.3.1",
      skippedVersion: null,
      sessionDismissed: false,
    })).toBe(true);
  });

  it("does not reopen after the operator closes the dialog this session", () => {
    expect(shouldAutoOpenUpdate({
      updateAvailable: true,
      latestVersion: "0.3.1",
      skippedVersion: null,
      sessionDismissed: true,
    })).toBe(false);
  });

  it("does not auto-open a version the operator skipped", () => {
    expect(shouldAutoOpenUpdate({
      updateAvailable: true,
      latestVersion: "0.3.1",
      skippedVersion: "0.3.1",
      sessionDismissed: false,
    })).toBe(false);
  });

  it("auto-opens the next release after a previous version was skipped", () => {
    expect(shouldAutoOpenUpdate({
      updateAvailable: true,
      latestVersion: "0.3.2",
      skippedVersion: "0.3.1",
      sessionDismissed: false,
    })).toBe(true);
  });

  it("never auto-opens when no update is available", () => {
    expect(shouldAutoOpenUpdate({
      updateAvailable: false,
      latestVersion: "0.2.11",
      skippedVersion: null,
      sessionDismissed: false,
    })).toBe(false);
  });
});

describe("shouldResetSessionDismiss", () => {
  it("resets only when the latest version changes", () => {
    expect(shouldResetSessionDismiss("0.3.1", "0.3.1")).toBe(false);
    expect(shouldResetSessionDismiss("v0.3.1", "0.3.1")).toBe(false);
    expect(shouldResetSessionDismiss("0.3.1", "0.3.2")).toBe(true);
    expect(shouldResetSessionDismiss(null, "0.3.1")).toBe(false);
  });
});

describe("skipped update persistence", () => {
  it("round-trips a skipped version through localStorage", () => {
    expect(readSkippedUpdateVersion()).toBeNull();
    writeSkippedUpdateVersion("v0.3.1");
    expect(readSkippedUpdateVersion()).toBe("0.3.1");
    clearSkippedUpdateVersion();
    expect(readSkippedUpdateVersion()).toBeNull();
  });
});
