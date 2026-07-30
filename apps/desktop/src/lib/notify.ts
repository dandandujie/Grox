/* Desktop notifications for permission / plan / question prompts when the window is in the background. */

import { invoke } from "@tauri-apps/api/core";

const inTauri = () => "__TAURI_INTERNALS__" in window;

let permissionAsked = false;

export async function ensureNotifyPermission(): Promise<boolean> {
  if (!("Notification" in window)) return inTauri();
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return inTauri();
  if (!permissionAsked) {
    permissionAsked = true;
    try {
      const result = await Notification.requestPermission();
      if (result === "granted") return true;
    } catch {
      // fall through
    }
  }
  return inTauri();
}

export async function notifyDesktop(title: string, body: string): Promise<void> {
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  const enabled = localStorage.getItem("grox.desktopNotify") !== "0";
  if (!enabled) return;

  const ok = await ensureNotifyPermission();
  if (!ok) return;

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body, silent: false });
      return;
    } catch {
      // fall through to native toast
    }
  }

  if (inTauri()) {
    try {
      await invoke("notify_desktop", { title, body });
    } catch {
      // best-effort
    }
  }
}
