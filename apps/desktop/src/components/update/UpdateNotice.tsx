import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../lib/i18n";
import {
  readSkippedUpdateVersion,
  shouldAutoOpenUpdate,
  shouldResetSessionDismiss,
  writeSkippedUpdateVersion,
} from "../../lib/updateNoticePolicy";
import { Icon } from "../fx/Icon";
import { Wordmark } from "../fx/Wordmark";

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  title: string;
  notes: string;
  releaseUrl: string;
  publishedAt?: string;
  installable: boolean;
  assetName?: string;
  requiresXattr: boolean;
}

interface ReleaseSummary {
  version: string;
  title: string;
  notes: string;
  releaseUrl: string;
  publishedAt?: string;
  installable: boolean;
}

interface UpdateStatus {
  currentVersion: string;
  updateAvailable: boolean;
  latest: UpdateInfo;
  history: ReleaseSummary[];
  rollback?: ReleaseSummary | null;
}

const UPDATE_POLL_INTERVAL_MS = 2 * 60_000;
const VISIBILITY_RECHECK_AFTER_MS = 30_000;

const formatDate = (value: string | undefined, language: string) => value
  ? new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(value))
  : null;

const releaseNotes = (notes: string, zh: boolean) => notes.trim() || (
  zh ? "此版本包含功能改进与问题修复。" : "This release includes improvements and fixes."
);

/**
 * Keeps a lightweight release heartbeat while the app is open. A new release
 * becomes an actionable notice without requiring a full app restart; opening
 * the title-bar changelog always performs a fresh, user-visible check.
 */
