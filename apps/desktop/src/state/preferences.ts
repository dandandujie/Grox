import { create } from "zustand";

export type Language = "zh-CN" | "en-US";
export type Theme = "dark" | "light";

interface PreferencesState {
  language: Language;
  theme: Theme;
  fontSize: number;
  fontWeight: number;
  sidebarWidth: number;
  inspectorWidth: number;
  previewWidth: number;
  setLanguage(language: Language): void;
  setTheme(theme: Theme): void;
  setFontSize(fontSize: number): void;
  setFontWeight(fontWeight: number): void;
  setSidebarWidth(width: number): void;
  setInspectorWidth(width: number): void;
  setPreviewWidth(width: number): void;
}

const numberPreference = (key: string, fallback: number) => {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const dimensionPersistTimers = new Map<string, number>();
const persistDimension = (key: string, value: number) => {
  const pending = dimensionPersistTimers.get(key);
  if (pending !== undefined) window.clearTimeout(pending);
  dimensionPersistTimers.set(key, window.setTimeout(() => {
    localStorage.setItem(key, String(value));
    dimensionPersistTimers.delete(key);
  }, 180));
};

const initialLanguage: Language =
  localStorage.getItem("grox.language") === "en-US" ? "en-US" : "zh-CN";
const initialTheme: Theme = localStorage.getItem("grox.theme") === "light" ? "light" : "dark";
const clampFontSize = (value: number) => Math.min(6, Math.max(0, Math.round(value * 4) / 4));
const clampFontWeight = (value: number) => Math.min(700, Math.max(400, Math.round(value / 25) * 25));
const initialFontSize = (() => {
  const value = localStorage.getItem("grox.fontSize");
  if (value === "compact") return 0;
  if (value === "large") return 3;
  if (value === "comfortable") return 1.5;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampFontSize(parsed) : 2;
})();
const initialFontWeight = (() => {
  const value = localStorage.getItem("grox.fontWeight");
  if (value === "regular") return 400;
  if (value === "strong") return 600;
  if (value === "medium") return 500;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampFontWeight(parsed) : 500;
})();

document.documentElement.dataset.theme = initialTheme;
document.documentElement.lang = initialLanguage;
document.documentElement.style.setProperty("--grox-font-increase", `${initialFontSize}px`);
document.documentElement.style.setProperty("--grox-font-weight", String(initialFontWeight));

export const usePreferences = create<PreferencesState>((set) => ({
  language: initialLanguage,
  theme: initialTheme,
  fontSize: initialFontSize,
  fontWeight: initialFontWeight,
  sidebarWidth: Math.min(360, Math.max(196, numberPreference("grox.sidebarWidth", 232))),
  inspectorWidth: Math.min(520, Math.max(248, numberPreference("grox.inspectorWidth", 292))),
  previewWidth: Math.min(720, Math.max(320, numberPreference("grox.previewWidth", 440))),
  setLanguage(language) {
    localStorage.setItem("grox.language", language);
    document.documentElement.lang = language;
    set({ language });
  },
  setTheme(theme) {
    localStorage.setItem("grox.theme", theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  setFontSize(fontSize) {
    const value = clampFontSize(fontSize);
    localStorage.setItem("grox.fontSize", String(value));
    document.documentElement.style.setProperty("--grox-font-increase", `${value}px`);
    set({ fontSize: value });
  },
  setFontWeight(fontWeight) {
    const value = clampFontWeight(fontWeight);
    localStorage.setItem("grox.fontWeight", String(value));
    document.documentElement.style.setProperty("--grox-font-weight", String(value));
    set({ fontWeight: value });
  },
  setSidebarWidth(sidebarWidth) {
    const width = Math.min(360, Math.max(196, sidebarWidth));
    persistDimension("grox.sidebarWidth", width);
    set({ sidebarWidth: width });
  },
  setInspectorWidth(inspectorWidth) {
    const width = Math.min(520, Math.max(248, inspectorWidth));
    persistDimension("grox.inspectorWidth", width);
    set({ inspectorWidth: width });
  },
  setPreviewWidth(previewWidth) {
    const width = Math.min(720, Math.max(320, previewWidth));
    persistDimension("grox.previewWidth", width);
    set({ previewWidth: width });
  },
}));
