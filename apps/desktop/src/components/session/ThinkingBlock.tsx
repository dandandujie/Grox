/* ─────────────────────────────────────────────────────────────────────────
   Thinking block — Grok's reasoning, folded by default.
   Live: the orbital spins and the text pours in, dimmed.
   Done: one quiet line — "THOUGHT FOR 6.2S" — expandable on demand.
   ───────────────────────────────────────────────────────────────────────── */

import { useState } from "react";
import type { SessionBlock } from "../../bridge/types";
import { fmtDuration } from "../../lib/format";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";
import { useI18n } from "../../lib/i18n";

type ThinkingBlock = Extract<SessionBlock, { type: "thinking" }>;

export function ThinkingBlock({ block }: { block: ThinkingBlock }) {
  const { language } = useI18n();
  const [open, setOpen] = useState(false);
  const live = block.live ?? false;

  return (
    <div className="mb-5 animate-fade-up">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <BlackHole size={15} spin={live} />
        <span className={`lbl ${live ? "lbl-acc" : ""}`}>
          {live
            ? language === "zh-CN" ? "思考中" : "THINKING"
            : `${language === "zh-CN" ? "思考" : "THOUGHT"}${block.elapsedMs ? ` · ${fmtDuration(block.elapsedMs).toUpperCase()}` : ""}`}
        </span>
        {live && <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc" />}
        <span className="flex-1" />
        <Icon
          name="chevronRight"
          size={11}
          className={`text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </button>
      {(open || live) && block.text && (
        <div className="ml-[22px] mt-2 border-l border-line2 pl-3 text-[12.5px] italic leading-relaxed text-dim select-text">
          {block.text}
          {live && <span className="ml-0.5 inline-block h-3 w-[6px] animate-blink bg-acc-dim align-[-1px]" />}
        </div>
      )}
    </div>
  );
}
