import type { SessionStatus } from "../bridge/types";

export type TurnKind = "idle" | "running" | "gated";

export function classifyTurnStatus(status: SessionStatus): TurnKind {
  if (status === "idle" || status === "failed") return "idle";
  if (status === "awaiting_permission" || status === "awaiting_input") return "gated";
  return "running";
}

export function shouldDrainLocalQueue(input: {
  status: SessionStatus;
  providerSwitching: boolean;
  restoring: boolean;
  suppressed: boolean;
  queueLength: number;
}): boolean {
  return classifyTurnStatus(input.status) === "idle"
    && !input.providerSwitching
    && !input.restoring
    && !input.suppressed
    && input.queueLength > 0;
}
