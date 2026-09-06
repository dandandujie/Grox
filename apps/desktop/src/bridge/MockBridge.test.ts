import { describe, expect, it } from "vitest";
import { MockBridge } from "./MockBridge";
import type { BridgeEvent, PromptOptions } from "./types";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OPTS: PromptOptions = { model: "grok-build", effort: "high", mode: "agent" };

function collect(bridge: MockBridge): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  bridge.subscribe((event) => events.push(event));
  return events;
}

const joinAppend = (events: BridgeEvent[], kind: "thinking_append" | "assistant_append") =>
  events
    .filter((event): event is Extract<BridgeEvent, { type: typeof kind }> => event.type === kind)
    .map((event) => event.delta)
    .join("");

const settled = async (events: BridgeEvent[]) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const idle = events.some((event) => event.type === "status" && event.status === "idle");
    const failed = events.some((event) => event.type === "error");
    if (idle || failed) return;
    await wait(100);
  }
};

describe("MockBridge 任务回显（PRODUCT_REVIEW P5）", () => {
  it("普通任务回合引用任务文本，不再播放无关演示内容", async () => {
    const bridge = new MockBridge();
    const events = collect(bridge);
    const sessionId = [...(bridge as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0];
    if (!sessionId) throw new Error("种子会话缺失");

    void bridge.prompt(sessionId, "帮我检查测试覆盖率", OPTS);
    await settled(events);

    const thinking = joinAppend(events, "thinking_append");
    const assistant = joinAppend(events, "assistant_append");
    expect(thinking).toContain('Let me work through "帮我检查测试覆盖率"');
    expect(assistant).toContain("帮我检查测试覆盖率");
    expect(assistant + thinking).not.toContain("middleware");
  });

  it("/demo 仍触发完整展示回合", async () => {
    const bridge = new MockBridge();
    const events = collect(bridge);
    const sessions = (bridge as unknown as { sessions: Map<string, { blocks: unknown[] }> }).sessions;
    const sessionId = [...sessions.keys()][0];
    if (!sessionId) throw new Error("种子会话缺失");
    // 展示回合只在「新会话的第一条消息」触发；模拟空会话。
    sessions.get(sessionId)!.blocks = [];
    // 展示回合带权限门；绕过等待（等价 ?auto=1 开发钩子）。
    (bridge as unknown as { autoApprove: boolean }).autoApprove = true;

    void bridge.prompt(sessionId, "/demo", OPTS);
    await settled(events);

    const assistant = joinAppend(events, "assistant_append");
    expect(assistant.toLowerCase()).toContain("middleware");
  }, 40000);
});
