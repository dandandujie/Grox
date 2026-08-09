import { create } from "zustand";

export type Language = "zh-CN" | "en-US";
export type Theme = "dark" | "light";
/** Content column density: narrow (compact read), medium, wide (more on-screen). */
export type ContentDensity = "narrow" | "medium" | "wide";

interface PreferencesState {
  language: Language;
  theme: Theme;
  fontSize: number;
  fontWeight: number;
  contentDensity: ContentDensity;
  sidebarWidth: number;
  inspectorWidth: number;
  previewWidth: number;
  setLanguage(language: Language): void;
  setTheme(theme: Theme): void;
  setFontSize(fontSize: number): void;
  setFontWeight(fontWeight: number): void;
  setContentDensity(density: ContentDensity): void;
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
// Allow slightly-below-baseline sizes so dense screens can show more content.
const clampFontSize = (value: number) => Math.min(6, Math.max(-2, Math.round(value * 4) / 4));
const clampFontWeight = (value: number) => Math.min(700, Math.max(400, Math.round(value / 25) * 25));
const parseContentDensity = (value: string | null): ContentDensity => {
  if (value === "narrow" || value === "wide" || value === "medium") return value;
  return "medium";
};
const initialFontSize = (() => {
  const value = localStorage.getItem("grox.fontSize");
  if (value === "compact") return -1;
  if (value === "large") return 2.5;
  if (value === "comfortable") return 0.5;
  const parsed = Number(value);
  // New default is 0 (was +3.5). One-shot migrate only the old factory default.
  if (!Number.isFinite(parsed)) return 0;
  if (value === "3.5" && localStorage.getItem("grox.fontSize.v2") !== "1") {
    localStorage.setItem("grox.fontSize.v2", "1");
    localStorage.setItem("grox.fontSize", "0");
    return 0;
  }
  return clampFontSize(parsed);
})();
const initialFontWeight = (() => {
  const value = localStorage.getItem("grox.fontWeight");
  if (value === "regular") return 400;
  if (value === "strong") return 600;
  if (value === "medium") return 500;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampFontWeight(parsed) : 500;
})();
const initialContentDensity = parseContentDensity(localStorage.getItem("grox.contentDensity"));

document.documentElement.dataset.theme = initialTheme;
document.documentElement.dataset.density = initialContentDensity;
document.documentElement.lang = initialLanguage;
document.documentElement.style.setProperty("--grox-font-increase", `${initialFontSize}px`);
document.documentElement.style.setProperty("--grox-font-weight", String(initialFontWeight));

export const usePreferences = create<PreferencesState>((set) => ({
  language: initialLanguage,
  theme: initialTheme,
  fontSize: initialFontSize,
  fontWeight: initialFontWeight,
  contentDensity: initialContentDensity,
  sidebarWidth: Math.min(380, Math.max(210, numberPreference("grox.sidebarWidth", 252))),
  inspectorWidth: Math.min(540, Math.max(260, numberPreference("grox.inspectorWidth", 312))),
  previewWidth: Math.min(760, Math.max(340, numberPreference("grox.previewWidth", 460))),
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
  setContentDensity(density) {
    const value = parseContentDensity(density);
    localStorage.setItem("grox.contentDensity", value);
    document.documentElement.dataset.density = value;
    set({ contentDensity: value });
  },
  setSidebarWidth(sidebarWidth) {
    const width = Math.min(380, Math.max(210, sidebarWidth));
    persistDimension("grox.sidebarWidth", width);
    set({ sidebarWidth: width });
  },
  setInspectorWidth(inspectorWidth) {
    const width = Math.min(540, Math.max(260, inspectorWidth));
    persistDimension("grox.inspectorWidth", width);
    set({ inspectorWidth: width });
  },
  setPreviewWidth(previewWidth) {
    const width = Math.min(760, Math.max(340, previewWidth));
    persistDimension("grox.previewWidth", width);
    set({ previewWidth: width });
  },
}));
