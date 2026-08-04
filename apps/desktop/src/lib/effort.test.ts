import { describe, expect, it } from "vitest";
import { EFFORTS } from "../bridge/types";

describe("reasoning effort catalogue", () => {
  it("包含 Grok CLI 与新模型使用的 MAX 档位", () => {
    expect(EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
