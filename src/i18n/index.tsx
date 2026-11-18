import { createContext, useContext, useMemo, type ReactNode } from "react";
import chinese from "./zh.json";

export type Language = "zh" | "en";
export type Translate = (message: string, ...values: unknown[]) => string;

const translations: Readonly<Record<string, string>> = chinese;

export function normalizeLanguage(value: unknown): Language {
  return value === "en" ? "en" : "zh";
}

export function localeTag(language: Language): string {
  return language === "zh" ? "zh-CN" : "en";
}

export function translate(language: Language, message: string, ...values: unknown[]): string {
  const text = language === "zh" && Object.hasOwn(translations, message) ? translations[message]! : message;
  return values.length ? text.replace(/\{(\d+)\}/g, (match, index: string) => {
    const position = Number(index);
    return position < values.length ? String(values[position] ?? "") : match;
  }) : text;
}

export function translator(language: Language): Translate {
  return (message, ...values) => translate(language, message, ...values);
}

const LocaleContext = createContext<{ language: Language; t: Translate }>({ language: "zh", t: translator("zh") });

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const locale = useMemo(() => ({ language, t: translator(language) }), [language]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useT(): Translate {
  return useContext(LocaleContext).t;
}

export function useLanguage(): Language {
  return useContext(LocaleContext).language;
}
