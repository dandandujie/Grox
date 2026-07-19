/* ─────────────────────────────────────────────────────────────────────────
   ToolCallCard — one instrument reading per tool invocation.
   Light spine on the left (the TUI accent line, translated); a header
   row of glyph, title, status; a body specialized by kind:
   edit → inline diff, terminal → console, read/search → locations.
   ───────────────────────────────────────────────────────────────────────── */

import { useState } from "react";
import type { SessionBlock, ToolCall, ToolKind } from "../../bridge/types";
import { fmtDuration } from "../../lib/format";
import { Icon, type IconProps } from "../fx/Icon";
import { DiffView } from "./DiffView";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";

type ToolBlock = Extract<SessionBlock, { type: "tool" }>;

const kindMeta: Partial<Record<ToolKind, { icon: IconProps["name"]; tone: string }>> = {
  read: { icon: "file", tone: "text-mute" },
  list_dir: { icon: "folder", tone: "text-mute" },
  list: { icon: "folder", tone: "text-mute" },
  memory_get: { icon: "file", tone: "text-mute" },
  edit: { icon: "edit", tone: "text-fg" },
  write: { icon: "edit", tone: "text-fg" },
  delete: { icon: "trash", tone: "text-red" },
  move: { icon: "arrowRight", tone: "text-mute" },
  execute: { icon: "terminal", tone: "text-fg2" },
  terminal: { icon: "terminal", tone: "text-fg2" },
  monitor: { icon: "terminal", tone: "text-fg2" },
  background_task_action: { icon: "layers", tone: "text-fg2" },
  wait_tasks_action: { icon: "clock", tone: "text-mute" },
  kill_task_action: { icon: "trash", tone: "text-red" },
  search: { icon: "search", tone: "text-mute" },
  search_tool: { icon: "search", tone: "text-mute" },
  memory_search: { icon: "search", tone: "text-mute" },
  lsp: { icon: "bolt", tone: "text-mute" },
  web: { icon: "globe", tone: "text-mute" },
  web_search: { icon: "globe", tone: "text-mute" },
  web_fetch: { icon: "globe", tone: "text-mute" },
  deploy_app: { icon: "external", tone: "text-acc" },
  task: { icon: "layers", tone: "text-fg" },
  plan: { icon: "layers", tone: "text-gold" },
  enter_plan: { icon: "layers", tone: "text-gold" },
  exit_plan: { icon: "check", tone: "text-green" },
  ask_user: { icon: "user", tone: "text-gold" },
  skill: { icon: "bolt", tone: "text-fg" },
  use_tool: { icon: "layers", tone: "text-fg" },
  goal_update: { icon: "check", tone: "text-green" },
  image_gen: { icon: "file", tone: "text-acc" },
  video_gen: { icon: "play", tone: "text-acc" },
  image_to_video: { icon: "play", tone: "text-acc" },
  reference_to_video: { icon: "play", tone: "text-acc" },
  think: { icon: "bolt", tone: "text-dim" },
  switch_mode: { icon: "refresh", tone: "text-gold" },
  other: { icon: "bolt", tone: "text-dim" },
};

