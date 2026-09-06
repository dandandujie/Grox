/* App shell — window chrome, three-column deck, overlays, keymap. */

import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from "react";
import { useDesktop } from "./state/store";
import { TitleBar } from "./components/chrome/TitleBar";
import { StatusBar } from "./components/chrome/StatusBar";
import { SidebarDock } from "./components/chrome/SidebarDock";
import { Home } from "./components/home/Home";
import { Timeline } from "./components/session/Timeline";
import { Composer } from "./components/session/Composer";
import { Inspector } from "./components/inspector/Inspector";
import { CommandPalette } from "./components/palette/CommandPalette";
import { BlackHole } from "./components/fx/BlackHole";
import { StageTransition } from "./components/fx/StageTransition";
import { PreviewPane } from "./components/preview/PreviewPane";
import { PlanPreviewPane } from "./components/preview/PlanPreviewPane";
import { usePreferences } from "./state/preferences";
import { useI18n } from "./lib/i18n";
import { WorkbenchPanel } from "./components/chrome/WorkbenchPanel";
import { AccountSetup } from "./components/settings/AccountSetup";
import { UpdateNotice } from "./components/update/UpdateNotice";
import { RuntimeNotice } from "./components/update/RuntimeNotice";

const SettingsModal = lazy(() => import("./components/settings/SettingsModal").then((module) => ({ default: module.SettingsModal })));

class AppErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Grox UI render failed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-base px-8 text-center">
        <BlackHole size={34} />
        <p className="font-mono text-[12px] text-fg">界面遇到异常，但会话没有被删除</p>
        <p className="max-w-[680px] break-words font-mono text-[10px] leading-relaxed text-dim">{this.state.error.message}</p>
        <button onClick={() => window.location.reload()} className="rounded-[5px] border border-line2 px-3 py-2 font-mono text-[10px] text-acc hover:border-acc-dim hover:text-fg">重新载入界面</button>
      </div>
    );
  }
}

export default function App() {
  const { language } = useI18n();
  const init = useDesktop((s) => s.init);
  const ready = useDesktop((s) => s.ready);
  const view = useDesktop((s) => s.view);
  const activeId = useDesktop((s) => s.activeId);
  const session = useDesktop((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const inspectorOpen = useDesktop((s) => s.inspectorOpen);
  const terminalOpen = useDesktop((s) => s.terminalOpen);
  const previewOpen = useDesktop((s) => s.previewOpen);
  const planPreviewOpen = useDesktop((s) => s.planPreviewOpen);
  const settingsOpen = useDesktop((s) => s.settingsOpen);
  const sidebarVisible = usePreferences((s) => s.sidebarVisible);
  const sidebarWidth = usePreferences((s) => s.sidebarWidth);
  const setSidebarWidth = usePreferences((s) => s.setSidebarWidth);
  const toggleSidebar = usePreferences((s) => s.toggleSidebar);

  useEffect(() => {
    void init();
  }, [init]);

  // Shrink BSOD / hard-kill loss window: flush UI cache + catalog when the
  // window is backgrounded or the page is being torn down.
  useEffect(() => {
    const flush = () => {
      try {
        useDesktop.getState().flushDurableState();
      } catch {
        // ignore
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useDesktop.getState();
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void s.newProject();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        s.setSettingsOpen(true);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        s.toggleInspector();
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "Escape") {
        if (e.isComposing || e.keyCode === 229) return;
        if (s.paletteOpen) { s.setPaletteOpen(false); return; }
        if (s.settingsOpen) { s.setSettingsOpen(false); return; }
        // 覆盖层（确认框、图片预览、更新说明等）优先消费 Esc；只有在干净
        // 界面下 Esc 才中止运行中的回合，避免误停。
        if (document.querySelector("[role='dialog'],[role='alertdialog']")) return;
        if (s.view === "session" && s.activeId && s.sessions[s.activeId]?.status === "running") {
          e.preventDefault();
          s.stop();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  if (!ready) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-base">
        <BlackHole size={38} spin />
        <span className="lbl">{language === "zh-CN" ? "正在连接 GROK" : "ESTABLISHING LINK"}</span>
      </div>
    );
  }

  const inSession = view === "session" && activeId;

  return (
    <AppErrorBoundary>
    <div className="flex h-screen flex-col bg-base">
      <TitleBar />
      <RuntimeNotice />
      <div className="relative flex min-h-0 flex-1">
        <SidebarDock visible={sidebarVisible} width={sidebarWidth} onResize={setSidebarWidth} />
        <div className="flex min-w-0 flex-1 flex-col bg-base">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <StageTransition
              stageKey={inSession ? (session ? `session-${activeId}` : `restore-${activeId}`) : "home"}
              variant={inSession ? "deck" : "home"}
            >
              {inSession && session ? (
                <>
                  <Timeline session={session} />
                  <Composer />
                </>
              ) : inSession && !session ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3">
                  <BlackHole size={28} spin />
                  <span className="lbl !text-[10px]">{language === "zh-CN" ? "正在恢复任务" : "RESTORING MISSION"}</span>
                </div>
              ) : (
                <Home />
              )}
            </StageTransition>
          </main>
        </div>
        {inspectorOpen && !planPreviewOpen && inSession && session && <Inspector />}
        {terminalOpen && <WorkbenchPanel />}
        {previewOpen && <PreviewPane />}
        {planPreviewOpen && inSession && session && <PlanPreviewPane />}
      </div>
      {inSession && <StatusBar />}
      <CommandPalette />
      {settingsOpen && <Suspense fallback={null}><SettingsModal /></Suspense>}
      <AccountSetup />
      <UpdateNotice />
    </div>
    </AppErrorBoundary>
  );
}
