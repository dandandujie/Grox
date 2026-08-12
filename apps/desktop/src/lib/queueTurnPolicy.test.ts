import { describe, expect, it } from "vitest";
import { classifyTurnStatus, shouldDrainLocalQueue } from "./queueTurnPolicy";

describe("queue turn policy", () => {
  it("权限与提问阶段保持门控，不会提前排空队列", () => {
    expect(classifyTurnStatus("awaiting_permission")).toBe("gated");
    expect(classifyTurnStatus("awaiting_input")).toBe("gated");
  });

  it("仅在会话空闲且通道稳定时排空", () => {
    const base = { status: "idle" as const, providerSwitching: false, restoring: false, suppressed: false, queueLength: 1 };
    expect(shouldDrainLocalQueue(base)).toBe(true);
    expect(shouldDrainLocalQueue({ ...base, status: "running" })).toBe(false);
    expect(shouldDrainLocalQueue({ ...base, providerSwitching: true })).toBe(false);
    expect(shouldDrainLocalQueue({ ...base, suppressed: true })).toBe(false);
    expect(shouldDrainLocalQueue({ ...base, hasLiveProcess: true })).toBe(false);
  });
});
