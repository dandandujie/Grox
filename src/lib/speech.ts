export interface RecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string };
}

export interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

type RecognitionCtor = new () => RecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  }
}

export function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export function getVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices();
}

export function findVoice(name: string): SpeechSynthesisVoice | undefined {
  if (!name) return undefined;
  return getVoices().find((voice) => voice.name === name);
}

export function plainSpeech(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>\x60]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speak(text: string, voiceName?: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const clean = plainSpeech(text);
  if (!clean) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean.slice(0, 4000));
  const voice = findVoice(voiceName ?? "");
  if (voice) utterance.voice = voice;
  utterance.rate = 1.02;
  window.speechSynthesis.speak(utterance);
}
