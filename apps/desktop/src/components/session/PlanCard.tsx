/* ─────────────────────────────────────────────────────────────────────────
   PlanCard — the flight plan. Gold, checklist, live progress.
   ───────────────────────────────────────────────────────────────────────── */

import type { SessionBlock } from "../../bridge/types";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

type PlanBlock = Extract<SessionBlock, { type: "plan" }>;

export function PlanCard({ block }: { block: PlanBlock }) {
  const { language } = useI18n();
  const done = block.steps.filter((s) => s.status === "completed").length;
  const total = block.steps.length;

  return (
    <div className="mb-4 animate-fade-up pl-0.5">
      <div className="border-l border-gold/50 pl-3">
        <div className="flex items-center gap-2">
          <span className="lbl !text-gold">{language === "zh-CN" ? "计划" : "PLAN"}</span>
          <span className="tnum text-[9.5px] text-faint">
            {done}/{total}
          </span>
          <span className="relative h-[2px] w-16 overflow-hidden rounded-full bg-high">
            <span className="absolute inset-y-0 left-0 bg-gold/70" style={{ width: `${(done / total) * 100}%` }} />
          </span>
        </div>
        <div className="mt-2 space-y-1.5">
          {block.steps.map((s) => (
            <div key={s.id} className="flex items-start gap-2.5">
              <StepIcon status={s.status} />
              <span
                className={`text-[12px] leading-snug ${
                  s.status === "completed"
                    ? "text-dim"
                    : s.status === "in_progress"
                      ? "text-fg"
                      : "text-mute"
                }`}
              >
                {s.content}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: "pending" | "in_progress" | "completed" }) {
  if (status === "completed")
    return <Icon name="check" size={12} className="mt-0.5 shrink-0 text-green" />;
  if (status === "in_progress")
    return <span className="mt-[7px] h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-gold" />;
  return <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full border border-line3" />;
}
