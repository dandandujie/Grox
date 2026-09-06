/* Custom popup select — never uses native <select>. Chip / field / ghost triggers. */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // 打开菜单时把键盘起点落在当前选中项；守卫保证每次打开只初始化一次，
  // 否则方向键更新 activeIndex 会触发本 effect 重跑并把高亮重置回去。
  const initializedForOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      initializedForOpen.current = false;
      return;
    }
    if (!initializedForOpen.current) {
      initializedForOpen.current = true;
      setActiveIndex(Math.max(0, items.findIndex((it) => it.id === activeId)));
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (items.length === 0) return;
      const last = items.length - 1;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((index) => {
          if (index < 0) return Math.max(0, last);
          const step = e.key === "ArrowDown" ? 1 : -1;
          return (index + step + items.length) % items.length;
        });
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setActiveIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setActiveIndex(last);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        // 焦点通常停留在触发按钮上：接管 Enter/Space 完成选择，避免按钮原生
        // click 把菜单关掉；选项按钮自身持有焦点时让原生 click 生效。
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('[role="option"]')) return;
        const item = items[activeIndex];
        if (!item) return;
        e.preventDefault();
        onSelect(item.id);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, items, activeId, activeIndex, onSelect]);

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
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${menuId}-${items[activeIndex]?.id}` : undefined}
        className={`${trigger} ${fullWidth && variant !== "chip" ? "w-full" : ""} ${triggerClassName}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <Icon name="chevronDown" size={9} className={`shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          id={menuId}
          className={`absolute z-50 ${menuPosition} ${menuAlign} max-h-[min(360px,60vh)] overflow-y-auto overflow-x-hidden rounded-[16px] border border-line2 bg-raise p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.55)] animate-fade-up`}
          style={{ width: fullWidth ? "100%" : `min(${width}px, calc(100vw - 32px))` }}
        >
          {items.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[10px] text-faint">—</p>
          ) : (
            items.map((it, index) => (
              <button
                key={it.id}
                id={`${menuId}-${it.id}`}
                type="button"
                role="option"
                aria-selected={it.id === activeId}
                onClick={() => {
                  onSelect(it.id);
                  setOpen(false);
                }}
                onMouseMove={() => setActiveIndex(index)}
                ref={(node) => {
                  if (node && index === activeIndex) node.scrollIntoView({ block: "nearest" });
                }}
                title={it.hint ? `${it.label} — ${it.hint}` : it.label}
                className={`grid w-full grid-cols-[6px_minmax(0,1fr)_minmax(0,0.9fr)] items-center gap-2 rounded-full px-3 py-1.5 text-left transition-colors ${
                  index === activeIndex || it.id === activeId ? "bg-high" : "hover:bg-high/60"
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
