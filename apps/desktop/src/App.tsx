/* App shell — window chrome, three-column deck, overlays, keymap. */

import { useEffect } from "react";
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
import { PreviewPane } from "./components/preview/PreviewPane";
import { ResizeHandle } from "./components/common/ResizeHandle";
import { usePreferences } from "./state/preferences";
import { useI18n } from "./lib/i18n";
import { AccountSetup } from "./components/settings/AccountSetup";

export default function App() {
  const { language } = useI18n();
  const ready = useDesktop((s) => s.ready);
  const view = useDesktop((s) => s.view);
  const activeId = useDesktop((s) => s.activeId);
  const session = useDesktop((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const inspectorOpen = useDesktop((s) => s.inspectorOpen);
  const previewOpen = useDesktop((s) => s.previewOpen);
  const sidebarWidth = usePreferences((s) => s.sidebarWidth);
  const setSidebarWidth = usePreferences((s) => s.setSidebarWidth);

  useEffect(() => {
    void useDesktop.getState().init();
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
    <div className="flex h-screen flex-col bg-base">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ResizeHandle side="right" value={sidebarWidth} onChange={setSidebarWidth} />
        <main className="flex min-w-0 flex-1 flex-col bg-base">
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
        </main>
        {inspectorOpen && inSession && session && <Inspector />}
        {previewOpen && <PreviewPane />}
      </div>
      <StatusBar />
      <CommandPalette />
      <SettingsModal />
      <AccountSetup />
    </div>
  );
}
