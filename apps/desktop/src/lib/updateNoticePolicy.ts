/**
 * Update-notice policy.
 *
 * The release heartbeat polls every couple of minutes. Closing the dialog
 * must not reopen the same release this session; "skip this version" must
 * persist so only a newer tag auto-opens again.
 */

const SKIPPED_UPDATE_KEY = "grox.skippedUpdateVersion";

export function normalizeReleaseVersion(value: string): string {
  return value.trim().replace(/^[vV]/, "");
}

export function isSkippedUpdateVersion(
  latestVersion: string,
  skippedVersion: string | null | undefined,
): boolean {
  if (!skippedVersion) return false;
  const latest = normalizeReleaseVersion(latestVersion);
  const skipped = normalizeReleaseVersion(skippedVersion);
  return Boolean(latest && skipped && latest === skipped);
}

export function shouldAutoOpenUpdate(args: {
  updateAvailable: boolean;
  latestVersion: string;
  skippedVersion: string | null | undefined;
  sessionDismissed: boolean;
}): boolean {
  if (!args.updateAvailable) return false;
  if (args.sessionDismissed) return false;
  if (isSkippedUpdateVersion(args.latestVersion, args.skippedVersion)) return false;
  return true;
}

/** A newer tag than the one just dismissed should prompt again. */
export function shouldResetSessionDismiss(
  previousLatest: string | null | undefined,
  nextLatest: string,
): boolean {
  if (!previousLatest) return false;
  return normalizeReleaseVersion(previousLatest) !== normalizeReleaseVersion(nextLatest);
}

export function readSkippedUpdateVersion(): string | null {
  try {
    const raw = localStorage.getItem(SKIPPED_UPDATE_KEY);
    if (!raw) return null;
    const normalized = normalizeReleaseVersion(raw);
    return normalized || null;
  } catch {
    return null;
  }
}

export function writeSkippedUpdateVersion(version: string): void {
  const normalized = normalizeReleaseVersion(version);
  if (!normalized) return;
  try {
    localStorage.setItem(SKIPPED_UPDATE_KEY, normalized);
  } catch {
    // Private-mode / blocked storage — skip state is best-effort.
  }
}

export function clearSkippedUpdateVersion(): void {
  try {
    localStorage.removeItem(SKIPPED_UPDATE_KEY);
  } catch {
    // ignore
  }
}
