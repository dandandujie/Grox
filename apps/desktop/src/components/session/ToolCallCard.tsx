/* ─────────────────────────────────────────────────────────────────────────
   ToolCallCard — one instrument reading per tool invocation.
   Light spine on the left (the TUI accent line, translated); a header
   row of glyph, title, status; a body specialized by kind:
   edit → inline diff, terminal → console, read/search → locations.
   ───────────────────────────────────────────────────────────────────────── */

import { useMemo, useState } from "react";
import type { SessionBlock, ToolCall, ToolKind } from "../../bridge/types";
import { fmtDuration } from "../../lib/format";
import { Icon, type IconProps } from "../fx/Icon";
import { DiffView } from "./DiffView";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";

type ToolBlock = Extract<SessionBlock, { type: "tool" }>;

type SearchTool = {
  name: string;
  description?: string;
};

type SearchToolGroup = {
  server: string;
  tools: SearchTool[];
};

type SearchToolsPreview = {
  resultCount: number;
  groups: SearchToolGroup[];
};

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
  computer: { icon: "command", tone: "text-gold" },
  think: { icon: "bolt", tone: "text-dim" },
  switch_mode: { icon: "refresh", tone: "text-gold" },
  other: { icon: "bolt", tone: "text-dim" },
};

export function ToolCallCard({ block }: { block: ToolBlock }) {
  const { language } = useI18n();
  const { call } = block;
  const busy = call.status === "running" || call.status === "awaiting_permission";
  const [open, setOpen] = useState(false);
  const searchTools = useMemo(() => parseSearchTools(call.output), [call.output]);
  const meta = kindMeta[call.kind] ?? { icon: "bolt" as const, tone: "text-dim" };
  const duration = call.endedAt ? call.endedAt - call.startedAt : Date.now() - call.startedAt;
  const title = language === "zh-CN"
    ? ({ "Web search:": "网页搜索", "X search:": "X 搜索", "Model search:": "模型搜索" } as Record<string, string>)[call.title] ?? call.title
    : call.title;
  const failure = call.status === "error" && call.output
    ? toolFailureSummary(call.output, language)
    : undefined;

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
          {failure && (
            <span title={failure} className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-red/80">
              {failure}
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
            {!call.diff && !call.terminal && !call.locations && searchTools && <SearchToolsSummary preview={searchTools} />}
            {!call.diff && !call.terminal && !call.locations && !searchTools && call.output && (
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
            {call.output && (call.diff || call.terminal || call.locations || searchTools) && (
              <RawPayload label={language === "zh-CN" ? "原始输出" : "RAW OUTPUT"} value={call.output} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SearchToolsSummary({ preview }: { preview: SearchToolsPreview }) {
  const { language } = useI18n();
  const displayedTools = preview.groups.flatMap((group) => group.tools).slice(0, 24);
  const omitted = preview.groups.reduce((count, group) => count + group.tools.length, 0) - displayedTools.length;

  return (
    <div className="rounded-[5px] border border-line2 bg-void/70 px-2.5 py-2">
      <p className="mb-2 font-mono text-[10px] font-medium text-fg2">
        {language === "zh-CN" ? `发现 ${preview.resultCount} 个搜索工具` : `Found ${preview.resultCount} search tools`}
      </p>
      <div className="space-y-2">
        {preview.groups.map((group) => {
          const tools = displayedTools.filter((tool) => group.tools.includes(tool));
          if (tools.length === 0) return null;
          return (
            <section key={group.server}>
              <p className="mb-1 font-mono text-[9px] tracking-[0.1em] text-faint">{group.server}</p>
              <div className="space-y-1">
                {tools.map((tool) => (
                  <div key={tool.name} className="rounded-[3px] border border-line bg-raise/35 px-2 py-1.5">
                    <p className="font-mono text-[10px] text-fg2 select-text">{tool.name}</p>
                    {tool.description && <p className="mt-0.5 text-[10px] leading-relaxed text-mute">{tool.description}</p>}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {omitted > 0 && <p className="mt-2 text-[9.5px] text-faint">{language === "zh-CN" ? `另有 ${omitted} 个工具，请展开原始输出查看。` : `${omitted} more tools are available in raw output.`}</p>}
    </div>
  );
}

function parseSearchTools(output: string | undefined): SearchToolsPreview | undefined {
  if (!output) return undefined;
  const outer = asRecord(parseJson(output));
  if (!outer) return undefined;
  const nested = asRecord(parseJson(outer.content));
  const results = Array.isArray(nested?.results) ? nested.results : Array.isArray(outer.results) ? outer.results : undefined;
  if (!results) return undefined;

  const groups = results.flatMap((entry, index) => {
    const value = asRecord(entry);
    if (!value || !Array.isArray(value.tools)) return [];
    const tools = value.tools.flatMap((tool) => {
      const item = asRecord(tool);
      const name = asText(item?.tool_name) ?? asText(item?.toolName) ?? asText(item?.name);
      if (!name) return [];
      const description = searchToolDescription(asText(item?.description));
      return [{ name, ...(description ? { description } : {}) }];
    });
    if (tools.length === 0) return [];
    return [{ server: asText(value.server) ?? `server-${index + 1}`, tools }];
  });
  if (groups.length === 0) return undefined;

  const counted = asNumber(outer.result_count) ?? asNumber(outer.resultCount);
  return { resultCount: counted ?? groups.reduce((count, group) => count + group.tools.length, 0), groups };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function searchToolDescription(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const firstParagraph = value.trim().split(/\r?\n\s*\r?\n/, 1)[0]
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!firstParagraph) return undefined;
  return firstParagraph.length > 240 ? `${firstParagraph.slice(0, 239)}…` : firstParagraph;
}

function toolFailureSummary(output: string, language: "zh-CN" | "en-US") {
  // The upstream web sandbox rejects targets that resolve to private/internal
  // addresses (including some DNS-filtered public domains). Showing that
  // reason directly avoids making an OAuth or provider issue look like a
  // mysterious generic tool failure, while deliberately not weakening SSRF
  // protection in the desktop host.
  if (/ssrf\s+blocked|private\/internal\s+ip/i.test(output)) {
    return language === "zh-CN" ? "目标地址被安全策略拦截" : "blocked by network safety policy";
  }
  return output.replace(/\s+/g, " ").trim().slice(0, 180);
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
  const { language } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  const selected = active === null ? undefined : images[active];
  return (
    <>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {images.map((image, index) => (
          <button key={`${image.mime}-${index}`} onClick={() => setActive(index)} className="group/image relative overflow-hidden rounded-[4px] border border-line2 bg-void text-left" title={language === "zh-CN" ? "点击预览图片" : "Preview image"}>
            <img src={`data:${image.mime};base64,${image.data}`} alt="Tool output" className="max-h-44 w-full object-contain transition-transform duration-200 group-hover/image:scale-[1.015]" />
            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-void/80 px-2 py-1 font-mono text-[8.5px] text-faint opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100">{language === "zh-CN" ? "点击预览" : "PREVIEW"}</span>
          </button>
        ))}
      </div>
      {selected && <div role="dialog" aria-modal="true" aria-label={language === "zh-CN" ? "图片预览" : "Image preview"} onClick={() => setActive(null)} className="fixed inset-0 z-[90] flex items-center justify-center bg-void/90 p-8 backdrop-blur-sm animate-fade-up">
        <button onClick={() => setActive(null)} className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-[4px] border border-line2 bg-panel text-dim hover:text-fg" title={language === "zh-CN" ? "关闭预览" : "Close preview"}><Icon name="x" size={13} /></button>
        <img onClick={(event) => event.stopPropagation()} src={`data:${selected.mime};base64,${selected.data}`} alt="Tool output enlarged" className="max-h-full max-w-full rounded-[5px] border border-line2 bg-void object-contain shadow-2xl" />
      </div>}
    </>
  );
}
