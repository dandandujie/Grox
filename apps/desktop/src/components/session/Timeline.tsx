import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isSessionTerminal, type Session, type SessionBlock, type WorkflowRun } from "../../bridge/types";
import { useI18n } from "../../lib/i18n";
import {
  isProcessFoldComplete,
  nextProcessOpenOnCompleteChange,
  rememberProcessOpen,
  resolveInitialProcessOpen,
  turnHasInspectableProcess,
} from "../../lib/processFold";
import { deriveSessionSnapshot } from "../../lib/sessionRuntime";
import {
  TIMELINE_TURN_WINDOW_INITIAL,
  TIMELINE_TURN_WINDOW_STEP,
  visibleCountToIncludeIndex,
  visibleTurnSlice,
} from "../../lib/timelineWindow";
import { isSessionHistoryPending } from "../../lib/sessionShell";
import { deadSessionCopy, isDeadSessionView } from "../../lib/sessionUnavailable";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";
import { AssistantMsg, SystemEvent, UserMsg } from "./blocks";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { PlanCard } from "./PlanCard";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { TurnChangeCard } from "./TurnChangeCard";
import { ConfirmDialog } from "../common/ConfirmDialog";

/** Near-bottom slack for stick-to-bottom while streaming. */
const FOLLOW_BOTTOM_PX = 96;

interface Turn {
  id: string;
  blocks: SessionBlock[];
  promptIndex: number;
}

interface RequestMarker {
  id: string;
  index: number;
  prompt: string;
  response: string;
}

// Keep Zustand's selector snapshot referentially stable when this session has
// never launched a workflow. Creating `[]` in the selector causes React to
// observe a fresh store snapshot on every render and recurse indefinitely.
const EMPTY_WORKFLOWS: WorkflowRun[] = [];

// Deep Research has a separate, durable task timeline. Its launch and
// completion are host-side workflow events, not a normal model turn, so a
// generic "provider did not expose" process panel would be misleading.
function isDeepResearchRequest(block: Extract<SessionBlock, { type: "user" }> | undefined): boolean {
  return Boolean(block && /^\/(?:deep-research|workflow\s+grox-deep-research)\b/i.test(block.text.trim()));
}

function deepResearchQuery(text: string): string | undefined {
  const visible = text.trim().match(/^\/deep-research\s+(.+)$/i);
  if (visible?.[1]) return visible[1].trim();
  const internal = text.trim().match(/^\/workflow\s+grox-deep-research\s+(.+)$/i);
  if (!internal?.[1]) return undefined;
  try {
    const args = JSON.parse(internal[1]) as { query?: unknown };
    return typeof args.query === "string" ? args.query.trim() : undefined;
  } catch {
    return undefined;
  }
}

function matchingResearchRun(
  runs: WorkflowRun[],
  user: Extract<SessionBlock, { type: "user" }> | undefined,
): WorkflowRun | undefined {
  const query = user ? deepResearchQuery(user.text) : undefined;
  const candidates = runs.filter((run) => run.name === "grox-deep-research");
  return candidates.find((run) => query && run.objective.trim() === query)
    ?? candidates.find((run) => !["complete", "failed", "cancelled", "interrupted"].includes(run.status))
    ?? candidates.at(0);
}

