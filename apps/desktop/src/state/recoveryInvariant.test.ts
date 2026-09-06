import { describe, expect, it } from "vitest";
import { mergeHydratedPromptQueues, type PersistedPromptQueues } from "../lib/promptQueuePersistence";
import { isQueueDrainParked, nextQueueDrainParked } from "../lib/sessionRuntime";

const queued = (id: string) => ({
  id, text: `prompt-${id}`, attachments: [], model: "grok-build", effort: "high" as const,
  mode: "agent" as const, permissionMode: "default" as const, createdAt: 1,
});

describe("recovery invariants", () => {
  it("reinit keeps persisted prompts and remains parked until explicit resume", () => {
    const persisted: PersistedPromptQueues = { sessionA: [queued("disk")] };
    const current: PersistedPromptQueues = { sessionA: [queued("local")] };
    const restored = mergeHydratedPromptQueues(persisted, current);
    expect(restored.sessionA.map((row) => row.id)).toEqual(["disk", "local"]);

    let parked = nextQueueDrainParked({}, "sessionA", true);
    expect(isQueueDrainParked(parked, "sessionA")).toBe(true);
    parked = nextQueueDrainParked(parked, "sessionA", false);
    expect(isQueueDrainParked(parked, "sessionA")).toBe(false);
  });
});
