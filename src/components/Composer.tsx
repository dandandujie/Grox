import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Mic, Paperclip, Plus, Square, X } from "lucide-react";
import { useApp } from "@/state/store";
import { IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { Attachment } from "@/lib/bridge";
import { getRecognitionCtor, type RecognitionLike } from "@/lib/speech";
import { AttachmentGallery, formatBytes } from "@/components/Attachments";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export function Composer() {
  const { activeBot, activeGroup, activeThread, send, uploadAttachment, stop, newTask, setUI, toast } = useApp();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<string[]>([]);
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const dictationBase = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingQueue = useRef(false);
  const threadId = activeThread?.id ?? "";
  const text = drafts[threadId] ?? "";
  const busy = Boolean(activeThread?.busy);

  useEffect(() => {
    setQueue([]);
    setPending([]);
    setPlusOpen(false);
  }, [threadId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    const height = Math.min(148, Math.max(26, element.scrollHeight));
    element.style.height = height + "px";
  }, [text]);

  useEffect(() => () => {
    recognitionRef.current?.abort?.();
    recognitionRef.current = null;
  }, []);

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

  if ((!activeBot && !activeGroup) || !activeThread) return null;
  const conversationName = activeGroup ? "# " + activeGroup.name : activeBot?.name ?? "this chat";

  const setText = (value: string) => setDrafts((previous) => ({ ...previous, [threadId]: value }));

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) {
        toast({ kind: "error", title: "That file is too large", body: file.name + " is over 32 MB." });
        continue;
      }
      const attachment = await uploadAttachment(file);
      if (attachment) setPending((previous) => [...previous, attachment]);
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submit = (value: string) => {
    const clean = value.trim();
    if (!clean && pending.length === 0) return;
    if (busy) {
      if (pending.length > 0) {
        toast({ kind: "info", title: "Wait for the current turn", body: "Attachments can be sent with the next message; text can still be queued." });
        return;
      }
      setQueue((previous) => [...previous, clean]);
      setText("");
      return;
    }
    setText("");
    setPending([]);
    void send(clean, pending);
  };

  const removePending = (id: string) => setPending((previous) => previous.filter((item) => item.id !== id));

  const toggleDictation = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      toast({ kind: "info", title: "Dictation is not available here", body: "This webview does not expose speech recognition. Use a browser preview, or type instead." });
      return;
    }
    const recognition = new Ctor();
    recognition.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    dictationBase.current = text;
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        if (result.isFinal) finalText += result[0]?.transcript ?? "";
        else interimText += result[0]?.transcript ?? "";
      }
      if (finalText) {
        dictationBase.current = (dictationBase.current + " " + finalText).trim();
        setText(dictationBase.current);
      } else if (interimText) {
        setText((dictationBase.current + " " + interimText).trim());
      }
    };
    recognition.onerror = (event) => {
      setListening(false);
      const reason = event.error === "not-allowed" ? "Microphone permission was denied." : "The microphone could not be used.";
      toast({ kind: "error", title: "Dictation stopped", body: reason });
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      toast({ kind: "error", title: "Dictation could not start" });
    }
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
      {pending.length > 0 && (
        <div className="composer-attachments">
          <AttachmentGallery attachments={pending} removable onRemove={removePending} />
          <span className="composer-attachment-note">
            {pending.length} file{pending.length === 1 ? "" : "s"} · {formatBytes(pending.reduce((sum, item) => sum + item.size, 0))}
          </span>
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
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); fileInputRef.current?.click(); }}>
                  <Paperclip size={15} /> Attach files or images
                </button>
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); newTask(); }}>
                  <Plus size={15} /> New task
                </button>
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setUI({ panel: "profile" }); }}>
                  <span className="menu-dot" /> {activeGroup ? "Channel details" : "Agent profile"}
                </button>
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setUI({ settingsOpen: true, settingsSection: "general" }); }}>
                  <span className="menu-dot" /> Settings
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
          placeholder={"Message " + conversationName}
          aria-label={"Message " + conversationName}
          className="composer-input"
          spellCheck={false}
        />
        <div className="composer-actions">
          {uploading && <span className="composer-uploading"><Loader2 size={15} className="spin" /></span>}
          <IconButton
            label={listening ? "Stop dictation" : "Dictate"}
            size={30}
            className={cn("composer-mic", listening && "is-listening")}
            onClick={toggleDictation}
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
              disabled={!text.trim() && pending.length === 0}
              onClick={() => submit(text)}
            >
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => void addFiles(event.target.files)}
        aria-label="Attach files"
      />
      <div className="composer-hint">
        <span>Enter to send · Shift + Enter for a new line</span>
        <span className="composer-model">Grox runs on your machine</span>
      </div>
    </div>
  );
}
