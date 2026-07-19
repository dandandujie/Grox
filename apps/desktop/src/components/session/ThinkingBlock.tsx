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

export function ThinkingBlock({ block, processing = false }: { block: ThinkingBlock; processing?: boolean }) {
  const { language } = useI18n();
  const [open, setOpen] = useState(false);
  const live = block.live ?? false;

  return (
    <div className="process-thinking mb-3 animate-fade-up">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-7 w-full items-center gap-2 text-left"
      >
        <span className={`process-node ${live ? "is-live" : "is-done"}`} aria-hidden="true" />
        <BlackHole size={13} spin={live} />
        <span className={`text-[10.5px] font-medium ${live ? "text-fg2" : "text-dim"}`}>
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
      {(open || live || processing) && block.text && (
        <div className="ml-[6px] mt-1 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words border-l border-line2 pb-1 pl-6 text-[12.5px] leading-[1.72] text-mute select-text">
          {block.text}
          {live && <span className="ml-0.5 inline-block h-3 w-[6px] animate-blink bg-acc-dim align-[-1px]" />}
        </div>
      )}
    </div>
  );
}
