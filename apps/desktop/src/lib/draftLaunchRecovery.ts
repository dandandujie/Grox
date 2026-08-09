import type {
  AgentMode,
  Effort,
  PermissionMode,
  PromptAttachment,
  Session,
  SessionStatus,
} from "../bridge/types";

export type DraftLaunchPayload = {
  text: string;
  attachments: PromptAttachment[];
};

export type DraftComposerSnapshot = {
  text: string;
  attachments: PromptAttachment[];
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
};

export type DraftComposerControls = {
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
};

/**
 * When the first draft send hands off to `session/new`, keep a recoverable
 * snapshot until `session_ready`. If create fails, rebuild a draft shell so
 * the operator never loses text + attachments.
 */
export function buildDraftRestoreAfterSessionNewFailure(input: {
  pendingId: string;
  draftId: string;
  workspace: string;
  launch: DraftLaunchPayload | undefined;
  sessions: Record<string, Session>;
  sessionComposers: Record<string, DraftComposerSnapshot>;
  controls: DraftComposerControls;
  now: number;
}): {
  sessions: Record<string, Session>;
  sessionComposers: Record<string, DraftComposerSnapshot>;
  activeId: string;
  view: "session";
  draftText: string;
  draftAttachments: PromptAttachment[];
} {
  const draftText = input.launch?.text ?? "";
  const draftAttachments = input.launch?.attachments ?? [];
  const nextSessions = { ...input.sessions };
  delete nextSessions[input.pendingId];
  for (const id of Object.keys(nextSessions)) {
    if (id.startsWith("pending-") || id.startsWith("draft-")) {
      delete nextSessions[id];
    }
  }

  const emptyUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    contextUsed: 0,
    contextMax: 0,
    turns: 0,
  };

  nextSessions[input.draftId] = {
    id: input.draftId,
    title: "",
    cwd: input.workspace,
    createdAt: input.now,
    updatedAt: input.now,
    model: input.controls.model,
    blocks: [],
    usage: emptyUsage,
    status: "idle" as SessionStatus,
  };

  const nextComposers = { ...input.sessionComposers };
  delete nextComposers[input.pendingId];
  nextComposers[input.draftId] = {
    text: draftText,
    attachments: draftAttachments,
    model: input.controls.model,
    effort: input.controls.effort,
    mode: input.controls.mode,
    permissionMode: input.controls.permissionMode,
  };

  return {
    sessions: nextSessions,
    sessionComposers: nextComposers,
    activeId: input.draftId,
    view: "session",
    draftText,
    draftAttachments,
  };
}

/** First-send draft must keep crash buffer until ACP session is ready. */
export function shouldRetainDraftBufferUntilSessionReady(sessionId: string): boolean {
  return sessionId.startsWith("draft-");
}
