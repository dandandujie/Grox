import { invoke } from "@tauri-apps/api/core";
import type { AgentMode, Effort, PermissionMode } from "../bridge/types";

export type AutomationFrequency = "once" | "daily" | "weekdays" | "weekly";

export interface Automation {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
  frequency: AutomationFrequency;
  time: string;
  weekday?: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  lastError?: string;
}

export function upsertAutomation(current: readonly Automation[], next: Automation): Automation[] {
  return [...current.filter((item) => item.id !== next.id), next].sort((a, b) => a.nextRunAt - b.nextRunAt);
}

export function removeAutomation(current: readonly Automation[], id: string): Automation[] {
  return current.filter((item) => item.id !== id);
}

export function setAutomationEnabled(current: readonly Automation[], id: string, enabled: boolean): Automation[] {
  return current.map((item) => item.id === id ? { ...item, enabled } : item);
}

export function replaceAutomation(current: readonly Automation[], next: Automation): Automation[] {
  return current.map((item) => item.id === next.id ? next : item);
}

export function patchAutomation(current: readonly Automation[], id: string, patch: Partial<Automation>): Automation[] {
  return current.map((item) => item.id === id ? { ...item, ...patch } : item);
}

let nativeWriteChain = Promise.resolve();
let nativeCommittedAutomations: Automation[] = [];
let nativeDesiredAutomations: Automation[] = [];
let nativePersistenceStarted = false;

function validTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function nextAtTime(after: number, time: string, allowSameDay: boolean): Date {
  const [hour, minute] = time.split(":").map(Number);
  const result = new Date(after);
  result.setSeconds(0, 0);
  result.setHours(hour, minute, 0, 0);
  if (!allowSameDay || result.getTime() <= after) result.setDate(result.getDate() + 1);
  return result;
}

export function nextAutomationRun(
  frequency: AutomationFrequency,
  time: string,
  after = Date.now(),
  weekday?: number,
): number {
  let next = nextAtTime(after, time, true);
  if (frequency === "once" || frequency === "daily") return next.getTime();
  if (frequency === "weekdays") {
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  const target = Number.isInteger(weekday) ? Math.max(0, Math.min(6, weekday!)) : new Date(after).getDay();
  while (next.getDay() !== target) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function parseAutomations(raw: string | null | undefined): Automation[] {
  if (!raw?.trim()) return [];
  let values: unknown;
  try {
    values = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`自动化文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(values)) throw new Error("自动化文件必须是 JSON 数组");
  const parsed = values.filter((value): value is Automation => {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<Automation>;
    return typeof item.id === "string"
      && typeof item.title === "string"
      && typeof item.prompt === "string"
      && typeof item.cwd === "string"
      && typeof item.model === "string"
      && ["low", "medium", "high", "xhigh", "max"].includes(String(item.effort))
      && ["agent", "plan", "ask"].includes(String(item.mode))
      && ["default", "auto", "bypass"].includes(String(item.permissionMode))
      && ["once", "daily", "weekdays", "weekly"].includes(String(item.frequency))
      && validTime(item.time)
      && typeof item.enabled === "boolean"
      && typeof item.nextRunAt === "number";
  });
  if (parsed.length !== values.length) throw new Error("自动化文件包含无效任务");
  return parsed;
}

export async function loadAutomations(): Promise<Automation[]> {
  if (!("__TAURI_INTERNALS__" in window)) {
    try {
      return parseAutomations(localStorage.getItem("grox.automations.v1"));
    } catch {
      return [];
    }
  }
  const persisted = parseAutomations(await invoke<string | null>("read_automations"));
  nativeCommittedAutomations = snapshotAutomations(persisted);
  nativeDesiredAutomations = nativePersistenceStarted
    ? mergeAutomationSnapshots(persisted, nativeDesiredAutomations)
    : snapshotAutomations(persisted);
  return snapshotAutomations(nativeDesiredAutomations);
}

export interface AutomationPatch {
  upserts: Automation[];
  deletes: string[];
}

export function diffAutomations(
  previous: readonly Automation[],
  next: readonly Automation[],
): AutomationPatch {
  const before = new Map(previous.map((automation) => [automation.id, automation]));
  const after = new Map(next.map((automation) => [automation.id, automation]));
  const upserts = next.filter((automation) => (
    JSON.stringify(before.get(automation.id)) !== JSON.stringify(automation)
  ));
  const deletes = [...before.keys()].filter((id) => !after.has(id)).sort();
  return { upserts, deletes };
}

function mergeAutomationSnapshots(
  persisted: readonly Automation[],
  current: readonly Automation[],
): Automation[] {
  const currentById = new Map(current.map((automation) => [automation.id, automation]));
  const merged = persisted.map((automation) => currentById.get(automation.id) ?? automation);
  const persistedIds = new Set(persisted.map((automation) => automation.id));
  merged.push(...current.filter((automation) => !persistedIds.has(automation.id)));
  return snapshotAutomations(merged);
}

function snapshotAutomations(automations: readonly Automation[]): Automation[] {
  return automations.map((automation) => ({ ...automation }));
}

export async function persistAutomations(automations: readonly Automation[]): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) {
    localStorage.setItem("grox.automations.v1", JSON.stringify(automations));
    return;
  }
  nativePersistenceStarted = true;
  nativeDesiredAutomations = snapshotAutomations(automations);
  nativeWriteChain = nativeWriteChain.catch(() => {}).then(async () => {
    const target = snapshotAutomations(nativeDesiredAutomations);
    const patch = diffAutomations(nativeCommittedAutomations, target);
    if (patch.upserts.length === 0 && patch.deletes.length === 0) return;
    await invoke("patch_automations", {
      upserts: patch.upserts,
      deletes: patch.deletes,
    });
    nativeCommittedAutomations = target;
  });
  await nativeWriteChain;
}

/** 接受 Host 结算后的权威单行快照，防止后续 UI patch 写回旧排程。 */
export function adoptNativeAutomation(automation: Automation): Automation[] {
  const replace = (values: readonly Automation[]) => {
    const exists = values.some((item) => item.id === automation.id);
    return exists
      ? values.map((item) => item.id === automation.id ? { ...automation } : { ...item })
      : [...snapshotAutomations(values), { ...automation }];
  };
  nativeCommittedAutomations = replace(nativeCommittedAutomations);
  nativeDesiredAutomations = replace(nativeDesiredAutomations);
  return snapshotAutomations(nativeDesiredAutomations);
}
