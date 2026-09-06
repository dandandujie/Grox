import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ACP 协议合同（TS 消费端）。
//
// fixtures/acp/ 下的黄金 HostSessionEvent 由 Rust 侧 session_event_journal.rs
// 的真实解码路径生成（serde camelCase 输出），本文件消费同一份夹具做严格
// 键集白名单校验。任一侧漂移都会变红：
// - Rust serde 字段改名 / 新增投影 kind / null 序列化策略变化 → 黄金形状变化，
//   Rust 合同测试与这里的白名单同时报警；
// - TS 侧 AcpBridge 的 HostSessionEvent interface 与投影分派改名/漏掉 kind →
//   这里失败。
// 有意的协议变更流程：改 Rust 模型 → GROX_PROTOCOL_FIXTURE_REGEN=1 重新生成
// → 同步本文件白名单与 AcpBridge 的消费分支。

const TOP_LEVEL_KEYS = [
  "streamId",
  "sequence",
  "generation",
  "receivedAt",
  "sessionId",
  "method",
  "updateType",
  "projection",
  "journalRecoverable",
  "journalAcknowledged",
] as const;

const PROJECTION_KEYS: Record<string, readonly string[]> = {
  session_update: ["blockOps", "channel", "kind", "sessionId", "update", "updateType"],
  block_lifecycle: ["blockOps", "kind", "phase", "sessionId"],
  notification: ["kind", "method", "params"],
  unsupported_request: ["kind", "method"],
  orphan_response: ["kind"],
  protocol_error: ["code", "kind", "message"],
};

const BLOCK_OP_KEYS = new Set(["action", "blockType", "blockId", "sourceId", "startedAt"]);
const BLOCK_OP_REQUIRED = ["action", "blockType", "blockId"] as const;
const CHANNELS = new Set(["session", "notification"]);
const PHASES = new Set(["turn_started", "turn_finished", "session_reset", "session_removed"]);
const ACTIONS = new Set(["open", "update", "close"]);
const BLOCK_TYPES = new Set(["user", "assistant", "thinking", "tool", "plan"]);

/** TS 消费端的核心 updateType（AcpBridge 的 sessionUpdate 分派主干）。 */
const CORE_UPDATE_TYPES = [
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "current_mode_update",
  "available_commands_update",
  "turn_completed",
] as const;

type Json = Record<string, unknown>;

function fixtureDir(): string {
  return join(process.cwd(), "fixtures", "acp");
}

function loadFixtures(): Array<{ name: string; events: Json[] }> {
  return readdirSync(fixtureDir())
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(fixtureDir(), name), "utf8")) as {
        expected?: Json[];
      };
      if (!Array.isArray(fixture.expected)) throw new Error(`夹具 ${name} 缺少 expected 黄金`);
      return { name, events: fixture.expected };
    });
}

