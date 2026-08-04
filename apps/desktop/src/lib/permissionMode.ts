import type { PermissionMode } from "../bridge/types";

/** 新安装默认 Auto；只接受已知的持久化值，避免坏数据静默切到高权限模式。 */
export function readStoredPermissionMode(value: string | null): PermissionMode {
  if (value === "default" || value === "auto" || value === "bypass") return value;
  return "auto";
}
