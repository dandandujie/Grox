import { useEffect, useMemo, useRef, useState } from "react";
import { agentRuntimeStatus, gitCheckout, gitCommit, gitPush, gitSummary, gitWorktreeAdd, gitWorktreeRemove, gitWorktrees, openExternal, openInApp, prepareGitCommit, prepareGitPush, prepareGitWorktreeRemove, sessionJournalStatus } from "../../lib/hostActions";
import { useDesktop } from "../../state/store";
import { MAX_ATTACHMENTS, prepareAttachment, validateAttachmentSet } from "../../lib/attachments";
import { baseName } from "../../lib/format";
import { samePath } from "../../lib/projectCatalog";
import { useI18n } from "../../lib/i18n";
import { useImeGuard } from "../../lib/ime";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "../common/ChipSelect";

interface GitSummary {
  isRepository: boolean;
  branch?: string;
  branches: string[];
  added: number;
  removed: number;
  changedFiles: number;
  remoteUrl?: string;
  defaultBranch?: string;
  ahead: number;
  behind: number;
}

interface GitWorktree {
  path: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

interface SessionJournalStatus {
  count: number;
  totalBytes: number;
  latestSavedAt?: number;
  migrationPending: number;
  unreadableCount: number;
}

interface AgentRuntimeStatus {
  topology: "shared_process";
  processCapacity: number;
  running: boolean;
  ready: boolean;
  phase: "stopped" | "starting" | "initializing" | "authenticating" | "ready" | "paused" | "offline";
  generation?: number;
  pid?: number;
  pendingRequests: number;
  pendingInteractions: number;
  pendingClientCallbacks: number;
  boundClientSessions: number;
  activeTerminals: number;
  automaticReconnectActive: boolean;
  lastConnectConfigured: boolean;
  worktreeSessionBindings: number;
  worktreeOwnershipError?: string;
}

interface SummarySource {
  id: string;
  kind: "attachment" | "link";
  label: string;
  url?: string;
}

const inTauri = () => "__TAURI_INTERNALS__" in window;

const githubBaseUrl = (remote?: string) => {
  if (!remote) return null;
  const ssh = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (ssh) return `https://github.com/${ssh[1].replace(/\.git$/i, "")}`;
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return `${url.origin}${url.pathname.replace(/\.git$/i, "").replace(/\/$/, "")}`;
  } catch {
    return null;
  }
};

