import { formatGroxError } from "../lib/errorModel";
import type { BridgeEvent, Session, SessionBlock } from "./types";

export function applyToSession(session: Session, event: BridgeEvent): Session {
  if ("sessionId" in event && event.sessionId !== session.id) return session;
  const patchBlock = (blockId: string, patch: Partial<SessionBlock>) =>
    session.blocks.map((block) => block.id === blockId ? ({ ...block, ...patch } as SessionBlock) : block);

  switch (event.type) {
    case "auth_state":
    case "model_state":
    case "mode_state":
    case "available_commands":
    case "workflow_update":
    case "workflow_trace_update":
    case "runtime_notice":
    case "runtime_state":
    case "runtime_occupancy":
    case "session_journal_checkpoint":
    case "prompt_queue_changed":
    case "automation_session_started":
    case "automation_session_settled":
    case "automation_runner_tick":
      return session;
    case "session_meta":
      return { ...session, ...event.patch };
    case "block_add":
      return session.blocks.some((block) => block.id === event.block.id) ? session : { ...session, blocks: [...session.blocks, event.block] };
    case "block_patch":
      return { ...session, blocks: patchBlock(event.blockId, event.patch) };
    case "assistant_append":
    case "thinking_append":
      return { ...session, blocks: session.blocks.map((block) => block.id === event.blockId && (block.type === "assistant" || block.type === "thinking") ? { ...block, text: block.text + event.delta } : block) };
    case "user_append":
      return { ...session, blocks: session.blocks.map((block) => block.id === event.blockId && block.type === "user" ? { ...block, text: block.text + event.delta } : block) };
    case "tool_patch":
      return { ...session, blocks: session.blocks.map((block) => block.id === event.blockId && block.type === "tool" ? { ...block, call: { ...block.call, ...event.call } } : block) };
    case "plan_patch":
      return { ...session, blocks: session.blocks.map((block) => block.id === event.blockId && block.type === "plan" ? { ...block, steps: event.steps } : block) };
    case "permission_request":
      return { ...session, status: "awaiting_permission", blocks: [...session.blocks, { type: "permission", id: event.blockId, req: event.req, ts: Date.now() }] };
    case "permission_resolved":
      return { ...session, status: "running", blocks: session.blocks.map((block) => block.id === event.blockId && block.type === "permission" ? { ...block, resolved: event.option } : block) };
    case "question_request":
      return { ...session, status: "awaiting_input", blocks: [...session.blocks, { type: "question", id: event.blockId, req: event.req, ts: Date.now() }] };
    case "question_resolved":
      return { ...session, status: "running", blocks: session.blocks.map((block) => block.id === event.blockId && block.type === "question" ? { ...block, response: event.response } : block) };
    case "status":
      return { ...session, status: event.status };
    case "usage":
      return { ...session, usage: event.usage };
    case "error":
      return { ...session, status: event.error.fatal ? "failed" : session.status, blocks: [...session.blocks, { type: "system", id: crypto.randomUUID(), text: formatGroxError(event.error), ts: Date.now(), kind: "error" }] };
    case "session_ready":
      return event.session;
  }
}
