import { create } from "zustand";

export type Language = "zh-CN" | "en-US";
export type Theme = "dark" | "light";
/** Content column density: narrow → fill (reading column max-width only). */
export type ContentDensity = "narrow" | "medium" | "wide" | "fill";
/**
 * Transcript font scale only — integer CSS px tiers.
 * Never applied to chrome (sidebar / titlebar / fixed-height chips) to avoid
 * layout overflow and sub-pixel blur.
 */
export type FontScale = "sm" | "md" | "lg" | "xl";

interface PreferencesState {
  language: Language;
  theme: Theme;
  /** @deprecated kept for migration; use fontScale */
  fontSize: number;
  fontScale: FontScale;
  fontWeight: number;
  contentDensity: ContentDensity;
  sidebarWidth: number;
  inspectorWidth: number;
  previewWidth: number;
  setLanguage(language: Language): void;
  setTheme(theme: Theme): void;
  setFontScale(scale: FontScale): void;
  /** Maps legacy numeric offsets to discrete scales. */
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

const clampFontWeight = (value: number) => Math.min(700, Math.max(400, Math.round(value / 25) * 25));

const parseContentDensity = (value: string | null): ContentDensity => {
  if (value === "narrow" || value === "medium" || value === "wide" || value === "fill") return value;
  // Legacy aliases (xwide was the previous "更宽" tier)
  if (value === "full" || value === "xl" || value === "wider" || value === "xwide") return "fill";
  return "medium";
};

const FONT_SCALES: FontScale[] = ["sm", "md", "lg", "xl"];

export function parseFontScale(value: string | null): FontScale {
  if (value === "sm" || value === "md" || value === "lg" || value === "xl") return value;
  // Legacy string labels
  if (value === "compact" || value === "smaller") return "sm";
  if (value === "comfortable" || value === "default") return "md";
  if (value === "large" || value === "larger") return "lg";
  if (value === "xlarge") return "xl";
  // Legacy numeric offsets (px increase, including fractions)
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n <= -0.5) return "sm";
    if (n <= 0.75) return "md";
    if (n <= 2.25) return "lg";
    return "xl";
  }
  return "md";
}

/** Stable integer rank for UI “active” checks against old number consumers. */
export function fontScaleToRank(scale: FontScale): number {
  return FONT_SCALES.indexOf(scale);
}

function applyFontScale(scale: FontScale) {
  document.documentElement.dataset.font = scale;
  // Clear legacy offset so no chrome rule can re-introduce sub-pixel sizes.
  document.documentElement.style.removeProperty("--grox-font-increase");
}

const initialLanguage: Language =
  localStorage.getItem("grox.language") === "en-US" ? "en-US" : "zh-CN";
const initialTheme: Theme = localStorage.getItem("grox.theme") === "light" ? "light" : "dark";

const initialFontScale = (() => {
  // Prefer new key; fall back to legacy grox.fontSize.
  const fromNew = localStorage.getItem("grox.fontScale");
  if (fromNew) return parseFontScale(fromNew);
  return parseFontScale(localStorage.getItem("grox.fontSize"));
})();

const initialFontWeight = (() => {
  const value = localStorage.getItem("grox.fontWeight");
  if (value === "regular") return 400;
  if (value === "strong") return 600;
  if (value === "medium") return 500;
  const parsed = Number(value);
  // Prefer 400 for crisp rendering at small UI sizes; 500 often looks soft.
  return Number.isFinite(parsed) ? clampFontWeight(parsed) : 400;
})();
const initialContentDensity = parseContentDensity(localStorage.getItem("grox.contentDensity"));

document.documentElement.dataset.theme = initialTheme;
document.documentElement.dataset.density = initialContentDensity;
document.documentElement.lang = initialLanguage;
applyFontScale(initialFontScale);
document.documentElement.style.setProperty("--grox-font-weight", String(initialFontWeight));
// One-shot: persist discrete scale if user still has fractional legacy value.
if (!localStorage.getItem("grox.fontScale")) {
  localStorage.setItem("grox.fontScale", initialFontScale);
}

export const usePreferences = create<PreferencesState>((set) => ({
  language: initialLanguage,
  theme: initialTheme,
  fontSize: fontScaleToRank(initialFontScale),
  fontScale: initialFontScale,
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
  setFontScale(scale) {
    const value = parseFontScale(scale);
    localStorage.setItem("grox.fontScale", value);
    localStorage.setItem("grox.fontSize", value); // keep legacy key in sync as label
    applyFontScale(value);
    set({ fontScale: value, fontSize: fontScaleToRank(value) });
  },
  setFontSize(fontSize) {
    // Accept old numeric API → discrete scale.
    const value = parseFontScale(String(fontSize));
    localStorage.setItem("grox.fontScale", value);
    localStorage.setItem("grox.fontSize", value);
    applyFontScale(value);
    set({ fontScale: value, fontSize: fontScaleToRank(value) });
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
