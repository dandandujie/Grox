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
}: {
  label: ReactNode;
  items: SelectItem[];
  activeId?: string;
  onSelect: (id: string) => void;
  width?: number;
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
    <div ref={ref} className="relative">
      <button className="chip" onClick={() => setOpen((v) => !v)}>
        {label}
        <Icon name="chevronDown" size={9} className="text-faint" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 z-40 mb-1.5 overflow-hidden rounded-[6px] border border-line2 bg-raise py-1 shadow-[0_8px_28px_rgba(0,0,0,0.55)] animate-fade-up"
          style={{ width }}
        >
          {items.map((it) => (
            <button
              key={it.id}
              onClick={() => {
                onSelect(it.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                it.id === activeId ? "bg-high" : "hover:bg-high/60"
              }`}
            >
              <span
                className={`h-1 w-1 shrink-0 rounded-full ${it.id === activeId ? "bg-acc" : "bg-transparent"}`}
              />
              <span className="flex-1 font-mono text-[11px] text-fg2">{it.label}</span>
              {it.hint && <span className="text-[10px] text-faint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
