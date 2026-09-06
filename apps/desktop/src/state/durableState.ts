import { EFFORTS } from "../bridge/types";
import type { WorkflowRun } from "../bridge/types";
import type { SessionComposerState } from "./storeTypes";

export const SESSION_COMPOSERS_KEY = "grox.sessionComposers.v1";
export const WORKFLOW_RUNS_KEY = "grox.workflowRuns.v1";

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadSessionComposers(): Record<string, SessionComposerState> {
  const stored = loadJson<Record<string, Omit<SessionComposerState, "attachments">>>(SESSION_COMPOSERS_KEY, {});
  return Object.fromEntries(Object.entries(stored).map(([id, state]) => [id, {
    ...state,
    effort: EFFORTS.find((effort) => effort === state.effort) ?? "high",
    attachments: [],
  }]));
}

export function loadWorkflowRuns(): Record<string, WorkflowRun[]> {
  const stored = loadJson<Record<string, WorkflowRun[]>>(WORKFLOW_RUNS_KEY, {});
  return Object.fromEntries(Object.entries(stored).map(([sessionId, runs]) => [sessionId, (Array.isArray(runs) ? runs : []).map((run) => ({
    ...run,
    phases: Array.isArray(run.phases) ? run.phases : [],
    agents: Array.isArray(run.agents) ? run.agents : [],
    events: Array.isArray(run.events) ? run.events : [],
    agentTraces: Array.isArray(run.agentTraces)
      ? run.agentTraces.map((trace) => ({ ...trace, entries: Array.isArray(trace.entries) ? trace.entries : [] }))
      : [],
  }))]));
}
