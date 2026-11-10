import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export function IconButton({
  label, children, onClick, className, active, disabled, size = 32, type = "button",
}: {
  label: string;
  children: ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  active?: boolean;
  disabled?: boolean;
  size?: number;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn("icon-button", active && "is-active", className)}
      style={{ width: size, height: size }}
    >
      {children}
    </button>
  );
}

export function Modal({
  open, onClose, title, children, className, width = 520, labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  width?: number;
  labelledBy?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      const dialog = dialogRef.current;
      const target = dialog?.querySelector<HTMLElement>("[autofocus]")
        ?? dialog?.querySelector<HTMLElement>("input:not([type=file]), textarea, select")
        ?? dialog?.querySelector<HTMLElement>("button");
      target?.focus();
    }, 30);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className={cn("modal", className)}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
      >
        {title && (
          <header className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
          </header>
        )}
        {children}
      </div>
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value, options, onChange, label, className, size = "md",
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("segmented", size === "sm" && "segmented-sm", className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={option.disabled}
          aria-pressed={option.value === value}
          className={cn("segment", option.value === value && "is-active")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn("switch", checked && "is-on")}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("field", className)}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <span className={cn("spinner", className)} style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" }) {
  return <span className={cn("badge", "badge-" + tone)}>{children}</span>;
}
