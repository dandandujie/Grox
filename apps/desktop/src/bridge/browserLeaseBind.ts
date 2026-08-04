/**
 * Bind exactly one pending Browser Use lease to a session.
 * Concurrent session/new must not migrate unrelated pending:* entries.
 */
export function claimPendingBrowserLease(
  leases: Map<string, string>,
  sessionId: string,
  browserLeaseId: string,
): void {
  if (!browserLeaseId) return;
  const pendingKey = `pending:${browserLeaseId}`;
  if (leases.get(pendingKey) !== browserLeaseId) return;
  leases.delete(pendingKey);
  leases.set(sessionId, browserLeaseId);
}
