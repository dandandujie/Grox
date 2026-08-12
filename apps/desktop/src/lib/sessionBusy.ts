/**
 * Operator chrome for a live vs finished turn.
 *
 * A leftover thinking.live after idle is a finished conversation (expand the
 * fold and it still said 思考中). Composer follows session status. Late ACP
 * chunks after prompt return promote status back to running, then settle.
 */

import type { SessionBlock, SessionStatus } from "../bridge/types";
import { isSessionTerminal } from "../bridge/types";
import { isOpenToolStatus } from "./promptTurnTimeout";

/** Quiet gap after the last live block before post-prompt continuation settles. */
export const POST_PROMPT_SETTLE_MS = 1_600;

export function sessionLooksBusy(args: {
  status: SessionStatus | null | undefined;
  blocks?: readonly SessionBlock[];
}): boolean {
  if (!args.status) return false;
  // Idle with a leftover thinking.live is a finished conversation (the
  // screenshot case). Only a non-terminal status keeps Stop / queue chrome.
  return !isSessionTerminal(args.status);
}

/** A new primary prompt is safe once the session itself is terminal. */
export function sessionAcceptsNewPrimaryPrompt(args: {
  status: SessionStatus;
  blocks?: readonly SessionBlock[];
}): boolean {
  return isSessionTerminal(args.status);
}

export function shouldPromotePostPrompt(args: {
  status: SessionStatus;
  promptReturned: boolean;
  hasLiveText: boolean;
}): boolean {
  return args.promptReturned && args.hasLiveText && args.status === "idle";
}

/**
 * Arm a quiet timer after prompt return. The timer must fire even while
 * thinking.live is still true — leftover live after the last chunk would
 * otherwise keep the session running forever.
 */
export function shouldArmPostPromptSettle(args: {
  status: SessionStatus;
  promptReturned: boolean;
  hasLiveText: boolean;
}): boolean {
  if (!args.promptReturned) return false;
  return args.hasLiveText || args.status === "running";
}

/** Clear stale thinking/streaming labels without touching background tools. */
export function settleLiveTextBlocks(blocks: readonly SessionBlock[]): SessionBlock[] {
  return blocks.map((block) => {
    if (block.type === "thinking" && block.live) return { ...block, live: false };
    if (block.type === "assistant" && block.streaming) return { ...block, streaming: false };
    return block;
  });
}

/** Stop a post-prompt continuation in the UI so Send comes back immediately. */
export function settleLiveProcessBlocks(blocks: readonly SessionBlock[]): SessionBlock[] {
  const now = Date.now();
  return settleLiveTextBlocks(blocks).map((block) => {
    if (block.type === "tool" && isOpenToolStatus(block.call.status)) {
      return {
        ...block,
        call: { ...block.call, status: "cancelled", endedAt: block.call.endedAt ?? now },
      };
    }
    return block;
  });
}
