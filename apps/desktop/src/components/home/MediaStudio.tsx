import { useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "../common/ChipSelect";
import { openFileWithConfiguredApplication } from "../../lib/defaultOpen";
import { useI18n } from "../../lib/i18n";
import { useDesktop } from "../../state/store";

type MediaMode = "image" | "video";
type Aspect = "1:1" | "16:9" | "9:16" | "4:3";

interface MediaArtifact {
  path?: string;
  url?: string;
  mime: string;
}

interface MediaGenerationResult {
  artifacts: MediaArtifact[];
  summary: string;
}

export function MediaStudio({ mode }: { mode: MediaMode }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const workspace = useDesktop((state) => state.workspace);
  const fileRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<Aspect>(mode === "image" ? "1:1" : "16:9");
  const [count, setCount] = useState(2);
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState("1080p");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MediaArtifact[]>([]);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [reference, setReference] = useState<{ name: string; path: string; preview: string } | null>(null);
  const selected = selectedIndex === null ? undefined : results[selectedIndex];

  const runArtifactAction = async (action: () => Promise<void>) => {
    setActionError("");
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    setActionError("");
    setSelectedIndex(null);
    try {
      const result = await invoke<MediaGenerationResult>("generate_media", {
        request: {
          kind: mode,
          prompt: prompt.trim(),
          aspect,
          count: mode === "image" ? count : 1,
          duration,
          resolution,
          referencePath: reference?.path,
          cwd: workspace,
        },
      });
      setResults(result.artifacts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectReference = async (file?: File) => {
    if (!file) return;
    setError("");
    try {
      const data = await readDataUrl(file);
      const path = await invoke<string>("save_media_reference", { cwd: workspace, name: file.name, data });
      setReference({ name: file.name, path, preview: data });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
          <div className="flex items-center gap-2 font-mono text-[9px] text-green">
            <span className="h-1.5 w-1.5 rounded-full bg-green shadow-[0_0_10px_var(--color-green)]" />
            {zh ? "内置引擎就绪" : "BUILT-IN ENGINE READY"}
          </div>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1fr_290px]">
          <div className="rounded-[20px] border border-line2 bg-raise p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="lbl !text-[9px]">{zh ? "描述你的创意" : "DESCRIBE YOUR IDEA"}</span>
              <span className="font-mono text-[9px] text-faint">{prompt.length}/1000</span>
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value.slice(0, 1000))}
              rows={7}
              placeholder={mode === "image" ? (zh ? "例如：雨夜中的未来城市，镜头贴近湿润的霓虹招牌…" : "A future city in the rain, close to wet neon signage…") : (zh ? "例如：一列磁悬浮列车穿过云层，镜头缓慢推进…" : "A maglev train cuts through clouds as the camera slowly pushes in…")}
              className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-fg outline-none placeholder:text-faint"
            />
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
              {mode === "video" ? <div className="flex items-center gap-2"><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void selectReference(event.target.files?.[0]); event.target.value = ""; }} /><button onClick={() => fileRef.current?.click()} className="flex h-7 items-center gap-1.5 rounded-full border border-line2 px-2.5 text-[9.5px] text-dim hover:border-line3 hover:text-fg2"><Icon name="clip" size={10} />{reference ? reference.name : (zh ? "添加参考图" : "ADD REFERENCE")}</button>{reference && <button onClick={() => setReference(null)} className="text-faint hover:text-fg"><Icon name="x" size={9} /></button>}</div> : <span className="text-[10px] text-dim">{zh ? "由 Grok Build 内置 image_gen 执行" : "Powered by Grok Build image_gen"}</span>}
              <button onClick={() => void generate()} disabled={!prompt.trim() || busy} className="flex h-8 items-center gap-2 rounded-full bg-acc px-4 font-mono text-[9.5px] tracking-[0.08em] text-base transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30">
                <Icon name={busy ? "refresh" : "play"} size={11} className={busy ? "animate-orbit" : ""} />
                {busy ? (zh ? "生成中" : "GENERATING") : (zh ? "开始生成" : "GENERATE")}
              </button>
            </div>
          </div>

          <div className="rounded-[20px] border border-line2 bg-panel p-4">
            <span className="lbl !text-[9px]">{zh ? "输出设置" : "OUTPUT SETTINGS"}</span>
            <Setting label={zh ? "画面比例" : "ASPECT RATIO"}>
              <div className="grid grid-cols-4 gap-1">
                {(["1:1", "16:9", "9:16", "4:3"] as Aspect[]).map((item) => <button key={item} onClick={() => setAspect(item)} className={`h-7 rounded-full border font-mono text-[9px] ${aspect === item ? "border-acc bg-acc-wash text-fg" : "border-line2 text-dim hover:text-fg2"}`}>{item}</button>)}
              </div>
            </Setting>
            {mode === "image" ? (
              <Setting label={zh ? "生成数量" : "VARIATIONS"}>
                <div className="grid grid-cols-4 gap-1">{[1, 2, 3, 4].map((item) => <button key={item} onClick={() => setCount(item)} className={`h-7 rounded-full border font-mono text-[9px] ${count === item ? "border-acc bg-acc-wash text-fg" : "border-line2 text-dim hover:text-fg2"}`}>{item}</button>)}</div>
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
                    items={[
                      { id: "5", label: "5 sec" },
                      { id: "10", label: "10 sec" },
                      { id: "15", label: "15 sec" },
                    ]}
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
                    items={[
                      { id: "720p", label: "720p" },
                      { id: "1080p", label: "1080p" },
                      { id: "4K", label: "4K" },
                    ]}
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
          <div className="mb-3 flex items-center justify-between"><span className="lbl !text-[9px]">{zh ? "本次生成" : "CURRENT RUN"}</span><span className="font-mono text-[9px] text-faint">{results.length ? `${results.length} ${zh ? "个结果" : "RESULTS"}` : (zh ? "等待输入" : "WAITING FOR INPUT")}</span></div>
          {error && <div className="mb-3 rounded-[16px] border border-red/30 bg-red/5 px-3 py-2 text-[10.5px] leading-relaxed text-red">{error}</div>}
          {reference && mode === "video" && results.length === 0 && <div className="mb-3 flex items-center gap-3 rounded-[16px] border border-line2 bg-panel p-2.5"><img src={reference.preview} alt="" className="h-12 w-16 rounded-[12px] object-cover" /><div><p className="text-[10px] text-fg2">{reference.name}</p><p className="font-mono text-[9px] text-dim">{zh ? "将使用 image_to_video" : "IMAGE_TO_VIDEO INPUT"}</p></div></div>}
          {results.length === 0 ? <div className="flex h-44 items-center justify-center rounded-[20px] border border-dashed border-line2 bg-panel/40 text-[11px] text-faint">{busy ? (zh ? "Grok Build 正在生成真实媒体，请保持窗口开启…" : "Grok Build is generating media…") : (zh ? "输入提示词后，实际产物会显示在这里" : "Your generated media will appear here")}</div> : <div className={`grid gap-3 ${mode === "image" ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1"}`}>{results.map((item, index) => { const src = item.url ?? (item.path ? convertFileSrc(item.path) : ""); return <div key={`${src}-${index}`} onClick={() => setSelectedIndex(index)} className={`group relative cursor-zoom-in overflow-hidden rounded-[18px] border border-line2 bg-panel ${mode === "video" ? "aspect-video" : ratioClass}`}>{item.mime.startsWith("video/") ? <video src={src} controls onClick={(event) => event.stopPropagation()} className="absolute inset-0 h-full w-full cursor-default object-contain" /> : <img src={src} alt={prompt} className="absolute inset-0 h-full w-full object-cover" />}<button onClick={(event) => { event.stopPropagation(); setSelectedIndex(index); }} className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white/80 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus:opacity-100" title={zh ? "预览产物" : "Preview artifact"} aria-label={zh ? "预览产物" : "Preview artifact"}><Icon name="search" size={11} /></button><div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between"><span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[9px] text-white/80 backdrop-blur">{mode === "image" ? `IMG_${String(index + 1).padStart(2, "0")}` : "VIDEO_01"}</span><span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[8px] text-white/70 backdrop-blur">{item.path ? (zh ? "本地文件" : "LOCAL") : "URL"}</span></div></div>; })}</div>}
          {selected && <div role="dialog" aria-modal="true" aria-label={zh ? "生成结果预览" : "Generated artifact preview"} onClick={() => setSelectedIndex(null)} className="fixed inset-0 z-[90] flex items-center justify-center bg-void/90 p-6 backdrop-blur-sm animate-fade-up">
            <div onClick={(event) => event.stopPropagation()} className="flex max-h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-[20px] border border-line2 bg-panel shadow-2xl">
              <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
                <Icon name="file" size={12} className="text-acc" />
                <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-fg2">{selected.path ?? selected.url}</span>
                {selected.path && <>
                  <button onClick={() => void runArtifactAction(() => openFileWithConfiguredApplication(workspace, selected.path!))} className="flex h-7 items-center gap-1 rounded-full px-2 text-[9px] text-dim hover:bg-high hover:text-fg2" title={zh ? "用默认应用打开" : "Open with default app"}><Icon name="external" size={10} />{zh ? "打开" : "OPEN"}</button>
                  <button onClick={() => void runArtifactAction(() => invoke("open_file_with_dialog", { cwd: workspace, path: selected.path }))} className="flex h-7 items-center gap-1 rounded-full px-2 text-[9px] text-dim hover:bg-high hover:text-fg2" title={zh ? "选择打开方式" : "Choose application"}><Icon name="external" size={10} />{zh ? "打开方式" : "WITH…"}</button>
                  <button onClick={() => void runArtifactAction(() => invoke("reveal_in_explorer", { cwd: workspace, path: selected.path }))} className="flex h-7 items-center gap-1 rounded-full px-2 text-[9px] text-dim hover:bg-high hover:text-fg2" title={zh ? "在 Finder 中显示" : "Reveal in file manager"}><Icon name="folder" size={10} /></button>
                </>}
                {selected.url && <button onClick={() => void runArtifactAction(() => invoke("open_external", { url: selected.url }))} className="flex h-7 items-center gap-1 rounded-full px-2 text-[9px] text-dim hover:bg-high hover:text-fg2" title={zh ? "在浏览器打开" : "Open in browser"}><Icon name="external" size={10} />{zh ? "浏览器" : "BROWSER"}</button>}
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

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="mt-4"><p className="mb-1.5 font-mono text-[9px] tracking-[0.08em] text-dim">{label}</p>{children}</div>;
}
