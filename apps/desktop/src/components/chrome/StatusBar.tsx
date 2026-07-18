/* ─────────────────────────────────────────────────────────────────────────
   StatusBar — the telemetry strip. Spacecraft instrument readouts for the
   active mission: link state, context burn, token flow, cost, model.
   ───────────────────────────────────────────────────────────────────────── */

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

  const status = session?.status ?? "idle";
  const usage = session?.usage;
  const ctxPct =
    usage && usage.contextMax > 0
      ? Math.min(100, Math.round((usage.contextUsed / usage.contextMax) * 100))
      : 0;

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel px-3 font-mono text-[10.5px] tracking-[0.06em] text-dim select-none">
      {/* left — link state */}
      <div className="flex items-center gap-2">
        <BlackHole size={13} spin={status === "running"} />
        <span
          className={
            status === "running"
              ? "text-acc"
              : status === "awaiting_permission"
                ? "text-gold"
                : "text-mute"
          }
        >
          {language === "zh-CN"
            ? status === "running" ? "处理中" : status === "awaiting_permission" ? "等待批准" : status === "awaiting_input" ? "等待输入" : "就绪"
            : status === "running" ? "WORKING" : status === "awaiting_permission" ? "AWAITING APPROVAL" : status === "awaiting_input" ? "AWAITING INPUT" : "READY"}
        </span>
        {activeId && (
          <>
            <Sep />
            <span className="tnum text-faint">SID {activeId.slice(0, 8)}</span>
          </>
        )}
      </div>

      {/* right — instruments */}
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
