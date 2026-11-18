import { useT } from "@/i18n";
import { AlertTriangle, Bell, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useApp } from "@/state/store";
import { Modal } from "@/components/ui";
import { cn } from "@/lib/cn";

export function ConfirmDialog() {
  const t = useT();
  const { confirm, closeConfirm } = useApp();
  return (
    <Modal open={Boolean(confirm)} onClose={closeConfirm} title={undefined} width={430} className="confirm-modal">
      {confirm && (
        <div className="confirm-body">
          <span className={cn("confirm-icon", confirm.danger && "is-danger")}>
            <AlertTriangle size={20} />
          </span>
          <h2>{confirm.title}</h2>
          {confirm.body && <p>{confirm.body}</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={closeConfirm}>{t("Cancel")}</button>
            <button
              type="button"
              className={cn("btn", confirm.danger ? "btn-danger" : "btn-primary")}
              onClick={() => { confirm.onConfirm(); closeConfirm(); }}
            >
              {confirm.confirmLabel ?? t("Confirm")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Toasts() {
  const t = useT();
  const { toasts, dismissToast } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="region" aria-label={t("Notifications")}>
      {toasts.map((toast) => (
        <div key={toast.id} className={cn("toast", "toast-" + toast.kind)} role="status">
          <span className="toast-icon">
            {toast.kind === "error" ? <XCircle size={16} /> : toast.kind === "success" ? <CheckCircle2 size={16} /> : toast.kind === "info" ? <Info size={16} /> : <Bell size={16} />}
          </span>
          <div className="toast-copy">
            <div>{toast.title}</div>
            {toast.body && <p>{toast.body}</p>}
          </div>
          <button type="button" className="toast-close" aria-label={t("Dismiss")} onClick={() => dismissToast(toast.id)}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "⌘ K", label: "Command palette" },
  { keys: "⌘ N", label: "New bot" },
  { keys: "⌘ ⇧ N", label: "New task" },
  { keys: "⌘ ,", label: "Settings" },
  { keys: "⌘ F", label: "Search bots and messages" },
  { keys: "⌘ 1–9", label: "Switch to a bot" },
  { keys: "⌘ /", label: "Keyboard shortcuts" },
  { keys: "↵", label: "Send a message" },
  { keys: "⇧ ↵", label: "New line in the composer" },
  { keys: "Esc", label: "Close the top surface" },
];

export function ShortcutsModal() {
  const t = useT();
  const { ui, setUI } = useApp();
  return (
    <Modal open={ui.shortcutsOpen} onClose={() => setUI({ shortcutsOpen: false })} title={t("Keyboard shortcuts")} width={520}>
      <div className="shortcut-list">
        {SHORTCUTS.map((shortcut) => (
          <div className="shortcut-row" key={shortcut.keys}>
            <span>{t(shortcut.label)}</span>
            <span className="shortcut-keys">{shortcut.keys.split(" ").map((key) => <span className="keycap" key={key}>{key}</span>)}</span>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setUI({ shortcutsOpen: false })}>{t("Done")}</button>
      </div>
    </Modal>
  );
}
