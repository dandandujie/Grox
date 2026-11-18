import { localeTag, translate, type Language } from "@/i18n";

const DAY = 86_400_000;

export function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function clock(value: string | Date, language: Language): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "";
  return date.toLocaleTimeString(localeTag(language), { hour: "numeric", minute: "2-digit" });
}

export function sidebarTime(value: string | undefined, language: Language): string {
  const date = parseDate(value);
  if (!date) return "";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const then = date.getTime();
  if (then >= start) return clock(date, language);
  if (then >= start - DAY) return translate(language, "Yesterday");
  if (then >= start - 6 * DAY) return date.toLocaleDateString(localeTag(language), { weekday: "short" });
  return date.toLocaleDateString(localeTag(language), { month: "short", day: "numeric" });
}

export function dayKey(value: string): string {
  const date = parseDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabel(value: string, language: Language): string {
  const date = parseDate(value);
  if (!date) return "";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const then = date.getTime();
  const time = clock(date, language);
  if (then >= start) return translate(language, "Today {0}", time);
  if (then >= start - DAY) return translate(language, "Yesterday {0}", time);
  return `${date.toLocaleDateString(localeTag(language), { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export function relative(value: string | undefined, language: Language, now = new Date()): string {
  const date = parseDate(value);
  if (!date) return "";
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(localeTag(language), { numeric: "auto" });
  if (abs < 60_000) return translate(language, "now");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 7 * DAY) return rtf.format(Math.round(diff / DAY), "day");
  return date.toLocaleDateString(localeTag(language), { month: "short", day: "numeric" });
}

export function shortDate(value: string | Date, language: Language): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "";
  return date.toLocaleDateString(localeTag(language), { month: "short", day: "numeric" });
}

export function weekdayShort(date: Date, language: Language): string {
  return date.toLocaleDateString(localeTag(language), { weekday: "short" });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[parts.length - 1]!.slice(0, 1)).toUpperCase();
}

export function truncate(value: string, length = 60): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  return text.slice(0, length - 1) + "…";
}

export function iso(value: Date): string {
  return value.toISOString();
}
