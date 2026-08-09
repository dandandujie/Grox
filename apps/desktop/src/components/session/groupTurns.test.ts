import { describe, expect, it } from "vitest";
import type { SessionBlock } from "../../bridge/types";
import { groupTurns } from "./Timeline";

describe("groupTurns", () => {
  it("插话留在当前回合，不生成新的请求导航项", () => {
    const blocks: SessionBlock[] = [
      { type: "user", id: "p1", text: "主请求", ts: 1 },
      { type: "thinking", id: "t1", text: "处理中", ts: 2 },
      { type: "user", id: "i1", text: "插话", interjected: true, ts: 3 },
      { type: "assistant", id: "a1", text: "完成", ts: 4 },
    ];
    const turns = groupTurns(blocks);
    expect(turns).toHaveLength(1);
    expect(turns[0].blocks.map((block) => block.id)).toEqual(["p1", "t1", "i1", "a1"]);
  });

  it("scales to long sessions (50+ turns) for virtualized timelines", () => {
    // Regression for #20 / #22: 50+ turns feed Virtuoso as data, not full DOM.
    const blocks: SessionBlock[] = [];
    for (let i = 0; i < 60; i += 1) {
      blocks.push({ type: "user", id: `u${i}`, text: `prompt ${i}`, ts: i * 2 });
      blocks.push({
        type: "thinking",
        id: `t${i}`,
        text: "x".repeat(200),
        ts: i * 2 + 1,
      });
      blocks.push({ type: "assistant", id: `a${i}`, text: `answer ${i}`, ts: i * 2 + 2 });
    }
    const turns = groupTurns(blocks);
    expect(turns).toHaveLength(60);
    expect(turns[0]?.id).toBe("u0");
    expect(turns[59]?.blocks).toHaveLength(3);
    expect(turns.every((turn) => turn.blocks[0]?.type === "user")).toBe(true);
  });
});
