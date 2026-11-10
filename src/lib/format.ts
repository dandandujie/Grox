const DAY = 86_400_000;

export function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function clock(value: string | Date): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "";
  return date.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
}

export function sidebarTime(value: string | undefined): string {
  const date = parseDate(value);
  if (!date) return "";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const then = date.getTime();
  if (then >= start) return clock(date);
  if (then >= start - DAY) return "Yesterday";
  if (then >= start - 6 * DAY) return date.toLocaleDateString("en", { weekday: "short" });
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

export function dayKey(value: string): string {
  const date = parseDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabel(value: string): string {
  const date = parseDate(value);
  if (!date) return "";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const then = date.getTime();
  const time = clock(date);
  if (then >= start) return `Today ${time}`;
  if (then >= start - DAY) return `Yesterday ${time}`;
  return `${date.toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export function relative(value: string | undefined, now = new Date()): string {
  const date = parseDate(value);
  if (!date) return "";
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60_000) return "now";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 7 * DAY) return rtf.format(Math.round(diff / DAY), "day");
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

export function shortDate(value: string | Date): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "";
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

export function weekdayShort(date: Date): string {
  return date.toLocaleDateString("en", { weekday: "short" });
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