export function UpdateNotice() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [error, setError] = useState("");
  const lastAutomaticCheck = useRef(0);
  const inFlight = useRef(false);
  const sessionDismissed = useRef(false);
  const lastLatestVersion = useRef<string | null>(null);

  const check = useCallback(async (openWhenCurrent: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    setError("");
    try {
      const next = await invoke<UpdateStatus>("get_update_status");
      if (shouldResetSessionDismiss(lastLatestVersion.current, next.latest.latestVersion)) {
        sessionDismissed.current = false;
      }
      lastLatestVersion.current = next.latest.latestVersion;
      setStatus(next);
      if (
        openWhenCurrent
        || shouldAutoOpenUpdate({
          updateAvailable: next.updateAvailable,
          latestVersion: next.latest.latestVersion,
          skippedVersion: readSkippedUpdateVersion(),
          sessionDismissed: sessionDismissed.current,
        })
      ) {
        setOpen(true);
      }
    } catch (cause) {
      if (openWhenCurrent) setOpen(true);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, []);

  const dismissForSession = () => {
    sessionDismissed.current = true;
    setOpen(false);
  };

  const skipThisVersion = () => {
    if (status?.latest.latestVersion) writeSkippedUpdateVersion(status.latest.latestVersion);
    sessionDismissed.current = true;
    setOpen(false);
  };

  useEffect(() => {
    const automaticCheck = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAutomaticCheck.current < VISIBILITY_RECHECK_AFTER_MS) return;
      lastAutomaticCheck.current = now;
      void check(false);
    };
    const openCenter = () => {
      setOpen(true);
      void check(true);
    };
    automaticCheck();
    const timer = window.setInterval(automaticCheck, UPDATE_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", automaticCheck);
    window.addEventListener("grox:open-update-center", openCenter);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", automaticCheck);
      window.removeEventListener("grox:open-update-center", openCenter);
    };
  }, [check]);

  const install = async () => {
    if (!status?.updateAvailable) return;
    setInstalling(true);
    setError("");
    try {
      await invoke("install_update", { version: status.latest.latestVersion });
    } catch (cause) {
      setInstalling(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const rollback = async () => {
    if (!status?.rollback?.installable) return;
    setRollingBack(true);
    setError("");
    try {
      await invoke("rollback_update", { version: status.rollback.version });
    } catch (cause) {
      setRollingBack(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!open) return null;

  const update = status?.latest;
  const published = formatDate(update?.publishedAt, language);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-void/80 p-5 backdrop-blur-[4px]">
      <section className="flex max-h-[min(720px,92vh)] w-[min(620px,94vw)] flex-col overflow-hidden rounded-[9px] border border-line3 bg-panel shadow-2xl animate-fade-up" role="dialog" aria-modal="true" aria-labelledby="grox-update-title">
        <div className="flex items-center justify-between border-b border-line bg-void px-5 py-3">
          <Wordmark size={11} withMark />
          <div className="flex items-center gap-3">
            {checking && <span className="flex items-center gap-1.5 font-mono text-[9px] tracking-[0.1em] text-acc"><Icon name="refresh" size={10} className="animate-orbit" />{zh ? "检查中" : "CHECKING"}</span>}
            <button onClick={dismissForSession} className="flex h-6 w-6 items-center justify-center rounded-[3px] text-faint hover:bg-high hover:text-fg" title={zh ? "关闭" : "Close"}><Icon name="x" size={10} /></button>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto p-5">
          {!status && !error && (
            <div className="flex min-h-36 flex-col items-center justify-center gap-3 text-dim"><Icon name="refresh" size={18} className="animate-orbit text-acc" /><p className="text-[11px]">{zh ? "正在检查更新…" : "Checking for updates…"}</p></div>
          )}

          {status && update && (
            <>
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${status.updateAvailable ? "border-acc-dim bg-acc-wash text-acc" : "border-line2 bg-raise text-dim"}`}>
                  <Icon name={status.updateAvailable ? "arrowUp" : "check"} size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="grox-update-title" className="text-[15px] font-semibold text-fg">
                    {status.updateAvailable ? (zh ? "发现新版本" : "A new version is available") : (zh ? "当前已是最新版本" : "You are up to date")}
                  </h2>
                  <p className="mt-1 text-[11px] text-dim">
                    <span className="font-mono text-faint">v{status.currentVersion}</span>
                    {status.updateAvailable && <><span className="mx-2 text-faint">→</span><span className="font-mono font-medium text-acc">v{update.latestVersion}</span></>}
                    {!status.updateAvailable && <span className="ml-2 text-faint">· {zh ? "最新发布" : "latest release"} v{update.latestVersion}</span>}
                    {published && <span className="ml-2 text-faint">· {published}</span>}
                  </p>
                </div>
              </div>

              {status.updateAvailable && (
                <div className="mt-5 rounded-[6px] border border-line2 bg-raise">
                  <div className="border-b border-line px-4 py-2.5"><p className="truncate text-[11.5px] font-medium text-fg2">{update.title}</p></div>
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap px-4 py-3 font-sans text-[11px] leading-[1.75] text-mute select-text">{releaseNotes(update.notes, zh)}</pre>
                </div>
              )}

              <div className="mt-6 border-t border-line pt-4">
                <div className="mb-2 flex items-center justify-between"><h3 className="lbl !text-[9.5px]">{zh ? "更新历史" : "RELEASE HISTORY"}</h3><span className="font-mono text-[9px] text-faint">{status.history.length}</span></div>
                <div className="space-y-1.5">
                  {status.history.map((release) => (
                    <button key={`${release.version}-${release.releaseUrl}`} onClick={() => void invoke("open_external", { url: release.releaseUrl })} className="group flex w-full items-start gap-3 rounded-[5px] border border-line bg-raise px-3 py-2.5 text-left hover:border-line3 hover:bg-high/60">
                      <span className="mt-0.5 font-mono text-[9.5px] text-acc">v{release.version}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-[10.5px] text-fg2">{release.title}</span><span className="mt-0.5 block line-clamp-2 text-[9.5px] leading-relaxed text-dim">{releaseNotes(release.notes, zh)}</span></span>
                      <span className="shrink-0 font-mono text-[8.5px] text-faint">{formatDate(release.publishedAt, language) ?? ""}</span>
                      <Icon name="external" size={10} className="mt-0.5 shrink-0 text-faint group-hover:text-fg2" />
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {error && <p role="alert" className="mt-4 rounded-[5px] border border-red/25 bg-red/5 px-3 py-2 text-[10px] leading-relaxed text-red">{error}</p>}

          {status?.updateAvailable && update?.requiresXattr && (
            <div className="mt-3 flex items-start gap-2 rounded-[5px] border border-gold/25 bg-gold/5 px-3 py-2 text-[10px] leading-relaxed text-gold"><Icon name="alert" size={12} className="mt-0.5 shrink-0" /><span>{zh ? "macOS 更新会自动清除新应用包的隔离标记；如应用位于受保护目录，系统可能要求管理员授权。" : "macOS clears the new app bundle's quarantine marker automatically; protected directories may require administrator approval."}</span></div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-void px-5 py-3">
          {status?.updateAvailable && (
            <button
              disabled={installing || rollingBack}
              onClick={skipThisVersion}
              className="mr-auto flex h-8 items-center rounded-[4px] px-3 text-[10.5px] text-mute hover:text-fg2 disabled:opacity-40"
              title={zh ? "不再提醒这个版本，有更新的版本时再提示" : "Don't remind me about this version; newer releases will still notify"}
            >
              {zh ? "跳过此版本" : "Skip this version"}
            </button>
          )}
          <button disabled={checking || installing || rollingBack} onClick={() => void check(true)} className="flex h-8 items-center gap-2 rounded-[4px] border border-line2 px-3 text-[10.5px] text-mute hover:border-line3 hover:text-fg2 disabled:opacity-40"><Icon name="refresh" size={11} className={checking ? "animate-orbit" : ""} />{zh ? "手动检查更新" : "Check again"}</button>
          {status?.rollback && <button disabled={!status.rollback.installable || installing || rollingBack} onClick={() => void rollback()} className="flex h-8 items-center gap-2 rounded-[4px] border border-gold/35 bg-gold/5 px-3 text-[10.5px] text-gold hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-40" title={!status.rollback.installable ? (zh ? "上一版本缺少适用于当前系统的安装包" : "No installer for the previous version on this platform") : undefined}>{rollingBack ? (zh ? "正在回退…" : "Rolling back…") : (zh ? `一键回退到 v${status.rollback.version}` : `Roll back to v${status.rollback.version}`)}<Icon name={rollingBack ? "refresh" : "arrowDown"} size={11} className={rollingBack ? "animate-orbit" : ""} /></button>}
          {status?.updateAvailable && update && <>
            <button disabled={installing || rollingBack} onClick={() => void invoke("open_external", { url: update.releaseUrl })} className="flex h-8 items-center gap-2 rounded-[4px] border border-line2 px-3 text-[10.5px] text-mute hover:border-line3 hover:text-fg2 disabled:opacity-40">{zh ? "手动下载" : "Manual download"}<Icon name="external" size={11} /></button>
            <button disabled={!update.installable || installing || rollingBack} onClick={() => void install()} className="flex h-8 items-center gap-2 rounded-[4px] border border-acc-dim bg-acc-wash px-3 font-medium text-[10.5px] text-acc hover:bg-high disabled:cursor-not-allowed disabled:opacity-40" title={!update.installable ? (zh ? "此版本缺少适用于当前系统的安装包" : "No installer for this platform") : undefined}>{installing ? (zh ? "正在更新…" : "Updating…") : (zh ? "一键更新并重启" : "Update & restart")}<Icon name={installing ? "refresh" : "arrowUp"} size={11} className={installing ? "animate-orbit" : ""} /></button>
          </>}
        </div>
      </section>
    </div>
  );
}