function collectIssues(issues: string[], event: Json, label: string): void {
  for (const key of Object.keys(event)) {
    if (!TOP_LEVEL_KEYS.includes(key as (typeof TOP_LEVEL_KEYS)[number])) {
      issues.push(`${label}: 未知顶层字段 ${key}`);
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in event)) issues.push(`${label}: 缺少顶层字段 ${key}`);
  }
  const projection = event.projection as Json | undefined;
  if (!projection || typeof projection !== "object") {
    issues.push(`${label}: projection 缺失`);
    return;
  }
  const kind = projection.kind as string;
  const allowed = PROJECTION_KEYS[kind];
  if (!allowed) {
    issues.push(`${label}: 未知投影 kind ${kind}；Rust 新增投影必须同步 AcpBridge 分派与本白名单`);
    return;
  }
  const actualKeys = Object.keys(projection).sort();
  const expectedKeys = [...allowed].sort();
  if (actualKeys.join(",") !== expectedKeys.join(",")) {
    issues.push(`${label}: 投影 ${kind} 字段集漂移，实际 [${actualKeys}] 期望 [${expectedKeys}]`);
  }
  if (kind === "session_update") {
    if (!CHANNELS.has(projection.channel as string)) issues.push(`${label}: 未知通道 ${String(projection.channel)}`);
    if (typeof projection.sessionId !== "string" || projection.sessionId === "") {
      issues.push(`${label}: session_update.sessionId 必须是非空字符串`);
    }
    const updateType = projection.updateType;
    if (updateType !== null && typeof updateType !== "string") {
      issues.push(`${label}: updateType 必须是字符串或 null`);
    }
    const update = projection.update;
    if (!update || typeof update !== "object") {
      issues.push(`${label}: update 必须是对象`);
    } else if (typeof updateType === "string" && (update as Json).sessionUpdate !== updateType) {
      issues.push(`${label}: 顶层 updateType 与 update.sessionUpdate 不一致`);
    }
  }
  if (kind === "block_lifecycle") {
    if (!PHASES.has(projection.phase as string)) issues.push(`${label}: 未知生命周期 phase ${String(projection.phase)}`);
    if (typeof projection.sessionId !== "string" || projection.sessionId === "") {
      issues.push(`${label}: block_lifecycle.sessionId 必须是非空字符串`);
    }
  }
  if (kind === "notification" && (typeof projection.method !== "string" || projection.method === "")) {
    issues.push(`${label}: notification.method 必须是非空字符串`);
  }
  if (kind === "protocol_error") {
    if (typeof projection.code !== "string" || projection.code === "") issues.push(`${label}: protocol_error.code 必须是非空字符串`);
    if (typeof projection.message !== "string" || projection.message === "") issues.push(`${label}: protocol_error.message 必须是非空字符串`);
  }
  const blockOps = projection.blockOps;
  if (blockOps !== undefined) {
    if (!Array.isArray(blockOps)) {
      issues.push(`${label}: blockOps 必须是数组`);
    } else {
      for (const op of blockOps as Json[]) {
        for (const key of Object.keys(op)) {
          if (!BLOCK_OP_KEYS.has(key)) issues.push(`${label}: 块操作未知字段 ${key}`);
        }
        for (const key of BLOCK_OP_REQUIRED) {
          if (!(key in op)) issues.push(`${label}: 块操作缺少字段 ${key}`);
        }
        if (!ACTIONS.has(op.action as string)) issues.push(`${label}: 未知块操作 ${String(op.action)}`);
        if (!BLOCK_TYPES.has(op.blockType as string)) issues.push(`${label}: 未知块类型 ${String(op.blockType)}`);
        if (typeof op.blockId !== "string" || op.blockId === "") issues.push(`${label}: blockId 必须是非空字符串`);
      }
    }
  }
  // 顶层身份字段与投影内字段的一致性（TS 两侧都会读取）。
  // 注意：unsupported_request / notification / orphan_response 投影不携带
  // sessionId/updateType 字段，顶层字段此时没有投影内对应物，不做比较。
  if ("updateType" in projection && event.updateType !== projection.updateType) {
    issues.push(`${label}: 顶层 updateType 与投影 updateType 不一致`);
  }
  if ("sessionId" in projection && event.sessionId !== projection.sessionId) {
    issues.push(`${label}: 顶层 sessionId 与投影 sessionId 不一致`);
  }
}

describe("ACP 协议合同（HostSessionEvent ↔ TS 消费端）", () => {
  it("fixtures/acp 黄金事件符合 TS 白名单、枚举域与一致性约束", () => {
    const issues: string[] = [];
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(14);
    for (const fixture of fixtures) {
      fixture.events.forEach((event, index) => collectIssues(issues, event, `${fixture.name}[${index}]`));
    }
    expect(issues).toEqual([]);
  });

  it("夹具覆盖 TS 消费的全部投影 kind", () => {
    const seen = new Set<string>();
    for (const fixture of loadFixtures()) {
      for (const event of fixture.events) {
        seen.add((event.projection as Json).kind as string);
      }
    }
    for (const kind of Object.keys(PROJECTION_KEYS)) {
      expect(seen, `夹具缺少投影 kind ${kind} 的覆盖`).toContain(kind);
    }
  });

  it("夹具覆盖 TS 消费的核心 updateType", () => {
    const seen = new Set<string>();
    for (const fixture of loadFixtures()) {
      for (const event of fixture.events) {
        const updateType = event.updateType;
        if (typeof updateType === "string") seen.add(updateType);
      }
    }
    for (const updateType of CORE_UPDATE_TYPES) {
      expect(seen, `夹具缺少核心 updateType ${updateType} 的覆盖`).toContain(updateType);
    }
  });
});
