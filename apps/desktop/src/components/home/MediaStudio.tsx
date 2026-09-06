import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cancelMediaGeneration, mediaGenerationCapabilities, mediaGenerationHistory, openMediaArtifact, releaseMediaReference, saveMediaReference, startMediaGeneration,
  hostListen,
} from "../../lib/hostActions";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "../common/ChipSelect";
import { errorDomainLabel, formatGroxError, toGroxError } from "../../lib/errorModel";
import { useI18n } from "../../lib/i18n";
import { useDesktop } from "../../state/store";

type MediaMode = "image" | "video";

interface MediaArtifact {
  path?: string;
  url?: string;
  mime: string;
}

type MediaJobPhase = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

interface MediaFailure {
  domain: "protocol" | "operation" | "environment";
  code: string;
  message: string;
  recoverable: boolean;
  fatal: boolean;
  holdQueue: boolean;
  action: string;
}

interface MediaJobSnapshot {
  id: string;
  workspace: string;
  kind: MediaMode;
  prompt: string;
  aspect: string;
  count: number;
  duration: number;
  resolution: string;
  phase: MediaJobPhase;
  startedAt: number;
  completedAt?: number;
  artifacts: MediaArtifact[];
  error?: MediaFailure;
}

interface MediaReferenceResponse { id: string }

interface MediaGenerationCapabilities {
  aspects: string[];
  imageCounts: number[];
  videoDurations: number[];
  videoResolutions: string[];
  maxActiveJobs: number;
}

interface MediaDiagnostic {
  jobId: string;
  workspace: string;
  kind: MediaMode;
  error: MediaFailure;
}

const ACTIVE_MEDIA_PHASES = new Set<MediaJobPhase>(["queued", "running", "cancelling"]);
const MEDIA_DRAFT_PREFIX = "grox.mediaDraft.v1";

interface MediaDraft {
  prompt: string;
  aspect: string;
  count: number;
  duration: number;
  resolution: string;
}

function mediaDraftKey(mode: MediaMode, workspace: string) {
  return `${MEDIA_DRAFT_PREFIX}:${mode}:${workspace}`;
}

function loadMediaDraft(mode: MediaMode, workspace: string): MediaDraft | null {
  try {
    const raw = localStorage.getItem(mediaDraftKey(mode, workspace));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<MediaDraft>;
    if (typeof value.prompt !== "string" || typeof value.aspect !== "string") return null;
    return {
      prompt: value.prompt.slice(0, 4000),
      aspect: value.aspect,
      count: Number(value.count) || 1,
      duration: Number(value.duration) || 6,
      resolution: typeof value.resolution === "string" ? value.resolution : "480p",
    };
  } catch {
    return null;
  }
}

function mediaErrorText(cause: unknown, domain: "operation" | "environment", code: string) {
  return formatGroxError(toGroxError(cause, { domain, code }));
}

