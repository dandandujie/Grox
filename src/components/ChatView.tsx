import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, Check, ChevronDown, FolderOpen, Loader2, MessagesSquare, Monitor, Phone, PanelRight,
  Pencil, Plus, SquarePen, Trash2, X,
} from "lucide-react";
import { useApp } from "@/state/store";
import type { Message } from "@/lib/bridge";
import { Mascot } from "@/components/Mascot";
import { MessageItem, WorkingRow } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { ModelPicker } from "@/components/ModelPicker";
import { IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { clock, dayKey, dayLabel, sidebarTime } from "@/lib/format";

function DaySeparator({ label }: { label: string }) {
  return <div className="day-separator"><span>{label}</span></div>;
}

function EmptyConversation() {
  const { activeBot, activeGroup, activeThread } = useApp();
  const name = activeGroup ? "# " + activeGroup.name : activeBot?.name;
  if (!name) return null;
  const task = activeThread?.kind === "task";
  return (
    <div className="empty-conversation">
      <Mascot seed={name} avatarUrl={activeBot?.avatarUrl} size={64} />
      <h2>{task ? "New task" : name}</h2>
      <p>{activeGroup?.description || (activeGroup
        ? "Message the channel or mention a bot by name."
        : task ? "Describe what you want done and what the result should include." : activeBot?.description || "What would you like help with?")}</p>
    </div>
  );
}

function ThreadPopover() {
  const { activeBot, activeGroup, activeThread, ui, setUI, openThread, openGroupThread, newTask, deleteThread, renameThread } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (!ui.threadMenuOpen) {
      setEditing(null);
      setDraft("");
      return;
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".thread-popover") || target?.closest(".thread-toggle")) return;
      setUI({ threadMenuOpen: false });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUI({ threadMenuOpen: false });
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [ui.threadMenuOpen, setUI]);

  if ((!activeBot && !activeGroup) || !ui.threadMenuOpen) return null;
  const threads = [...(activeGroup ? activeGroup.threads : activeBot?.threads ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <div className="thread-popover" role="dialog" aria-label="Conversations">
      <div className="thread-popover-head">
        <span>Conversations</span>
        <button type="button" className="thread-new" onClick={() => { setUI({ threadMenuOpen: false }); newTask(); }}>
          <Plus size={14} /> New task
        </button>
      </div>
      <div className="thread-list">
        {threads.map((thread) => {
          const selected = thread.id === activeThread?.id;
          return (
            <div key={thread.id} className={cn("thread-row", selected && "is-selected")}>
              {editing === thread.id ? (
                <form
                  className="thread-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.trim()) void renameThread(thread.id, draft.trim());
                    setEditing(null);
                  }}
                >
                  <input
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => { if (draft.trim()) void renameThread(thread.id, draft.trim()); setEditing(null); }}
                  />
                </form>
              ) : (
                <button type="button" className="thread-main" onClick={() => {
                  if (activeGroup) openGroupThread(activeGroup.id, thread.id);
                  else if (activeBot) openThread(activeBot.id, thread.id);
                  setUI({ threadMenuOpen: false });
                }}>
                  <span className="thread-title">{thread.title}</span>
                  <span className="thread-meta">
                    {thread.kind === "task" ? "Task" : thread.kind === "group" ? "Channel" : "Chat"} · {sidebarTime(thread.updatedAt)}
                    {thread.unread > 0 && <span className="thread-unread">{thread.unread}</span>}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="thread-action"
                title="Rename"
                aria-label="Rename conversation"
                onClick={() => { setEditing(thread.id); setDraft(thread.title); }}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                className="thread-action danger"
                title="Delete"
                aria-label="Delete conversation"
                onClick={() => deleteThread(thread.id)}
              >
                <Trash2 size={13} />
              </button>
              {selected && <Check size={14} className="thread-check" />}
            </div>
          );
        })}
      </div>
      <div className="thread-popover-foot">{activeGroup ? "Every channel keeps its own conversation. Tasks start a fresh one." : "Every bot keeps its own threads. Tasks start a fresh one."}</div>
    </div>
  );
}

