/* ─────────────────────────────────────────────────────────────────────────
   StatusBar — the telemetry strip. Spacecraft instrument readouts for the
   active mission: link state, context burn, token flow, cost, model.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDesktop } from "../../state/store";
import { fmtCost, fmtTokens } from "../../lib/format";
import { BlackHole } from "../fx/BlackHole";
import { useI18n } from "../../lib/i18n";

export function StatusBar() {
  const { language } = useI18n();
  const activeId = useDesktop((s) => s.activeId);
  const session = useDesktop((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const model = useDesktop((s) => s.model);
  const effort = useDesktop((s) => s.effort);
  const workspace = useDesktop((s) => s.workspace);
  const [branch, setBranch] = useState<string | null>(null);

  const status = session?.status ?? "idle";
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
    void invoke<{ branch?: string; isRepository: boolean }>("git_summary", { cwd: workspace })
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
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel px-3 font-mono text-[10.5px] tracking-[0.06em] text-dim select-none">
      <div className="flex items-center gap-2">
        <BlackHole size={13} spin={status === "running"} />
        <span
          className={
            status === "running"
              ? "text-acc"
            : status === "failed"
              ? "text-red"
              : status === "awaiting_permission" || status === "awaiting_input"
                ? "text-gold"
                : "text-mute"
          }
        >
          {language === "zh-CN"
            ? status === "running" ? "处理中" : status === "failed" ? "失败" : status === "awaiting_permission" ? "等待批准" : status === "awaiting_input" ? "等待输入" : "已完成"
            : status === "running" ? "WORKING" : status === "failed" ? "FAILED" : status === "awaiting_permission" ? "AWAITING APPROVAL" : status === "awaiting_input" ? "AWAITING INPUT" : "COMPLETED"}
        </span>
        {branch && (
          <>
            <Sep />
            <span className="tnum text-fg2">{branch}</span>
          </>
        )}
        {activeId && (
          <>
            <Sep />
            <span className="tnum text-faint">SID {activeId.slice(0, 8)}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        {usage && usage.contextUsed > 0 && (
          <>
            <span className="flex items-center gap-1.5">
              <span>CTX</span>
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
            <span className="tnum">{usage.turns} TRN</span>
            <Sep />
          </>
        )}
        <span className="text-fg2">{model.toUpperCase().replace(/-/g, "‑")}</span>
        <Sep />
        <span>{language === "zh-CN" ? "强度" : "EFFORT"} {effort.toUpperCase()}</span>
      </div>
    </footer>
  );
}

const Sep = () => <span className="text-faint">·</span>;