const linksFromText = (text: string) =>
  text.match(/https?:\/\/[^\s<>"')\]]+/g)?.map((url) => url.replace(/[.,;:!?]+$/, "")) ?? [];

export function EnvironmentSummary() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const { onCompositionStart, onCompositionEnd, isImeBlocking } = useImeGuard();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [journalStatus, setJournalStatus] = useState<SessionJournalStatus | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"checkout" | "commit" | "push" | "worktree" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [worktreeName, setWorktreeName] = useState("");
  const [confirmWorktree, setConfirmWorktree] = useState<GitWorktree | null>(null);
  const [showAllSources, setShowAllSources] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadGenerationRef = useRef(0);
  const workspace = useDesktop((state) => state.workspace);
  const runtimeOccupancy = useDesktop((state) => state.runtimeOccupancy);
  const activeId = useDesktop((state) => state.activeId);
  const session = useDesktop((state) => (state.activeId ? state.sessions[state.activeId] : null));
  const composer = useDesktop((state) => (state.activeId ? state.sessionComposers[state.activeId] : null));
  const setComposerAttachments = useDesktop((state) => state.setComposerAttachments);
  const openProjectInExplorer = useDesktop((state) => state.openProjectInExplorer);

  const sources = useMemo<SummarySource[]>(() => {
    const items = new Map<string, SummarySource>();
    for (const attachment of composer?.attachments ?? []) {
      items.set(`attachment:${attachment.name}`, {
        id: `composer-${attachment.id}`,
        kind: "attachment",
        label: attachment.name,
      });
    }
    for (const block of session?.blocks ?? []) {
      if (block.type === "user") {
        for (const attachment of block.attachments ?? []) {
          const key = `attachment:${attachment.name}`;
          if (!items.has(key)) items.set(key, { id: attachment.id, kind: "attachment", label: attachment.name });
        }
      }
      if (block.type === "user" || block.type === "assistant") {
        for (const url of linksFromText(block.text)) {
          if (!items.has(url)) items.set(url, { id: url, kind: "link", label: url.replace(/^https?:\/\//, ""), url });
        }
      }
    }
    return [...items.values()];
  }, [composer?.attachments, session]);

  const loadSummary = async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError("");
    // 切换工作区后旧快照不能继续提供可点击的 worktree 目标；若新目录读取
    // 失败，应呈现真实错误，而不是让旧数据挂在新的 cwd 下。
    setSummary(null);
    setWorktrees([]);
    setJournalStatus(null);
    setRuntimeStatus(null);
    try {
      if (inTauri()) {
        const [nextSummary, nextWorktrees, nextJournalStatus, nextRuntimeStatus] = await Promise.all([
          gitSummary<GitSummary>(workspace),
          gitWorktrees<GitWorktree[]>(workspace),
          sessionJournalStatus<SessionJournalStatus>(),
          agentRuntimeStatus<AgentRuntimeStatus>(),
        ]);
        if (generation !== loadGenerationRef.current) return;
        setSummary(nextSummary);
        setWorktrees(nextWorktrees);
        setJournalStatus(nextJournalStatus);
        setRuntimeStatus(nextRuntimeStatus);
      } else {
        if (generation !== loadGenerationRef.current) return;
        setSummary({
          isRepository: true,
          branch: "main",
          branches: ["main", "feature/summary-card"],
          added: 220,
          removed: 31,
          changedFiles: 4,
          remoteUrl: "https://github.com/dandandujie/Grox.git",
          defaultBranch: "main",
          ahead: 0,
          behind: 0,
        });
        setWorktrees([]);
        setJournalStatus({ count: 12, totalBytes: 1_480_000, latestSavedAt: Date.now(), migrationPending: 0, unreadableCount: 0 });
        setRuntimeStatus({ topology: "shared_process", processCapacity: 1, running: true, ready: true, phase: "ready", generation: 1, pid: 12345, pendingRequests: 0, pendingInteractions: 0, pendingClientCallbacks: 0, boundClientSessions: 0, activeTerminals: 0, automaticReconnectActive: false, lastConnectConfigured: true, worktreeSessionBindings: 0 });
      }
    } catch (cause) {
      if (generation === loadGenerationRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadSummary();
    else loadGenerationRef.current += 1;
  }, [open, workspace]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const runAction = async (kind: "checkout" | "commit" | "push" | "worktree", action: () => Promise<string>) => {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      const result = await action();
      setNotice(result);
      await loadSummary();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const checkout = (branch: string) => {
    if (!branch || branch === summary?.branch) return;
    if (!window.confirm(zh ? `切换到分支 ${branch}？未提交的变更将保留。` : `Switch to ${branch}? Uncommitted changes will be kept.`)) return;
    void runAction("checkout", () =>
      inTauri() ? gitCheckout(workspace, branch) : Promise.resolve(zh ? `已切换到 ${branch}` : `Switched to ${branch}`),
    );
  };

  const commit = () => {
    const message = commitMessage.trim();
    if (!message) return;
    void runAction("commit", async () => {
      if (!inTauri()) return zh ? "提交已创建" : "Commit created";
      // Native shell shows the OS confirm dialog inside prepare_git_commit.
      const confirmToken = await prepareGitCommit(workspace);
      return gitCommit(workspace, message, confirmToken);
    }).then((succeeded) => {
      if (succeeded) {
        setCommitMessage("");
        setCommitOpen(false);
      }
    });
  };

  const push = () => {
    void runAction("push", async () => {
      if (!inTauri()) return zh ? "推送已完成" : "Push completed";
      // Native shell shows the OS confirm dialog inside prepare_git_push.
      const confirmToken = await prepareGitPush(workspace);
      return gitPush(workspace, confirmToken);
    });
  };

  const openCompare = () => {
    const base = githubBaseUrl(summary?.remoteUrl);
    const branch = summary?.branch;
    if (!base || !branch) return;
    const target = `${base}/compare/${encodeURIComponent(summary?.defaultBranch ?? "main")}...${encodeURIComponent(branch)}`;
    if (inTauri()) void openExternal(target);
    else window.open(target, "_blank", "noopener,noreferrer");
  };

  const addSources = async (files: FileList | null) => {
    if (!files || !activeId) return;
    setError("");
    try {
      const prepared = await Promise.all([...files].map((file) => prepareAttachment(file)));
      const next = [...(composer?.attachments ?? []), ...prepared];
      validateAttachmentSet(next);
      setComposerAttachments(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeWorktree = async (item: GitWorktree) => {
    setBusy("worktree");
    setError("");
    setNotice("");
    try {
      const result = inTauri()
        ? await (async () => {
            const confirmToken = await prepareGitWorktreeRemove(workspace, item.path);
            return gitWorktreeRemove({ cwd: workspace, path: item.path, confirmToken });
          })()
        : (zh ? "Worktree 已移除" : "Worktree removed");
      setNotice(result);
      setConfirmWorktree(null);
      await loadSummary();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBusy(null);
    }
  };

  const visibleSources = showAllSources ? sources : sources.slice(0, 4);
  const compareAvailable = Boolean(
    githubBaseUrl(summary?.remoteUrl)
      && summary?.branch
      && summary.branch !== (summary.defaultBranch ?? "main"),
  );
  const activeTurns = runtimeOccupancy.activeTurnSessionIds.length;
  const runtimeOccupancyLabel = runtimeOccupancy.lifecycleActive
    ? (runtimeOccupancy.pendingLifecycle > 0
      ? `${zh ? "同步中" : "syncing"} +${runtimeOccupancy.pendingLifecycle}`
      : (zh ? "同步中" : "syncing"))
    : runtimeOccupancy.pendingLifecycle > 0
      ? `${runtimeOccupancy.pendingLifecycle} ${zh ? "待同步" : "queued"}`
      : activeTurns > 0
        ? `${activeTurns} ${zh ? "活跃" : "active"}`
        : "";
  const runtimePhaseLabel = runtimeStatus && ({
    stopped: zh ? "已停止" : "stopped",
    starting: zh ? "启动中" : "starting",
    initializing: zh ? "初始化中" : "initializing",
    authenticating: zh ? "认证中" : "authenticating",
    ready: zh ? "已就绪" : "ready",
    paused: zh ? "已暂停" : "paused",
    offline: zh ? "离线" : "offline",
  } as const)[runtimeStatus.phase];

  return (
    <div ref={rootRef} className="relative">
      <button
        className={`chip ${open ? "!border-line3 !text-fg2" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title={zh ? "环境摘要" : "Environment summary"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Icon name="summary" size={12} />
      </button>

      {open && (
        <section
          role="dialog"
          aria-label={zh ? "环境摘要" : "Environment summary"}
          className="absolute right-0 top-[calc(100%+9px)] z-50 max-h-[calc(100vh-52px)] w-[min(380px,calc(100vw-20px))] overflow-y-auto rounded-[10px] border border-line2 bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.58)] animate-fade-up"
        >
          <div className="flex h-11 items-center border-b border-line px-4">
            <span className="lbl !text-[10px] !tracking-[0.12em]">{zh ? "环境信息" : "ENVIRONMENT"}</span>
            <button
              onClick={() => void loadSummary()}
              className="ml-auto flex h-7 w-7 items-center justify-center text-dim hover:bg-high hover:text-fg"
              title={zh ? "刷新" : "Refresh"}
              aria-label={zh ? "刷新环境信息" : "Refresh environment"}
            >
              <Icon name="refresh" size={11} className={loading ? "animate-orbit" : ""} />
            </button>
          </div>

          <div className="p-3">
            <SummaryRow icon="edit" label={zh ? "变更" : "Changes"}>
              <span className="ml-auto flex items-center gap-1.5 font-mono text-[10.5px]">
                <span className="text-dim">{summary?.changedFiles ?? 0}</span>
                <span className="text-green">+{summary?.added ?? 0}</span>
                <span className="text-red">−{summary?.removed ?? 0}</span>
              </span>
            </SummaryRow>

            <button onClick={() => void openProjectInExplorer()} className="summary-row w-full" title={workspace}>
              <Icon name="folder" size={14} className="text-mute" />
              <span className="min-w-0 flex-1 truncate text-left">{zh ? "本地" : "Local"}</span>
              <span className="max-w-[72px] truncate text-[10px] text-dim">{baseName(workspace)}</span>
              <span className="max-w-[150px] truncate font-mono text-[9px] text-faint">{workspace}</span>
              <Icon name="external" size={10} className="text-faint" />
            </button>

            <SummaryRow icon="clock" label={zh ? "会话 journal" : "Session journal"}>
              <span
                className={`ml-auto font-mono text-[9.5px] ${journalStatus?.unreadableCount ? "text-red" : journalStatus?.migrationPending ? "text-gold" : "text-dim"}`}
                title={journalStatus?.latestSavedAt
                  ? `${zh ? "最近写入" : "Latest write"}: ${new Date(journalStatus.latestSavedAt).toLocaleString()}`
                  : undefined}
              >
                {journalStatus
                  ? journalStatus.unreadableCount > 0
                    ? (zh ? `${journalStatus.unreadableCount} 个无法读取` : `${journalStatus.unreadableCount} unreadable`)
                    : journalStatus.migrationPending > 0
                      ? (zh ? `${journalStatus.migrationPending} 个待迁移` : `${journalStatus.migrationPending} to migrate`)
                      : `${journalStatus.count} · ${(journalStatus.totalBytes / 1024 / 1024).toFixed(1)} MB`
                  : "—"}
              </span>
            </SummaryRow>

            <SummaryRow icon="bolt" label={zh ? "Agent 运行时" : "Agent runtime"}>
              <span
                className={`ml-auto font-mono text-[9.5px] ${runtimeStatus?.ready ? "text-green" : runtimeStatus?.running ? "text-gold" : "text-dim"}`}
                title={runtimeStatus
                  ? [
                      runtimeStatus.running ? (zh ? "进程运行中" : "Process running") : (zh ? "按需启动" : "Starts on demand"),
                      `${zh ? "连接阶段" : "Connection phase"}: ${runtimePhaseLabel}`,
                      runtimeStatus.pid ? `PID ${runtimeStatus.pid}` : "",
                      runtimeStatus.generation ? `${zh ? "代次" : "Generation"} ${runtimeStatus.generation}` : "",
                      runtimeStatus.pendingRequests > 0
                        ? `${runtimeStatus.pendingRequests} ${zh ? "个 Host 请求等待响应" : "Host requests pending"}`
                        : "",
                      runtimeStatus.pendingInteractions > 0
                        ? `${runtimeStatus.pendingInteractions} ${zh ? "个交互门控等待用户" : "operator gates pending"}`
                        : "",
                      runtimeStatus.pendingClientCallbacks > 0
                        ? `${runtimeStatus.pendingClientCallbacks} ${zh ? "个 Client 回调处理中" : "client callbacks pending"}`
                        : "",
                      runtimeStatus.boundClientSessions > 0
                        ? `${runtimeStatus.boundClientSessions} ${zh ? "个会话已绑定工作区" : "sessions bound to workspaces"}`
                        : "",
                      runtimeStatus.activeTerminals > 0
                        ? `${runtimeStatus.activeTerminals} ${zh ? "个 Host 终端仍被持有" : "Host terminals retained"}`
                        : "",
                      runtimeStatus.automaticReconnectActive
                        ? (zh ? "Host 正在自动重连" : "Host automatic reconnect active")
                        : "",
                      !runtimeStatus.lastConnectConfigured
                        ? (zh ? "尚未建立可自动恢复的连接" : "No reconnectable connection yet")
                        : "",
                      runtimeStatus.worktreeSessionBindings > 0
                        ? `${runtimeStatus.worktreeSessionBindings} ${zh ? "个会话绑定到 worktree" : "sessions bound to worktrees"}`
                        : "",
                      runtimeStatus.worktreeOwnershipError
                        ? `${zh ? "Worktree 所有权索引异常" : "Worktree ownership index error"}: ${runtimeStatus.worktreeOwnershipError}`
                        : "",
                      activeTurns > 0 ? `${activeTurns} ${zh ? "个活动回合" : "active turns"}` : "",
                      runtimeOccupancy.lifecycleActive ? (zh ? "会话同步占用中" : "Session sync active") : "",
                      runtimeOccupancy.pendingLifecycle > 0
                        ? `${runtimeOccupancy.pendingLifecycle} ${zh ? "个会话同步排队" : "session syncs queued"}`
                        : "",
                    ].filter(Boolean).join(" · ")
                  : undefined}
              >
                {runtimeStatus
                  ? [
                      `${zh ? "共享" : "Shared"} · ${runtimeStatus.processCapacity} ${zh ? "进程" : "process"}`,
                      runtimeStatus.ready ? "" : runtimePhaseLabel,
                      runtimeOccupancyLabel,
                    ].filter(Boolean).join(" · ")
                  : "—"}
              </span>
            </SummaryRow>

            <div className="mx-2 mb-2 grid grid-cols-4 gap-1">
              {([
                ["cursor", "Cursor"],
                ["code", "VS Code"],
                ["terminal", zh ? "终端" : "Term"],
                ["explorer", zh ? "目录" : "Files"],
              ] as const).map(([app, label]) => (
                <button
                  key={app}
                  disabled={!inTauri()}
                  onClick={() => {
                    void openInApp(workspace, app).then(
                      () => setNotice(zh ? `已打开 ${label}` : `Opened ${label}`),
                      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
                    );
                  }}
                  className="summary-action !px-1"
                  title={zh ? `在 ${label} 中打开` : `Open in ${label}`}
                >
                  {label}
                </button>
              ))}
            </div>

            <SummaryRow icon="branch" label={summary === null
              ? (loading ? (zh ? "正在读取 Git…" : "Reading Git…") : "Git")
              : summary.isRepository
                ? (summary.branch ?? "DETACHED HEAD")
                : (zh ? "非 Git 仓库" : "Not a Git repository")}>
              {summary?.isRepository && (
                <ChipSelect
                  variant="ghost"
                  menuPlacement="down"
                  align="end"
                  width={180}
                  disabled={busy !== null}
                  activeId={summary.branch ?? ""}
                  label={summary.branch ?? "DETACHED"}
                  items={summary.branches.map((branch) => ({ id: branch, label: branch }))}
                  onSelect={checkout}
                  aria-label={zh ? "切换分支" : "Switch branch"}
                  triggerClassName="ml-auto max-w-[145px] justify-end"
                />
              )}
            </SummaryRow>

            {summary?.isRepository && (
              <>
                <button onClick={() => setCommitOpen((value) => !value)} className="summary-row w-full">
                  <Icon name="dot" size={14} className="text-mute" />
                  <span>{zh ? "提交或推送" : "Commit or push"}</span>
                  {(summary.ahead > 0 || summary.behind > 0) && (
                    <span className="ml-auto font-mono text-[9px] text-faint">↑{summary.ahead} ↓{summary.behind}</span>
                  )}
                  <Icon name="chevronDown" size={9} className={`ml-auto text-faint transition-transform ${commitOpen ? "rotate-180" : ""}`} />
                </button>
                {commitOpen && (
                  <div className="mx-2 mb-2 rounded-[6px] border border-line bg-void p-2">
                    <input
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      onCompositionStart={onCompositionStart}
                      onCompositionEnd={onCompositionEnd}
                      onKeyDown={(event) => {
                        if (isImeBlocking(event)) return;
                        if (event.key === "Enter") commit();
                      }}
                      placeholder={zh ? "提交说明…" : "Commit message…"}
                      maxLength={200}
                      className="h-8 w-full rounded-[4px] border border-line2 bg-raise px-2.5 text-[10.5px] text-fg2 outline-none focus:border-line3"
                    />
                    <div className="mt-2 flex justify-end gap-1.5">
                      <button disabled={!commitMessage.trim() || busy !== null} onClick={commit} className="summary-action">
                        {busy === "commit" ? (zh ? "提交中…" : "Committing…") : (zh ? "提交全部" : "Commit all")}
                      </button>
                      <button disabled={busy !== null} onClick={push} className="summary-action">
                        {busy === "push" ? (zh ? "推送中…" : "Pushing…") : (zh ? "推送" : "Push")}
                      </button>
                    </div>
                  </div>
                )}

                <button disabled={!compareAvailable} onClick={openCompare} className="summary-row w-full disabled:opacity-35">
                  <Icon name="github" size={14} className="text-mute" />
                  <span>{zh ? "比较分支" : "Compare branch"}</span>
                  <span className="ml-auto font-mono text-[9px] text-faint">{summary.defaultBranch ?? "main"} ← {summary.branch}</span>
                  <Icon name="external" size={10} className="text-faint" />
                </button>

                <div className="mx-2 mt-2 rounded-[6px] border border-line bg-void p-2">
                  <p className="mb-1.5 font-mono text-[9px] tracking-[0.08em] text-dim">{zh ? "WORKTREES" : "WORKTREES"}</p>
                  {worktrees.length === 0 ? (
                    <p className="text-[10px] text-faint">{zh ? "暂无附加 worktree" : "No linked worktrees"}</p>
                  ) : (
                    <div className="mb-2 space-y-1">
                      {worktrees.map((item, index) => {
                        const primary = index === 0;
                        const current = samePath(item.path, workspace);
                        return (
                        <div key={item.path} className="flex items-center gap-2 rounded-[4px] px-1.5 py-1 hover:bg-high">
                          <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-fg2">{item.branch ?? (item.detached ? "DETACHED" : baseName(item.path))}</span>
                          <button
                            disabled={busy !== null}
                            onClick={() => {
                              setError("");
                              setNotice("");
                              void useDesktop.getState().setWorkspace(item.path).catch((cause) => {
                                setError(cause instanceof Error ? cause.message : String(cause));
                              });
                            }}
                            className="text-[9px] text-acc hover:text-fg"
                          >
                            {zh ? "打开" : "Open"}
                          </button>
                          <button
                            disabled={busy !== null || current || primary}
                            onClick={() => {
                              setError("");
                              setNotice("");
                              setConfirmWorktree(item);
                            }}
                            className="text-[9px] text-faint hover:text-red disabled:cursor-not-allowed disabled:opacity-30"
                            title={current
                              ? (zh ? "不能删除当前工作树" : "Cannot delete the current worktree")
                              : primary
                                ? (zh ? "不能删除仓库主工作树" : "Cannot delete the primary worktree")
                              : (zh ? "删除工作树" : "Remove worktree")}
                          >
                            {zh ? "删除" : "Remove"}
                          </button>
                        </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <input
                      value={worktreeName}
                      onChange={(event) => {
                        setWorktreeName(event.target.value);
                        setError("");
                        setNotice("");
                      }}
                      placeholder={zh ? "名称，如 fix-auth" : "name, e.g. fix-auth"}
                      className="h-7 min-w-0 flex-1 rounded-[4px] border border-line2 bg-raise px-2 font-mono text-[10px] text-fg2 outline-none"
                    />
                    <button
                      disabled={!worktreeName.trim() || busy !== null}
                      onClick={() => {
                        const name = worktreeName.trim();
                        void runAction("worktree", async () => {
                          const path = await gitWorktreeAdd(workspace, name, null);
                          setWorktreeName("");
                          return path;
                        });
                      }}
                      className="summary-action"
                    >
                      {busy === "worktree" ? "…" : (zh ? "新建" : "Add")}
                    </button>
                  </div>
                </div>
              </>
            )}

            {(error || notice) && (
              <p className={`mx-2 mt-2 rounded-[4px] border border-line px-2 py-1.5 font-mono text-[9px] ${error ? "text-red" : "text-green"}`}>
                {error || notice}
              </p>
            )}

            <div className="mx-2 my-3 h-px bg-line" />

            <div className="flex h-8 items-center px-2">
              <span className="lbl !text-[9.5px]">{zh ? "来源" : "SOURCES"}</span>
              <button
                disabled={!activeId || (composer?.attachments.length ?? 0) >= MAX_ATTACHMENTS}
                onClick={() => fileRef.current?.click()}
                className="ml-auto flex h-7 w-7 items-center justify-center text-dim hover:bg-high hover:text-fg disabled:opacity-30"
                title={zh ? "添加到当前消息" : "Add to current message"}
                aria-label={zh ? "添加来源到当前消息" : "Add source to current message"}
              >
                <Icon name="plus" size={13} />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  void addSources(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            {visibleSources.length === 0 ? (
              <p className="px-2 py-3 text-[10px] text-faint">{zh ? "当前任务还没有附件或链接来源" : "No attachment or link sources in this mission"}</p>
            ) : (
              <div>
                {visibleSources.map((source) => (
                  <button
                    key={source.id}
                    disabled={!source.url}
                    onClick={() => source.url && (inTauri() ? void openExternal(source.url) : window.open(source.url, "_blank", "noopener,noreferrer"))}
                    className="summary-row w-full disabled:cursor-default"
                    title={source.label}
                  >
                    <Icon name={source.kind === "link" ? "external" : "file"} size={13} className="text-dim" />
                    <span className="min-w-0 flex-1 truncate text-left text-mute">{source.label}</span>
                  </button>
                ))}
                {sources.length > 4 && (
                  <button onClick={() => setShowAllSources((value) => !value)} className="summary-row w-full !text-dim">
                    <Icon name="layers" size={12} />
                    <span>{showAllSources ? (zh ? "收起" : "Show less") : (zh ? `查看全部 ${sources.length}` : `View all ${sources.length}`)}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}
      {confirmWorktree && (
        <ConfirmDialog
          title={zh ? "删除工作树？" : "Remove worktree?"}
          description={zh
            ? `将删除“${confirmWorktree.branch ?? baseName(confirmWorktree.path)}”的工作树目录。Host 会再次检查会话和自动化引用；Git 分支不会被删除。`
            : `The worktree directory for “${confirmWorktree.branch ?? baseName(confirmWorktree.path)}” will be removed. The Host will recheck session and automation references; the Git branch is kept.`}
          confirmLabel={zh ? "删除工作树" : "Remove worktree"}
          cancelLabel={zh ? "取消" : "Cancel"}
          workingLabel={zh ? "删除中" : "Removing"}
          onCancel={() => setConfirmWorktree(null)}
          onConfirm={() => removeWorktree(confirmWorktree)}
        />
      )}
    </div>
  );
}

function SummaryRow({ icon, label, children }: { icon: "edit" | "branch" | "clock" | "bolt"; label: string; children?: React.ReactNode }) {
  return (
    <div className="summary-row">
      <Icon name={icon} size={14} className="text-mute" />
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </div>
  );
}
