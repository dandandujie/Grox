import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Plus, Square, X } from "lucide-react";
import { useApp } from "@/state/store";
import { IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";

export function Composer() {
  const { activeBot, activeThread, send, stop, newTask, setUI, toast } = useApp();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<string[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendingQueue = useRef(false);
  const threadId = activeThread?.id ?? "";
  const text = drafts[threadId] ?? "";
  const busy = Boolean(activeThread?.busy);

  useEffect(() => {
    setQueue([]);
    setPlusOpen(false);
  }, [threadId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    const height = Math.min(148, Math.max(26, element.scrollHeight));
    element.style.height = height + "px";
  }, [text]);

  useEffect(() => {
    if (busy || queue.length === 0 || sendingQueue.current) return;
    const [next, ...rest] = queue;
    if (!next) return;
    sendingQueue.current = true;
    setQueue(rest);
    void send(next).finally(() => {
      sendingQueue.current = false;
    });
  }, [busy, queue, send]);

  if (!activeBot || !activeThread) return null;

  const setText = (value: string) => setDrafts((previous) => ({ ...previous, [threadId]: value }));

  const submit = (value: string) => {
    const clean = value.trim();
    if (!clean) return;
    if (busy) {
      setQueue((previous) => [...previous, clean]);
      setText("");
      return;
    }
    setText("");
    void send(clean);
  };

  return (
    <div className="composer-dock">
      {queue.length > 0 && (
        <div className="composer-queue">
          {queue.map((item, index) => (
            <span className="queue-chip" key={item + index}>
              <span className="queue-label">Queued</span>
              <span className="queue-text">{item}</span>
              <button type="button" aria-label="Remove queued message" onClick={() => setQueue((previous) => previous.filter((_, i) => i !== index))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={cn("composer", busy && "is-busy")}>
        <div className="composer-plus-wrap no-drag">
          <IconButton label="More" size={30} onClick={() => setPlusOpen((open) => !open)} active={plusOpen}>
            <Plus size={20} />
          </IconButton>
          {plusOpen && (
            <>
              <div className="composer-plus-backdrop" onClick={() => setPlusOpen(false)} />
              <div className="composer-plus-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); newTask(); }}>
                  <Plus size={15} /> New task
                </button>
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setUI({ panel: "profile" }); }}>
                  <span className="menu-dot" /> Agent profile
                </button>
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setUI({ settingsOpen: true, settingsSection: "general" }); }}>
                  <span className="menu-dot" /> Settings
                </button>
                <div className="context-separator" />
                <button type="button" role="menuitem" disabled title="Attachments are not in this build">
                  <span className="menu-dot" /> Attach a file <span className="soon">soon</span>
                </button>
              </div>
            </>
          )}
        </div>
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit(text);
          }}
          placeholder={"Message " + activeBot.name}
          aria-label={"Message " + activeBot.name}
          className="composer-input"
          spellCheck={false}
        />
        <div className="composer-actions">
          <IconButton
            label="Dictate"
            size={30}
            className="composer-mic"
            onClick={() => toast({ kind: "info", title: "Dictation is not connected in this build", body: "Voice input is on the roadmap; the text composer is ready." })}
          >
            <Mic size={18} />
          </IconButton>
          {busy ? (
            <button type="button" className="composer-send is-stop" aria-label="Stop" title="Stop" onClick={stop}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              aria-label="Send"
              title="Send"
              disabled={!text.trim()}
              onClick={() => submit(text)}
            >
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        <span>Enter to send · Shift + Enter for a new line</span>
        <span className="composer-model">Grox runs on your machine</span>
      </div>
    </div>
  );
}
