import { useLanguage, useT } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Mic, Paperclip, Plus, Square, X } from "lucide-react";
import { useApp } from "@/state/store";
import { IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { Attachment } from "@/lib/bridge";
import { getRecognitionCtor, type RecognitionLike } from "@/lib/speech";
import { AttachmentGallery, formatBytes } from "@/components/Attachments";
import { unfinishedReply } from "@/lib/conversations";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

type Draft = {
  text: string;
  queue: string[];
  attachments: Attachment[];
  uploads: number;
  sending: boolean;
  queuePaused: boolean;
  resumedAfter: string;
  error: string;
};

const emptyDraft: Draft = {
  text: "", queue: [], attachments: [], uploads: 0, sending: false, queuePaused: false, resumedAfter: "", error: "",
};

export function Composer({ visible }: { visible: boolean }) {
  const t = useT();
  const language = useLanguage();
  const { activeBot, activeGroup, activeThread, state, providers, send, uploadAttachment, stop, newTask, setUI, toast } = useApp();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [plusOpen, setPlusOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const dictationBase = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingThreads = useRef(new Set<string>());
  const threadId = activeThread?.id ?? "";
  const { text, queue, attachments: pending, uploads, sending, queuePaused, resumedAfter, error } = drafts[threadId] ?? emptyDraft;
  const busy = Boolean(activeThread?.busy);
  const unfinished = unfinishedReply(activeThread);
  const queueBlocked = queuePaused || Boolean(unfinished && unfinished.id !== resumedAfter);
  const previousRequest = unfinished && [...(activeThread?.messages ?? [])].reverse().find((message) => message.role === "user");
  const engineMode = state.settings.engineMode;
  const demo = engineMode === "demo" || (!activeGroup && engineMode === "auto" && activeBot?.modelId === "grox-demo");
  const model = providers.flatMap((provider) => provider.models).find((item) => item.id === activeBot?.modelId);
  const needsModel = !activeGroup && engineMode === "auto" && !demo && !model?.available;
  const openEngines = () => setUI({ settingsOpen: true, settingsSection: "engines" });

  const updateDraft = useCallback((update: (draft: Draft) => Partial<Draft>) => {
    setDrafts((previous) => {
      const draft = previous[threadId] ?? emptyDraft;
      return { ...previous, [threadId]: { ...draft, ...update(draft) } };
    });
  }, [threadId, visible]);

  useEffect(() => {
    setPlusOpen(false);
    setListening(false);
    return () => {
      const recognition = recognitionRef.current;
      if (!recognition) return;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort?.();
      recognitionRef.current = null;
    };
  }, [threadId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    const height = Math.min(148, Math.max(26, element.scrollHeight));
    element.style.height = height + "px";
  }, [text, visible]);

  useEffect(() => {
    const [next] = queue;
    if (!visible || !threadId || busy || !next || queueBlocked || sendingThreads.current.has(threadId)) return;
    const inFlight = sendingThreads.current;
    inFlight.add(threadId);
    updateDraft(() => ({ sending: true }));
    void send(next).then((result) => {
      inFlight.delete(threadId);
      updateDraft((draft) => ({
        sending: false,
        queue: result.accepted ? draft.queue.slice(1) : draft.queue,
        queuePaused: !result.accepted,
        error: result.accepted ? "" : result.error,
      }));
    });
  }, [busy, queue, queueBlocked, send, threadId, updateDraft, visible]);

  if ((!activeBot && !activeGroup) || !activeThread) return null;
  const conversationName = activeGroup ? "# " + activeGroup.name : activeBot?.name ?? t("this chat");

  const setText = (value: string) => updateDraft(() => ({ text: value, error: "" }));

  const addFiles = async (files: FileList | null) => {
    const selected = Array.from(files ?? []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (selected.length === 0) return;
    updateDraft((draft) => ({ uploads: draft.uploads + 1 }));
    try {
      for (const file of selected) {
        if (file.size > MAX_FILE_BYTES) {
          toast({ kind: "error", title: t("That file is too large"), body: file.name + t(" is over 32 MB.") });
          continue;
        }
        const attachment = await uploadAttachment(file);
        if (attachment) updateDraft((draft) => ({ attachments: [...draft.attachments, attachment] }));
      }
    } finally {
      updateDraft((draft) => ({ uploads: draft.uploads - 1 }));
    }
  };

  const submit = async (value: string) => {
    const clean = value.trim();
    const inFlight = sendingThreads.current;
    if ((!clean && pending.length === 0) || uploads > 0 || inFlight.has(threadId)) return;
    if (busy || (queue.length > 0 && !queueBlocked)) {
      if (pending.length > 0) {
        toast({ kind: "info", title: t("Wait for the current turn"), body: t("Attachments can be sent with the next message.") });
        return;
      }
      updateDraft((draft) => ({ text: "", queue: [...draft.queue, clean] }));
      return;
    }
    inFlight.add(threadId);
    updateDraft(() => ({ sending: true, text: "", attachments: [], error: "", queuePaused: queueBlocked && queue.length > 0 }));
    const result = await send(clean, pending);
    inFlight.delete(threadId);
    updateDraft((draft) => result.accepted ? { sending: false } : {
      sending: false,
      text: [value, draft.text].filter(Boolean).join("\n"),
      attachments: [...pending, ...draft.attachments],
      error: result.error,
    });
  };

  const removePending = (id: string) => updateDraft((draft) => ({
    attachments: draft.attachments.filter((item) => item.id !== id),
  }));

  const toggleDictation = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      toast({ kind: "info", title: t("Dictation is not available here"), body: t("This webview does not expose speech recognition. Use a browser preview, or type instead.") });
      return;
    }
    const recognition = new Ctor();
    recognition.lang = language === "zh" ? "zh-CN" : "en-US";
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
      const reason = event.error === "not-allowed" ? t("Microphone permission was denied.") : t("The microphone could not be used.");
      toast({ kind: "error", title: t("Dictation stopped"), body: reason });
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      toast({ kind: "error", title: t("Dictation could not start") });
    }
  };

  return (
    <div className="composer-dock">
      {(error || unfinished || needsModel) && (
        <div className="composer-notice" role={error ? "alert" : "status"}>
          <span>{error ? t(error) : (unfinished ? unfinished.error ? t("The last turn failed.") : t("The last turn stopped.") : t("This model is unavailable."))}</span>
          {previousRequest && !text && pending.length === 0 && (
            <button type="button" className="link-button" onClick={() => {
              updateDraft(() => ({ text: previousRequest.text, attachments: previousRequest.attachments ?? [], error: "" }));
              textareaRef.current?.focus();
            }}>{t("Restore request")}</button>
          )}
          <button type="button" className="link-button" onClick={openEngines}>{t("Engines")}</button>
        </div>
      )}
      {queue.length > 0 && (
        <div className="composer-queue">
          {queue.map((item, index) => (
            <span className="queue-chip" key={item + index}>
              <span className="queue-label">{t("Queued")}</span>
              <span className="queue-text">{item}</span>
              <button type="button" aria-label={t("Remove queued message")} disabled={sending && index === 0}
                onClick={() => updateDraft((draft) => ({
                  queue: draft.queue.filter((_, i) => i !== index),
                  queuePaused: index === 0 ? false : draft.queuePaused,
                }))}>
                <X size={12} />
              </button>
            </span>
          ))}
          {queueBlocked && <button type="button" className="btn btn-ghost" onClick={() => updateDraft(() => ({ queuePaused: false, resumedAfter: unfinished?.id ?? "", error: "" }))}>{t("Resume queue")}</button>}
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
          <IconButton label={t("More")} size={30} onClick={() => setPlusOpen((open) => !open)} active={plusOpen}>
            <Plus size={20} />
          </IconButton>
          {plusOpen && (
            <>
              <div className="composer-plus-backdrop" onClick={() => setPlusOpen(false)} />
              <div className="composer-plus-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); fileInputRef.current?.click(); }}>
                  <Paperclip size={15} /> {t("Attach files or images")}
                </button>
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); newTask(); }}>
                  <Plus size={15} /> {t("New task")}
                </button>
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setUI({ panel: "profile" }); }}>
                  <span className="menu-dot" /> {activeGroup ? t("Channel details") : t("Agent profile")}
                </button>
                <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setUI({ settingsOpen: true, settingsSection: "general" }); }}>
                  <span className="menu-dot" /> {t("Settings")}
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
            void submit(text);
          }}
          placeholder={t("Message ") + conversationName}
          aria-label={t("Message ") + conversationName}
          className="composer-input"
          spellCheck={false}
        />
        <div className="composer-actions">
          {uploads > 0 && <span className="composer-uploading"><Loader2 size={15} className="spin" /></span>}
          <IconButton
            label={listening ? t("Stop dictation") : t("Dictate")}
            size={30}
            className={cn("composer-mic", listening && "is-listening")}
            onClick={toggleDictation}
          >
            <Mic size={18} />
          </IconButton>
          {busy ? (
            <button type="button" className="composer-send is-stop" aria-label={t("Stop")} title={t("Stop")} onClick={stop}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              aria-label={t("Send")}
              title={t("Send")}
              disabled={sending || uploads > 0 || (!text.trim() && pending.length === 0)}
              onClick={() => void submit(text)}
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
        aria-label={t("Attach files")}
      />
      <div className="composer-hint">
        <span>{t("Enter to send · Shift + Enter for a new line")}</span>
        {demo && <span className="composer-model">{t("Demo · scripted replies")}</span>}
      </div>
    </div>
  );
}
