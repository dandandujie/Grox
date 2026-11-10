import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bell, CalendarDays, Check, ChevronRight, Copy, EyeOff, MessageSquarePlus, MoreHorizontal,
  Pencil, Pin, PinOff, Plug, Plus, Search, Settings, Trash2, Users,
} from "lucide-react";
import { useApp, botUnread } from "@/state/store";
import type { Bot, Thread } from "@/lib/bridge";
import { Mascot } from "@/components/Mascot";
import { cn } from "@/lib/cn";
import { initials, sidebarTime, truncate } from "@/lib/format";
import { IconButton } from "@/components/ui";

function latestThreadOf(bot: Bot): Thread | undefined {
  return [...bot.threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

function cleanPreview(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function botPreview(bot: Bot): string {
  const thread = latestThreadOf(bot);
  if (!thread) return "Start a conversation";
  if (thread.busy) return thread.status ? thread.status + "…" : "Working…";
  const pending = [...thread.messages].reverse().find((message) => message.status === "pending");
  if (pending?.kind === "approval") return "Waiting for your approval";
  if (pending?.kind === "options") return "Waiting for your answer";
  const last = [...thread.messages].reverse().find((message) => message.text.trim() || message.kind === "notice");
  if (!last) return "Start a conversation";
  return truncate(cleanPreview(last.text), 48);
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

export function Sidebar() {
  const {
    state, activeBot, activeThread, ui, setUI, selectBot, openThread, updateBot, duplicateBot, deleteBot,
    backend, toast, patchSettings, markUnread,
  } = useApp();
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const query = ui.sidebarSearch.trim();
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(
    () => state.bots.filter((bot) => !bot.archived && (showHidden || !bot.hidden)),
    [state.bots, showHidden],
  );
  const hiddenCount = state.bots.filter((bot) => bot.hidden && !bot.archived).length;
  const ordered = useMemo(() => {
    return [...visible].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return 0;
    });
  }, [visible]);

  const botMatches = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return visible.filter((bot) =>
      [bot.name, bot.title, bot.description].some((value) => value.toLowerCase().includes(q)),
    );
  }, [visible, query]);

  const messageMatches = useMemo(() => {
    if (query.length < 2) return [];
    const q = query.toLowerCase();
    const results: { bot: Bot; thread: Thread; text: string; at: string }[] = [];
    for (const bot of visible) {
      for (const thread of bot.threads) {
        for (const message of thread.messages) {
          if (!message.text || message.pending) continue;
          if (!message.text.toLowerCase().includes(q)) continue;
          results.push({ bot, thread, text: message.text, at: message.createdAt });
        }
      }
    }
    return results.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12);
  }, [visible, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenu = (bot: Bot, x: number, y: number) => {
    setMenu({ bot, x: Math.min(x, window.innerWidth - 236), y: Math.min(y, window.innerHeight - 330) });
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = ui.sidebarWidth;
    const onMove = (move: PointerEvent) => {
      const width = Math.max(252, Math.min(420, startWidth + move.clientX - startX));
      setUI({ sidebarWidth: width });
    };
    const onUp = (up: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const width = Math.max(252, Math.min(420, startWidth + up.clientX - startX));
      void patchSettings({ sidebarWidth: width });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const totalUnread = visible.reduce((sum, bot) => sum + botUnread(bot), 0);

  return (
    <aside className="sidebar" style={{ width: ui.sidebarWidth }} data-sidebar-root>
      <div className="sidebar-top drag-region">
        <div className="sidebar-top-actions no-drag">
          <IconButton label="New bot (⌘N)" onClick={() => setUI({ newBotOpen: true })} size={30}>
            <Plus size={18} />
          </IconButton>
        </div>
      </div>

      <div className="sidebar-search-wrap">
        <div className={cn("sidebar-search", query && "has-value")}>
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            data-sidebar-search=""
            value={ui.sidebarSearch}
            onChange={(event) => setUI({ sidebarSearch: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") setUI({ sidebarSearch: "" });
            }}
            placeholder="Search"
            aria-label="Search bots and messages"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="search-clear" onClick={() => setUI({ sidebarSearch: "" })} aria-label="Clear search">
              ×
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        {query ? (
          <div className="search-results">
            <div className="sidebar-section-label">Bots</div>
            {botMatches.length === 0 && <div className="search-empty">No bots match “{query}”.</div>}
            {botMatches.map((bot) => (
              <button
                type="button"
                key={bot.id}
                className="search-result"
                onClick={() => {
                  selectBot(bot.id);
                  setUI({ sidebarSearch: "" });
                }}
              >
                <Mascot color={bot.color} shape={bot.mascotShape} expression={bot.expression} size={28} />
                <span className="search-result-body">
                  <span className="search-result-title"><Highlight text={bot.name} query={query} /></span>
                  <span className="search-result-sub">{bot.title || "Bot"}</span>
                </span>
              </button>
            ))}
            <div className="sidebar-section-label messages-label">Messages</div>
            {messageMatches.length === 0 && <div className="search-empty">No messages match “{query}”.</div>}
            {messageMatches.map((result, index) => (
              <button
                type="button"
                key={result.thread.id + result.at + index}
                className="search-result message-result"
                onClick={() => {
                  openThread(result.bot.id, result.thread.id);
                  setUI({ sidebarSearch: "" });
                }}
              >
                <Mascot color={result.bot.color} shape={result.bot.mascotShape} expression={result.bot.expression} size={24} />
                <span className="search-result-body">
                  <span className="search-result-title">
                    {result.bot.name} <span className="search-result-thread">· {result.thread.title}</span>
                  </span>
                  <span className="search-result-sub search-result-text">
                    <Highlight text={truncate(cleanPreview(result.text), 120)} query={query} />
                  </span>
                </span>
                <span className="search-result-time">{sidebarTime(result.at)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="bot-list">
            {ordered.map((bot) => {
              const thread = latestThreadOf(bot);
              const selected = activeBot?.id === bot.id && ui.view === "chat";
              const unread = botUnread(bot);
              return (
                <button
                  type="button"
                  key={bot.id}
                  data-bot-row={bot.id}
                  className={cn("bot-row", selected && "is-selected", unread > 0 && "has-unread", bot.hidden && "is-hidden")}
                  onClick={() => selectBot(bot.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(bot, event.clientX, event.clientY);
                  }}
                >
                  <span className="bot-avatar">
                    <Mascot
                      color={bot.color}
                      shape={bot.mascotShape}
                      expression={bot.expression}
                      size={42}
                      avatarUrl={bot.avatarUrl}
                      title={bot.name}
                    />
                    {bot.pinned && <Pin size={10} className="bot-pin" aria-hidden="true" />}
                  </span>
                  <span className="bot-row-body">
                    <span className="bot-row-top">
                      <span className="bot-name">{bot.name}</span>
                      {unread > 0 ? <span className="unread-dot" aria-label={unread + " unread"} /> : (
                        <span className="bot-time">{sidebarTime(thread?.updatedAt ?? bot.lastActiveAt)}</span>
                      )}
                    </span>
                    <span className={cn("bot-preview", thread?.busy && "is-working")}>
                      {thread?.busy && <span className="working-pip" aria-hidden="true" />}
                      {botPreview(bot)}
                    </span>
                  </span>
                  <span className="bot-row-actions no-drag">
                    <MoreHorizontal
                      size={16}
                      onClick={(event) => {
                        event.stopPropagation();
                        openMenu(bot, event.clientX, event.clientY);
                      }}
                    />
                  </span>
                </button>
              );
            })}
            {hiddenCount > 0 && (
              <button type="button" className="hidden-toggle" onClick={() => setShowHidden((value) => !value)}>
                <EyeOff size={12} /> {showHidden ? "Hide hidden bots" : hiddenCount + " hidden bot" + (hiddenCount === 1 ? "" : "s")}
              </button>
            )}
            {visible.length === 0 && (
              <div className="sidebar-empty">
                <p>No bots yet.</p>
                <button type="button" onClick={() => setUI({ newBotOpen: true })}><Plus size={14} /> Create a bot</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={cn("sidebar-nav-row", ui.view === "routines" && "is-active")}
          onClick={() => setUI({ view: "routines", settingsOpen: false, panel: null })}
        >
          <CalendarDays size={17} aria-hidden="true" />
          <span>Tasks &amp; routines</span>
        </button>
        <button
          type="button"
          className={cn("sidebar-nav-row", ui.view === "apps" && "is-active")}
          onClick={() => setUI({ view: "apps", settingsOpen: false, panel: null })}
        >
          <Plug size={17} aria-hidden="true" />
          <span>Connected apps</span>
          {state.connections && Object.values(state.connections).filter((connection) => connection.connected).length > 0 && (
            <span className="nav-count">{Object.values(state.connections).filter((connection) => connection.connected).length}</span>
          )}
        </button>
        <div className="sidebar-person">
          <div className="person-avatar">{initials("You")}</div>
          <span className="person-name">You</span>
          {totalUnread > 0 && <span className="person-unread">{totalUnread}</span>}
          <IconButton label="Settings (⌘,)" size={30} onClick={() => setUI({ settingsOpen: true, settingsSection: "general" })}>
            <Settings size={17} />
          </IconButton>
        </div>
      </div>

      <div className="sidebar-resizer" onPointerDown={startResize} aria-hidden="true" />

      {menu && createPortal(
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => { void updateBot(menu.bot.id, { pinned: !menu.bot.pinned }); setMenu(null); }}>
            {menu.bot.pinned ? <PinOff size={16} /> : <Pin size={16} />}
            {menu.bot.pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" role="menuitem" onClick={() => {
            const thread = latestThreadOf(menu.bot);
            if (!thread) { setMenu(null); return; }
            if (thread.unread > 0) void backend.markRead(menu.bot.id, thread.id);
            else void markUnread(menu.bot.id, thread.id);
            setMenu(null);
          }}>
            {latestThreadOf(menu.bot)?.unread ? <Check size={16} /> : <Bell size={16} />}
            {latestThreadOf(menu.bot)?.unread ? "Mark as read" : "Mark as unread"}
          </button>
          <button type="button" role="menuitem" onClick={() => {
            const thread = latestThreadOf(menu.bot);
            if (thread) void backend.select(menu.bot.id, thread.id);
            setUI({ panel: "profile", settingsOpen: false, view: "chat", activeBotId: menu.bot.id });
            setMenu(null);
          }}>
            <Pencil size={16} /> Edit profile
          </button>
          <button type="button" role="menuitem" onClick={() => { void duplicateBot(menu.bot.id); setMenu(null); }}>
            <Copy size={16} /> Duplicate
          </button>
          <button type="button" role="menuitem" onClick={() => {
            const id = latestThreadOf(menu.bot)?.id ?? menu.bot.id;
            void navigator.clipboard?.writeText(id);
            toast({ kind: "info", title: "Conversation ID copied" });
            setMenu(null);
          }}>
            <Copy size={16} /> Copy conversation ID
          </button>
          <div className="context-separator" />
          <button type="button" role="menuitem" onClick={() => { void updateBot(menu.bot.id, { hidden: !menu.bot.hidden }); setMenu(null); }}>
            <EyeOff size={16} /> {menu.bot.hidden ? "Show in sidebar" : "Hide from sidebar"}
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => { deleteBot(menu.bot.id); setMenu(null); }}>
            <Trash2 size={16} /> Delete
          </button>
        </div>,
        document.body,
      )}
    </aside>
  );
}
