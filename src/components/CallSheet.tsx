import { useLanguage, useT } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";
import { useApp } from "@/state/store";
import { Mascot } from "@/components/Mascot";
import { getRecognitionCtor, type RecognitionLike } from "@/lib/speech";
import { cn } from "@/lib/cn";
import { clock } from "@/lib/format";

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
}

export function CallSheet() {
  const t = useT();
  const language = useLanguage();
  const { ui, setUI, activeBot, activeGroup, activeThread, state, send } = useApp();
  const bot = activeGroup ? state.bots.find((item) => item.id === activeGroup.leadId) : activeBot;
  const [elapsed, setElapsed] = useState(0);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [typed, setTyped] = useState("");
  const [micError, setMicError] = useState("");
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const restartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(false);

  const stopRecognition = useCallback(() => {
    if (restartRef.current) clearTimeout(restartRef.current);
    restartRef.current = null;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try { recognition?.abort?.(); } catch { /* already stopped */ }
    setListening(false);
    setInterim("");
  }, []);

  const startRecognition = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setMicError(t("Live listening is not exposed by this webview. You can type in the call instead."));
      return;
    }
    const recognition = new Ctor();
    recognition.lang = language === "zh" ? "zh-CN" : "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalText = "";
      let pending = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        if (result.isFinal) finalText += result[0]?.transcript ?? "";
        else pending += result[0]?.transcript ?? "";
      }
      setInterim(pending);
      if (finalText.trim()) {
        setInterim("");
        void send(finalText.trim());
      }
    };
    recognition.onerror = (event) => {
      setListening(false);
      const denied = event.error === "not-allowed" || event.error === "service-not-allowed";
      setMicError(denied ? t("Microphone permission was denied. Allow it in System Settings, or type below.") : t("The microphone stopped. Type below or resume the call."));
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      if (openRef.current && !ui.callMuted) {
        restartRef.current = setTimeout(() => {
          if (openRef.current && !ui.callMuted) startRecognition();
        }, 500);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
      setMicError("");
    } catch {
      setListening(false);
      setMicError(t("The microphone could not start. Type below instead."));
    }
  }, [send, ui.callMuted, t, language]);

  useEffect(() => {
    openRef.current = ui.callOpen;
    if (!ui.callOpen) {
      stopRecognition();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      return;
    }
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    const startTimer = window.setTimeout(() => startRecognition(), 350);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(startTimer);
      stopRecognition();
    };
    // Only re-run when the call opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.callOpen]);

  useEffect(() => {
    if (!ui.callOpen) return;
    if (ui.callMuted) {
      stopRecognition();
    } else if (!recognitionRef.current && !micError) {
      startRecognition();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.callMuted]);

  if (!ui.callOpen || (!activeBot && !activeGroup) || !bot) return null;

  const name = activeGroup ? "# " + activeGroup.name : activeBot?.name ?? bot.name;
  const messages = (activeThread?.messages ?? []).slice(-5);
  const end = () => {
    openRef.current = false;
    stopRecognition();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setUI({ callOpen: false, callMuted: false });
  };
  const toggleMic = () => {
    if (ui.callMuted) setUI({ callMuted: false });
    if (listening) stopRecognition();
    else startRecognition();
  };
  const sendTyped = (event: React.FormEvent) => {
    event.preventDefault();
    const value = typed.trim();
    if (!value) return;
    setTyped("");
    void send(value);
  };

  return (
    <div className="call-layer" role="dialog" aria-modal="true" aria-label={t("Voice call with ") + name}>
      <div className="call-sheet">
        <div className="call-top">
          <span className="call-live"><i /> {t("Live")}</span>
          <span className="call-duration">{formatDuration(elapsed)}</span>
          <span className="call-mode">{activeGroup ? t("Channel call") : t("Agent call")}</span>
        </div>
        <div className={cn("call-avatar", listening && !ui.callMuted && "is-listening")}>
          <Mascot seed={bot.name} size={94} title={bot.name} />
        </div>
        <h2>{name}</h2>
        <p className="call-status">
          {ui.callMuted ? t("Speaker muted") : micError ? t("Type below") : listening ? t("Listening — speak naturally") : t("Connecting the microphone…")}
        </p>
        {interim && <div className="call-interim">{interim}</div>}
        {micError && <div className="call-error">{micError}</div>}

        <div className="call-captions">
          {messages.length === 0 && <div className="call-caption-empty">{t("The conversation will appear here as you speak.")}</div>}
          {messages.map((message) => {
            const sender = message.role === "user"
              ? t("You")
              : message.senderName || bot.name;
            return (
              <div key={message.id} className={cn("call-caption", message.role === "user" && "is-user")}>
                <span>{sender}</span>
                <p>{message.text.replace(/[*_#>\x60]/g, "").slice(0, 240)}</p>
                <time>{clock(message.createdAt, language)}</time>
              </div>
            );
          })}
        </div>

        <form className="call-fallback" onSubmit={sendTyped}>
          <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={t("Type to {0} instead", name)} aria-label={t("Type a message")} />
          <button type="submit" disabled={!typed.trim()}>{t("Send")}</button>
        </form>

        <div className="call-controls">
          <button type="button" className={cn("call-control", listening && !micError && "is-on")} onClick={toggleMic} aria-label={listening ? t("Mute microphone") : t("Unmute microphone")}>
            {listening ? <Mic size={20} /> : <MicOff size={20} />}
            <span>{listening ? t("Mic on") : t("Mic off")}</span>
          </button>
          <button type="button" className="call-end" onClick={end} aria-label={t("End call")}>
            <PhoneOff size={22} />
          </button>
          <button type="button" className={cn("call-control", !ui.callMuted && "is-on")} onClick={() => setUI({ callMuted: !ui.callMuted })} aria-label={ui.callMuted ? t("Unmute speaker") : t("Mute speaker")}>
            {ui.callMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            <span>{ui.callMuted ? t("Muted") : t("Speaker")}</span>
          </button>
        </div>
        <p className="call-footnote">{t("Speech recognition and the system voice stay on this machine. Nothing is uploaded by Grox.")}</p>
      </div>
    </div>
  );
}
