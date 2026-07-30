import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDesktop } from "../../state/store";
import { usePreferences } from "../../state/preferences";
import { useI18n } from "../../lib/i18n";
import { Markdown } from "../../lib/markdown";
import { Icon } from "../fx/Icon";
import { ResizeHandle } from "../common/ResizeHandle";

export function PreviewPane() {
  const { t, language } = useI18n();
  const file = useDesktop((state) => state.previewFile);
  const loading = useDesktop((state) => state.previewLoading);
  const error = useDesktop((state) => state.previewError);
  const close = useDesktop((state) => state.closePreview);
  const workspace = useDesktop((state) => state.workspace);
  const setInspectorTab = useDesktop((state) => state.setInspectorTab);
  const width = usePreferences((state) => state.previewWidth);
  const setWidth = usePreferences((state) => state.setPreviewWidth);
  const [notice, setNotice] = useState("");
  const run = (action: () => Promise<void>) => {
    setNotice("");
    void action().catch((cause) => setNotice(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <>
      <ResizeHandle side="left" value={width} onChange={setWidth} />
      <aside
        className="flex min-w-0 shrink-0 flex-col border-l border-line bg-raise"
        style={{ width }}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <Icon name="file" size={12} className="text-acc" />
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg2">
            {file?.name ?? t("preview")}
          </span>
          {file?.kind && <span className="lbl !text-[9.5px]">{file.kind}</span>}
          {file && <>
            <button onClick={() => setInspectorTab("files")} className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg" title={languageLabel(language, "files")}><Icon name="folder" size={11} /></button>
            <button onClick={() => run(() => navigator.clipboard.writeText(file.path).then(() => undefined))} className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg" title={languageLabel(language, "copyPath")}><Icon name="copy" size={11} /></button>
            {file.kind !== "image" && <button onClick={() => run(() => navigator.clipboard.writeText(file.content).then(() => undefined))} className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg" title={languageLabel(language, "copyContents")}><Icon name="copy" size={10} /></button>}
            <button onClick={() => run(() => invoke("reveal_in_explorer", { cwd: workspace, path: file.path }))} className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg" title={languageLabel(language, "reveal")}><Icon name="folder" size={11} /></button>
            <button onClick={() => run(() => invoke("open_file_with_default", { cwd: workspace, path: file.path }))} className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg" title={languageLabel(language, "openDefault")}><Icon name="external" size={11} /></button>
          </>}
          <button
            onClick={close}
            className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg"
            title={t("closePreview")}
          >
            <Icon name="x" size={12} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-base">
          {loading ? (
            <PaneMessage text={t("loading")} />
          ) : error ? (
            <PaneMessage text={error} error />
          ) : !file ? (
            <PaneMessage text={t("noFiles")} />
          ) : file.kind === "markdown" ? (
            <article className="mx-auto max-w-[760px] p-5 text-[14px] leading-relaxed text-fg2">
              <Markdown text={file.content} />
            </article>
          ) : file.kind === "html" ? (
            <iframe
              key={file.url}
              title={file.name}
              sandbox=""
              src={file.url}
              className="h-full min-h-[320px] w-full border-0 bg-white"
            />
          ) : file.kind === "image" ? (
            <div className="flex min-h-full items-center justify-center p-4 checkerboard">
              <img
                src={`data:${file.mime};base64,${file.content}`}
                alt={file.name}
                className="max-h-full max-w-full object-contain shadow-2xl"
              />
            </div>
          ) : (
            <pre className="min-h-full whitespace-pre-wrap p-4 font-mono text-[11px] leading-relaxed text-fg2 select-text">
              {file.content}
            </pre>
          )}
        </div>
        {file && (
          <footer className="shrink-0 truncate border-t border-line px-3 py-1.5 font-mono text-[9.5px] text-faint">
            {notice || file.path}
          </footer>
        )}
      </aside>
    </>
  );
}

function languageLabel(language: "zh-CN" | "en-US", key: "files" | "copyPath" | "copyContents" | "reveal" | "openDefault") {
  const labels = language === "zh-CN"
    ? { files: "文件列表", copyPath: "复制路径", copyContents: "复制内容", reveal: "在 Finder 中显示", openDefault: "用默认应用打开" }
    : { files: "Files", copyPath: "Copy path", copyContents: "Copy contents", reveal: "Reveal in file manager", openDefault: "Open with default app" };
  return labels[key];
}
function PaneMessage({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div className="flex h-full min-h-52 items-center justify-center p-6 text-center">
      <span className={`font-mono text-[10px] ${error ? "text-red" : "text-dim"}`}>{text}</span>
    </div>
  );
}
