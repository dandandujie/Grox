import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { createBackend, type Backend, type Bootstrap } from "@/lib/bridge";
import { AppProvider, useApp } from "@/state/store";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { BotPanel } from "@/components/BotPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { NewBotDialog } from "@/components/NewBotDialog";
import { NewChannelDialog } from "@/components/NewChannelDialog";
import { GroupPanel } from "@/components/GroupPanel";
import { CallSheet } from "@/components/CallSheet";
import { RoutinesPage } from "@/components/RoutinesPage";
import { AppsPage } from "@/components/AppsPage";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialog, ShortcutsModal, Toasts } from "@/components/Overlays";
import { GroxLogo } from "@/components/Icons";
import { Mascot } from "@/components/Mascot";
import { cn } from "@/lib/cn";

function Shell() {
  const {
    state, ui, setUI, activeBot, activeGroup, selectBot, newTask,
  } = useApp();

  useEffect(() => {
    const theme = state.settings.theme || "midnight";
    const light = theme === "daylight" || theme === "atelier";
    document.documentElement.dataset.skin = theme;
    document.documentElement.style.colorScheme = light ? "light" : "dark";
    document.documentElement.dataset.motion = state.settings.reduceMotion ? "reduced" : "full";
  }, [state.settings.theme, state.settings.reduceMotion]);

  useEffect(() => {
    if (activeGroup) document.title = "# " + activeGroup.name + " · Grox";
    else if (activeBot) document.title = activeBot.name + " · Grox";
    else document.title = "Grox";
  }, [activeBot, activeGroup]);

  useEffect(() => {
    if (ui.sidebarWidth !== state.settings.sidebarWidth) {
      setUI({ sidebarWidth: state.settings.sidebarWidth });
    }
  }, [state.settings.sidebarWidth, ui.sidebarWidth, setUI]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "k") {
        event.preventDefault();
        setUI({ paletteOpen: !ui.paletteOpen });
        return;
      }
      if (mod && key === ",") {
        event.preventDefault();
        setUI({ settingsOpen: true, settingsSection: "general" });
        return;
      }
      if (mod && key === "n") {
        event.preventDefault();
        if (event.shiftKey) newTask();
        else setUI({ newBotOpen: true });
        return;
      }
      if (mod && key === "/") {
        event.preventDefault();
        setUI({ shortcutsOpen: true });
        return;
      }
      if (mod && key === "f") {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>("[data-sidebar-search]");
        input?.focus();
        input?.select();
        return;
      }
      if (mod && /^[1-9]$/.test(key)) {
        const bots = state.bots.filter((bot) => !bot.hidden && !bot.archived);
        const target = bots[Number(key) - 1];
        if (target) {
          event.preventDefault();
          selectBot(target.id);
        }
        return;
      }
      if (event.key === "Escape") {
        if (ui.settingsOpen) setUI({ settingsOpen: false });
        else if (ui.paletteOpen) setUI({ paletteOpen: false });
        else if (ui.newBotOpen) setUI({ newBotOpen: false });
        else if (ui.newChannelOpen) setUI({ newChannelOpen: false });
        else if (ui.callOpen) setUI({ callOpen: false });
        else if (ui.shortcutsOpen) setUI({ shortcutsOpen: false });
        else if (ui.modelPickerOpen) setUI({ modelPickerOpen: false });
        else if (ui.threadMenuOpen) setUI({ threadMenuOpen: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui.settingsOpen, ui.paletteOpen, ui.newBotOpen, ui.newChannelOpen, ui.callOpen, ui.shortcutsOpen, ui.modelPickerOpen, ui.threadMenuOpen, state.bots, selectBot, newTask, setUI]);

  return (
    <div
      className={cn("app-shell", ui.panel && ui.view === "chat" && "has-panel")}
      style={{ "--sidebar-width": ui.sidebarWidth + "px" } as React.CSSProperties}
    >
      <Sidebar />
      <main className="workspace">
        {ui.view === "chat" && <ChatView />}
        {ui.view === "routines" && <RoutinesPage />}
        {ui.view === "apps" && <AppsPage />}
      </main>
      {ui.view === "chat" && ui.panel && (activeGroup ? <GroupPanel /> : <BotPanel />)}
      <SettingsModal />
      <NewBotDialog />
      <NewChannelDialog />
      <CommandPalette />
      <ConfirmDialog />
      <ShortcutsModal />
      <CallSheet />
      <Toasts />
    </div>
  );
}

function Loading() {
  return (
    <div className="boot-screen">
      <div className="boot-mark">
        <Mascot color="green" expression="curious" size={82} animated />
      </div>
      <GroxLogo size={30} />
      <h1>Grox</h1>
      <p>Opening your workspace</p>
      <span className="boot-spinner" />
    </div>
  );
}

function BootError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="boot-screen">
      <Mascot color="red" expression="suspicious" size={74} />
      <h1>Grox could not open</h1>
      <p className="boot-error">{message}</p>
      <button type="button" className="btn btn-secondary" onClick={retry}><RefreshCw size={14} /> Try again</button>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<{ backend: Backend; boot: Bootstrap } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSession(null);
    void (async () => {
      try {
        const backend = await createBackend();
        const boot = await backend.bootstrap();
        if (!cancelled) setSession({ backend, boot });
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  if (error) return <BootError message={error} retry={() => setAttempt((value) => value + 1)} />;
  if (!session) return <Loading />;
  return (
    <AppProvider backend={session.backend} boot={session.boot}>
      <Shell />
    </AppProvider>
  );
}
