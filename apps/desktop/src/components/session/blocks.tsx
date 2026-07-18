/* ─────────────────────────────────────────────────────────────────────────
   Core transcript blocks: operator prompt, agent message, system event.
   ───────────────────────────────────────────────────────────────────────── */

import type { SessionBlock } from "../../bridge/types";
import { fmtClock } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { BlackHole } from "../fx/BlackHole";
import { Icon } from "../fx/Icon";

type UserBlock = Extract<SessionBlock, { type: "user" }>;
type AssistantBlock = Extract<SessionBlock, { type: "assistant" }>;
type SystemBlock = Extract<SessionBlock, { type: "system" }>;

/** Operator prompt — a raised panel, starlight caret, monospace timestamp. */
export function UserMsg({ block }: { block: UserBlock }) {
  return (
    <div className="group mb-5 animate-fade-up">
      <div className="rounded-[6px] border border-line2 bg-raise px-4 py-3">
        <div className="flex items-baseline gap-2.5">
          <span className="select-none text-acc">›</span>
          <p className="flex-1 whitespace-pre-wrap text-[14px] leading-relaxed text-fg select-text">
            {block.text}
          </p>
          <span className="tnum shrink-0 text-[9.5px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
            {fmtClock(block.ts)}
          </span>
        </div>
        {block.attachments && block.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 pl-5">
            {block.attachments.map((attachment) => (
              <span key={attachment.id} className="flex max-w-[220px] items-center gap-1.5 rounded-[4px] border border-line bg-high/70 px-2 py-1 font-mono text-[9px] text-mute">
                <Icon name={attachment.kind === "image" ? "square" : "file"} size={9} className={attachment.kind === "image" ? "text-acc" : "text-dim"} />
                <span className="truncate">{attachment.name}</span>
                <span className="text-faint">{attachment.size < 1024 * 1024 ? `${Math.max(1, Math.round(attachment.size / 1024))}K` : `${(attachment.size / 1024 / 1024).toFixed(1)}M`}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Agent message — the black hole mark and clean prose. */
export function AssistantMsg({ block }: { block: AssistantBlock }) {
  return (
    <div className="mb-5 flex gap-3 animate-fade-up">
      <div className="mt-0.5 shrink-0">
        <BlackHole size={15} spin={block.streaming ?? false} />
      </div>
      <div className="min-w-0 flex-1 text-[14px] leading-relaxed text-fg2">
        <Markdown text={block.text} />
        {block.streaming && <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-blink bg-acc align-[-2px]" />}
      </div>
    </div>
  );
}

/** System event — a centered mono whisper (compact, rewind, errors). */
export function SystemEvent({ block }: { block: SystemBlock }) {
  const tone =
    block.kind === "error" ? "text-red" : block.kind === "compact" || block.kind === "rewind" ? "text-gold" : "text-dim";
  return (
    <div className="my-5 flex items-center gap-3 animate-fade-up">
      <span className="h-px flex-1 bg-line" />
      <span className={`font-mono text-[10px] tracking-[0.14em] uppercase ${tone}`}>{block.text}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
