/**
 * Policy for opening old missions after a desktop shell upgrade.
 *
 * Evidence: after install/update, operators open a long session and see broken
 * chrome (empty process fold, send hangs) until they fully quit and reopen.
 *
 * Root cause class: `get_ui_transcript` fingerprint can still match while the
 * *painted* snapshot is truncated / pre-upgrade shaped; openSession then marks
 * offlineHistoryComplete and skips the full disk rescan. A cold restart often
 * races differently or picks a fresher path — feels like "must close window".
 *
 * 0.2.30: force is **per-session once** within the upgrade generation — not a
 * process-wide permanent Wave-1 bypass for every mission (perf on multi-open).
 */

export const SHELL_VERSION_STORAGE_KEY = "grox.lastShellVersion";

/**
 * Pin the running shell version. Returns true when the version **changed**
 * (including first pin after this feature ships) so callers can force a one-shot
 * offline history rescan + bind reset.
 */
export function consumeShellUpgradeRescan(currentVersion: string): boolean {
  const current = currentVersion.trim();
  if (!current) return false;
  const previous = localStorage.getItem(SHELL_VERSION_STORAGE_KEY);
  if (previous === current) return false;
  localStorage.setItem(SHELL_VERSION_STORAGE_KEY, current);
  return true;
}

/**
 * When true, openSession must not treat fingerprint UI transcript as final —
 * paint it for speed, but still kick the full offline scan and re-bind on send.
 *
 * `sessionAlreadyForceRescanned`: this mission already completed a force scan
 * in the current upgrade generation — do not force again.
 */
export function shouldForceOfflineRescan(args: {
  upgradeRescanActive: boolean;
  sessionAlreadyForceRescanned?: boolean;
  /** @deprecated unused — kept for call-site compatibility during 0.2.x */
  alreadyComplete?: boolean;
}): boolean {
  if (!args.upgradeRescanActive) return false;
  if (args.sessionAlreadyForceRescanned) return false;
  return true;
}

/**
 * Sanitize a cached/fingerprint session for post-upgrade paint: never resume a
 * busy status from a previous shell generation.
 */
export function sanitizeSessionForOpen(_session: {
  status: string;
  blocks: readonly unknown[];
}): { status: "idle" } {
  return { status: "idle" };
}

export function shouldCloseDetachedSession(args: {
  currentId: string | null;
  nextId?: string | null;
  status?: string;
}): args is { currentId: string; nextId?: string | null; status: string } {
  return Boolean(
    args.currentId
    // Local draft / pending shells are never ACP-attached.
    && !args.currentId.startsWith("pending-")
    && !args.currentId.startsWith("draft-")
    && args.currentId !== args.nextId
    && (args.status === "idle" || args.status === "failed"),
  );
}