export function ChatView({ visible }: { visible: boolean }) {
  const {
    activeBot, activeGroup, activeThread, state, ui, setUI, decide, answer, newTask, toast,
  } = useApp();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [threadId, setThreadId] = useState(activeThread?.id ?? "");
  const lead = activeGroup ? state.bots.find((bot) => bot.id === activeGroup.leadId) : activeBot;
  const groupMembers = activeGroup
    ? activeGroup.memberIds.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is NonNullable<typeof bot> => Boolean(bot))
    : [];

  const messages = useMemo(() => activeThread?.messages ?? [], [activeThread]);
  const last = messages[messages.length - 1];
  const lastLength = last?.text.length ?? 0;

  useEffect(() => {
    if (activeThread?.id !== threadId) {
      setThreadId(activeThread?.id ?? "");
      setNearBottom(true);
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    }
  }, [activeThread?.id, threadId]);

  useEffect(() => {
    if (!visible || !nearBottom) return;
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, lastLength, activeThread?.busy, nearBottom, visible]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setNearBottom(distance < 120);
  };

  const jumpToLatest = () => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    setNearBottom(true);
  };

  const rendered = useMemo(() => {
    const nodes: ReactNode[] = [];
    let lastDay = "";
    for (const message of messages) {
      const key = dayKey(message.createdAt);
      if (key !== lastDay) {
        nodes.push(<DaySeparator key={"day-" + key + message.id} label={dayLabel(message.createdAt)} />);
        lastDay = key;
      }
      const sender = activeGroup && message.senderId
        ? state.bots.find((bot) => bot.id === message.senderId)
        : undefined;
      const messageBot = sender ?? lead ?? activeBot;
      if (!messageBot) continue;
      nodes.push(
        <MessageItem
          key={message.id}
          message={message}
          bot={messageBot}
          showSender={Boolean(activeGroup)}
          onDecide={(id, decision) => void decide(id, decision)}
          onAnswer={(id, choice) => void answer(id, choice)}
        />,
      );
    }
    return nodes;
  }, [messages, activeGroup, activeBot, lead, state.bots, decide, answer]);

  if (!activeBot && !activeGroup) {
    return (
      <section className="chat-view empty-workspace" hidden={!visible}>
        <div className="empty-conversation">
          <Mascot seed="Grox" size={76} />
          <h2>No bots yet</h2>
          <p>Create your first bot and give it a job. It will get its own conversations and model.</p>
          <button type="button" className="btn btn-primary" onClick={() => setUI({ newBotOpen: true })}>
            <Plus size={15} /> Create a bot
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-view" hidden={!visible}>
      <header className="chat-head drag-region">
        <div className="chat-head-left no-drag">
          {activeGroup ? (
            <Mascot seed={activeGroup.name} size={28} />
          ) : activeBot ? (
            <Mascot
              color={activeBot.color}
              shape={activeBot.mascotShape}
              expression={activeBot.expression}
              size={28}
              avatarUrl={activeBot.avatarUrl}
              title={activeBot.name}
            />
          ) : null}
          <button
            type="button"
            className="chat-title"
            aria-label="Conversations"
            aria-expanded={ui.threadMenuOpen}
            title={activeThread?.title || "Conversations"}
            onClick={() => setUI({ threadMenuOpen: !ui.threadMenuOpen })}
          >
            <span className="chat-context">
              <span className="chat-owner">{activeGroup ? "# " + activeGroup.name : activeBot?.name}</span>
              <span className="chat-thread-title">{activeThread?.title || "Conversations"}</span>
            </span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="chat-head-actions no-drag">
          <button type="button" className="head-task" onClick={newTask}>
            <Plus size={14} /> Task
          </button>
          {lead && <ModelPicker bot={lead} />}
          <IconButton label="Call" active={ui.callOpen} onClick={() => setUI({ callOpen: true, callMuted: false })}>
            <Phone size={17} />
          </IconButton>
          {!activeGroup && (
            <IconButton label="Computer" active={ui.panel === "computer"} onClick={() => setUI({ panel: ui.panel === "computer" ? null : "computer" })}>
              <Monitor size={17} />
            </IconButton>
          )}
          <IconButton label="Conversation files" active={ui.panel === "artifacts"} onClick={() => setUI({ panel: ui.panel === "artifacts" ? null : "artifacts" })}>
            <FolderOpen size={17} />
          </IconButton>
          <IconButton label={activeGroup ? "Channel details" : "Agent profile"} active={ui.panel === "profile"} onClick={() => setUI({ panel: ui.panel === "profile" ? null : "profile" })}>
            <PanelRight size={17} />
          </IconButton>
        </div>
      </header>

      <ThreadPopover />

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className={cn("chat-content", messages.length === 0 && "is-empty")}>
          {messages.length === 0 ? (
            <EmptyConversation />
          ) : (
            <>
              {rendered}
              {activeThread?.busy && <WorkingRow botName={activeGroup ? (lead?.name ?? activeGroup.name) : (activeBot?.name ?? "Bot")} status={activeThread.status ?? "Working"} />}
            </>
          )}
        </div>
        {!nearBottom && (
          <button type="button" className="jump-latest" onClick={jumpToLatest} aria-label="Jump to latest">
            <ArrowDown size={15} />
          </button>
        )}
      </div>

      <Composer visible={visible} />
    </section>
  );
}
