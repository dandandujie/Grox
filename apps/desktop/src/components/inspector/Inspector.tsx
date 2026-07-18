/* ─────────────────────────────────────────────────────────────────────────
   Inspector — the right-hand instrument panel. Four channels derived from
   the active mission's transcript: changed files, flight plan, terminals,
   and usage telemetry.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDesktop, type InspectorTab } from "../../state/store";
import type { DiffHunk, PlanStep, Session, WorkspaceEntry } from "../../bridge/types";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { DiffView } from "../session/DiffView";
import { ResizeHandle } from "../common/ResizeHandle";
import { usePreferences } from "../../state/preferences";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";

export function Inspector() {
  const { t } = useI18n();
  const tab = useDesktop((s) => s.inspectorTab);
  const setTab = useDesktop((s) => s.setInspectorTab);
  const session = useDesktop((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const width = usePreferences((state) => state.inspectorWidth);
  const setWidth = usePreferences((state) => state.setInspectorWidth);
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "files", label: t("files") },
    { id: "tasks", label: t("tasks") },
    { id: "preview", label: t("preview") },
    { id: "usage", label: t("usage") },
  ];

  return (
    <>
    <ResizeHandle side="left" value={width} onChange={setWidth} />
    <aside className="flex shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      {/* tab strip */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative h-full px-2 font-mono text-[10px] tracking-[0.14em] transition-colors ${
              tab === t.id ? "text-fg" : "text-dim hover:text-mute"
            }`}
          >
            {t.label}
            {tab === t.id && <span className="absolute inset-x-2 bottom-0 h-px bg-acc" />}
          </button>
        ))}
      </div>

      <div className={tab === "preview" ? "min-h-0 flex-1 overflow-hidden" : "flex-1 overflow-y-auto p-3"}>
        {tab === "files" ? (
          <FilesTab session={session ?? undefined} />
        ) : tab === "preview" ? (
          <PreviewTab />
        ) : !session ? (
          <Empty text={t("noMission")} />
        ) : tab === "tasks" ? (
          <TasksTab session={session} />
        ) : (
          <UsageTab session={session} />
        )}
      </div>
    </aside>
    </>
  );
}

const Empty = ({ text }: { text: string }) => (
  <div className="flex h-full items-center justify-center">
    <span className="lbl !text-[9.5px]">{text.toUpperCase()}</span>
  </div>
);

/* ── FILES ─────────────────────────────────────────────────────────────── */

function FilesTab({ session }: { session?: Session }) {
  const { t } = useI18n();
  const workspaceFiles = useDesktop((state) => state.workspaceFiles);
  const workspaceDiffs = useDesktop((state) => state.workspaceDiffs);
  const workspaceDiffReady = useDesktop((state) => state.workspaceDiffReady);
  const openPreview = useDesktop((state) => state.openPreview);
  const toolHunks: DiffHunk[] = (session?.blocks ?? []).flatMap((b) =>
    b.type === "tool" && b.call.diff ? b.call.diff : [],
  );
  const hunks = workspaceDiffReady ? workspaceDiffs : toolHunks;
  const tree = useMemo(() => buildFileTree(workspaceFiles), [workspaceFiles]);
  if (hunks.length === 0 && tree.length === 0) return <Empty text={t("noFiles")} />;
  const add = hunks.reduce((n, h) => n + h.added, 0);
  const del = hunks.reduce((n, h) => n + h.removed, 0);
  return (
    <div>
      {hunks.length > 0 && <>
        <div className="mb-2 flex items-center gap-2 px-1">
          <span className="lbl !text-[9.5px]">{hunks.length} {t("files")}</span>
          <span className="tnum text-[9.5px] text-diff-add-fg">+{add}</span>
          <span className="tnum text-[9.5px] text-diff-del-fg">−{del}</span>
        </div>
        <DiffView diff={hunks} collapsed />
      </>}
      <div className="mb-2 mt-4 px-1"><span className="lbl !text-[9.5px]">{t("projectResources")}</span></div>
      <div className="space-y-px">
        {tree.map((node) => <FileTreeNode key={node.path} node={node} onOpen={(path) => void openPreview(path)} />)}
      </div>
    </div>
  );
}

interface FileNode extends WorkspaceEntry {
  children: FileNode[];
}

function buildFileTree(entries: WorkspaceEntry[]): FileNode[] {
  const root: FileNode = { path: "", name: "", isDir: true, children: [] };
  const nodes = new Map<string, FileNode>([["", root]]);
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = entry.path.split("/").filter(Boolean);
    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join("/");
      let node = nodes.get(path);
      if (!node) {
        node = {
          path,
          name: parts[index],
          isDir: index < parts.length - 1 || entry.isDir,
          children: [],
        };
        nodes.set(path, node);
        parent.children.push(node);
      } else if (index === parts.length - 1) {
        node.isDir = entry.isDir;
      }
      parent = node;
    }
  }
  const sort = (nodesToSort: FileNode[]): FileNode[] => nodesToSort
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    .map((node) => ({ ...node, children: sort(node.children) }));
  return sort(root.children);
}

const canPreview = (path: string) => /\.(md|mdx|markdown|html?|png|jpe?g|gif|webp|svg|bmp|txt|json|toml|ya?ml|css|[jt]sx?|rs|py)$/i.test(path);

function FileTreeNode({ node, onOpen }: { node: FileNode; onOpen(path: string): void }) {
  if (node.isDir) {
    return (
      <details className="group/tree">
        <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-[3px] px-1 font-mono text-[10px] text-mute hover:bg-high hover:text-fg2 [&::-webkit-details-marker]:hidden">
          <Icon name="chevronRight" size={8} className="text-faint transition-transform group-open/tree:rotate-90" />
          <Icon name="folder" size={10} className="text-dim" />
          <span className="truncate">{node.name}</span>
        </summary>
        <div className="ml-2.5 border-l border-line pl-1">
          {node.children.map((child) => <FileTreeNode key={child.path} node={child} onOpen={onOpen} />)}
        </div>
      </details>
    );
  }
  const previewable = canPreview(node.path);
  return (
    <button
      disabled={!previewable}
      onClick={() => onOpen(node.path)}
      className="flex h-7 w-full items-center gap-1.5 rounded-[3px] px-1 pl-[15px] text-left font-mono text-[10px] text-mute enabled:hover:bg-high enabled:hover:text-fg2 disabled:text-faint"
    >
      <Icon name="file" size={9} className="shrink-0 text-faint" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

/* ── TASKS ─────────────────────────────────────────────────────────────── */

function TasksTab({ session }: { session: Session }) {
  const { t } = useI18n();
  const plans = session.blocks.filter((b) => b.type === "plan");
  const latest = plans[plans.length - 1];
  if (!latest || latest.type !== "plan") return <Empty text={t("noPlan")} />;
  return (
    <div className="space-y-1">
      {latest.steps.map((s: PlanStep, i: number) => (
        <div key={s.id} className="flex items-start gap-2.5 rounded-[4px] border border-line bg-raise px-3 py-2.5">
          <span className="tnum mt-0.5 text-[9.5px] text-faint">{String(i + 1).padStart(2, "0")}</span>
          <div className="min-w-0 flex-1">
            <p className={`text-[11.5px] leading-snug ${s.status === "completed" ? "text-dim line-through decoration-line3" : "text-fg2"}`}>
              {s.content}
            </p>
            <p className={`lbl mt-1 !text-[9.5px] ${s.status === "in_progress" ? "!text-gold" : s.status === "completed" ? "!text-green" : ""}`}>
              {s.status.replace("_", " ").toUpperCase()}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── PROJECT PREVIEW ─────────────────────────────────────────────────── */

function PreviewTab() {
  const { language } = useI18n();
  const preview = useDesktop((state) => state.projectPreview);
  const refresh = useDesktop((state) => state.refreshProjectPreview);
  const setUrl = useDesktop((state) => state.setProjectPreviewUrl);
  const [draft, setDraft] = useState(preview.url ?? "");
  const [frameKey, setFrameKey] = useState(0);
  useEffect(() => setDraft(preview.url ?? ""), [preview.url]);
  const zh = language === "zh-CN";
  const navigate = (event: FormEvent) => {
    event.preventDefault();
    try {
      const url = new URL(draft);
      if (!/^https?:$/.test(url.protocol)) return;
      setUrl(url.toString());
    } catch {
      // Keep the current page when the address is incomplete.
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-void">
      <form onSubmit={navigate} className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2">
        <button type="button" onClick={() => setFrameKey((key) => key + 1)} className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg" title={zh ? "重新载入" : "Reload"}>
          <Icon name="refresh" size={11} />
        </button>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="http://localhost:5173" className="h-6 min-w-0 flex-1 rounded-[3px] border border-line bg-raise px-2 font-mono text-[9.5px] text-fg2 outline-none focus:border-line3" />
        {preview.url && (
          <button type="button" onClick={() => void invoke("open_external", { url: preview.url })} className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg" title={zh ? "在浏览器打开" : "Open in browser"}>
            <Icon name="external" size={11} />
          </button>
        )}
      </form>
      {preview.status === "ready" && preview.url ? (
        <iframe key={`${preview.url}-${frameKey}`} src={preview.url} title="Project preview" className="min-h-0 flex-1 border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
          <span className={`h-2 w-2 rounded-full ${preview.status === "starting" ? "animate-pulse-dot bg-acc" : preview.status === "error" ? "bg-red" : "bg-faint"}`} />
          <div>
            <p className="text-[11px] text-fg2">
              {preview.status === "starting" ? (zh ? "正在启动项目预览…" : "Starting project preview…") : preview.status === "error" ? (zh ? "预览启动失败" : "Preview failed") : (zh ? "未检测到可预览的前端项目" : "No previewable frontend detected")}
            </p>
            {preview.framework && <p className="mt-1 font-mono text-[9.5px] text-acc">{preview.framework}</p>}
            {preview.error && <p className="mt-2 max-w-[260px] font-mono text-[9.5px] leading-relaxed text-red">{preview.error}</p>}
            {preview.command && <p className="mt-2 max-w-[260px] truncate font-mono text-[9px] text-faint">{preview.command}</p>}
          </div>
          <button onClick={() => void refresh(true)} className="rounded-[3px] border border-line2 bg-raise px-3 py-1.5 text-[10px] text-fg2 hover:border-line3 hover:text-fg">
            {zh ? "检测并启动" : "Detect & start"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── USAGE ─────────────────────────────────────────────────────────────── */

function UsageTab({ session }: { session: Session }) {
  const { t } = useI18n();
  const u = session.usage;
  const pct = u.contextMax > 0 ? Math.min(100, (u.contextUsed / u.contextMax) * 100) : 0;
  return (
    <div className="space-y-4">
      {/* context gauge */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="lbl !text-[9.5px]">{t("context")}</span>
          <span className="tnum text-[10px] text-fg2">
            {fmtTokens(u.contextUsed)} / {fmtTokens(u.contextMax)}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-high">
          <div className={`h-full ${pct > 80 ? "bg-gold" : "bg-acc"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <Readout label={t("inputTokens")} value={fmtTokens(u.inputTokens)} />
      <Readout label={t("cacheRead")} value={fmtTokens(u.cacheReadTokens)} tone="text-mute" />
      <Readout label={t("outputTokens")} value={fmtTokens(u.outputTokens)} />
      <Readout label={t("cost")} value={fmtCost(u.costUSD)} tone="text-green" />
      <Readout label={t("turns")} value={String(u.turns)} />
      <Readout label={t("model")} value={session.model.toUpperCase()} tone="text-fg2" />
      <Readout
        label={t("elapsed")}
        value={fmtDuration(Math.max(0, session.updatedAt - session.createdAt))}
      />

      <div className="rounded-[4px] border border-line bg-raise p-2.5">
        <p className="lbl !text-[9.5px] !text-faint">{t("sessionId")}</p>
        <p className="tnum mt-1 break-all text-[10px] text-mute select-text">{session.id}</p>
      </div>
    </div>
  );
}

function Readout({ label, value, tone = "text-fg2" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-line pb-1.5">
      <span className="lbl !text-[9.5px]">{label}</span>
      <span className={`tnum text-[11px] ${tone}`}>{value}</span>
    </div>
  );
}
