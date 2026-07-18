import { create } from "zustand";

export type Language = "zh-CN" | "en-US";
export type Theme = "dark" | "light";

interface PreferencesState {
  language: Language;
  theme: Theme;
  sidebarWidth: number;
  inspectorWidth: number;
  previewWidth: number;
  setLanguage(language: Language): void;
  setTheme(theme: Theme): void;
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

const initialLanguage: Language =
  localStorage.getItem("grox.language") === "en-US" ? "en-US" : "zh-CN";
const initialTheme: Theme = localStorage.getItem("grox.theme") === "light" ? "light" : "dark";

document.documentElement.dataset.theme = initialTheme;
document.documentElement.lang = initialLanguage;

export const usePreferences = create<PreferencesState>((set) => ({
  language: initialLanguage,
  theme: initialTheme,
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
  setSidebarWidth(sidebarWidth) {
    const width = Math.min(360, Math.max(196, sidebarWidth));
    localStorage.setItem("grox.sidebarWidth", String(width));
    set({ sidebarWidth: width });
  },
  setInspectorWidth(inspectorWidth) {
    const width = Math.min(520, Math.max(248, inspectorWidth));
    localStorage.setItem("grox.inspectorWidth", String(width));
    set({ inspectorWidth: width });
  },
  setPreviewWidth(previewWidth) {
    const width = Math.min(720, Math.max(320, previewWidth));
    localStorage.setItem("grox.previewWidth", String(width));
    set({ previewWidth: width });
  },
}));
