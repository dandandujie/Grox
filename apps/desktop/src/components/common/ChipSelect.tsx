/* Minimal popup select — chip trigger, upward menu, closes on outside/Esc. */

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
}: {
  label: ReactNode;
  items: SelectItem[];
  activeId?: string;
  onSelect: (id: string) => void;
  width?: number;
  disabled?: boolean;
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

  return (
    <div ref={ref} className="relative min-w-0">
      <button disabled={disabled} className="chip max-w-[220px] min-w-0 disabled:cursor-wait disabled:opacity-60" onClick={() => setOpen((v) => !v)}>
        <span className="min-w-0 truncate">{label}</span>
        <Icon name="chevronDown" size={9} className="text-faint" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 z-40 mb-1.5 max-h-[min(360px,60vh)] overflow-y-auto overflow-x-hidden rounded-[6px] border border-line2 bg-raise py-1 shadow-[0_8px_28px_rgba(0,0,0,0.55)] animate-fade-up"
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
        >
          {items.map((it) => (
            <button
              key={it.id}
              onClick={() => {
                onSelect(it.id);
                setOpen(false);
              }}
              title={it.hint ? `${it.label} — ${it.hint}` : it.label}
              className={`grid w-full grid-cols-[6px_minmax(0,1fr)_minmax(0,0.9fr)] items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                it.id === activeId ? "bg-high" : "hover:bg-high/60"
              }`}
            >
              <span
                className={`h-1 w-1 shrink-0 rounded-full ${it.id === activeId ? "bg-acc" : "bg-transparent"}`}
              />
              <span className="truncate font-mono text-[11px] text-fg2">{it.label}</span>
              <span className="truncate text-right text-[10px] text-faint">{it.hint ?? ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
