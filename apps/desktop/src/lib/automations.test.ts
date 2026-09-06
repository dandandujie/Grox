import { describe, expect, it } from "vitest";
import {
  diffAutomations,
  removeAutomation,
  nextAutomationRun,
  parseAutomations,
  setAutomationEnabled,
  upsertAutomation,
  patchAutomation,
  replaceAutomation,
  type Automation,
} from "./automations";

const base: Automation = {
  id: "a",
  title: "Daily review",
  prompt: "review",
  cwd: "/tmp/repo",
  model: "grok-build",
  effort: "high",
  mode: "agent",
  permissionMode: "auto",
  frequency: "daily",
  time: "09:30",
  enabled: true,
  nextRunAt: 1,
};

describe("automations", () => {
  it("顶层文件损坏时明确失败，不伪装成没有任务", () => {
    expect(() => parseAutomations("not-json")).toThrow("不是有效 JSON");
    expect(() => parseAutomations("{}")).toThrow("必须是 JSON 数组");
    expect(() => parseAutomations(JSON.stringify([base, { id: "broken" }]))).toThrow("包含无效任务");
  });

  it("工作日不会排到周末", () => {
    const fridayEvening = new Date("2026-08-14T18:00:00+08:00").getTime();
    expect(new Date(nextAutomationRun("weekdays", "09:30", fridayEvening)).getDay()).toBe(1);
  });

  it("按 automation id 生成 patch，不覆盖无关任务", () => {
    expect(diffAutomations(
      [base, { ...base, id: "remove" }],
      [{ ...base, enabled: false }, { ...base, id: "new" }],
    )).toEqual({
      upserts: [{ ...base, enabled: false }, { ...base, id: "new" }],
      deletes: ["remove"],
    });
  });

  it("纯状态操作保持排序并只修改目标任务", () => {
    const other = { ...base, id: "b", nextRunAt: 3 };
    const updated = upsertAutomation([other], { ...base, nextRunAt: 1 });
    expect(updated.map((item) => item.id)).toEqual(["a", "b"]);
    expect(setAutomationEnabled(updated, "b", false).find((item) => item.id === "a")?.enabled).toBe(true);
    expect(removeAutomation(updated, "a").map((item) => item.id)).toEqual(["b"]);
    expect(patchAutomation(updated, "b", { lastError: "failed" })[1].lastError).toBe("failed");
    expect(replaceAutomation(updated, { ...other, title: "new" })[1].title).toBe("new");
  });
});
