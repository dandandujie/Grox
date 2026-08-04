import { describe, expect, it } from "vitest";
import type { Session, SessionMeta } from "../bridge/types";
import { normalizeSessionQuery, sessionMatchesLoadedContent } from "./sessionSearch";

const meta: SessionMeta = {
  id: "session-1",
  title: "OAuth 登录修复",
  cwd: "/tmp/project",
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
};

const session: Session = {
  ...meta,
  status: "idle",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, contextUsed: 0, contextMax: 0, turns: 0 },
  blocks: [
    { type: "user", id: "u", text: "检查供应商切换", ts: 1 },
    { type: "assistant", id: "a", text: "已经修复竞态", ts: 2 },
  ],
};

describe("sessionMatchesLoadedContent", () => {
  it("匹配标题、用户请求和助手回复且忽略大小写", () => {
    expect(sessionMatchesLoadedContent(meta, session, normalizeSessionQuery("oauth"))).toBe(true);
    expect(sessionMatchesLoadedContent(meta, session, normalizeSessionQuery("供应商"))).toBe(true);
    expect(sessionMatchesLoadedContent(meta, session, normalizeSessionQuery("竞态"))).toBe(true);
    expect(sessionMatchesLoadedContent(meta, session, normalizeSessionQuery("不存在"))).toBe(false);
  });
});
