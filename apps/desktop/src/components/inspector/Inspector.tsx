/* ─────────────────────────────────────────────────────────────────────────
   Inspector — the right-hand instrument panel. Four channels derived from
   the active mission's transcript: changed files, flight plan, terminals,
   and usage telemetry.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDesktop, type InspectorTab } from "../../state/store";
import type { DiffHunk, PlanStep, Session, WorkflowRun, WorkspaceEntry } from "../../bridge/types";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { DiffView } from "../session/DiffView";
import { ResizeHandle } from "../common/ResizeHandle";
import { usePreferences } from "../../state/preferences";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";

const EMPTY_WORKFLOWS: WorkflowRun[] = [];

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
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
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
      {hunks.length > 0 ? <>
        <div className="mb-2 flex items-center gap-2 px-1">
          <span className="lbl !text-[9.5px]">{workspaceDiffReady ? (zh ? "工作区差异" : "WORKING TREE DIFF") : (zh ? "会话差异" : "SESSION DIFF")}</span>
          <span className="tnum text-[9.5px] text-diff-add-fg">+{add}</span>
          <span className="tnum text-[9.5px] text-diff-del-fg">−{del}</span>
        </div>
        <DiffView diff={hunks} />
      </> : <div className="mb-3 rounded-[4px] border border-line bg-raise px-3 py-3 text-[10px] leading-relaxed text-dim">
        {zh ? "当前工作区没有可显示的未提交差异。" : "No uncommitted working-tree diff is available."}
      </div>}
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
  // Zustand selectors must return a stable reference when the store did not
  // change. Creating `[]` here caused React to treat every read of a history
  // session as a new snapshot and recurse until the update-depth limit.
  const workflows = useDesktop((state) => state.workflows[session.id] ?? EMPTY_WORKFLOWS);
  const sendPrompt = useDesktop((state) => state.sendPrompt);
  const plans = session.blocks.filter((b) => b.type === "plan");
  const latest = plans[plans.length - 1];
  if (workflows.length === 0 && (!latest || latest.type !== "plan")) return <Empty text={t("noPlan")} />;
  return (
    <div className="space-y-3">
      {workflows.map((workflow) => (
        <WorkflowCard
          key={workflow.runId}
          workflow={workflow}
          onAction={(action) => sendPrompt(`/workflow ${action} ${workflow.name}`, [])}
        />
      ))}
      {latest?.type === "plan" && <div className="space-y-1">
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
      </div>}
    </div>
  );
}

const terminalWorkflowStatuses = new Set(["complete", "failed", "cancelled", "interrupted"]);
const pausedWorkflowStatuses = new Set([
  "user_paused",
  "back_off_paused",
  "no_progress_paused",
  "infra_paused",
  "blocked",
  "budget_limited",
]);

function WorkflowCard({ workflow, onAction }: { workflow: WorkflowRun; onAction(action: "pause" | "resume" | "stop"): void }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const terminal = terminalWorkflowStatuses.has(workflow.status);
  // Completed runs are normally opened from history. Keeping those compact
  // avoids an old deep-research run taking over the whole task panel, while a
  // live run still opens itself for immediate progress feedback.
  const [expanded, setExpanded] = useState(!terminal);
  const paused = pausedWorkflowStatuses.has(workflow.status);
  const currentPhaseIndex = workflow.currentPhase
    ? workflow.phases.findIndex((phase) => phase.title === workflow.currentPhase)
    : -1;
  const unreachedPhases = terminal && currentPhaseIndex >= 0
    ? workflow.phases.slice(currentPhaseIndex + 1).filter((phase) => phase.state === "pending")
    : [];
  const statusTone = workflow.status === "complete"
    ? "text-green"
    : workflow.status === "failed" || workflow.status === "cancelled" || workflow.status === "interrupted"
      ? "text-red"
      : paused
        ? "text-gold"
        : "text-acc";
  return (
    <div className="overflow-hidden rounded-[5px] border border-line2 bg-raise">
      <div className="border-b border-line px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 text-left"
          title={expanded ? (zh ? "收起任务详情" : "Collapse task details") : (zh ? "展开任务详情" : "Expand task details")}
        >
          <Icon name="chevronRight" size={9} className={`shrink-0 text-faint transition-transform ${expanded ? "rotate-90" : ""}`} />
          <Icon name="search" size={11} className={statusTone} />
          <p className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg2">{workflow.name}</p>
          <span className={`font-mono text-[8.5px] tracking-[0.08em] ${statusTone}`}>{workflow.status.toUpperCase()}</span>
        </button>
        {workflow.objective && <p className={`mt-1.5 text-[10.5px] leading-relaxed text-mute ${expanded ? "line-clamp-3" : "truncate"}`}>{workflow.objective}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[8px] text-faint">
          <span className="rounded-[3px] border border-line2 px-1.5 py-0.5">{workflow.foreground ? "FOREGROUND" : "BACKGROUND"}</span>
          {workflow.currentPhase && <span className="rounded-[3px] border border-line2 px-1.5 py-0.5">{workflow.currentPhase}</span>}
          <span className="max-w-[180px] truncate rounded-[3px] border border-line2 px-1.5 py-0.5" title={workflow.runId}>RUN · {workflow.runId}</span>
          <span className="rounded-[3px] border border-line2 px-1.5 py-0.5">REV {workflow.revision}</span>
        </div>
        {!expanded && <p className="mt-2 font-mono text-[8.5px] text-dim">
          {workflow.phases.length} {zh ? "个阶段" : "PHASES"} · {workflow.agents.length} {zh ? "个子代理" : "SUBAGENTS"} · {workflow.events.length} {zh ? "条记录" : "EVENTS"}
        </p>}
      </div>

      {expanded && workflow.phases.length > 0 && (
        <div className="space-y-1 border-b border-line px-3 py-2">
          {workflow.phases.map((phase, index) => {
            const unreached = terminal && currentPhaseIndex >= 0 && index > currentPhaseIndex && phase.state === "pending";
            return (
            <div key={`${phase.title}-${index}`} className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${phase.state === "done" ? "bg-green" : phase.state === "active" ? "animate-pulse-dot bg-acc" : unreached ? "bg-gold/70" : "bg-faint"}`} />
              <span className={`text-[9.5px] ${phase.state === "active" ? "text-fg2" : "text-dim"}`}>{phase.title}</span>
              {unreached && <span className="font-mono text-[8px] text-gold">{zh ? "未进入" : "NOT REACHED"}</span>}
            </div>
            );
          })}
          {unreachedPhases.length > 0 && <p className="pt-1 text-[8.5px] leading-relaxed text-gold">
            {zh
              ? `CLI 在「${workflow.currentPhase}」阶段结束，后续 ${unreachedPhases.map((phase) => phase.title).join(" / ")} 未执行；这通常对应 Partial 结果，不是界面漏报。`
              : `The CLI ended in ${workflow.currentPhase}; later phases were not reached. This commonly indicates a partial result, not missing UI state.`}
          </p>}
        </div>
      )}

      {expanded && <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 font-mono text-[8.5px] text-dim">
        <span>{zh ? "活跃代理" : "ACTIVE AGENTS"}</span><span className="text-right text-fg2">{workflow.activeAgents}</span>
        <span>{zh ? "已用代理" : "AGENTS USED"}</span><span className="text-right text-fg2">{workflow.agentsUsed}{workflow.agentBudget !== undefined ? ` / ${workflow.agentBudget}` : ""}</span>
        <span>{zh ? "剩余 / 保留" : "REMAINING / HELD"}</span><span className="text-right text-fg2">{workflow.agentsRemaining ?? "—"} / {workflow.agentsReserved}</span>
        <span>{zh ? "耗时" : "ELAPSED"}</span><span className="text-right text-fg2">{fmtDuration(workflow.elapsedMs)}</span>
        {workflow.agentUsageIncomplete && <><span className="text-gold">{zh ? "用量状态" : "USAGE"}</span><span className="text-right text-gold">{zh ? "仍在汇总" : "PARTIAL"}</span></>}
      </div>}

      {expanded && workflow.agents.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <p className="mb-1 text-[8.5px] leading-relaxed text-dim">{zh ? "子代理（展开单个代理可查看公开输出、思考片段与工具调用）" : "SUBAGENTS · expand one for its public output, thought chunks, and tool calls"}</p>
          <div className="space-y-1">
            {workflow.agents.map((agent) => <WorkflowAgentRow key={agent.agentId} agent={agent} trace={workflow.agentTraces?.find((item) => item.agentId === agent.agentId || item.label === agent.label)} zh={zh} />)}
          </div>
        </div>
      )}

      {expanded && workflow.events.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <p className="mb-1.5 font-mono text-[8.5px] tracking-[0.1em] text-faint">{zh ? "运行记录" : "RUN LOG"}</p>
          <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
            {[...workflow.events].reverse().map((entry, index) => (
              <div key={`${entry.timestamp ?? "event"}-${index}`} className="border-l border-line3 pl-2 text-[9px] leading-relaxed text-mute">
                <p className="font-mono text-fg2">{entry.event}</p>
                {entry.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-dim">{entry.detail}</p>}
                {entry.timestamp && <p className="mt-0.5 font-mono text-[8px] text-faint">{entry.timestamp.replace("T", " ").replace("Z", "")}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {expanded && (workflow.currentAgentLabel || workflow.pauseMessage || workflow.resultSummary) && (
        <div className="border-t border-line px-3 py-2 text-[9.5px] leading-relaxed text-mute">
          {workflow.currentAgentLabel && <p>{zh ? "正在运行：" : "Running: "}{workflow.currentAgentLabel}</p>}
          {workflow.pauseMessage && <p className="mt-1 text-gold">{workflow.pauseMessage}</p>}
          {workflow.resultSummary && <div className="mt-2 rounded-[3px] border border-line2 bg-high/45 p-2"><p className="mb-1 font-mono text-[8.5px] tracking-[0.1em] text-acc">{zh ? "研究结果摘要" : "RESEARCH SUMMARY"}</p><p className="whitespace-pre-wrap break-words text-fg2">{workflow.resultSummary}</p></div>}
        </div>
      )}

      {expanded && !terminal && (
        <div className="flex gap-1 border-t border-line p-2">
          <button
            onClick={() => onAction(paused ? "resume" : "pause")}
            disabled={workflow.status === "budget_limited"}
            title={workflow.status === "budget_limited" ? (zh ? "代理预算耗尽，需要通过 workflow 工具提高 agent_budget" : "Agent budget exhausted; raise agent_budget through the workflow tool") : undefined}
            className="flex-1 rounded-[3px] border border-line2 px-2 py-1 font-mono text-[8.5px] text-mute hover:border-line3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {workflow.status === "budget_limited"
              ? (zh ? "需要提高预算" : "RAISE BUDGET")
              : paused ? (zh ? "恢复" : "RESUME") : (zh ? "暂停" : "PAUSE")}
          </button>
          <button onClick={() => onAction("stop")} className="flex-1 rounded-[3px] border border-red/30 px-2 py-1 font-mono text-[8.5px] text-red hover:bg-red/10">
            {zh ? "停止" : "STOP"}
          </button>
        </div>
      )}
    </div>
  );
}

function WorkflowAgentRow({
  agent,
  trace,
  zh,
}: {
  agent: WorkflowRun["agents"][number];
  trace?: NonNullable<WorkflowRun["agentTraces"]>[number];
  zh: boolean;
}) {
  const summary = (
    <>
      <span className={`h-1.5 w-1.5 rounded-full ${agent.state === "running" ? "animate-pulse-dot bg-acc" : agent.state === "complete" || agent.state === "done" ? "bg-green" : agent.state === "failed" ? "bg-red" : "bg-faint"}`} />
      <div className="min-w-0 flex-1"><p className="truncate font-mono text-[9px] text-fg2">{agent.label}</p><p className="truncate text-[8.5px] text-dim">{[agent.phase, agent.model].filter(Boolean).join(" · ") || agent.state}</p></div>
      <span className="text-right font-mono text-[8px] leading-relaxed text-faint">{agent.tokensUsed !== undefined ? `${fmtTokens(agent.tokensUsed)} tok` : ""}{agent.durationMs !== undefined ? <><br />{fmtDuration(agent.durationMs)}</> : null}</span>
    </>
  );
  if (!trace) return <div className="grid grid-cols-[7px_minmax(0,1fr)_auto] items-center gap-2 rounded-[3px] bg-high/45 px-2 py-1.5">{summary}</div>;
  return (
    <details className="group rounded-[3px] border border-line2 bg-high/45">
      <summary className="grid cursor-pointer list-none grid-cols-[8px_7px_minmax(0,1fr)_auto] items-center gap-2 px-2 py-1.5 [&::-webkit-details-marker]:hidden">
        <Icon name="chevronRight" size={8} className="text-faint transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="border-t border-line px-2 py-2">
        <p className="mb-1.5 break-all font-mono text-[8px] text-faint">{trace.childSessionId} · {trace.entries.length} {zh ? "条公开记录" : "PUBLIC ENTRIES"}</p>
        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {trace.entries.length === 0 ? <p className={`text-[9px] ${agent.state === "failed" ? "text-red" : "text-dim"}`}>{agent.state === "failed" ? (zh ? "该子代理在产生公开记录前失败；这不是隐藏的思考内容。" : "This subagent failed before producing public entries; this is not hidden reasoning.") : (zh ? "该子代理尚未产生可回放的公开明细。" : "This subagent has not produced replayable public detail yet.")}</p> : trace.entries.map((entry) => (
            <div key={entry.id} className="border-l border-line3 pl-2 text-[9px] leading-relaxed">
              <p className={`font-mono text-[8px] ${entry.kind === "thinking" ? "text-gold" : entry.kind === "tool" ? "text-acc" : "text-fg2"}`}>
                {entry.kind === "thinking" ? (zh ? "思考" : "THINKING") : entry.kind === "tool" ? `TOOL · ${entry.title ?? "tool"}` : entry.kind === "output" ? (zh ? "输出" : "OUTPUT") : (entry.title ?? "EVENT")}
                {entry.status && <span className="ml-1 text-faint">· {entry.status}</span>}
              </p>
              {entry.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-dim">{entry.detail}</p>}
              {entry.timestamp && <p className="mt-0.5 font-mono text-[8px] text-faint">{new Date(entry.timestamp).toLocaleString()}</p>}
            </div>
          ))}
        </div>
      </div>
    </details>
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
        <iframe key={`${preview.url}-${frameKey}`} src={preview.url} title="Project preview" className="min-h-0 flex-1 border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
          <span className={`h-2 w-2 rounded-full ${preview.status === "starting" ? "animate-pulse-dot bg-acc" : preview.status === "error" ? "bg-red" : "bg-faint"}`} />
          <div>
            <p className="text-[11px] text-fg2">
              {preview.status === "starting"
                ? (zh ? "正在启动项目预览…" : "Starting project preview…")
                : preview.status === "detected"
                  ? (zh ? "检测到前端项目，确认后再执行开发脚本" : "Frontend detected. Start its development script when ready.")
                  : preview.status === "error"
                    ? (zh ? "预览启动失败" : "Preview failed")
                    : (zh ? "未检测到可预览的前端项目" : "No previewable frontend detected")}
            </p>
            {preview.framework && <p className="mt-1 font-mono text-[9.5px] text-acc">{preview.framework}</p>}
            {preview.error && <p className="mt-2 max-w-[260px] font-mono text-[9.5px] leading-relaxed text-red">{preview.error}</p>}
            {preview.command && <p className="mt-2 max-w-[260px] truncate font-mono text-[9px] text-faint">{preview.command}</p>}
          </div>
          <button onClick={() => void refresh(true)} className="rounded-[3px] border border-line2 bg-raise px-3 py-1.5 text-[10px] text-fg2 hover:border-line3 hover:text-fg">
            {preview.command
              ? (zh ? `执行 ${preview.command}` : `Run ${preview.command}`)
              : (zh ? "检测并启动" : "Detect & start")}
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
