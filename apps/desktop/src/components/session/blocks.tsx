/* ─────────────────────────────────────────────────────────────────────────
   Core transcript blocks: operator prompt, agent message, system event.
   ───────────────────────────────────────────────────────────────────────── */

import { useLayoutEffect, useRef, useState } from "react";
import type { SessionBlock } from "../../bridge/types";
import { fmtClock } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { Markdown } from "../../lib/markdown";
import { useDesktop } from "../../state/store";
import { BlackHole } from "../fx/BlackHole";
import { Icon } from "../fx/Icon";
import { RewindMenu } from "./RewindMenu";

type UserBlock = Extract<SessionBlock, { type: "user" }>;
type AssistantBlock = Extract<SessionBlock, { type: "assistant" }>;
type SystemBlock = Extract<SessionBlock, { type: "system" }>;

/** Operator prompt — compact and visually distinct from the agent transcript. */
export function UserMsg({ block, rewindPromptIndex }: { block: UserBlock; rewindPromptIndex?: number }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (element && !expanded) setOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, [block.text, expanded]);
  return (
    <div className="group mb-3 flex animate-fade-up justify-end">
      <div className="w-fit max-w-[90%] rounded-[8px] rounded-tr-[3px] border border-line2 bg-raise px-3 py-2 shadow-[0_8px_28px_rgba(0,0,0,0.08)]">
        <div className="mb-1 flex items-center gap-2 font-mono text-[9px] tracking-[0.08em] text-faint">
          <span>{zh ? "你" : "YOU"}</span>
          <span className="h-px w-3 bg-line2" />
          <span className="tnum">{fmtClock(block.ts)}</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="mt-[2px] select-none text-acc">›</span>
          <p ref={textRef} className={`user-msg-text min-w-0 flex-1 whitespace-pre-wrap text-fg select-text ${expanded ? "" : "line-clamp-6"}`}>
            {block.text}
          </p>
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
        <div className="mt-2 flex items-center gap-2 pl-5 font-mono text-[9px]"><span className="flex-1" />{rewindPromptIndex !== undefined && <RewindMenu targetPromptIndex={rewindPromptIndex} variant="request" />}{(overflowing || expanded) && <button onClick={() => setExpanded((value) => !value)} className="h-7 px-1.5 text-acc hover:text-fg">{expanded ? (zh ? "收起" : "COLLAPSE") : (zh ? "显示更多" : "SHOW MORE")}</button>}<MessageActions text={block.text} /></div>
      </div>
    </div>
  );
}

/** Agent message — an editorial transcript with a quiet identity rail. */
export function AssistantMsg({ block, process = false }: { block: AssistantBlock; process?: boolean }) {
  if (process) {
    return (
      <div className="process-text mb-2 animate-fade-up">
        <span className="process-node" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <Markdown
            text={block.text}
            streaming={block.streaming ?? false}
            className="process-prose text-mute"
          />
          {block.streaming && <span className="stream-caret" />}
        </div>
      </div>
    );
  }

  return (
    <article className="assistant-message mb-4 animate-fade-up">
      <div className="assistant-message__content min-w-0 flex-1">
        <div className="mb-2 flex items-center gap-2">
          <BlackHole size={15} spin={block.streaming ?? false} />
          <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-dim">GROX</span>
          {block.streaming && <span className="text-[9px] text-faint">正在输出</span>}
        </div>
        <Markdown text={block.text} streaming={block.streaming ?? false} className="assistant-prose text-fg2" />
        {block.streaming && <span className="stream-caret" />}
        {!block.streaming && <div className="mt-1.5 flex justify-end"><MessageActions text={block.text} /></div>}
      </div>
    </article>
  );
}

function MessageActions({ text }: { text: string }) {
  const { language } = useI18n();
  const newSession = useDesktop((state) => state.newSession);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };
  const continueInNewTask = () => {
    const prefix = language === "zh-CN"
      ? "请在新任务中继续处理以下上文：\n\n"
      : "Continue this work in a new task using the following context:\n\n";
    void newSession({ text: `${prefix}${text}` });
  };
  return <div className="flex items-center gap-1 opacity-65 transition-opacity hover:opacity-100">
    <button onClick={copy} className="flex h-6 items-center gap-1 rounded-[3px] px-1.5 font-mono text-[8.5px] text-dim hover:bg-high hover:text-fg2" title={language === "zh-CN" ? "复制这条消息" : "Copy message"}><Icon name="copy" size={9} />{copied ? (language === "zh-CN" ? "已复制" : "COPIED") : (language === "zh-CN" ? "复制" : "COPY")}</button>
    <button onClick={continueInNewTask} className="flex h-6 items-center gap-1 rounded-[3px] px-1.5 font-mono text-[8.5px] text-dim hover:bg-high hover:text-fg2" title={language === "zh-CN" ? "在一个新任务中继续" : "Continue in a new task"}><Icon name="branch" size={9} />{language === "zh-CN" ? "新任务继续" : "CONTINUE"}</button>
  </div>;
}

/** System event — a centered mono whisper (compact, rewind, errors). */
export function SystemEvent({ block }: { block: SystemBlock }) {
  const tone =
    block.kind === "error" ? "text-red" : block.kind === "compact" || block.kind === "rewind" ? "text-gold" : "text-dim";
  return (
    <div className="mb-2 flex min-h-7 items-start gap-2 rounded-[5px] border border-line bg-high/30 px-2.5 py-1.5 animate-fade-up">
      <Icon name={block.kind === "error" ? "x" : block.kind === "rewind" ? "refresh" : "bolt"} size={10} className={`mt-1 shrink-0 ${tone}`} />
      <span className={`min-w-0 font-mono text-[9.5px] leading-relaxed ${tone}`}>{block.text}</span>
    </div>
  );
}