export function MediaStudio({ mode }: { mode: MediaMode }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const workspace = useDesktop((state) => state.workspace);
  const initialDraft = useRef(loadMediaDraft(mode, workspace)).current;
  const fileRef = useRef<HTMLInputElement>(null);
  const referenceLeaseRef = useRef<{ id: string; cwd: string } | null>(null);
  const referenceSelectionRef = useRef(0);
  const mediaScopeRef = useRef("");
  mediaScopeRef.current = `${mode}\0${workspace}`;
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? "");
  const [aspect, setAspect] = useState(initialDraft?.aspect ?? (mode === "image" ? "1:1" : "16:9"));
  // 新工作区默认只生成一张，避免用户首次点击就无意消耗双份额度。
  const [count, setCount] = useState(initialDraft?.count ?? 1);
  const [duration, setDuration] = useState(initialDraft?.duration ?? 6);
  const [resolution, setResolution] = useState(initialDraft?.resolution ?? "480p");
  const [jobs, setJobs] = useState<MediaJobSnapshot[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<MediaGenerationCapabilities | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [reference, setReference] = useState<{ id: string; name: string; preview: string } | null>(null);
  const latestJob = jobs[0] ?? null;
  const activeJob = jobs.find((candidate) => ACTIVE_MEDIA_PHASES.has(candidate.phase)) ?? null;
  const job = (selectedJobId ? jobs.find((candidate) => candidate.id === selectedJobId) : null) ?? latestJob;
  const results = job?.artifacts ?? [];
  const busy = activeJob !== null;
  const selected = selectedIndex === null ? undefined : results[selectedIndex];
  const failureText = error || (job?.error ? `${errorDomainLabel(job.error.domain)} · ${job.error.message}` : "");

  useEffect(() => {
    localStorage.setItem(mediaDraftKey(mode, workspace), JSON.stringify({
      prompt,
      aspect,
      count,
      duration,
      resolution,
    } satisfies MediaDraft));
  }, [aspect, count, duration, mode, prompt, resolution, workspace]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenDiagnostic: (() => void) | undefined;
    setJobs([]);
    setSelectedJobId(null);
    setCapabilities(null);
    setError("");
    void (async () => {
      try {
        unlisten = await hostListen<MediaJobSnapshot>("media-generation-changed", (payload) => {
          if (disposed || payload.kind !== mode || payload.workspace !== workspace) return;
          void mediaGenerationHistory<MediaJobSnapshot[]>(workspace, mode, 12)
            .then((history) => { if (!disposed) setJobs(history); })
            .catch((cause) => { if (!disposed) setError(mediaErrorText(cause, "environment", "MEDIA_STATUS_FAILED")); });
        });
        unlistenDiagnostic = await hostListen<MediaDiagnostic>("media-generation-diagnostic", (payload) => {
          if (!disposed && payload.kind === mode && payload.workspace === workspace) {
            setError(formatGroxError(payload.error));
          }
        });
        const [history, contract] = await Promise.all([
          mediaGenerationHistory<MediaJobSnapshot[]>(workspace, mode, 12),
          mediaGenerationCapabilities<MediaGenerationCapabilities>(),
        ]);
        if (!disposed) {
          const latest = history[0];
          setJobs(history);
          setCapabilities(contract);
          if (latest && !loadMediaDraft(mode, workspace)?.prompt.trim()) {
            setPrompt(latest.prompt);
            setAspect(latest.aspect);
            setCount(latest.count);
            setDuration(latest.duration);
            setResolution(latest.resolution);
          } else {
            setAspect((current) => contract.aspects.includes(current) ? current : (contract.aspects[0] ?? "1:1"));
            setCount((current) => contract.imageCounts.includes(current) ? current : (contract.imageCounts[0] ?? 1));
            setDuration((current) => contract.videoDurations.includes(current) ? current : (contract.videoDurations[0] ?? 6));
            setResolution((current) => contract.videoResolutions.includes(current) ? current : (contract.videoResolutions[0] ?? "480p"));
          }
        }
      } catch (cause) {
        if (!disposed) setError(mediaErrorText(cause, "environment", "MEDIA_STATUS_FAILED"));
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
      unlistenDiagnostic?.();
    };
  }, [mode, workspace]);

  useEffect(() => {
    setReference(null);
    return () => {
      referenceSelectionRef.current += 1;
      const lease = referenceLeaseRef.current;
      referenceLeaseRef.current = null;
      if (lease) void releaseMediaReference(lease.cwd, lease.id);
    };
  }, [mode, workspace]);

  const runArtifactAction = async (action: () => Promise<void>) => {
    setActionError("");
    try {
      await action();
    } catch (cause) {
      setActionError(formatGroxError(toGroxError(cause, { domain: "operation", code: "MEDIA_ARTIFACT_ACTION_FAILED" })));
    }
  };

  const openSelectedArtifact = (action: "open" | "reveal") => {
    if (!job || selectedIndex === null) return Promise.resolve();
    return openMediaArtifact(workspace, job.id, selectedIndex, action);
  };

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setError("");
    setActionError("");
    setSelectedIndex(null);
    try {
      const next = await startMediaGeneration<MediaJobSnapshot>({
          kind: mode,
          prompt: prompt.trim(),
          aspect,
          count: mode === "image" ? count : 1,
          duration,
          resolution,
          referenceId: reference?.id,
          cwd: workspace,
      });
      setJobs((current) => [next, ...current.filter((candidate) => candidate.id !== next.id)].slice(0, 12));
      setSelectedJobId(null);
    } catch (cause) {
      setError(mediaErrorText(cause, "operation", "MEDIA_START_FAILED"));
    }
  };

  const cancel = async () => {
    if (!activeJob || activeJob.phase === "cancelling") return;
    setError("");
    try {
      const cancelled = await cancelMediaGeneration<MediaJobSnapshot>(workspace, activeJob.id);
      setJobs((current) => current.map((candidate) => candidate.id === cancelled.id ? cancelled : candidate));
    } catch (cause) {
      setError(mediaErrorText(cause, "operation", "MEDIA_CANCEL_FAILED"));
    }
  };

  const selectReference = async (file?: File) => {
    if (!file) return;
    const selection = ++referenceSelectionRef.current;
    const scope = mediaScopeRef.current;
    const cwd = workspace;
    setError("");
    try {
      const data = await readDataUrl(file);
      const saved = await saveMediaReference<MediaReferenceResponse>(cwd, file.name, data);
      if (selection !== referenceSelectionRef.current || scope !== mediaScopeRef.current) {
        void releaseMediaReference(cwd, saved.id);
        return;
      }
      const previous = referenceLeaseRef.current;
      referenceLeaseRef.current = { id: saved.id, cwd };
      setReference({ id: saved.id, name: file.name, preview: data });
      if (previous) void releaseMediaReference(previous.cwd, previous.id);
    } catch (cause) {
      if (selection === referenceSelectionRef.current && scope === mediaScopeRef.current) {
        setError(mediaErrorText(cause, "operation", "MEDIA_REFERENCE_FAILED"));
      }
    }
  };

  const clearReference = () => {
    referenceSelectionRef.current += 1;
    const previous = referenceLeaseRef.current;
    referenceLeaseRef.current = null;
    setReference(null);
    if (previous) void releaseMediaReference(previous.cwd, previous.id);
  };

  const ratioClass = useMemo(() => {
    if (aspect === "9:16") return "aspect-[9/16]";
    if (aspect === "4:3") return "aspect-[4/3]";
    if (aspect === "16:9") return "aspect-video";
    return "aspect-square";
  }, [aspect]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-base px-8 py-7">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-8">
        <header className="flex items-end justify-between border-b border-line pb-5">
          <div>
            <p className="lbl !text-[9px] text-faint">GROK BUILD / MEDIA PIPELINE</p>
            <h1 className="mt-2 text-[28px] font-medium tracking-[-0.03em] text-fg">
              {mode === "image" ? (zh ? "图像工作台" : "Image studio") : (zh ? "视频工作台" : "Video studio")}
            </h1>
            <p className="mt-1 text-[11px] text-dim">
              {mode === "image"
                ? (zh ? "直接使用内置生成能力，不需要额外插件。" : "Native generation, no extra service required.")
                : (zh ? "从文字或参考图开始，快速生成短片。" : "Create short clips from a prompt or reference frame.")}
            </p>
          </div>
          <div className={`flex items-center gap-2 font-mono text-[9px] ${error && !capabilities ? "text-red" : "text-green"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${error && !capabilities ? "bg-red" : "bg-green shadow-[0_0_10px_var(--color-green)]"}`} />
            {error && !capabilities ? (zh ? "Host 媒体服务不可用" : "HOST MEDIA UNAVAILABLE") : busy ? (activeJob?.phase === "cancelling" ? (zh ? "正在停止" : "STOPPING") : (zh ? "Host 正在执行" : "HOST RUNNING")) : capabilities ? (zh ? "Host 托管" : "HOST MANAGED") : (zh ? "正在读取能力" : "LOADING CAPABILITIES")}
          </div>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1fr_290px]">
          <div className="rounded-[20px] border border-line2 bg-raise p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="lbl !text-[9px]">{zh ? "描述你的创意" : "DESCRIBE YOUR IDEA"}</span>
              <span className="font-mono text-[9px] text-faint">{prompt.length}/4000</span>
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value.slice(0, 4000))}
              rows={7}
              placeholder={mode === "image" ? (zh ? "例如：雨夜中的未来城市，镜头贴近湿润的霓虹招牌…" : "A future city in the rain, close to wet neon signage…") : (zh ? "例如：一列磁悬浮列车穿过云层，镜头缓慢推进…" : "A maglev train cuts through clouds as the camera slowly pushes in…")}
              className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-fg outline-none placeholder:text-faint"
            />
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
              {mode === "video" ? <div className="flex items-center gap-2"><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void selectReference(event.target.files?.[0]); event.target.value = ""; }} /><button onClick={() => fileRef.current?.click()} disabled={busy} className="flex h-7 items-center gap-1.5 rounded-full border border-line2 px-2.5 text-[9.5px] text-dim hover:border-line3 hover:text-fg2 disabled:opacity-40"><Icon name="clip" size={10} />{reference ? reference.name : (zh ? "添加参考图" : "ADD REFERENCE")}</button>{reference && <button onClick={clearReference} disabled={busy} className="text-faint hover:text-fg disabled:opacity-40"><Icon name="x" size={9} /></button>}</div> : <span className="text-[10px] text-dim">{zh ? "由 Grok Build 内置 image_gen 执行" : "Powered by Grok Build image_gen"}</span>}
              <button onClick={() => void (busy ? cancel() : generate())} disabled={!busy && (!prompt.trim() || !capabilities)} className={`flex h-8 items-center gap-2 rounded-full px-4 font-mono text-[9.5px] tracking-[0.08em] text-base transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30 ${busy ? "border border-red/40 bg-red/10 text-red" : "bg-acc"}`}>
                <Icon name={busy ? "stop" : "play"} size={11} />
                {busy ? (activeJob?.phase === "cancelling" ? (zh ? "停止中" : "STOPPING") : (zh ? "停止" : "STOP")) : (zh ? "开始生成" : "GENERATE")}
              </button>
            </div>
          </div>

          <div className="rounded-[20px] border border-line2 bg-panel p-4">
            <span className="lbl !text-[9px]">{zh ? "输出设置" : "OUTPUT SETTINGS"}</span>
            <Setting label={zh ? "画面比例" : "ASPECT RATIO"}>
              <div className="grid grid-cols-4 gap-1">
                {(capabilities?.aspects ?? []).map((item) => <button key={item} onClick={() => setAspect(item)} className={`h-7 rounded-full border font-mono text-[9px] ${aspect === item ? "border-acc bg-acc-wash text-fg" : "border-line2 text-dim hover:text-fg2"}`}>{item}</button>)}
              </div>
            </Setting>
            {mode === "image" ? (
              <Setting label={zh ? "生成数量" : "VARIATIONS"}>
                <div className="grid grid-cols-4 gap-1">{(capabilities?.imageCounts ?? []).map((item) => <button key={item} onClick={() => setCount(item)} className={`h-7 rounded-full border font-mono text-[9px] ${count === item ? "border-acc bg-acc-wash text-fg" : "border-line2 text-dim hover:text-fg2"}`}>{item}</button>)}</div>
              </Setting>
            ) : (
              <>
                <Setting label={zh ? "时长" : "DURATION"}>
                  <ChipSelect
                    variant="field"
                    menuPlacement="down"
                    fullWidth
                    width={160}
                    activeId={String(duration)}
                    label={`${duration} sec`}
                    items={(capabilities?.videoDurations ?? []).map((seconds) => ({ id: String(seconds), label: `${seconds} sec` }))}
                    onSelect={(id) => setDuration(Number(id))}
                    aria-label={zh ? "时长" : "Duration"}
                  />
                </Setting>
                <Setting label={zh ? "分辨率" : "RESOLUTION"}>
                  <ChipSelect
                    variant="field"
                    menuPlacement="down"
                    fullWidth
                    width={160}
                    activeId={resolution}
                    label={resolution}
                    items={(capabilities?.videoResolutions ?? []).map((item) => ({ id: item, label: item }))}
                    onSelect={setResolution}
                    aria-label={zh ? "分辨率" : "Resolution"}
                  />
                </Setting>
              </>
            )}
            <div className="mt-5 border-t border-line pt-3"><p className="text-[10px] text-dim">{zh ? "预计消耗" : "ESTIMATED USE"}</p><p className="mt-1 font-mono text-[12px] text-fg">{mode === "image" ? `${count} × 1 render` : `${duration}s · ${resolution}`}</p></div>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between"><span className="lbl !text-[9px]">{zh ? "生成记录" : "GENERATIONS"}</span><span className="font-mono text-[9px] text-faint">{results.length ? `${results.length} ${zh ? "个结果" : "RESULTS"}` : (zh ? "等待输入" : "WAITING FOR INPUT")}</span></div>
          {jobs.length > 0 && <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {jobs.map((candidate, index) => <button
              key={candidate.id}
              onClick={() => { setSelectedJobId(candidate.id); setSelectedIndex(null); setActionError(""); }}
              className={`min-w-[150px] max-w-[220px] rounded-[14px] border px-3 py-2 text-left transition-colors ${candidate.id === job?.id ? "border-acc bg-acc-wash" : "border-line2 bg-panel hover:border-line3"}`}
              title={candidate.prompt}
            >
              <span className="flex items-center justify-between gap-2 font-mono text-[8.5px] text-dim"><span>{index === 0 ? (zh ? "最新" : "LATEST") : formatMediaTime(candidate.startedAt)}</span><span>{mediaPhaseLabel(candidate.phase, zh)}</span></span>
              <span className="mt-1 block truncate text-[10px] text-fg2">{candidate.prompt}</span>
            </button>)}
          </div>}
          {failureText && <div className="mb-3 rounded-[16px] border border-red/30 bg-red/5 px-3 py-2 text-[10.5px] leading-relaxed text-red"><p>{failureText}</p>{!error && job?.error?.action && <p className="mt-1 text-[9.5px] text-red/75">{job.error.action}</p>}</div>}
          {reference && mode === "video" && results.length === 0 && <div className="mb-3 flex items-center gap-3 rounded-[16px] border border-line2 bg-panel p-2.5"><img src={reference.preview} alt="" className="h-12 w-16 rounded-[12px] object-cover" /><div><p className="text-[10px] text-fg2">{reference.name}</p><p className="font-mono text-[9px] text-dim">{zh ? "将使用 image_to_video" : "IMAGE_TO_VIDEO INPUT"}</p></div></div>}
          {results.length === 0 ? <div className="flex h-44 items-center justify-center rounded-[20px] border border-dashed border-line2 bg-panel/40 px-6 text-center text-[11px] text-faint">{job && ACTIVE_MEDIA_PHASES.has(job.phase) ? (job.phase === "cancelling" ? (zh ? "Host 正在终止 Grok Build 及其媒体子进程…" : "Host is stopping Grok Build and its media subprocesses…") : (zh ? "任务由 Host 持续执行，切换页面后也可回来查看…" : "The Host keeps this job running across navigation…")) : job?.phase === "cancelled" ? (zh ? "任务已取消，没有保存不完整产物" : "Cancelled; incomplete artifacts were not attached") : (zh ? "输入提示词后，结构化产物会显示在这里" : "Structured media artifacts will appear here")}</div> : <div className={`grid gap-3 ${mode === "image" ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1"}`}>{results.map((item, index) => { const src = item.url ?? (item.path ? convertFileSrc(item.path) : ""); return <div key={`${src}-${index}`} onClick={() => setSelectedIndex(index)} className={`group relative cursor-zoom-in overflow-hidden rounded-[18px] border border-line2 bg-panel ${mode === "video" ? "aspect-video" : ratioClass}`}>{item.mime.startsWith("video/") ? <video src={src} controls onClick={(event) => event.stopPropagation()} className="absolute inset-0 h-full w-full cursor-default object-contain" /> : <img src={src} alt={job?.prompt ?? prompt} className="absolute inset-0 h-full w-full object-cover" />}<button onClick={(event) => { event.stopPropagation(); setSelectedIndex(index); }} className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white/80 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus:opacity-100" title={zh ? "预览产物" : "Preview artifact"} aria-label={zh ? "预览产物" : "Preview artifact"}><Icon name="search" size={11} /></button><div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between"><span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[9px] text-white/80 backdrop-blur">{mode === "image" ? `IMG_${String(index + 1).padStart(2, "0")}` : "VIDEO_01"}</span><span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[8px] text-white/70 backdrop-blur">{item.path ? (zh ? "本地文件" : "LOCAL") : "URL"}</span></div></div>; })}</div>}
          {selected && <div role="dialog" aria-modal="true" aria-label={zh ? "生成结果预览" : "Generated artifact preview"} onClick={() => setSelectedIndex(null)} className="fixed inset-0 z-[90] flex items-center justify-center bg-void/90 p-6 backdrop-blur-sm animate-fade-up">
            <div onClick={(event) => event.stopPropagation()} className="flex max-h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-[20px] border border-line2 bg-panel shadow-2xl">
              <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
                <Icon name="file" size={12} className="text-acc" />
                <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-fg2">{selected.path ?? selected.url}</span>
                {selected.path && <>
                  <button onClick={() => void runArtifactAction(() => openSelectedArtifact("open"))} className="flex h-7 items-center gap-1 rounded-full px-2 text-[9px] text-dim hover:bg-high hover:text-fg2" title={zh ? "用默认应用打开" : "Open with default app"}><Icon name="external" size={10} />{zh ? "打开" : "OPEN"}</button>
                  <button onClick={() => void runArtifactAction(() => openSelectedArtifact("reveal"))} className="flex h-7 items-center gap-1 rounded-full px-2 text-[9px] text-dim hover:bg-high hover:text-fg2" title={zh ? "在 Finder 中显示" : "Reveal in file manager"}><Icon name="folder" size={10} /></button>
                </>}
                {selected.url && <button onClick={() => void runArtifactAction(() => openSelectedArtifact("open"))} className="flex h-7 items-center gap-1 rounded-full px-2 text-[9px] text-dim hover:bg-high hover:text-fg2" title={zh ? "在浏览器打开" : "Open in browser"}><Icon name="external" size={10} />{zh ? "浏览器" : "BROWSER"}</button>}
                <button onClick={() => void runArtifactAction(() => navigator.clipboard.writeText(selected.path ?? selected.url ?? ""))} className="flex h-7 w-7 items-center justify-center rounded-full text-dim hover:bg-high hover:text-fg2" title={zh ? "复制路径或链接" : "Copy path or URL"}><Icon name="copy" size={10} /></button>
                <button onClick={() => setSelectedIndex(null)} className="flex h-7 w-7 items-center justify-center text-dim hover:text-fg" title={zh ? "关闭预览" : "Close preview"}><Icon name="x" size={12} /></button>
              </header>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-void p-5 checkerboard">
                {selected.mime.startsWith("video/") ? <video src={selected.url ?? (selected.path ? convertFileSrc(selected.path) : "")} controls autoPlay className="max-h-[75vh] max-w-full object-contain" /> : <img src={selected.url ?? (selected.path ? convertFileSrc(selected.path) : "")} alt={prompt} className="max-h-[75vh] max-w-full object-contain" />}
              </div>
              {actionError && <p className="shrink-0 border-t border-line px-3 py-2 font-mono text-[9px] text-red">{actionError}</p>}
            </div>
          </div>}
        </section>
      </div>
    </div>
  );
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取参考图片"));
    reader.readAsDataURL(file);
  });
}

function formatMediaTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function mediaPhaseLabel(phase: MediaJobPhase, zh: boolean): string {
  const labels: Record<MediaJobPhase, [string, string]> = {
    queued: ["排队", "QUEUED"],
    running: ["运行", "RUNNING"],
    cancelling: ["停止中", "STOPPING"],
    completed: ["完成", "DONE"],
    failed: ["失败", "FAILED"],
    cancelled: ["已取消", "CANCELLED"],
  };
  return labels[phase][zh ? 0 : 1];
}

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="mt-4"><p className="mb-1.5 font-mono text-[9px] tracking-[0.08em] text-dim">{label}</p>{children}</div>;
}
