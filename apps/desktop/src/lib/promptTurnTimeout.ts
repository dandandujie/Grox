/**
 * Long-turn session/prompt timeout policy.
 *
 * Evidence (spoofer / pre-push, 2026-08-04): primary `session/prompt` used a
 * fixed 15-minute FE timer. Healthy multi-tool turns (workspace cargo test +
 * edits) hit wall-clock 900s → "Grok Agent 请求超时：session/prompt" → idle
 * with tools stuck "执行中", operator had to send a kick message.
 *
 * Policy:
 * 1) First-event stall (constants in firstEventWatch) — 0 events.
 * 2) After events: idle timeout only when no open tools (silent model hang).
 * 3) Absolute ceiling always (safety for zombies / silent long tools).
 * 4) Open tools suppress idle — long cargo tests emit nothing for a long time.
 */

import { FIRST_EVENT_STALL_MS } from "./firstEventWatch";

/** No session/update while tools are closed → treat as mid-turn model stall. */
export const PROMPT_TURN_IDLE_MS = 45 * 60_000;

/**
 * AcpBridge mid-turn silence watchdog (dead socket / wedged gateway).
 *
 * Distinct from {@link PROMPT_TURN_IDLE_MS}: this is the live runtime
 * detector. Open tools / operator gates MUST suppress it — a sealed LRC or
 * `cargo test` can emit nothing for 20–40+ minutes while still healthy
 * (evidence: Grox 2026-08-13, "执行中" + 5 min stall → false cancel).
 */
export const PROMPT_STALL_MS = 5 * 60_000;

/**
 * Hard wall-clock ceiling from session/prompt write.
 * Long enough for multi-hour agent work; not infinite.
 */
export const PROMPT_TURN_ABSOLUTE_MS = 4 * 60 * 60_000;

/** Poll interval for the FE watchdog. */
export const PROMPT_TURN_POLL_MS = 2_000;

/** Runtime overrides from host_prefs (0.2.19 platform debt). */
let idleMsOverride: number | null = null;
let absoluteMsOverride: number | null = null;

/**
 * Apply host-attested / Settings timeout overrides.
 * Clamped: idle 5–1440 min, absolute 1–24 h.
 */
export function configurePromptTurnTimeouts(opts: {
  idleMinutes?: number | null;
  absoluteHours?: number | null;
}): void {
  if (opts.idleMinutes != null && opts.idleMinutes >= 5 && opts.idleMinutes <= 1440) {
    idleMsOverride = opts.idleMinutes * 60_000;
  } else if (opts.idleMinutes === null) {
    idleMsOverride = null;
  }
  if (opts.absoluteHours != null && opts.absoluteHours >= 1 && opts.absoluteHours <= 24) {
    absoluteMsOverride = opts.absoluteHours * 3_600_000;
  } else if (opts.absoluteHours === null) {
    absoluteMsOverride = null;
  }
}

export function effectivePromptTurnIdleMs(): number {
  return idleMsOverride ?? PROMPT_TURN_IDLE_MS;
}

export function effectivePromptTurnAbsoluteMs(): number {
  return absoluteMsOverride ?? PROMPT_TURN_ABSOLUTE_MS;
}

export type PromptTurnExpireReason = "ok" | "first_event" | "idle" | "absolute";

export function shouldExpirePromptTurn(args: {
  now: number;
  /** Wall clock when session/prompt was written. */
  writtenAt: number;
  /**
   * Last live activity (session/update / gate). `0` or `< writtenAt` means
   * no first event yet.
   */
  lastActivityAt: number;
  /** True while any tool_call is still pending/running/awaiting permission. */
  hasOpenTools: boolean;
  /**
   * True while a permission / plan / question card is waiting on the operator.
   * Must suppress idle the same way open tools do (human is the bottleneck).
   */
  hasOpenGate?: boolean;
  firstEventMs?: number;
  idleMs?: number;
  absoluteMs?: number;
}): PromptTurnExpireReason {
  const firstEventMs = args.firstEventMs ?? FIRST_EVENT_STALL_MS;
  const idleMs = args.idleMs ?? effectivePromptTurnIdleMs();
  const absoluteMs = args.absoluteMs ?? effectivePromptTurnAbsoluteMs();

  if (args.now - args.writtenAt >= absoluteMs) return "absolute";

  const hasFirstEvent = args.lastActivityAt >= args.writtenAt && args.lastActivityAt > 0;
  if (!hasFirstEvent) {
    if (args.now - args.writtenAt >= firstEventMs) return "first_event";
    return "ok";
  }

  // Long silent tools (cargo test) or operator gates: do not idle-kill.
  if (args.hasOpenTools || args.hasOpenGate) return "ok";

  if (args.now - args.lastActivityAt >= idleMs) return "idle";
  return "ok";
}

