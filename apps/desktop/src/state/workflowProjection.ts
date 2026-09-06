import type { WorkflowRun } from "../bridge/types";

export const isWorkflowTerminal = (status: string) =>
  ["complete", "failed", "cancelled", "interrupted"].includes(status);

export function mergeWorkflowRun(previous: WorkflowRun | undefined, incoming: WorkflowRun): WorkflowRun {
  if (!previous) return incoming;
  const events = new Map<string, WorkflowRun["events"][number]>();
  for (const entry of [...previous.events, ...incoming.events]) {
    events.set(`${entry.timestamp ?? ""}\0${entry.event}\0${entry.detail ?? ""}`, entry);
  }
  const traces = incoming.agentTraces
    ? [...new Map([
      ...(previous.agentTraces ?? []).map((trace) => [trace.childSessionId, trace] as const),
      ...incoming.agentTraces.map((trace) => [trace.childSessionId, trace] as const),
    ]).values()]
    : previous.agentTraces;
  return {
    ...previous,
    ...incoming,
    phases: incoming.phases.length > 0 ? incoming.phases : previous.phases,
    agents: incoming.agents.length > 0 ? incoming.agents : previous.agents,
    events: [...events.values()].slice(-64),
    ...(traces ? { agentTraces: traces } : {}),
  };
}
