import { describe, expect, it } from "vitest";
import { formatGroxError, groxFailure, runtimeNoticeFromError, toGroxError } from "./errorModel";

describe("errorModel", () => {
  it("保留已经分类的运行时失败", () => {
    const original = {
      domain: "environment" as const,
      code: "ACP_PROCESS_EXITED",
      message: "Agent 已退出",
      recoverable: true,
      fatal: true,
      holdQueue: true,
      action: "重新发送前检查运行时",
    };
    expect(toGroxError(groxFailure(original), { domain: "protocol", code: "PROMPT" })).toEqual(original);
  });

  it("把 ACP RPC 错误呈现为协议错误", () => {
    const cause = Object.assign(new Error("invalid params"), { name: "AcpRpcError" });
    const error = toGroxError(cause, { domain: "operation", code: "SESSION_LOAD", fatal: true });
    expect(error.domain).toBe("protocol");
    expect(formatGroxError(error)).toContain("协议错误");
  });

  it("未结构化错误只使用调用边界提供的分类", () => {
    const error = toGroxError(new Error("Grok Agent 已退出（代码 1）"), {
      domain: "protocol",
      code: "PROMPT_FAILED",
      fatal: true,
    });
    expect(error.domain).toBe("protocol");
    expect(error.holdQueue).toBe(true);
  });

  it("保留原生 Host 提供的稳定错误代码和恢复动作", () => {
    const error = toGroxError({
      domain: "environment",
      code: "ACP_PROCESS_EXITED",
      message: "Grok Agent 已退出",
      recoverable: true,
      fatal: true,
      holdQueue: true,
      action: "重连后检查最后一轮结果",
    }, { domain: "protocol", code: "SESSION_PROMPT_FAILED" });
    expect(error).toEqual({
      domain: "environment",
      code: "ACP_PROCESS_EXITED",
      message: "Grok Agent 已退出",
      recoverable: true,
      fatal: true,
      holdQueue: true,
      action: "重连后检查最后一轮结果",
    });
  });
});

describe("runtimeNoticeFromError 通知分级", () => {
  const blocking = {
    domain: "environment" as const,
    code: "ACP_PROCESS_EXITED",
    message: "Grok Agent 已退出",
    recoverable: true,
    fatal: false,
    holdQueue: true,
    action: "重连后检查最后一轮结果",
  };

  it("缺省为 error 级：红色横幅承载任务阻断故障", () => {
    const notice = runtimeNoticeFromError(blocking);
    expect(notice.level).toBe("error");
    expect(notice.title).toBe("运行环境错误");
    expect(notice.message).toContain("重连后检查最后一轮结果");
  });

  it("warning 级承载非阻断降级，标题从「错误」转为「提示」", () => {
    const notice = runtimeNoticeFromError({
      ...blocking,
      code: "HOST_PREFS_MIGRATION_FAILED",
      message: "Computer Use 偏好迁移失败，本次启动按默认设置运行",
      holdQueue: false,
    }, "warning");
    expect(notice.level).toBe("warning");
    expect(notice.title).toBe("运行环境提示");
    expect(notice.id).toBe("error-environment-HOST_PREFS_MIGRATION_FAILED");
  });
});
