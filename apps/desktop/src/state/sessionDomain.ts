import type { SessionBlock, ToolCall } from "../bridge/types";

export const patchBlock = (blocks: SessionBlock[], blockId: string, patch: Partial<SessionBlock>) =>
  blocks.map((block) => block.id === blockId ? ({ ...block, ...patch } as SessionBlock) : block);

export const patchTool = (blocks: SessionBlock[], blockId: string, call: Partial<ToolCall>) =>
  blocks.map((block) => block.id === blockId && block.type === "tool" ? { ...block, call: { ...block.call, ...call } as ToolCall } : block);

export function isHiddenWorkflowControlPrompt(block: SessionBlock): boolean {
  if (block.type !== "user") return false;
  const text = block.text.trim();
  return /^A background workflow stopped\. Review the workflow completion reminder, report the result to the user, and take any appropriate next action\.$/i.test(text)
    || /^\/workflow\s+(?:pause|resume|stop)\s+\S+(?:\s|$)/i.test(text);
}

export function blocksBeforePrompt(blocks: SessionBlock[], targetPromptIndex: number): SessionBlock[] {
  let promptIndex = -1;
  return blocks.filter((block) => {
    if (isHiddenWorkflowControlPrompt(block)) return false;
    if (block.type === "user" && !block.interjected) promptIndex += 1;
    return promptIndex < targetPromptIndex;
  });
}
