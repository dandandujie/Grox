import { describe, expect, it } from "vitest";
import { decodeWorkflowRun } from "./workflowDecoder";

describe("decodeWorkflowRun", () => {
  it("normalizes snake_case payloads and terminal aliases", () => {
    const result = decodeWorkflowRun({
      workflow_run_id: "run-1",
      status: "succeeded",
      phases: [{ name: "plan", status: "done" }],
      agents: [{ agent_id: "a-1", tokens_used: 12 }],
      last_event: "finished",
    });
    expect(result).toMatchObject({
      runId: "run-1",
      status: "complete",
      phases: [{ title: "plan", state: "done" }],
      agents: [{ agentId: "a-1", tokensUsed: 12 }],
      lastEvent: "finished",
    });
  });

  it("rejects payloads without a stable run id", () => {
    expect(decodeWorkflowRun({ status: "active" })).toBeUndefined();
  });
});
