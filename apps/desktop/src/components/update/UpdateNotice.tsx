import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { Wordmark } from "../fx/Wordmark";

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  title: string;
  notes: string;
  releaseUrl: string;
  publishedAt?: string;
}

export function UpdateNotice() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const checked = useRef(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    const timer = window.setTimeout(() => {
      void invoke<UpdateInfo | null>("check_for_update")
        .then((result) => setUpdate(result))
        .catch(() => undefined);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, []);

  if (!update) return null;

  const notes = update.notes.trim() || (zh ? "此版本包含功能改进与问题修复。" : "This release includes improvements and fixes.");
  const published = update.publishedAt
    ? new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(update.publishedAt))
    : null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-void/80 p-5 backdrop-blur-[4px]">
      <section className="w-[min(520px,92vw)] overflow-hidden rounded-[9px] border border-line3 bg-panel shadow-2xl animate-fade-up" role="dialog" aria-modal="true" aria-labelledby="grox-update-title">
        <div className="flex items-center justify-between border-b border-line bg-void px-5 py-3">
          <Wordmark size={11} withMark />
          <span className="font-mono text-[9.5px] tracking-[0.12em] text-faint">UPDATE SIGNAL</span>
        </div>
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-acc-dim bg-acc-wash text-acc">
              <Icon name="arrowUp" size={15} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="grox-update-title" className="text-[15px] font-semibold text-fg">{zh ? "发现新版本" : "A new version is available"}</h2>
              <p className="mt-1 text-[11px] text-dim">
                <span className="font-mono text-faint">v{update.currentVersion}</span>
                <span className="mx-2 text-faint">→</span>
                <span className="font-mono font-medium text-acc">v{update.latestVersion}</span>
                {published && <span className="ml-2 text-faint">· {published}</span>}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-[6px] border border-line2 bg-raise">
            <div className="border-b border-line px-4 py-2.5">
              <p className="truncate text-[11.5px] font-medium text-fg2">{update.title}</p>
            </div>
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap px-4 py-3 font-sans text-[11px] leading-[1.75] text-mute select-text">{notes}</pre>
          </div>

          <p className="mt-3 text-[10px] leading-relaxed text-faint">
            {zh ? "更新页面会提供与你当前系统对应的安装包。" : "The release page provides the installer for your current platform."}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setUpdate(null)} className="h-8 rounded-[4px] border border-line2 px-3 text-[10.5px] text-mute hover:border-line3 hover:text-fg2">
              {zh ? "稍后提醒" : "Later"}
            </button>
            <button onClick={() => void invoke("open_external", { url: update.releaseUrl })} className="flex h-8 items-center gap-2 rounded-[4px] border border-acc-dim bg-acc-wash px-3 font-medium text-[10.5px] text-acc hover:bg-high">
              {zh ? "前往更新" : "Open update"}
              <Icon name="external" size={11} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
