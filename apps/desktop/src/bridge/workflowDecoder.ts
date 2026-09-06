import type { WorkflowRun } from "./types";

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => (
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined
);
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown) => typeof value === "boolean" ? value : undefined;
const array = (value: unknown) => Array.isArray(value) ? value : [];

/** 将 Host/ACP workflow 更新归一化为稳定的产品快照；不触碰运行时状态。 */
export function decodeWorkflowRun(update: Json): WorkflowRun | undefined {
  const runId = string(update.runId) ?? string(update.run_id) ?? string(update.workflowRunId) ?? string(update.workflow_run_id);
  if (!runId) return undefined;
  const phases = array(update.phases).flatMap((entry) => {
    const phase = record(entry);
    const title = string(phase?.title) ?? string(phase?.name);
    if (!phase || !title) return [];
    const rawState = string(phase.state) ?? string(phase.status);
    const state: WorkflowRun["phases"][number]["state"] = rawState === "active" || rawState === "done" ? rawState : "pending";
    return [{ title, state }];
  });
  const agents = array(update.agents).flatMap((entry) => {
    const agent = record(entry);
    const agentId = string(agent?.agentId) ?? string(agent?.agent_id);
    if (!agent || !agentId) return [];
    const tokensUsed = number(agent.tokensUsed) ?? number(agent.tokens_used);
    const durationMs = number(agent.durationMs) ?? number(agent.duration_ms);
    return [{
      agentId,
      label: string(agent.label) ?? agentId,
      ...(string(agent.phase) ? { phase: string(agent.phase) } : {}),
      ...(string(agent.model) ? { model: string(agent.model) } : {}),
      state: string(agent.state) ?? "unknown",
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }];
  });
  const lastEvent = string(update.lastEvent) ?? string(update.last_event);
  const lastEventDetail = string(update.lastEventDetail) ?? string(update.last_event_detail);
  const lastEventTimestamp = string(update.lastEventTimestamp) ?? string(update.last_event_timestamp);
  const rawStatus = string(update.status) ?? "active";
  return {
    runId,
    revision: number(update.revision) ?? 0,
    name: string(update.name) ?? "workflow",
    objective: string(update.objective) ?? "",
    status: rawStatus === "completed" || rawStatus === "succeeded" ? "complete" : rawStatus,
    foreground: bool(update.foreground) ?? false,
    phases,
    currentPhase: string(update.currentPhase) ?? string(update.current_phase),
    agentBudget: number(update.agentBudget) ?? number(update.agent_budget),
    agentsUsed: number(update.agentsUsed) ?? number(update.agents_used) ?? 0,
    agentsReserved: number(update.agentsReserved) ?? number(update.agents_reserved) ?? 0,
    agentsRemaining: number(update.agentsRemaining) ?? number(update.agents_remaining),
    agentUsageIncomplete: bool(update.agentUsageIncomplete) ?? bool(update.agent_usage_incomplete) ?? false,
    elapsedMs: number(update.elapsedMs) ?? number(update.elapsed_ms) ?? 0,
    activeAgents: number(update.activeAgents) ?? number(update.active_agents) ?? 0,
    currentAgentLabel: string(update.currentAgentLabel) ?? string(update.current_agent_label),
    agents,
    ...(lastEvent ? { lastEvent } : {}),
    ...(lastEventDetail ? { lastEventDetail } : {}),
    ...(lastEventTimestamp ? { lastEventTimestamp } : {}),
    events: lastEvent ? [{ event: lastEvent, ...(lastEventDetail ? { detail: lastEventDetail } : {}), ...(lastEventTimestamp ? { timestamp: lastEventTimestamp } : {}) }] : [],
    pauseMessage: string(update.pauseMessage) ?? string(update.pause_message),
    resultSummary: string(update.resultSummary) ?? string(update.result_summary),
  };
}