function DeepResearchToolCard({ run, query }: { run?: WorkflowRun; query?: string }) {
  const { language } = useI18n();
  const openTasks = useDesktop((state) => state.setInspectorTab);
  const state = run?.status ?? "active";
  const active = !["complete", "failed", "cancelled", "interrupted"].includes(state);
  const failed = state === "failed";
  const tone = failed ? "text-red" : active ? "text-acc" : "text-green";
  const status = failed
    ? (language === "zh-CN" ? "失败" : "FAILED")
    : active
      ? (language === "zh-CN" ? "执行中" : "RUNNING")
      : state === "cancelled" || state === "interrupted"
        ? (language === "zh-CN" ? "已停止" : "STOPPED")
        : (language === "zh-CN" ? "已完成" : "COMPLETE");
  const phase = run?.currentPhase ?? (language === "zh-CN" ? "等待任务状态" : "WAITING FOR TASK STATUS");

  return (
    <button
      type="button"
      onClick={() => openTasks("tasks")}
      className="mb-5 flex w-full items-center gap-3 rounded-[5px] border border-line2 bg-raise/35 px-3 py-2.5 text-left transition-colors hover:border-acc/50 hover:bg-acc/5"
    >
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] border border-line2 bg-void ${tone}`}>
        <Icon name="search" size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-fg2">{language === "zh-CN" ? "深度研究" : "DEEP RESEARCH"}</span>
          <span className={`font-mono text-[8.5px] tracking-[0.08em] ${tone}`}>{status}</span>
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-dim">{query || run?.objective || phase}</span>
      </span>
      <span className="hidden shrink-0 text-right font-mono text-[8.5px] text-faint sm:block">
        {phase}<br />{language === "zh-CN" ? "查看任务详情" : "OPEN TASK DETAILS"}
      </span>
      <Icon name="chevronRight" size={10} className="shrink-0 text-faint" />
    </button>
  );
}

export function groupTurns(blocks: SessionBlock[]): Turn[] {
  const turns: Turn[] = [];
  let promptIndex = -1;
  for (const block of blocks) {
    if (block.type === "user" && !block.interjected) {
      promptIndex += 1;
      turns.push({ id: block.id, blocks: [block], promptIndex });
    } else if (turns.length === 0) turns.push({ id: block.id, blocks: [block], promptIndex: -1 });
    else turns[turns.length - 1].blocks.push(block);
  }
  return turns;
}

export function DeadSessionNotice({ session }: { session: Session }) {
  const { language } = useI18n();
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const copy = deadSessionCopy(language === "zh-CN" ? "zh-CN" : "en", session.id);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 pb-24">
      <BlackHole size={34} />
      <div className="max-w-[420px] text-center">
        <p className="text-[15px] font-medium text-fg">{copy.title}</p>
        <p className="mt-2 text-[12px] leading-relaxed text-mute">{copy.body}</p>
        <p className="mt-3 break-all font-mono text-[9.5px] text-faint">{copy.detail}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          className="rounded-[5px] border border-red/40 bg-red/10 px-3 py-2 font-mono text-[10px] text-red transition-colors hover:border-red hover:bg-red/15"
          onClick={() => setConfirmRemoval(true)}
        >
          {copy.remove}
        </button>
        <button
          type="button"
          className="rounded-[5px] border border-line2 px-3 py-2 font-mono text-[10px] text-fg2 transition-colors hover:border-acc/40 hover:text-fg"
          onClick={() => useDesktop.getState().goHome()}
        >
          {copy.home}
        </button>
      </div>
      {confirmRemoval && (
        <ConfirmDialog
          title={language === "zh-CN" ? "永久删除失效会话记录？" : "Permanently delete the unavailable session?"}
          description={language === "zh-CN"
            ? "这不仅会隐藏侧栏条目，还会删除该会话残留的本机缓存、CLI 历史与支持数据。此操作无法撤销。"
            : "This does more than hide the sidebar row: it deletes remaining local cache, CLI history, and support data for this session. This cannot be undone."}
          confirmLabel={language === "zh-CN" ? "永久删除" : "Delete permanently"}
          cancelLabel={language === "zh-CN" ? "取消" : "Cancel"}
          workingLabel={language === "zh-CN" ? "删除中" : "Deleting"}
          onCancel={() => setConfirmRemoval(false)}
          onConfirm={async () => {
            await useDesktop.getState().removeSessionFromSidebar(session.id);
            setConfirmRemoval(false);
          }}
        />
      )}
    </div>
  );
}

function compactPreview(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function requestPreview(turn: Turn, language: string): Omit<RequestMarker, "index"> | undefined {
  const user = turn.blocks.find((block): block is Extract<SessionBlock, { type: "user" }> => block.type === "user");
  if (!user) return undefined;
  const assistant = turn.blocks.filter((block): block is Extract<SessionBlock, { type: "assistant" }> => block.type === "assistant").at(-1);
  return {
    id: turn.id,
    prompt: compactPreview(user.text, 92),
    response: assistant?.text.trim()
      ? compactPreview(assistant.text, 128)
      : language === "zh-CN" ? "正在等待 Grok 的回复…" : "Waiting for Grok's reply…",
  };
}

type RailTip = { marker: RequestMarker; top: number; right: number };

/**
 * Grok-app / grok.com style message node rail — right edge, tick list,
 * prev/next steppers, hover preview. Click jumps without relying on the
 * transcript scroll wheel alone.
 */
function RequestNodeRail({
  markers,
  language,
  scrollerRef,
  onJump,
}: {
  markers: RequestMarker[];
  language: string;
  scrollerRef: RefObject<HTMLDivElement | null>;
  onJump(id: string): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tip, setTip] = useState<RailTip | null>(null);
  const rafRef = useRef<number | null>(null);
  const zh = language === "zh-CN";

  const activeIndex = useMemo(
    () => (activeId ? markers.findIndex((m) => m.id === activeId) : -1),
    [markers, activeId],
  );
  const canPrev = activeIndex > 0 || (activeIndex < 0 && markers.length > 0);
  const canNext =
    (activeIndex >= 0 && activeIndex < markers.length - 1) ||
    (activeIndex < 0 && markers.length > 0);

  // Keep the active tick visible inside a long rail list.
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const tick = listRef.current.querySelector(
      `[data-node-id="${CSS.escape(markers[activeIndex]!.id)}"]`,
    ) as HTMLElement | null;
    tick?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeIndex, markers]);

  // Free-scroll highlight: which turn is near the reading focus line.
  // IntersectionObserver 缓存每个回合行的文档相对坐标（观察回调里才做布局读），
  // 滚动时只做纯算术选取，长会话不再每帧对全部行 querySelectorAll + getBoundingClientRect。
  useEffect(() => {
    const viewport = scrollerRef.current;
    if (!viewport || markers.length === 0) return;

    const idSet = new Set(markers.map((m) => m.id));
    const docRects = new Map<string, { top: number; bottom: number }>();

    const sync = () => {
      rafRef.current = null;
      const scrollTop = viewport.scrollTop;
      const viewBottom = scrollTop + viewport.clientHeight;
      const focusY = scrollTop + viewport.clientHeight * 0.28;
      let bestId: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const [id, rect] of docRects) {
        if (rect.bottom < scrollTop || rect.top > viewBottom) continue;
        const mid = (rect.top + rect.bottom) / 2;
        const dist = Math.abs(mid - focusY);
        if (dist < bestDist) {
          bestDist = dist;
          bestId = id;
        }
      }
      if (!bestId) {
        // Fallback: first / last by scroll extremes.
        if (scrollTop <= 8) bestId = markers[0]?.id ?? null;
        else if (viewport.scrollHeight - scrollTop - viewport.clientHeight <= 8) {
          bestId = markers[markers.length - 1]?.id ?? null;
        }
      }
      if (bestId) setActiveId((prev) => (prev === bestId ? prev : bestId));
    };

    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = window.requestAnimationFrame(sync);
    };

    // 120% 外扩：行进入可视区前后就完成坐标缓存；内容变化导致行重新相交时刷新缓存。
    const observer = new IntersectionObserver(
      (entries) => {
        let dirty = false;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).getAttribute("data-turn-id");
          if (!id || !idSet.has(id)) continue;
          docRects.set(id, {
            top: entry.boundingClientRect.top + viewport.scrollTop,
            bottom: entry.boundingClientRect.bottom + viewport.scrollTop,
          });
          dirty = true;
        }
        if (dirty) onScroll();
      },
      { root: viewport, rootMargin: "120% 0px 120% 0px" },
    );
    for (const row of viewport.querySelectorAll<HTMLElement>("[data-turn-id]")) {
      observer.observe(row);
    }

    viewport.addEventListener("scroll", onScroll, { passive: true });
    rafRef.current = window.requestAnimationFrame(sync);
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scrollerRef, markers]);

  const showTip = (marker: RequestMarker, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({
      marker,
      top: r.top + r.height / 2,
      right: window.innerWidth - r.left + 10,
    });
  };
  const clearTip = (id: string) => {
    setTip((cur) => (cur?.marker.id === id ? null : cur));
  };

  const jumpIndex = (index: number) => {
    const marker = markers[index];
    if (!marker) return;
    setActiveId(marker.id);
    onJump(marker.id);
  };

  const onPrev = () => {
    if (activeIndex > 0) jumpIndex(activeIndex - 1);
    else if (activeIndex < 0 && markers.length > 0) jumpIndex(markers.length - 1);
  };
  const onNext = () => {
    if (activeIndex >= 0 && activeIndex < markers.length - 1) jumpIndex(activeIndex + 1);
    else if (activeIndex < 0 && markers.length > 0) jumpIndex(0);
  };

  if (markers.length === 0) return null;

  return (
    <nav className="msg-rail" aria-label={zh ? "请求导航" : "Request navigation"}>
      <button
        type="button"
        className="msg-rail__step"
        aria-label={zh ? "上一条请求" : "Previous request"}
        disabled={!canPrev}
        onClick={onPrev}
      >
        <Icon name="chevronDown" size={12} className="rotate-180" />
      </button>

      <div ref={listRef} className="msg-rail__list" role="list">
        {markers.map((marker) => {
          const isActive = marker.id === activeId;
          const isHover = tip?.marker.id === marker.id;
          const label = zh ? `请求 ${marker.index + 1}` : `Request ${marker.index + 1}`;
          return (
            <div key={marker.id} role="listitem" className="msg-rail__item">
              <button
                type="button"
                data-node-id={marker.id}
                className={`msg-rail__tick${isActive ? " is-active" : ""}${isHover ? " is-hover" : ""}`}
                aria-label={`${label}: ${marker.prompt}`}
                aria-current={isActive ? "true" : undefined}
                onMouseEnter={(e) => showTip(marker, e.currentTarget)}
                onMouseLeave={() => clearTip(marker.id)}
                onFocus={(e) => showTip(marker, e.currentTarget)}
                onBlur={() => clearTip(marker.id)}
                onClick={() => {
                  setActiveId(marker.id);
                  onJump(marker.id);
                }}
              />
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="msg-rail__step"
        aria-label={zh ? "下一条请求" : "Next request"}
        disabled={!canNext}
        onClick={onNext}
      >
        <Icon name="chevronDown" size={12} />
      </button>

      {tip && typeof document !== "undefined"
        ? createPortal(
            <div
              className="msg-rail__tip"
              role="tooltip"
              style={{ top: tip.top, right: tip.right }}
            >
              <div className="msg-rail__tip-role">{zh ? "请求" : "Request"} · {tip.marker.index + 1}</div>
              <div className="msg-rail__tip-body">{tip.marker.prompt}</div>
              <div className="msg-rail__tip-response">{tip.marker.response}</div>
              <div className="msg-rail__tip-count">
                {tip.marker.index + 1} / {markers.length}
              </div>
            </div>,
            document.body,
          )
        : null}
    </nav>
  );
}

function renderBlock(block: SessionBlock, sessionId: string, processing = false) {
  switch (block.type) {
    case "user": return <UserMsg key={block.id} block={block} />;
    case "assistant": return <AssistantMsg key={block.id} block={block} process={processing} />;
    case "thinking": return <ThinkingBlock key={block.id} block={block} processing={processing} />;
    case "tool": return <ToolCallCard key={block.id} block={block} />;
    case "plan": return <PlanCard key={block.id} block={block} />;
    case "permission": return block.req.purpose === "plan" ? null : <PermissionCard key={block.id} block={block} sessionId={sessionId} />;
    case "question": return <QuestionCard key={block.id} block={block} />;
    case "system": return <SystemEvent key={block.id} block={block} />;
  }
}

function ToolBatch({ blocks }: { blocks: Extract<SessionBlock, { type: "tool" }>[] }) {
  const { language } = useI18n();
  const [open, setOpen] = useState(true);
  const commands = blocks.filter((block) => block.call.kind === "execute" || block.call.kind === "terminal").length;
  const edits = blocks.filter((block) => ["edit", "write", "delete", "move"].includes(block.call.kind)).length;
  const busy = blocks.some((block) => ["pending", "running", "awaiting_permission"].includes(block.call.status));
  const summary = language === "zh-CN"
    ? edits && commands ? `编辑了文件并运行了 ${commands} 个命令` : commands ? `运行了 ${commands} 个命令` : edits ? `编辑了 ${edits} 个文件` : `调用了 ${blocks.length} 个工具`
    : edits && commands ? `Edited files and ran ${commands} commands` : commands ? `Ran ${commands} commands` : edits ? `Edited ${edits} files` : `Used ${blocks.length} tools`;

  return (
    <div className="process-tool-batch mb-2 overflow-hidden">
      <button onClick={() => setOpen((value) => !value)} className="process-tool-toggle">
        <span className={`process-node ${busy ? "is-live" : "is-done"}`} aria-hidden="true" />
        <Icon name={commands ? "terminal" : edits ? "edit" : "bolt"} size={11} className="shrink-0 text-dim" />
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg2" title={summary}>{summary}</span>
        {busy && <span className="lbl lbl-acc shrink-0 !text-[9px]">{language === "zh-CN" ? "执行中" : "RUNNING"}</span>}
        <Icon name="chevronRight" size={9} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="ml-[6px] max-h-56 overflow-y-auto border-l border-line2 pb-1 pl-4 pt-1">{blocks.map((block) => <ToolCallCard key={block.id} block={block} />)}</div>}
    </div>
  );
}

function RenderSequence({ blocks, sessionId, processing }: { blocks: SessionBlock[]; sessionId: string; processing: boolean }) {
  const output: React.ReactNode[] = [];
  for (let index = 0; index < blocks.length;) {
    if (blocks[index].type !== "tool") {
      output.push(renderBlock(blocks[index], sessionId, processing));
      index += 1;
      continue;
    }
    const tools: Extract<SessionBlock, { type: "tool" }>[] = [];
    while (index < blocks.length && blocks[index].type === "tool") {
      tools.push(blocks[index] as Extract<SessionBlock, { type: "tool" }>);
      index += 1;
    }
    output.push(<ToolBatch key={`tools-${tools[0].id}`} blocks={tools} />);
  }
  return <>{output}</>;
}

interface TurnGroupProps {
  turn: Turn;
  sessionId: string;
  status: Session["status"];
  active: boolean;
  workflow?: WorkflowRun;
  /** Fired when the operator expands a completed process trail (stop auto-follow). */
  onProcessInspect?: () => void;
}

function TurnGroup({ turn, sessionId, status, active, workflow, onProcessInspect }: TurnGroupProps) {
  const { language } = useI18n();
  const compatibleProvider = useDesktop((state) => state.provider.kind === "compatible");
  const complete = isProcessFoldComplete({
    active,
    sessionTerminal: isSessionTerminal(status),
  });
  // 思考 / 工具 / 计划是审计轨迹：回合结束后仍然默认展开，否则用户会以为
  // 模型没思考、没调用工具。纯文字回合才折叠成一行摘要。手动选择优先。
  // Persist across Virtuoso remounts so expand → scroll does not re-collapse
  // and thrash scroll position.
  const hasInspectableProcess = turnHasInspectableProcess(turn.blocks);
  const [processOpen, setProcessOpenState] = useState(() =>
    resolveInitialProcessOpen(sessionId, turn.id, complete, hasInspectableProcess),
  );
  const wasCompleteRef = useRef(complete);
  const user = turn.blocks.find((block): block is Extract<SessionBlock, { type: "user" }> => block.type === "user");
  const deepResearch = isDeepResearchRequest(user);
  const query = user ? deepResearchQuery(user.text) : undefined;

  const commitProcessOpen = (next: boolean, opts?: { inspect?: boolean }) => {
    rememberProcessOpen(sessionId, turn.id, next);
    setProcessOpenState(next);
    // Expanding a completed trail is an intentional inspect gesture — stop
    // auto-follow so signature / height updates cannot yank the viewport.
    if (opts?.inspect && next) onProcessInspect?.();
  };

  useEffect(() => {
    setProcessOpenState((current) => {
      const next = nextProcessOpenOnCompleteChange({
        wasComplete: wasCompleteRef.current,
        complete,
        currentOpen: current,
        hasInspectableProcess,
      });
      wasCompleteRef.current = complete;
      // Map write is idempotent; keeps remounts aligned with transition policy.
      rememberProcessOpen(sessionId, turn.id, next);
      return next;
    });
  }, [complete, hasInspectableProcess, sessionId, turn.id]);

  if (!complete) {
    const liveBlocks = turn.blocks.filter((block) => block !== user);
    const lastLiveBlock = liveBlocks.at(-1);
    const streamingAnswer = lastLiveBlock?.type === "assistant" ? lastLiveBlock : undefined;
    const processBlocks = streamingAnswer ? liveBlocks.slice(0, -1) : liveBlocks;
    return (
      <section className="timeline-turn">
        {user && <UserMsg block={user} />}
        {deepResearch && <DeepResearchToolCard run={workflow} query={query} />}
        {!deepResearch && <div className="process-live mb-3">
          <div className="mb-2 flex min-h-7 items-center gap-2">
            <BlackHole size={15} spin />
            <span className="text-[10.5px] font-medium text-fg2">{status === "awaiting_permission" ? (language === "zh-CN" ? "等待批准" : "Awaiting approval") : status === "awaiting_input" ? (language === "zh-CN" ? "等待你的回答" : "Awaiting input") : (language === "zh-CN" ? "Grok 正在处理" : "Grok is working")}</span>
            <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc" />
            <span className="font-mono text-[9px] tracking-[0.08em] text-faint">{language === "zh-CN" ? `${liveBlocks.length} 条事件` : `${liveBlocks.length} events`}</span>
          </div>
          {processBlocks.length > 0 ? <div className="process-sequence process-rail ml-[7px] pl-5">
            <RenderSequence blocks={processBlocks} sessionId={sessionId} processing />
          </div> : !streamingAnswer ? (
            <div className="process-sequence process-rail ml-[7px] pl-5">
              <div className="mb-3 flex items-center gap-2 text-[10.5px] text-dim">
                <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc-dim" />
                {language === "zh-CN" ? "等待模型返回第一个事件…" : "Waiting for the first model event…"}
              </div>
            </div>
          ) : null}
        </div>}
        {streamingAnswer && <AssistantMsg block={streamingAnswer} />}
      </section>
    );
  }

  const unresolved = turn.blocks.filter((block) => (block.type === "permission" && !block.resolved) || (block.type === "question" && !block.response));
  const assistants = turn.blocks.filter((block): block is Extract<SessionBlock, { type: "assistant" }> => block.type === "assistant");
  const finalAssistant = assistants.at(-1);
  const process = turn.blocks.filter((block) => block !== user && block !== finalAssistant && !unresolved.includes(block));
  const toolCount = process.filter((block) => block.type === "tool").length;
  const thoughts = process.filter((block): block is Extract<SessionBlock, { type: "thinking" }> => block.type === "thinking");
  const thoughtCount = thoughts.length;
  const elapsed = thoughts.reduce((sum, block) => sum + (block.elapsedMs ?? 0), 0);
  const intermediateTextCount = process.filter((block) => block.type === "assistant").length;
  const otherEventCount = process.length - toolCount - thoughtCount - intermediateTextCount;
  const summaryParts = language === "zh-CN"
    ? [
        thoughtCount ? `${thoughtCount} 段思考` : "",
        intermediateTextCount ? `${intermediateTextCount} 段文字` : "",
        toolCount ? `${toolCount} 个工具` : "",
        otherEventCount ? `${otherEventCount} 条运行事件` : "",
      ].filter(Boolean)
    : [
        thoughtCount ? `${thoughtCount} thoughts` : "",
        intermediateTextCount ? `${intermediateTextCount} text segments` : "",
        toolCount ? `${toolCount} tools` : "",
        otherEventCount ? `${otherEventCount} runtime events` : "",
      ].filter(Boolean);
  const processSummary = summaryParts.join(" · ");

  return (
    <section className="timeline-turn">
      {user && <UserMsg block={user} rewindPromptIndex={turn.promptIndex >= 0 ? turn.promptIndex : undefined} />}
      {deepResearch && <DeepResearchToolCard run={workflow} query={query} />}
      {/*
       * ACP is allowed to return only a final answer. That is not a tool
       * invocation, nor evidence that a provider hid one. Keep the transcript
       * quiet in that case instead of manufacturing a "process" row.
       */}
      {!deepResearch && process.length > 0 && <div className="process-complete mb-3">
        <button
          type="button"
          className="process-summary"
          onClick={() => commitProcessOpen(!processOpen, { inspect: true })}
          aria-expanded={processOpen}
        >
          <Icon name={processOpen ? "chevronDown" : "chevronRight"} size={9} className="shrink-0 text-dim" />
          <span className="shrink-0 text-[10px] font-medium text-fg2">{language === "zh-CN" ? "已处理" : "Processed"}</span>
          <span className="min-w-0 flex-1 truncate text-[9.5px] text-dim" title={processSummary}>{processSummary}{elapsed ? ` · ${(elapsed / 1000).toFixed(1)}s` : ""}</span>
          <Icon name="check" size={9} className="text-green" />
        </button>
        {processOpen && (
          <div className="process-sequence process-rail process-sequence--bounded ml-[7px] mt-1.5 border-l border-line2 pb-1 pl-4 pt-1.5">
            <RenderSequence blocks={process} sessionId={sessionId} processing={false} />
          </div>
        )}
      </div>}
      {!deepResearch && active && compatibleProvider && finalAssistant && process.length === 0 && (
        <div className="mb-3 flex items-center gap-2 font-mono text-[9.5px] text-faint">
          <Icon name="alert" size={9} className="shrink-0" />
          <span>{language === "zh-CN"
            ? "本回合的模型服务未返回思考、工具调用或来源；Grox 不会把正文猜成搜索记录。"
            : "This model service returned no reasoning, tool calls, or sources; Grox will not invent a search trace from prose."}</span>
        </div>
      )}
      {unresolved.map((block) => renderBlock(block, sessionId))}
      {finalAssistant && <AssistantMsg block={finalAssistant} />}
      <TurnChangeCard blocks={turn.blocks} promptIndex={turn.promptIndex} />
    </section>
  );
}

const MemoTurnGroup = memo(TurnGroup, (previous, next) => {
  if (previous.active !== next.active || previous.sessionId !== next.sessionId || previous.workflow !== next.workflow) return false;
  if (previous.onProcessInspect !== next.onProcessInspect) return false;
  if (next.active && previous.status !== next.status) return false;
  if (previous.turn.blocks.length !== next.turn.blocks.length) return false;
  if (previous.turn.promptIndex !== next.turn.promptIndex) return false;
  return previous.turn.blocks.every((block, index) => block === next.turn.blocks[index]);
});

function isNearBottom(el: HTMLElement, slack = FOLLOW_BOTTOM_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export function Timeline({ session }: { session: Session }) {
  const { language } = useI18n();
  const workflows = useDesktop((state) => state.workflows[session.id] ?? EMPTY_WORKFLOWS);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Native scroller + turn window (not Virtuoso): expanding process used to make
  // Virtuoso re-range and yank scrollTop to 0 / stick-to-bottom thrash so the
  // operator could not freely scroll. DOM stays bounded via a hard mount cap.
  const followRef = useRef(true);
  const inspectHoldRef = useRef(false);
  const leftBottomRef = useRef(false);
  const pendingJumpIdRef = useRef<string | null>(null);
  /**
   * Until the operator scrolls away, keep re-landing at bottom whenever
   * transcript body grows (cache → disk → ACP). Clearing after first rAF was
   * wrong: later hydrations replace content and leave scrollTop at the top.
   */
  const userTookOverRef = useRef(false);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const turns = useMemo(() => groupTurns(session.blocks), [session.blocks]);
  const [visibleCount, setVisibleCount] = useState(TIMELINE_TURN_WINDOW_INITIAL);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const sessionRunning = deriveSessionSnapshot({ status: session.status, blocks: session.blocks }).busy;
  const wasRunningRef = useRef(sessionRunning);
  const lastBlock = session.blocks.at(-1);
  const liveSignature = sessionRunning
    ? `${session.blocks.length}:${lastBlock?.type === "assistant" || lastBlock?.type === "thinking" ? lastBlock.text.length : lastBlock?.id ?? ""}:${session.status}`
    : "";
  const contentEpoch = `${session.id}:${turns.length}:${session.blocks.length}:${lastBlock?.id ?? ""}:${lastBlock && "text" in lastBlock ? String(lastBlock.text).length : 0}`;

  useEffect(() => {
    setVisibleCount(TIMELINE_TURN_WINDOW_INITIAL);
    pendingJumpIdRef.current = null;
    userTookOverRef.current = false;
    followRef.current = true;
    inspectHoldRef.current = false;
    leftBottomRef.current = false;
    setAwayFromBottom(false);
  }, [session.id]);

  // Window is "last N turns" — as new turns stream in, the newest stay mounted
  // without growing N. Older ones roll out of the window unless the operator
  // loads earlier history.

  const { hiddenCount, visibleTurns } = useMemo(
    () => visibleTurnSlice(turns, visibleCount),
    [turns, visibleCount],
  );

  const markers = useMemo<RequestMarker[]>(() => {
    const requests = turns
      .map((turn) => requestPreview(turn, language))
      .filter((marker): marker is Omit<RequestMarker, "index"> => Boolean(marker));
    return requests.map((marker, index) => ({ ...marker, index }));
  }, [language, turns]);

  const stopFollowForInspect = useCallback(() => {
    followRef.current = false;
    inspectHoldRef.current = true;
    leftBottomRef.current = false;
    userTookOverRef.current = true;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // One layout write is enough; scrollIntoView here forced a second reflow
    // for every streamed chunk.
    el.scrollTop = el.scrollHeight;
  }, []);

  // Open / hydrate landing: re-apply on every content growth until the user
  // scrolls away. Debounce "done" only after content stops changing.
  useLayoutEffect(() => {
    // Live growth has its own single scroll effect below. Running both paths
    // made every token perform duplicate layout and timer work.
    if (sessionRunning) return;
    if (userTookOverRef.current) return;
    if (turns.length === 0) return;
    scrollToBottom();
    if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      scrollToBottom();
      settleTimerRef.current = undefined;
    }, 120);
    return () => {
      if (settleTimerRef.current !== undefined) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = undefined;
      }
    };
  }, [contentEpoch, sessionRunning, visibleTurns.length, scrollToBottom, turns.length]);

  // New live turn after idle: resume stick-to-bottom for streaming.
  useEffect(() => {
    if (sessionRunning && !wasRunningRef.current) {
      inspectHoldRef.current = false;
      leftBottomRef.current = false;
      followRef.current = true;
      userTookOverRef.current = false;
      scrollToBottom();
    }
    wasRunningRef.current = sessionRunning;
  }, [sessionRunning, scrollToBottom]);

  // Streaming stick-to-bottom — only while live and operator has not scrolled away.
  useLayoutEffect(() => {
    if (!sessionRunning || !liveSignature) return;
    if (inspectHoldRef.current || !followRef.current || userTookOverRef.current) return;
    scrollToBottom();
  }, [liveSignature, sessionRunning, scrollToBottom]);

  // After expanding the window for a rail jump, scroll to the target once mounted.
  useLayoutEffect(() => {
    const id = pendingJumpIdRef.current;
    if (!id) return;
    const node = scrollerRef.current?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
    if (!node) return;
    pendingJumpIdRef.current = null;
    node.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [visibleTurns, visibleCount]);

  // 回到最新：把控制权交还自动跟随，之后流式输出会继续吸底。
  const jumpToLatest = useCallback(() => {
    followRef.current = true;
    inspectHoldRef.current = false;
    leftBottomRef.current = false;
    userTookOverRef.current = false;
    const el = scrollerRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const onScrollerScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    setAwayFromBottom(!isNearBottom(el));
    if (!isNearBottom(el)) {
      // Operator left the bottom — never force-land again this open.
      userTookOverRef.current = true;
      followRef.current = false;
      leftBottomRef.current = true;
      return;
    }
    // At bottom: clear inspect only after the user left first (expand-at-bottom
    // must not immediately re-enable follow).
    if (inspectHoldRef.current) {
      if (leftBottomRef.current) {
        inspectHoldRef.current = false;
        leftBottomRef.current = false;
        followRef.current = true;
        userTookOverRef.current = false;
      }
      return;
    }
    leftBottomRef.current = false;
    followRef.current = true;
    userTookOverRef.current = false;
  };

  if (isSessionHistoryPending(session)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-24">
        <BlackHole size={28} spin />
        <span className="lbl !text-[10px]">
          {language === "zh-CN" ? "正在加载会话记录…" : "LOADING MISSION LOG…"}
        </span>
      </div>
    );
  }

  if (isDeadSessionView(session)) {
    return <DeadSessionNotice session={session} />;
  }

  if (session.blocks.length === 0) return <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-24"><BlackHole size={44} spin="slow" /><div className="text-center"><p className="text-[14px] text-mute">{language === "zh-CN" ? "任务通道已打开。" : "Mission channel open."}</p><p className="lbl mt-1.5 !text-[10px]">{language === "zh-CN" ? "输入你的第一个请求" : "TRANSMIT YOUR FIRST DIRECTIVE"}</p></div></div>;

  const jumpToTurn = (id: string) => {
    const index = turns.findIndex((turn) => turn.id === id);
    if (index < 0) return;
    stopFollowForInspect();
    const nextVisible = visibleCountToIncludeIndex(turns.length, index, visibleCount);
    if (nextVisible > visibleCount) {
      pendingJumpIdRef.current = id;
      setVisibleCount(nextVisible);
      return;
    }
    const node = scrollerRef.current?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
    node?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const loadEarlier = () => {
    stopFollowForInspect();
    setVisibleCount((current) => Math.min(turns.length, current + TIMELINE_TURN_WINDOW_STEP));
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollerRef}
        className="timeline-scroller h-full min-w-0 flex-1 overflow-y-auto"
        onScroll={onScrollerScroll}
      >
        <div className="h-9 shrink-0" />
        {hiddenCount > 0 && (
          <div className="timeline-content mx-auto mb-4">
            <button
              type="button"
              className="w-full rounded-[5px] border border-line2 bg-raise/40 px-3 py-2 text-center font-mono text-[10px] tracking-[0.06em] text-dim transition-colors hover:border-acc/40 hover:text-fg2"
              onClick={loadEarlier}
            >
              {language === "zh-CN"
                ? `加载更早的 ${Math.min(TIMELINE_TURN_WINDOW_STEP, hiddenCount)} 轮（还有 ${hiddenCount} 轮未显示）`
                : `Load earlier ${Math.min(TIMELINE_TURN_WINDOW_STEP, hiddenCount)} turns (${hiddenCount} hidden)`}
            </button>
          </div>
        )}
        {visibleTurns.map((turn, visibleIndex) => {
          const absoluteIndex = hiddenCount + visibleIndex;
          const user = turn.blocks.find((block): block is Extract<SessionBlock, { type: "user" }> => block.type === "user");
          return (
            <div key={turn.id} data-turn-id={turn.id} className="timeline-content mx-auto">
              <MemoTurnGroup
                turn={turn}
                sessionId={session.id}
                status={session.status}
                active={absoluteIndex === turns.length - 1}
                workflow={matchingResearchRun(workflows, user)}
                onProcessInspect={stopFollowForInspect}
              />
            </div>
          );
        })}
        <div className="h-11 shrink-0" aria-hidden="true" />
      </div>
      {awayFromBottom && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line2 bg-raise/95 px-3.5 py-1.5 font-mono text-[10px] text-fg2 shadow-lg backdrop-blur transition-colors hover:border-acc/50 hover:text-fg"
        >
          <Icon name="chevronDown" size={10} />
          {language === "zh-CN" ? "回到最新" : "Jump to latest"}
          {sessionRunning && <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc" aria-hidden="true" />}
        </button>
      )}
      <RequestNodeRail markers={markers} language={language} scrollerRef={scrollerRef} onJump={jumpToTurn} />
    </div>
  );
}
