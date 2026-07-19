import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RewindMode, RewindPoint, RewindResult } from "../../bridge/types";
import { useI18n } from "../../lib/i18n";
import { useDesktop } from "../../state/store";
import { BlackHole } from "../fx/BlackHole";
import { Icon } from "../fx/Icon";

type Stage = "loading" | "points" | "mode" | "previewing" | "confirm" | "executing";

const modeLabels: Record<RewindMode, { zh: string; en: string; zhHint: string; enHint: string }> = {
  all: {
    zh: "对话与文件",
    en: "Conversation & files",
    zhHint: "恢复对话，并撤销此轮之后的 Agent 文件修改",
    enHint: "Restore the conversation and revert later Agent file changes",
  },
  conversation_only: {
    zh: "仅对话",
    en: "Conversation only",
    zhHint: "恢复对话，保留工作区当前文件",
    enHint: "Restore the conversation and keep current workspace files",
  },
  files_only: {
    zh: "仅文件",
    en: "Files only",
    zhHint: "撤销文件修改，但保留当前对话上下文",
    enHint: "Revert files while keeping the current conversation",
  },
};

function RewindSurface({ modal, onClose, children }: { modal: boolean; onClose(): void; children: React.ReactNode }) {
  if (!modal) return children;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div onMouseDown={(event) => event.stopPropagation()}>{children}</div>
    </div>,
    document.body,
  );
}

