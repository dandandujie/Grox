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
});
