/* ─────────────────────────────────────────────────────────────────────────
   Thinking block — Grok's reasoning, folded by default.
   Live and done: one quiet preview line, expandable on demand.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from "react";
import type { SessionBlock } from "../../bridge/types";
import { fmtDuration } from "../../lib/format";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";
import { useI18n } from "../../lib/i18n";

type ThinkingBlock = Extract<SessionBlock, { type: "thinking" }>;

export function ThinkingBlock({ block }: { block: ThinkingBlock; processing?: boolean }) {
  const { language } = useI18n();
  const [open, setOpen] = useState(false);
  const live = block.live ?? false;
  const targetLength = useRef(block.text.length);
  const [visibleLength, setVisibleLength] = useState(live ? 0 : block.text.length);

  useEffect(() => {
    targetLength.current = block.text.length;
    if (!live || document.documentElement.dataset.reduceMotion === "1") {
      setVisibleLength(block.text.length);
    }
  }, [block.text.length, live]);

  useEffect(() => {
    if (!live || document.documentElement.dataset.reduceMotion === "1") return;
    let timer = 0;
    const tick = () => {
      setVisibleLength((current) => {
        const remaining = targetLength.current - current;
        if (remaining <= 0) return current;
        return current + Math.min(32, Math.max(1, Math.ceil(remaining / 24)));
      });
      timer = window.setTimeout(tick, 28);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [live]);

  const visibleText = live ? block.text.slice(0, visibleLength) : block.text;
  const preview = visibleText.replace(/\s+/g, " ").trim();

  return (
    <div className="process-thinking mb-3 animate-fade-up">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-7 w-full items-center gap-2 text-left"
      >
        <span className={`process-node ${live ? "is-live" : "is-done"}`} aria-hidden="true" />
        <BlackHole size={13} spin={live} />
        <span className={`shrink-0 text-[10.5px] font-medium ${live ? "text-fg2" : "text-dim"}`}>
          {live
            ? language === "zh-CN" ? "思考中" : "THINKING"
            : `${language === "zh-CN" ? "思考" : "THOUGHT"}${block.elapsedMs ? ` · ${fmtDuration(block.elapsedMs).toUpperCase()}` : ""}`}
        </span>
        {live && <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc" />}
        {!open && preview && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-faint" title={preview}>
            {preview}
            {live && <span className="ml-1 inline-block h-2.5 w-[5px] animate-blink bg-acc-dim align-[-1px]" />}
          </span>
        )}
        {(open || !preview) && <span className="flex-1" />}
        <Icon
          name="chevronRight"
          size={11}
          className={`text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && visibleText && (
        <div className="ml-[6px] mt-1 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words border-l border-line2 pb-1 pl-6 text-[12.5px] leading-[1.72] text-mute select-text">
          {visibleText}
          {live && <span className="ml-0.5 inline-block h-3 w-[6px] animate-blink bg-acc-dim align-[-1px]" />}
        </div>
      )}
    </div>
  );
}