export function RewindMenu({
  onComplete,
  targetPromptIndex,
  variant = "toolbar",
}: {
  onComplete?(): void;
  targetPromptIndex?: number;
  variant?: "toolbar" | "request";
}) {
  const { language } = useI18n();
  const activeId = useDesktop((state) => state.activeId);
  const listPoints = useDesktop((state) => state.listRewindPoints);
  const previewRewind = useDesktop((state) => state.previewRewind);
  const executeRewind = useDesktop((state) => state.executeRewind);
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("points");
  const [points, setPoints] = useState<RewindPoint[]>([]);
  const [point, setPoint] = useState<RewindPoint>();
  const [mode, setMode] = useState<RewindMode>("all");
  const [preview, setPreview] = useState<RewindResult>();
  const [error, setError] = useState("");
  const busy = stage === "previewing" || stage === "executing";

  const close = () => {
    if (!busy) setOpen(false);
  };

  useEffect(() => {
    setOpen(false);
  }, [activeId]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !dialogRef.current?.contains(target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open, busy]);

  const showPoints = async () => {
    setOpen(true);
    setStage("loading");
    setPoints([]);
    setPoint(undefined);
    setPreview(undefined);
    setError("");
    try {
      const next = await listPoints();
      setPoints([...next].sort((a, b) => b.prompt_index - a.prompt_index));
      if (targetPromptIndex !== undefined) {
        const selected = next.find((item) => item.prompt_index === targetPromptIndex);
        if (selected) {
          setPoint(selected);
          setMode("conversation_only");
          setStage("mode");
        } else {
          setStage("points");
          setError(language === "zh-CN" ? "没有找到这条请求对应的官方回退节点" : "No official rewind checkpoint was found for this request");
        }
      } else {
        setStage("points");
        if (next.length === 0) setError(language === "zh-CN" ? "当前会话还没有可回退的历史节点" : "This session has no rewind checkpoints yet");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectPoint = (selected: RewindPoint) => {
    setPoint(selected);
    setMode("all");
    setError("");
    setStage("mode");
  };

  const selectMode = async (selected: RewindMode) => {
    if (!point || (selected === "files_only" && !point.has_file_changes)) return;
    setMode(selected);
    setError("");
    setStage("previewing");
    try {
      const result = await previewRewind(point.prompt_index, selected);
      setPreview(result);
      setStage("confirm");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("mode");
    }
  };

  const execute = async () => {
    if (!point) return;
    setError("");
    setStage("executing");
    try {
      await executeRewind(point, mode);
      setOpen(false);
      requestAnimationFrame(() => onComplete?.());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("confirm");
    }
  };

  const totalRemoved = point ? points.filter((item) => item.prompt_index >= point.prompt_index).length : 0;
  const labels = modeLabels[mode];

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => open ? close() : void showPoints()}
        className={`flex h-7 items-center justify-center gap-1.5 rounded-[5px] border transition-colors ${variant === "request" ? "border-transparent px-1.5 text-[9px] text-acc hover:text-fg" : "border-line2 bg-high/45 px-2 text-[9.5px] font-medium text-mute hover:border-gold/35 hover:bg-high hover:text-gold"} ${open ? "border-gold/35 bg-high text-gold" : ""}`}
        title={language === "zh-CN" ? "选择历史节点回退并编辑" : "Choose a checkpoint to rewind and edit"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="refresh" size={11} />
        <span>{variant === "request" ? (language === "zh-CN" ? "撤回编辑" : "REWIND & EDIT") : (language === "zh-CN" ? "历史回退" : "HISTORY")}</span>
      </button>

      {open && (
        <RewindSurface modal={variant === "request"} onClose={close}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-label={language === "zh-CN" ? "对话回退" : "Rewind conversation"}
            className={`${variant === "request" ? "relative" : "absolute bottom-full right-0 mb-2"} z-50 flex max-h-[min(460px,calc(100vh-120px))] w-[min(520px,calc(100vw-32px))] flex-col overflow-hidden rounded-[8px] border border-line2 bg-raise shadow-[0_14px_44px_rgba(0,0,0,0.62)] animate-fade-up`}
          >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
            {busy ? <BlackHole size={13} spin /> : <Icon name="branch" size={12} className="text-gold" />}
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-fg2">
              {stage === "points" && (language === "zh-CN" ? "回退到哪一轮？" : "Rewind to which turn?")}
              {stage === "loading" && (language === "zh-CN" ? "正在读取历史节点…" : "Loading rewind checkpoints…")}
              {stage === "mode" && (language === "zh-CN" ? "选择恢复范围" : "Choose what to restore")}
              {stage === "previewing" && (language === "zh-CN" ? "正在检查文件变化…" : "Inspecting file changes…")}
              {stage === "confirm" && (language === "zh-CN" ? "确认回退" : "Confirm rewind")}
              {stage === "executing" && (language === "zh-CN" ? "正在回退…" : "Rewinding…")}
            </span>
            {!busy && <button onClick={close} className="flex h-7 w-7 items-center justify-center rounded-[4px] text-faint hover:bg-high hover:text-fg"><Icon name="x" size={10} /></button>}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {stage === "loading" && <div className="flex min-h-32 flex-col items-center justify-center gap-3"><BlackHole size={28} spin /><p className="text-[10px] text-mute">{language === "zh-CN" ? "从 grok-build 读取官方 checkpoint" : "Reading official grok-build checkpoints"}</p></div>}
            {stage === "points" && points.map((item) => (
              <button
                key={item.prompt_index}
                onClick={() => selectPoint(item)}
                className="mb-1 grid w-full min-w-0 grid-cols-[54px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] border border-transparent px-2.5 py-2 text-left hover:border-line2 hover:bg-high"
              >
                <span className="font-mono text-[9.5px] text-faint">#{item.prompt_index + 1}</span>
                <span className="min-w-0 truncate text-[11px] text-fg2" title={item.prompt_preview}>{item.prompt_preview || (language === "zh-CN" ? "无预览" : "No preview")}</span>
                <span className="shrink-0 font-mono text-[9px] text-dim">{item.has_file_changes ? (language === "zh-CN" ? `${item.num_file_snapshots} 文件` : `${item.num_file_snapshots} files`) : (language === "zh-CN" ? "仅对话" : "chat")}</span>
              </button>
            ))}

            {stage === "mode" && point && (
              <div className="p-1">
                <SelectedPoint point={point} language={language} />
                <div className="mt-2 space-y-1">
                  {(Object.keys(modeLabels) as RewindMode[]).map((value) => {
                    const item = modeLabels[value];
                    const disabled = value === "files_only" && !point.has_file_changes;
                    return (
                      <button key={value} disabled={disabled} onClick={() => void selectMode(value)} className="grid w-full grid-cols-[18px_minmax(0,1fr)_14px] items-center gap-2 rounded-[5px] border border-line px-2.5 py-2 text-left hover:border-line3 hover:bg-high disabled:cursor-not-allowed disabled:opacity-35">
                        <Icon name={value === "conversation_only" ? "command" : value === "files_only" ? "file" : "layers"} size={11} className="text-dim" />
                        <span className="min-w-0"><span className="block truncate text-[11px] text-fg2">{language === "zh-CN" ? item.zh : item.en}</span><span className="block truncate text-[9.5px] text-faint" title={language === "zh-CN" ? item.zhHint : item.enHint}>{language === "zh-CN" ? item.zhHint : item.enHint}</span></span>
                        <Icon name="chevronRight" size={9} className="text-faint" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {(stage === "previewing" || stage === "executing") && <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center"><BlackHole size={30} spin /><p className="text-[10px] text-mute">{stage === "previewing" ? (language === "zh-CN" ? "只读预览，不会修改对话或文件" : "Read-only preview; nothing is changed yet") : (language === "zh-CN" ? "正在恢复官方 checkpoint，请勿关闭应用" : "Restoring the official checkpoint; keep the app open")}</p></div>}

            {stage === "confirm" && point && preview && (
              <div className="p-1">
                <SelectedPoint point={point} language={language} />
                <div className="mt-2 rounded-[5px] border border-gold/25 bg-gold/5 p-2.5">
                  <p className="text-[11px] text-fg2">{language === "zh-CN" ? `将从第 ${point.prompt_index + 1} 轮开始移除 ${totalRemoved} 轮对话` : `${totalRemoved} turn(s) from turn ${point.prompt_index + 1} will be removed`}</p>
                  <p className="mt-1 text-[9.5px] text-mute">{mode === "files_only" ? (language === "zh-CN" ? `${labels.zh} · 对话保持不变` : `${labels.en} · the conversation remains unchanged`) : (language === "zh-CN" ? `${labels.zh} · 回退后会把所选请求放回输入框供你编辑` : `${labels.en} · the selected request returns to the composer for editing`)}</p>
                </div>
                {(preview.clean_files.length > 0 || preview.conflicts.length > 0) && (
                  <div className="mt-2 max-h-28 overflow-y-auto rounded-[5px] border border-line p-2 font-mono text-[9px]">
                    {preview.clean_files.map((path) => <p key={`clean-${path}`} className="truncate text-dim" title={path}>RESTORE · {path}</p>)}
                    {preview.conflicts.map((item) => <p key={`conflict-${item.path}`} className="truncate text-red" title={item.path}>CONFLICT · {item.path}</p>)}
                  </div>
                )}
                {preview.conflicts.length > 0 && <p className="mt-2 text-[9.5px] text-red">{language === "zh-CN" ? "检测到外部文件修改；继续将按官方 force 流程覆盖这些冲突。" : "External file changes detected; continuing uses the official force flow."}</p>}
                <div className="mt-3 flex justify-end gap-2">
                  <button onClick={() => setStage("mode")} className="rounded-[5px] border border-line2 px-3 py-1.5 text-[10px] text-mute hover:bg-high hover:text-fg2">{language === "zh-CN" ? "返回" : "Back"}</button>
                  <button onClick={() => void execute()} className="rounded-[5px] border border-gold/40 bg-gold/10 px-3 py-1.5 text-[10px] text-gold hover:bg-gold/15">{mode === "files_only" ? (language === "zh-CN" ? "确认回退文件" : "Rewind files") : (language === "zh-CN" ? "确认回退并编辑" : "Rewind and edit")}</button>
                </div>
              </div>
            )}

            {error && <p role="alert" className="m-1 rounded-[5px] border border-red/25 bg-red/5 px-2.5 py-2 text-[10px] text-red">{error}</p>}
          </div>
          </div>
        </RewindSurface>
      )}
    </div>
  );
}

function SelectedPoint({ point, language }: { point: RewindPoint; language: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] border border-line2 bg-panel/60 px-2.5 py-2">
      <span className="font-mono text-[9.5px] text-gold">#{point.prompt_index + 1}</span>
      <span className="min-w-0 truncate text-[10.5px] text-fg2" title={point.prompt_preview}>{point.prompt_preview || (language === "zh-CN" ? "无预览" : "No preview")}</span>
      <span className="font-mono text-[9px] text-faint">{point.has_file_changes ? (language === "zh-CN" ? `${point.num_file_snapshots} 文件` : `${point.num_file_snapshots} files`) : "CHAT"}</span>
    </div>
  );
}
