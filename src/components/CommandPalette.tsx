import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CalendarDays, Command, Keyboard, MessageSquarePlus, Palette, Plug, Plus, Search,
  Settings, Sparkles, PanelRight, UserRound, Download,
} from "lucide-react";
import { useApp } from "@/state/store";
import { Mascot } from "@/components/Mascot";
import { cn } from "@/lib/cn";

interface Item {
  id: string;
  label: string;
  sub?: string;
  icon?: ReactNode;
  section: string;
  run: () => void;
}

export function CommandPalette() {
  const {
    ui, setUI, state, selectBot, newTask, patchSettings, exportWorkspace,
  } = useApp();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = ui.paletteOpen;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const bots: Item[] = state.bots
      .filter((bot) => !bot.hidden && !bot.archived)
      .map((bot) => ({
        id: "bot-" + bot.id,
        label: bot.name,
        sub: bot.title || "Bot",
        icon: <Mascot color={bot.color} shape={bot.mascotShape} expression={bot.expression} size={22} avatarUrl={bot.avatarUrl} />,
        section: "Bots",
        run: () => { selectBot(bot.id); setUI({ paletteOpen: false }); },
      }));
    const actions: Item[] = [
      { id: "new-bot", label: "New bot", sub: "Create a new contact", icon: <Plus size={16} />, section: "Actions", run: () => setUI({ paletteOpen: false, newBotOpen: true }) },
      { id: "new-task", label: "New task", sub: "Start a fresh conversation", icon: <MessageSquarePlus size={16} />, section: "Actions", run: () => { setUI({ paletteOpen: false }); newTask(); } },
      { id: "profile", label: "Open agent profile", sub: "Avatar, instructions, approvals", icon: <PanelRight size={16} />, section: "Actions", run: () => setUI({ paletteOpen: false, panel: "profile" }) },
      { id: "routines", label: "Tasks & routines", sub: "Schedule a recurring task", icon: <CalendarDays size={16} />, section: "Navigate", run: () => setUI({ paletteOpen: false, view: "routines", panel: null }) },
      { id: "apps", label: "Connected apps", sub: "Marketplace of tools", icon: <Plug size={16} />, section: "Navigate", run: () => setUI({ paletteOpen: false, view: "apps", panel: null }) },
      { id: "settings", label: "Settings", sub: "General, engines, keys", icon: <Settings size={16} />, section: "Navigate", run: () => setUI({ paletteOpen: false, settingsOpen: true, settingsSection: "general" }) },
      { id: "theme", label: "Switch appearance", sub: "Cycle Midnight, Daylight, Atelier, Foundry", icon: <Palette size={16} />, section: "Actions", run: () => {
        const order = ["midnight", "daylight", "atelier", "foundry"];
        const next = order[(order.indexOf(state.settings.theme) + 1) % order.length]!;
        void patchSettings({ theme: next });
        setUI({ paletteOpen: false });
      } },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={16} />, section: "Help", run: () => setUI({ paletteOpen: false, shortcutsOpen: true }) },
      { id: "export", label: "Export workspace", sub: "A readable JSON copy", icon: <Download size={16} />, section: "Actions", run: () => { setUI({ paletteOpen: false }); void exportWorkspace(); } },
    ];
    return [...bots, ...actions];
  }, [state.bots, state.settings.theme, selectBot, newTask, patchSettings, exportWorkspace, setUI]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 18);
    return items.filter((item) => (item.label + " " + (item.sub ?? "")).toLowerCase().includes(q)).slice(0, 18);
  }, [items, query]);

  useEffect(() => {
    if (index >= filtered.length) setIndex(0);
  }, [filtered.length, index]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setUI({ paletteOpen: false });
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((value) => (filtered.length ? (value + 1) % filtered.length : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((value) => (filtered.length ? (value - 1 + filtered.length) % filtered.length : 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        filtered[index]?.run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, index, setUI]);

  if (!open) return null;

  let section = "";
  return (
    <div className="modal-layer palette-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUI({ paletteOpen: false }); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-search">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
            placeholder="Search bots and actions…"
            aria-label="Search commands"
            spellCheck={false}
          />
          <span className="keycap">esc</span>
        </div>
        <div className="palette-results">
          {filtered.length === 0 && <div className="palette-empty">No command matches “{query}”.</div>}
          {filtered.map((item, itemIndex) => {
            const showSection = item.section !== section;
            section = item.section;
            return (
              <div key={item.id}>
                {showSection && <div className="palette-section">{item.section}</div>}
                <button
                  type="button"
                  className={cn("palette-item", itemIndex === index && "is-active")}
                  onMouseEnter={() => setIndex(itemIndex)}
                  onClick={item.run}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-copy">
                    <span>{item.label}</span>
                    {item.sub && <span>{item.sub}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><span className="keycap">↑</span><span className="keycap">↓</span> navigate</span>
          <span><span className="keycap">↵</span> open</span>
          <span className="palette-brand"><Sparkles size={12} /> Grox commands</span>
        </div>
      </div>
    </div>
  );
}