export function ToolCallCard({ block }: { block: ToolBlock }) {
  const { language } = useI18n();
  const { call } = block;
  const busy = call.status === "running" || call.status === "awaiting_permission";
  const [open, setOpen] = useState(false);
  const meta = kindMeta[call.kind] ?? { icon: "bolt" as const, tone: "text-dim" };
  const duration = call.endedAt ? call.endedAt - call.startedAt : Date.now() - call.startedAt;
  const title = language === "zh-CN"
    ? ({ "Web search:": "网页搜索", "X search:": "X 搜索", "Model search:": "模型搜索" } as Record<string, string>)[call.title] ?? call.title
    : call.title;

  return (
    <div className="mb-1 animate-fade-up pl-0.5">
      <div className="toolline rounded-r-[4px] bg-raise/45 pl-2 pr-1">
        {/* header */}
        <button onClick={() => setOpen((v) => !v)} className="flex h-7 w-full items-center gap-1.5 text-left">
          <Icon name={meta.icon} size={12} className={`shrink-0 ${meta.tone}`} />
          <span className="max-w-[42%] truncate font-mono text-[10.5px] text-fg2">{title}</span>
          {call.detail && (
            <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-mute">
              {call.detail}
            </span>
          )}
          <StatusChip call={call} language={language} />
          <span className="tnum shrink-0 text-[9.5px] text-faint">
            {call.status === "done" || call.status === "error" || call.status === "cancelled" ? fmtDuration(duration) : ""}
          </span>
          <Icon
            name="chevronRight"
            size={9}
            className={`shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
        </button>

        {/* body */}
        {open && (
          <div className="mb-1 border-t border-line px-1 py-2 animate-fade-up">
            {call.diff && <DiffView diff={call.diff} />}
            {call.terminal && <TerminalView call={call} />}
            {!call.diff && !call.terminal && call.locations && <Locations paths={call.locations} />}
            {call.images && <ToolImages images={call.images} />}
            {!call.diff && !call.terminal && !call.locations && call.output && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-mute select-text">{call.output}</pre>
            )}
            {!call.diff && !call.terminal && !call.output && !call.locations && busy && (
              <p className="font-mono text-[10.5px] text-faint">
                {call.status === "awaiting_permission"
                  ? language === "zh-CN" ? "等待用户批准…" : "holding for operator approval…"
                  : language === "zh-CN" ? "执行中…" : "working…"}
              </p>
            )}
            {call.input && <RawPayload label={language === "zh-CN" ? "输入" : "INPUT"} value={call.input} />}
            {call.output && (call.diff || call.terminal || call.locations) && (
              <RawPayload label={language === "zh-CN" ? "原始输出" : "RAW OUTPUT"} value={call.output} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusChip({ call, language }: { call: ToolCall; language: "zh-CN" | "en-US" }) {
  switch (call.status) {
    case "running":
      return (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc" />
          <span className="lbl lbl-acc !text-[9.5px]">{language === "zh-CN" ? "执行中" : "RUNNING"}</span>
        </span>
      );
    case "awaiting_permission":
      return <span className="lbl shrink-0 !text-[9.5px] !text-gold">{language === "zh-CN" ? "待批准" : "GATED"}</span>;
    case "done":
      return <Icon name="check" size={11} className="shrink-0 text-dim" />;
    case "error":
      return <span className="lbl shrink-0 !text-[9.5px] !text-red">{language === "zh-CN" ? "失败" : "FAILED"}</span>;
    case "cancelled":
      return <span className="lbl shrink-0 !text-[9.5px] !text-faint">{language === "zh-CN" ? "已取消" : "CANCELLED"}</span>;
    default:
      return <span className="lbl shrink-0 !text-[9.5px]">{language === "zh-CN" ? "排队中" : "QUEUED"}</span>;
  }
}

function RawPayload({ label, value }: { label: string; value: string }) {
  return (
    <details className="group/raw mt-2 rounded-[4px] border border-line bg-void/60">
      <summary className="flex h-6 cursor-pointer items-center gap-1.5 px-2 font-mono text-[9px] tracking-[0.12em] text-faint hover:text-mute">
        <Icon name="chevronRight" size={8} className="transition-transform group-open/raw:rotate-90" />
        {label}
      </summary>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-line px-2 py-1.5 font-mono text-[9.5px] leading-relaxed text-mute select-text">{value}</pre>
    </details>
  );
}

/* ── terminal: the console readout ────────────────────────────────────── */

function TerminalView({ call }: { call: ToolCall }) {
  const t = call.terminal;
  if (!t) return null;
  const running = call.status === "running";
  return (
    <div className="overflow-hidden rounded-[5px] border border-line2 bg-void">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-acc select-none">$</span>
        <span className="flex-1 truncate font-mono text-[10.5px] text-fg select-text">{t.cmd}</span>
        {t.exitCode !== undefined && (
          <span className={`lbl !text-[9.5px] ${t.exitCode === 0 ? "!text-green" : "!text-red"}`}>
            EXIT {t.exitCode}
          </span>
        )}
        {running && <span className="h-1 w-1 animate-pulse-dot rounded-full bg-fg" />}
      </div>
      {t.lines.length > 0 && (
        <div className="max-h-56 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-[1.7] select-text">
          {t.lines.map((line, i) => (
            <TermLine key={i} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}

function TermLine({ line }: { line: string }) {
  // highlight trailing "... ok" test results and the summary line
  if (line.endsWith("... ok")) {
    const head = line.slice(0, -6);
    return (
      <div>
        <span className="text-mute">{head}</span>
        <span className="text-dim">... </span>
        <span className="text-green">ok</span>
      </div>
    );
  }
  if (line.startsWith("test result:")) return <div className="text-green/90">{line}</div>;
  if (line.includes("FAILED") || line.startsWith("failures")) return <div className="text-red/90">{line}</div>;
  return <div className="text-mute">{line || " "}</div>;
}

/* ── read/search: path locations ──────────────────────────────────────── */

function Locations({ paths }: { paths: string[] }) {
  const openPreview = useDesktop((state) => state.openPreview);
  return (
    <div className="space-y-0.5">
      {paths.map((p, i) => (
        <button
          key={i}
          className="flex w-full items-center gap-2 text-left font-mono text-[10.5px] hover:text-fg select-text"
          onClick={() => void openPreview(p)}
        >
          <Icon name="file" size={10} className="text-faint" />
          <span className="text-mute">{p}</span>
        </button>
      ))}
    </div>
  );
}

function ToolImages({ images }: { images: NonNullable<ToolCall["images"]> }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {images.map((image, index) => (
        <img
          key={`${image.mime}-${index}`}
          src={`data:${image.mime};base64,${image.data}`}
          alt="Tool output"
          className="max-h-44 w-full rounded-[4px] border border-line2 bg-void object-contain"
        />
      ))}
    </div>
  );
}
