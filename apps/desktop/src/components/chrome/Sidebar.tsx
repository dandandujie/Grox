import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDesktop, type ProjectMeta } from "../../state/store";
import { usePreferences } from "../../state/preferences";
import { useI18n } from "../../lib/i18n";
import { fmtBillingDate, fmtRelTime, fmtTokens } from "../../lib/format";
import { Wordmark } from "../fx/Wordmark";
import { Icon } from "../fx/Icon";
import type { Session, SessionMeta, SessionStatus } from "../../bridge/types";
import { BlackHole } from "../fx/BlackHole";
import { normalizeSessionQuery, sessionMatchesLoadedContent } from "../../lib/sessionSearch";
import { projectId, samePath } from "../../lib/projectCatalog";

export function Sidebar() {
  const { t, language } = useI18n();
  const width = usePreferences((state) => state.sidebarWidth);
  const theme = usePreferences((state) => state.theme);
  const setLanguage = usePreferences((state) => state.setLanguage);
  const setTheme = usePreferences((state) => state.setTheme);
  const sessionIndex = useDesktop((state) => state.sessionIndex);
  const sessions = useDesktop((state) => state.sessions);
  const activeId = useDesktop((state) => state.activeId);
  const activeProjectId = useDesktop((state) => state.activeProjectId);
  const projects = useDesktop((state) => state.projects);
  const view = useDesktop((state) => state.view);
  const openSession = useDesktop((state) => state.openSession);
  const goHome = useDesktop((state) => state.goHome);
  const newProject = useDesktop((state) => state.newProject);
  const account = useDesktop((state) => state.account);
  const billing = useDesktop((state) => state.billing);
  const setSettingsOpen = useDesktop((state) => state.setSettingsOpen);
  const setAccountSetupOpen = useDesktop((state) => state.setAccountSetupOpen);
  const logout = useDesktop((state) => state.logout);
  const refreshHistory = useDesktop((state) => state.refreshHistory);
  const historySyncing = useDesktop((state) => state.historySyncing);
  const historyCount = useDesktop((state) => state.historyCount);
  const historyError = useDesktop((state) => state.historyError);
  const [accountOpen, setAccountOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [historyMatches, setHistoryMatches] = useState<Set<string>>(() => new Set());
  const [historySearching, setHistorySearching] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  );

  useEffect(() => {
    if (!activeProjectId) return;
    setExpandedProjectIds((current) => {
      if (current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.add(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  useEffect(() => {
    if (!accountOpen) return;
    const close = (event: PointerEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [accountOpen]);

  const orderedProjects = [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt - a.lastOpenedAt,
  );
  const orderedSessions = [...sessionIndex].sort(
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt,
  );
  const sessionSearchIdsKey = sessionIndex.map((session) => session.id).join("\n");
  const normalizedQuery = normalizeSessionQuery(sessionQuery);
  const matchedSessions = normalizedQuery
    ? orderedSessions.filter((meta) =>
        historyMatches.has(meta.id) || sessionMatchesLoadedContent(meta, sessions[meta.id], normalizedQuery)
      )
    : orderedSessions;
  const matchedWorkspaceKeys = new Set(matchedSessions.map((session) => projectId(session.cwd)));
  const activeProjects = orderedProjects.filter(
    (project) => !project.archived && (!normalizedQuery || matchedWorkspaceKeys.has(projectId(project.path))),
  );
  const archivedProjects = orderedProjects.filter(
    (project) => project.archived && (!normalizedQuery || matchedWorkspaceKeys.has(projectId(project.path))),
  );

  useEffect(() => {
    if (!normalizedQuery) {
      setHistoryMatches(new Set());
      setHistorySearching(false);
      return;
    }
    let cancelled = false;
    setHistorySearching(true);
    const timeout = window.setTimeout(() => {
      void invoke<string[]>("search_session_history", {
        query: normalizedQuery,
        sessionIds: sessionIndex.map((session) => session.id),
      }).then((ids) => {
        if (!cancelled) setHistoryMatches(new Set(ids));
      }).catch(() => {
        if (!cancelled) setHistoryMatches(new Set());
      }).finally(() => {
        if (!cancelled) setHistorySearching(false);
      });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [normalizedQuery, sessionSearchIdsKey]);

  return (
    <aside className="relative flex shrink-0 flex-col border-r border-line bg-panel" style={{ width }}>
      <div className="flex h-14 items-center border-b border-line px-4">
        <button onClick={goHome} className="transition-opacity hover:opacity-70" title="Home">
          <Wordmark size={14} markSpin={view === "home" ? "slow" : false} />
        </button>
      </div>

      <div className="p-2.5">
        <button
          onClick={() => void newProject()}
          className="flex h-8 w-full items-center gap-2 rounded-[4px] border border-line2 bg-raise px-2.5 text-[11px] text-fg2 hover:border-line3 hover:text-fg"
        >
          <Icon name="plus" size={12} className="text-acc" />
          {t("newProject")}
          <span className="ml-auto font-mono text-[9.5px] text-faint">Ctrl N</span>
        </button>
        <div className="mt-1.5 flex h-8 items-center gap-2 rounded-[4px] border border-line2 bg-void px-2.5 focus-within:border-line3">
          <Icon name="search" size={11} className={historySearching ? "animate-pulse text-acc" : "text-dim"} />
          <input
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
            placeholder={language === "zh-CN" ? "搜索会话标题与内容" : "Search titles and content"}
            aria-label={language === "zh-CN" ? "搜索会话标题与内容" : "Search session titles and content"}
            className="min-w-0 flex-1 bg-transparent text-[10.5px] text-fg outline-none placeholder:text-faint"
          />
          {sessionQuery && (
            <button type="button" onClick={() => setSessionQuery("")} className="text-faint hover:text-fg" aria-label={language === "zh-CN" ? "清除搜索" : "Clear search"}>
              <Icon name="x" size={10} />
            </button>
          )}
        </div>
        <button
          onClick={() => void refreshHistory()}
          disabled={historySyncing}
          title={historyError ?? (language === "zh-CN" ? "重新扫描 ~/.grok/sessions" : "Rescan ~/.grok/sessions")}
          className="mt-1.5 flex h-7 w-full items-center gap-2 rounded-[4px] px-2.5 font-mono text-[9.5px] text-dim hover:bg-high hover:text-fg2 disabled:cursor-wait disabled:opacity-60"
        >
          <Icon name="refresh" size={10} className={historySyncing ? "animate-orbit" : ""} />
          {historySyncing
            ? (language === "zh-CN" ? "正在导入 CLI 历史" : "IMPORTING CLI HISTORY")
            : (language === "zh-CN" ? "导入 CLI 历史" : "IMPORT CLI HISTORY")}
          {historyCount > 0 && <span className="ml-auto text-faint">{historyCount}</span>}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionTitle label={normalizedQuery ? (language === "zh-CN" ? "搜索结果" : "SEARCH RESULTS") : t("projects")} count={normalizedQuery ? matchedSessions.length : projects.length} />
        {activeProjects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            active={project.id === activeProjectId}
            expanded={Boolean(normalizedQuery) || expandedProjectIds.has(project.id)}
            sessions={matchedSessions.filter((session) => samePath(session.cwd, project.path))}
            showArchived={Boolean(normalizedQuery)}
            activeId={activeId}
            loadedSessions={sessions}
            onOpenSession={(id) => void openSession(id)}
            onToggle={() => setExpandedProjectIds((current) => {
              const next = new Set(current);
              if (next.has(project.id)) next.delete(project.id);
              else next.add(project.id);
              return next;
            })}
          />
        ))}
        {archivedProjects.length > 0 && (
          <ArchiveGroup label={t("archived")} forceOpen={Boolean(normalizedQuery)}>
            {archivedProjects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                active={project.id === activeProjectId}
                expanded={Boolean(normalizedQuery) || expandedProjectIds.has(project.id)}
                sessions={matchedSessions.filter((session) => samePath(session.cwd, project.path))}
                showArchived={Boolean(normalizedQuery)}
                activeId={activeId}
                loadedSessions={sessions}
                onOpenSession={(id) => void openSession(id)}
                onToggle={() => setExpandedProjectIds((current) => {
                  const next = new Set(current);
                  if (next.has(project.id)) next.delete(project.id);
                  else next.add(project.id);
                  return next;
                })}
              />
            ))}
          </ArchiveGroup>
        )}
        {normalizedQuery && !historySearching && matchedSessions.length === 0 && (
          <p className="px-2 py-6 text-center font-mono text-[9.5px] text-faint">
            {language === "zh-CN" ? "没有匹配的历史会话" : "NO MATCHING SESSIONS"}
          </p>
        )}
      </div>

      <div ref={accountRef} className="relative flex h-12 shrink-0 items-center gap-2 border-t border-line px-2">
        <button
          onClick={() => setAccountOpen((open) => !open)}
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line2 bg-high text-[10px] text-fg2 hover:border-acc-dim"
          title={t("account")}
        >
          {account?.profileImageUrl ? (
            <img src={account.profileImageUrl} alt="" className="h-full w-full object-cover" />
          ) : account?.email ? (
            account.email.slice(0, 1).toUpperCase()
          ) : (
            <Icon name="user" size={14} />
          )}
        </button>
        <button
          onClick={() => setAccountOpen((open) => !open)}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-[10.5px] text-fg2">{account?.email ?? t("account")}</p>
          <p className="lbl truncate !text-[9.5px]">
            {billing?.subscriptionTier ?? account?.subscriptionTier ?? (account?.authenticated ? "GROK" : t("login"))}
          </p>
        </button>
        <button
          type="button"
          onClick={() => setLanguage(language === "zh-CN" ? "en-US" : "zh-CN")}
          className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-[3px] px-1 font-mono text-[9px] text-dim transition-colors hover:bg-high hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-acc"
          title={language === "zh-CN" ? "切换至 English" : "Switch to 简体中文"}
          aria-label={language === "zh-CN" ? "切换至 English" : "Switch to 简体中文"}
        >
          {language === "zh-CN" ? "中" : "EN"}
        </button>
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[3px] text-dim transition-colors hover:bg-high hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-acc"
          title={theme === "dark" ? (language === "zh-CN" ? "切换至明亮主题" : "Switch to light theme") : (language === "zh-CN" ? "切换至暗黑主题" : "Switch to dark theme")}
          aria-label={theme === "dark" ? (language === "zh-CN" ? "切换至明亮主题" : "Switch to light theme") : (language === "zh-CN" ? "切换至暗黑主题" : "Switch to dark theme")}
        >
          <Icon name={theme === "dark" ? "moon" : "sun"} size={12} />
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[3px] text-dim transition-colors hover:bg-high hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-acc"
          title={t("settings")}
          aria-label={t("settings")}
        >
          <Icon name="gear" size={13} />
        </button>

        {accountOpen && (
          <div className="absolute bottom-11 left-2 z-50 w-[232px] rounded-[6px] border border-line2 bg-raise p-2 shadow-2xl">
            <div className="border-b border-line px-2 pb-2">
              <p className="truncate text-[11px] text-fg">{account?.email ?? t("signInRequired")}</p>
              <p className="mt-0.5 font-mono text-[9.5px] text-acc">
                {billing?.subscriptionTier ?? account?.subscriptionTier ?? "—"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-1 border-b border-line py-2">
              <Limit
                label={language === "zh-CN" ? "周期结束" : "Period ends"}
                value={fmtBillingDate(billing?.periodEnd, language)}
              />
              <Limit
                label={language === "zh-CN" ? "订阅额度" : "Plan quota"}
                value={billing?.creditUsagePercent !== undefined
                  ? `${Math.round(billing.creditUsagePercent)}%`
                  : (language === "zh-CN" ? "上游未公开" : "Not exposed")}
              />
            </div>
            <MenuButton icon="gear" label={t("settings")} onClick={() => { setSettingsOpen(true); setAccountOpen(false); }} />
            {account?.authenticated ? (
              <MenuButton icon="external" label={t("upgrade")} onClick={() => void invoke("open_external", { url: "https://grok.com/supergrok?referrer=grok-build" })} />
            ) : (
              <MenuButton icon="user" label={t("login")} onClick={() => { setAccountSetupOpen(true); setAccountOpen(false); }} />
            )}
            {account?.authenticated && (
              <MenuButton icon="x" label={t("logout")} tone="text-red" onClick={() => void logout()} />
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function ProjectGroup({
  project,
  active,
  expanded,
  sessions,
  activeId,
  loadedSessions,
  showArchived,
  onOpenSession,
  onToggle,
}: {
  project: ProjectMeta;
  active: boolean;
  expanded: boolean;
  sessions: SessionMeta[];
  activeId: string | null;
  loadedSessions: Record<string, Session>;
  showArchived?: boolean;
  onOpenSession(id: string): void;
  onToggle(): void;
}) {
  const visible = showArchived ? sessions : sessions.filter((session) => !session.archived);
  return (
    <div className="mb-1">
      <ProjectRow
        project={project}
        active={active}
        expanded={expanded}
        count={visible.length}
        onToggle={onToggle}
      />
      {expanded && visible.length > 0 && (
        <div className="ml-3 border-l border-line pl-1">
          {visible.map((meta) => (
            <MissionRow
              key={meta.id}
              meta={meta}
              status={loadedSessions[meta.id]?.status ?? meta.lastStatus ?? "idle"}
              completionUnread={Boolean(meta.completionUnread)}
              active={meta.id === activeId}
              tokens={(loadedSessions[meta.id]?.usage.inputTokens ?? 0) + (loadedSessions[meta.id]?.usage.outputTokens ?? 0)}
              onOpen={() => onOpenSession(meta.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex h-7 items-center justify-between px-2">
      <span className="lbl !text-[9.5px]">{label}</span>
      <span className="tnum text-[9.5px] text-faint">{String(count).padStart(2, "0")}</span>
    </div>
  );
}

function ArchiveGroup({ label, children, forceOpen = false }: { label: string; children: React.ReactNode; forceOpen?: boolean }) {
  return (
    <details className="group/archive mt-1" open={forceOpen || undefined}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 font-mono text-[9.5px] text-faint hover:text-mute">
        <Icon name="chevronRight" size={8} className="transition-transform group-open/archive:rotate-90" />
        {label}
      </summary>
      {children}
    </details>
  );
}

function ProjectRow({ project, active, expanded, count, onToggle }: { project: ProjectMeta; active: boolean; expanded: boolean; count: number; onToggle(): void }) {
  const { t, language } = useI18n();
  const openProject = useDesktop((state) => state.openProject);
  const newSession = useDesktop((state) => state.newSession);
  const activeProjectId = useDesktop((state) => state.activeProjectId);
  const renameProject = useDesktop((state) => state.renameProject);
  const pinProject = useDesktop((state) => state.pinProject);
  const archiveProject = useDesktop((state) => state.archiveProject);
  const removeProject = useDesktop((state) => state.removeProject);
  const openExplorer = useDesktop((state) => state.openProjectInExplorer);
  const createWorktree = useDesktop((state) => state.createProjectWorktree);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const commit = () => {
    setEditing(false);
    renameProject(project.id, draft);
  };

  return (
    <div
      className={`group relative mb-px flex h-8 items-center gap-1 rounded-[4px] px-1 ${active ? "bg-high text-fg" : "text-fg2 hover:bg-high/60"}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu(true);
      }}
    >
      <button onClick={onToggle} className="flex h-6 w-5 shrink-0 items-center justify-center text-faint hover:text-fg" title={expanded ? "Collapse" : "Expand"}>
        <Icon name="chevronRight" size={9} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      <button onClick={() => void openProject(project.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon name={project.pinned ? "pin" : "folder"} size={11} className={project.pinned ? "text-acc" : "text-dim"} />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === "Enter" && commit()}
            onClick={(event) => event.stopPropagation()}
            className="min-w-0 flex-1 border border-line3 bg-void px-1 text-[10.5px] outline-none"
          />
        ) : (
          <span className="truncate text-[10.5px]">{project.name}</span>
        )}
      </button>
      {count > 0 && <span className="tnum text-[9px] text-faint">{count}</span>}
      <button
        onClick={(event) => {
          event.stopPropagation();
          void (async () => {
            if (activeProjectId !== project.id) await openProject(project.id);
            await newSession();
          })();
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] text-acc transition-colors hover:bg-acc/10 hover:text-fg"
        title={language === "zh-CN" ? "在此项目中新建会话" : "New session in this project"}
        aria-label={language === "zh-CN" ? "在此项目中新建会话" : "New session in this project"}
      >
        <Icon name="plus" size={12} />
      </button>
      <button
        onClick={() => setMenu((open) => !open)}
        className="flex h-5 w-5 shrink-0 items-center justify-center text-dim opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        aria-label={language === "zh-CN" ? "项目操作" : "Project actions"}
        aria-expanded={menu}
      >
        <Icon name="more" size={12} />
      </button>
      {menu && (
        <ContextMenu close={() => setMenu(false)}>
          <MenuButton icon="pin" label={project.pinned ? t("unpin") : t("pin")} onClick={() => pinProject(project.id)} />
          <MenuButton icon="external" label={t("openExplorer")} onClick={() => void openExplorer(project.id)} />
          <MenuButton icon="branch" label={language === "zh-CN" ? "创建永久工作树" : "Create permanent worktree"} onClick={() => void createWorktree(project.id)} />
          <MenuButton icon="gear" label={language === "zh-CN" ? "编辑项目" : "Edit project"} onClick={() => setEditing(true)} />
          <MenuDivider />
          <MenuButton icon="archive" label={project.archived ? t("unarchive") : (language === "zh-CN" ? "归档项目" : "Archive project")} onClick={() => archiveProject(project.id)} />
          <MenuButton icon="x" label={t("remove")} tone="text-red" onClick={() => removeProject(project.id)} />
        </ContextMenu>
      )}
    </div>
  );
}

function MissionRow({ meta, status, completionUnread, active, tokens, onOpen }: { meta: SessionMeta; status: SessionStatus; completionUnread: boolean; active: boolean; tokens: number; onOpen(): void }) {
  const { t, language } = useI18n();
  const renameSession = useDesktop((state) => state.renameSession);
  const pinSession = useDesktop((state) => state.pinSession);
  const archiveSession = useDesktop((state) => state.archiveSession);
  const markSessionUnread = useDesktop((state) => state.markSessionUnread);
  const continueInNewChat = useDesktop((state) => state.continueSessionInNewChat);
  const continueInWorktree = useDesktop((state) => state.continueSessionInNewWorktree);
  const openInNewWindow = useDesktop((state) => state.openSessionInNewWindow);
  const copySessionValue = useDesktop((state) => state.copySessionValue);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState(meta.title);
  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== meta.title) renameSession(meta.id, title);
  };

  return (
    <div
      className={`group relative mb-px cursor-pointer rounded-[4px] border-l-2 px-2 py-1.5 ${active ? "border-acc bg-high" : "border-transparent hover:bg-high/60"}`}
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu(true);
      }}
    >
      <div className="flex items-center gap-2">
        <SessionStatusLight status={status} completionUnread={completionUnread} />
        <span className={status === "running" || status.startsWith("awaiting_") ? "" : "opacity-55"}><BlackHole size={11} spin={status === "running" ? true : status.startsWith("awaiting_") ? "slow" : false} /></span>
        {editing ? (
          <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => event.key === "Enter" && commit()} onClick={(event) => event.stopPropagation()} className="min-w-0 flex-1 border border-line3 bg-void px-1 text-[11px] text-fg outline-none" />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg2">{meta.title}</span>
        )}
        <button
          onClick={(event) => { event.stopPropagation(); setMenu((open) => !open); }}
          className="flex h-5 w-5 shrink-0 items-center justify-center text-dim opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          aria-label={language === "zh-CN" ? "会话操作" : "Session actions"}
          aria-expanded={menu}
        >
          <Icon name="more" size={12} />
        </button>
      </div>
      {meta.summary && meta.summary !== meta.title && (
        <p className="mt-0.5 truncate pl-3.5 text-[9.5px] leading-tight text-mute" title={meta.summary}>{meta.summary}</p>
      )}
      <div className="mt-0.5 flex items-center justify-between pl-3.5">
        <span className="font-mono text-[9.5px] text-faint">{fmtRelTime(meta.updatedAt)}</span>
        {tokens > 0 && <span className="tnum text-[9.5px] text-faint">{fmtTokens(tokens)} TOK</span>}
      </div>
      {menu && (
        <ContextMenu close={() => setMenu(false)}>
          <MenuButton icon="pin" label={meta.pinned ? t("unpin") : t("pin")} onClick={() => pinSession(meta.id)} />
          <MenuButton icon="edit" label={t("rename")} onClick={() => setEditing(true)} />
          <MenuButton icon="archive" label={t("archive")} onClick={() => archiveSession(meta.id)} />
          <MenuButton icon="dot" label={language === "zh-CN" ? "标记为未读" : "Mark as unread"} onClick={() => markSessionUnread(meta.id)} />
          <MenuDivider />
          <MenuButton icon="external" label={language === "zh-CN" ? "在 Finder 中显示" : "Show in Finder"} onClick={() => void useDesktop.getState().openProjectInExplorer(projectId(meta.cwd))} />
          <MenuButton icon="folder" label={language === "zh-CN" ? "复制工作目录" : "Copy working directory"} onClick={() => void copySessionValue(meta.id, "cwd")} />
          <MenuButton icon="copy" label={language === "zh-CN" ? "复制会话 ID" : "Copy session ID"} onClick={() => void copySessionValue(meta.id, "id")} />
          <MenuButton icon="external" label={language === "zh-CN" ? "复制深度链接" : "Copy deep link"} onClick={() => void copySessionValue(meta.id, "link")} />
          <MenuButton icon="summary" label={language === "zh-CN" ? "导出会话诊断" : "Export session trace"} onClick={() => void invoke<string>("export_session_trace", { sessionId: meta.id }).then((path) => navigator.clipboard.writeText(path))} />
          <MenuDivider />
          <MenuButton icon="arrowRight" label={language === "zh-CN" ? "在新聊天中继续" : "Continue in new chat"} onClick={() => void continueInNewChat(meta.id)} />
          <MenuButton icon="branch" label={language === "zh-CN" ? "在新工作树中继续" : "Continue in new worktree"} onClick={() => void continueInWorktree(meta.id)} />
          <MenuDivider />
          <MenuButton icon="external" label={language === "zh-CN" ? "在新窗口中打开" : "Open in new window"} onClick={() => void openInNewWindow(meta.id)} />
        </ContextMenu>
      )}
    </div>
  );
}

function SessionStatusLight({ status, completionUnread }: { status: SessionStatus; completionUnread: boolean }) {
  const { language } = useI18n();
  const presentation = status === "running"
    ? { tone: "bg-acc animate-pulse-dot", label: language === "zh-CN" ? "运行中" : "Running" }
    : status === "failed"
      ? { tone: "bg-red", label: language === "zh-CN" ? "失败" : "Failed" }
      : status === "awaiting_permission" || status === "awaiting_input"
        ? { tone: "bg-status-blue animate-pulse-dot", label: language === "zh-CN" ? "待确认" : "Awaiting confirmation" }
        : completionUnread
          ? { tone: "bg-green", label: language === "zh-CN" ? "已完成" : "Completed" }
          : { tone: "bg-faint", label: language === "zh-CN" ? "无进行中的请求" : "No active request" };
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${presentation.tone}`} title={presentation.label} aria-label={presentation.label} />;
}

function ContextMenu({ children, close }: { children: React.ReactNode; close(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closeRef.current();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && closeRef.current();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <div ref={ref} className="absolute right-1 top-7 z-40 w-[min(192px,calc(100vw-24px))] overflow-hidden rounded-[5px] border border-line2 bg-raise p-1 shadow-2xl" onClick={(event) => { event.stopPropagation(); close(); }}>
      {children}
    </div>
  );
}

function MenuDivider() {
  return <div className="my-1 border-t border-line" role="separator" />;
}

function MenuButton({ icon, label, onClick, tone = "text-fg2" }: { icon: React.ComponentProps<typeof Icon>["name"]; label: string; onClick(): void; tone?: string }) {
  return (
    <button onClick={onClick} className={`flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left text-[10px] hover:bg-high ${tone}`}>
      <Icon name={icon} size={11} className="text-dim" />
      {label}
    </button>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] bg-high/70 px-2 py-1.5">
      <p className="lbl !text-[9.5px]">{label}</p>
      <p className="mt-1 truncate font-mono text-[9.5px] text-fg2">{value}</p>
    </div>
  );
}
