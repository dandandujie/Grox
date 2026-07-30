/* Custom popup select — never uses native <select>. Chip / field / ghost triggers. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../fx/Icon";

export interface SelectItem {
  id: string;
  label: string;
  hint?: string;
}

export function ChipSelect({
  label,
  items,
  activeId,
  onSelect,
  width = 200,
  disabled = false,
  variant = "chip",
  menuPlacement = "up",
  fullWidth = false,
  align = "start",
  triggerClassName = "",
  "aria-label": ariaLabel,
}: {
  label: ReactNode;
  items: SelectItem[];
  activeId?: string;
  onSelect: (id: string) => void;
  width?: number;
  disabled?: boolean;
  variant?: "chip" | "field" | "ghost";
  menuPlacement?: "up" | "down";
  fullWidth?: boolean;
  align?: "start" | "end";
  triggerClassName?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const trigger =
    variant === "field"
      ? `flex h-9 w-full min-w-0 items-center gap-2 rounded-full border border-line2 bg-void px-3.5 font-mono text-[10.5px] text-fg2 outline-none transition-colors hover:border-line3 disabled:cursor-wait disabled:opacity-60 ${open ? "border-line3" : ""}`
      : variant === "ghost"
        ? `inline-flex max-w-full min-w-0 items-center gap-1.5 bg-transparent font-mono text-[10px] text-dim outline-none hover:text-fg2 disabled:cursor-wait disabled:opacity-60`
        : `chip max-w-[260px] min-w-0 disabled:cursor-wait disabled:opacity-60`;

  const menuPosition =
    menuPlacement === "down"
      ? "top-full mt-1.5"
      : "bottom-full mb-1.5";
  const menuAlign = align === "end" ? "right-0" : "left-0";

  return (
    <div ref={ref} className={`relative min-w-0 ${fullWidth ? "w-full" : ""}`}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`${trigger} ${fullWidth && variant !== "chip" ? "w-full" : ""} ${triggerClassName}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <Icon name="chevronDown" size={9} className={`shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className={`absolute z-50 ${menuPosition} ${menuAlign} max-h-[min(360px,60vh)] overflow-y-auto overflow-x-hidden rounded-[16px] border border-line2 bg-raise p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.55)] animate-fade-up`}
          style={{ width: fullWidth ? "100%" : `min(${width}px, calc(100vw - 32px))` }}
        >
          {items.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[10px] text-faint">—</p>
          ) : (
            items.map((it) => (
              <button
                key={it.id}
                type="button"
                role="option"
                aria-selected={it.id === activeId}
                onClick={() => {
                  onSelect(it.id);
                  setOpen(false);
                }}
                title={it.hint ? `${it.label} — ${it.hint}` : it.label}
                className={`grid w-full grid-cols-[6px_minmax(0,1fr)_minmax(0,0.9fr)] items-center gap-2 rounded-full px-3 py-1.5 text-left transition-colors ${
                  it.id === activeId ? "bg-high" : "hover:bg-high/60"
                }`}
              >
                <span
                  className={`h-1 w-1 shrink-0 rounded-full ${it.id === activeId ? "bg-acc" : "bg-transparent"}`}
                />
                <span className="truncate font-mono text-[11px] text-fg2">{it.label}</span>
                <span className="truncate text-right text-[10px] text-faint">{it.hint ?? ""}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
