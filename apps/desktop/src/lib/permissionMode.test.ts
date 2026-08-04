import { describe, expect, it } from "vitest";
import { readStoredPermissionMode } from "./permissionMode";

describe("readStoredPermissionMode", () => {
  it("新安装默认使用 Auto", () => {
    expect(readStoredPermissionMode(null)).toBe("auto");
  });

  it("保留用户明确选择，并拒绝未知值", () => {
    expect(readStoredPermissionMode("default")).toBe("default");
    expect(readStoredPermissionMode("bypass")).toBe("bypass");
    expect(readStoredPermissionMode("broken")).toBe("auto");
  });
});
