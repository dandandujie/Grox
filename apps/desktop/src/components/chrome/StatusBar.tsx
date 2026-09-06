/* ─────────────────────────────────────────────────────────────────────────
   StatusBar — the telemetry strip. Spacecraft instrument readouts for the
   active mission: link state, context burn, token flow, cost, model.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from "react";
import { useDesktop } from "../../state/store";
import { gitSummary } from "../../lib/hostActions";
import { fmtCost, fmtTokens } from "../../lib/format";
import { BlackHole } from "../fx/BlackHole";
import { useI18n } from "../../lib/i18n";

export function StatusBar() {
  const { language } = useI18n();
  const activeId = useDesktop((s) => s.activeId);
  const session = useDesktop((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const model = useDesktop((s) => s.model);
  const effort = useDesktop((s) => s.effort);
  const runtimeConnection = useDesktop((s) => s.runtimeConnection);
  const workspace = useDesktop((s) => s.workspace);
  const [branch, setBranch] = useState<string | null>(null);

  const status = session?.status ?? "idle";
  const presentation = runtimeConnection === "reconnecting"
    ? { zh: "正在重连", en: "Reconnecting", tone: "text-gold", spin: "slow" as const }
    : runtimeConnection === "offline"
      ? { zh: "运行时离线", en: "Runtime offline", tone: "text-red", spin: false as const }
      : runtimeConnection === "starting"
        ? { zh: "正在连接", en: "Connecting", tone: "text-mute", spin: "slow" as const }
        : status === "connecting"
          ? { zh: "正在恢复", en: "Restoring", tone: "text-mute", spin: "slow" as const }
          : status === "running"
            ? { zh: "处理中", en: "Working", tone: "text-acc", spin: true as const }
            : status === "stopping"
              ? { zh: "正在停止", en: "Stopping", tone: "text-gold", spin: "slow" as const }
              : status === "cancelled"
                ? { zh: "已停止", en: "Stopped", tone: "text-gold", spin: false as const }
              : status === "disconnected"
                ? { zh: "连接已中断", en: "Disconnected", tone: "text-red", spin: false as const }
                : status === "failed"
                  ? { zh: "失败", en: "Failed", tone: "text-red", spin: false as const }
                  : status === "awaiting_permission"
                    ? { zh: "等待批准", en: "Awaiting approval", tone: "text-gold", spin: "slow" as const }
                    : status === "awaiting_input"
                      ? { zh: "等待输入", en: "Awaiting input", tone: "text-gold", spin: "slow" as const }
                      : { zh: "已完成", en: "Completed", tone: "text-mute", spin: false as const };
  const usage = session?.usage;
  const ctxPct =
    usage && usage.contextMax > 0
      ? Math.min(100, Math.round((usage.contextUsed / usage.contextMax) * 100))
      : 0;

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !workspace) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    void gitSummary<{ branch?: string; isRepository: boolean }>(workspace)
      .then((summary) => {
        if (!cancelled) setBranch(summary.isRepository ? (summary.branch ?? "DETACHED") : null);
      })
      .catch(() => {
        if (!cancelled) setBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, activeId, status]);

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-[11px] text-dim select-none">
      <div className="flex items-center gap-2">
        <BlackHole size={13} spin={presentation.spin} />
        <span className={presentation.tone}>
          {language === "zh-CN" ? presentation.zh : presentation.en}
        </span>
        {branch && (
          <>
            <Sep />
            <span className="tnum text-fg2">{branch}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        {usage && usage.contextUsed > 0 && (
          <>
            <span className="flex items-center gap-1.5">
              <span>{language === "zh-CN" ? "上下文" : "Context"}</span>
              <span className="relative h-[3px] w-14 overflow-hidden rounded-full bg-high">
                <span
                  className={`absolute inset-y-0 left-0 ${ctxPct > 80 ? "bg-gold" : "bg-acc"}`}
                  style={{ width: `${ctxPct}%` }}
                />
              </span>
              <span className={`tnum ${ctxPct > 80 ? "text-gold" : "text-fg2"}`}>{ctxPct}%</span>
            </span>
            <Sep />
            <span className="tnum">
              <span className="text-faint">↑</span> {fmtTokens(usage.inputTokens)}
              <span className="text-faint"> ↓</span> {fmtTokens(usage.outputTokens)}
            </span>
            <Sep />
            <span className="tnum text-fg2">{fmtCost(usage.costUSD)}</span>
            <Sep />
            <span className="tnum">{usage.turns} {language === "zh-CN" ? "轮" : "turns"}</span>
            <Sep />
          </>
        )}
        <span className="text-fg2">{model.toUpperCase().replace(/-/g, "‑")}</span>
        <Sep />
        <span>{language === "zh-CN" ? "强度" : "Effort"} {effort.toUpperCase()}</span>
      </div>
    </footer>
  );
}

const Sep = () => <span className="text-faint">·</span>;