/** Wire statuses that keep a tool "open" for idle suppress. */
export function isOpenToolStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "awaiting_permission";
}

export type PromptTurnTimeoutMessageOpts = {
  /** Actual first-event budget that fired (warm 25s or post-bind 60s). */
  firstEventMs?: number;
};

/**
 * Operator-facing timeout copy. Must include phrases matched by store
 * queueNotice / Timeline turnErrors (`自动终止|无事件返回|小时上限|无新输出`).
 *
 * Bridge expire must `emit({ type: "error", message })` **before**
 * `invalidatePromptFlights` so gen bump cannot swallow this (R2 P0).
 */
export function promptTurnTimeoutMessage(
  reason: Exclude<PromptTurnExpireReason, "ok">,
  opts?: PromptTurnTimeoutMessageOpts,
): string {
  switch (reason) {
    case "first_event": {
      const ms = opts?.firstEventMs ?? FIRST_EVENT_STALL_MS;
      const seconds = Math.max(1, Math.round(ms / 1000));
      return `Agent 超过 ${seconds}s 无事件返回（常见于大会话绑定后首包较慢或上一轮工具未结束）。已自动终止，可发消息重试。`;
    }
    case "idle":
      return `Agent 超过 ${Math.round(effectivePromptTurnIdleMs() / 60_000)} 分钟无新输出且无运行中工具。已自动终止，可发消息继续。`;
    case "absolute":
      return `本轮已超过 ${Math.round(effectivePromptTurnAbsoluteMs() / 3_600_000)} 小时上限。已自动终止，可发消息继续。`;
  }
}

/** True if a bridge/store error message is a prompt-turn watchdog timeout. */
export function isPromptTurnTimeoutMessage(message: string): boolean {
  return /自动终止|无事件返回|小时上限|无新输出/.test(message);
}

/**
 * session/update kinds that count as live turn progress for the sliding
 * first-event / idle clock. Excludes user_message_chunk echo and pure mode
 * updates so "0 条事件" hangs still hit the first-event stall (R2/R3).
 */
export const LIVE_TURN_PROGRESS_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "turn_completed",
]);

export function isLiveTurnProgressUpdate(sessionUpdate: string | undefined): boolean {
  if (!sessionUpdate) return false;
  return LIVE_TURN_PROGRESS_UPDATES.has(sessionUpdate);
}

export type PromptStallWatchdogReason = "ok" | "stall" | "absolute";

/**
 * Runtime AcpBridge silence watchdog.
 *
 * Keep the 5-minute dead-socket kill when nothing is in flight, but never
 * cancel a turn that still has an open tool or operator gate. Absolute
 * ceiling still wins (zombie tools).
 */
export function shouldFirePromptStallWatchdog(args: {
  silentForMs: number;
  elapsedMs: number;
  hasOpenTools: boolean;
  hasOpenGate?: boolean;
  stallMs?: number;
  absoluteMs?: number;
}): PromptStallWatchdogReason {
  const stallMs = args.stallMs ?? PROMPT_STALL_MS;
  const absoluteMs = args.absoluteMs ?? effectivePromptTurnAbsoluteMs();
  if (args.elapsedMs >= absoluteMs) return "absolute";
  if (args.hasOpenTools || args.hasOpenGate) return "ok";
  if (args.silentForMs > stallMs) return "stall";
  return "ok";
}
