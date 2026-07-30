/* App shell — window chrome, three-column deck, overlays, keymap. */

import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { useDesktop } from "./state/store";
import { TitleBar } from "./components/chrome/TitleBar";
import { Sidebar } from "./components/chrome/Sidebar";
import { StatusBar } from "./components/chrome/StatusBar";
import { Home } from "./components/home/Home";
import { Timeline } from "./components/session/Timeline";
import { Composer } from "./components/session/Composer";
import { Inspector } from "./components/inspector/Inspector";
import { CommandPalette } from "./components/palette/CommandPalette";
import { SettingsModal } from "./components/settings/SettingsModal";
import { BlackHole } from "./components/fx/BlackHole";
import { StageTransition } from "./components/fx/StageTransition";
import { PreviewPane } from "./components/preview/PreviewPane";
import { PlanPreviewPane } from "./components/preview/PlanPreviewPane";
import { ResizeHandle } from "./components/common/ResizeHandle";
import { usePreferences } from "./state/preferences";
import { useI18n } from "./lib/i18n";
import { WorkbenchPanel } from "./components/chrome/WorkbenchPanel";
import { AccountSetup } from "./components/settings/AccountSetup";
import { UpdateNotice } from "./components/update/UpdateNotice";

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
  const sidebarWidth = usePreferences((s) => s.sidebarWidth);
  const setSidebarWidth = usePreferences((s) => s.setSidebarWidth);

  useEffect(() => {
    void init();
  }, [init]);

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
      } else if (e.key === "Escape") {
        if (s.paletteOpen) s.setPaletteOpen(false);
        else if (s.settingsOpen) s.setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ResizeHandle side="right" value={sidebarWidth} onChange={setSidebarWidth} />
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
          {terminalOpen && <WorkbenchPanel />}
        </div>
        {inspectorOpen && !planPreviewOpen && inSession && session && <Inspector />}
        {previewOpen && <PreviewPane />}
        {planPreviewOpen && inSession && session && <PlanPreviewPane />}
      </div>
      <StatusBar />
      <CommandPalette />
      <SettingsModal />
      <AccountSetup />
      <UpdateNotice />
    </div>
    </AppErrorBoundary>
  );
}
