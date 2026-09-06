/* Home — a calm starting surface: choose a medium, describe the work, begin. */

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import type { PromptAttachment, SessionStatus } from "../../bridge/types";
import { fmtRelTime, fmtTokens } from "../../lib/format";
import { MAX_ATTACHMENTS, prepareAttachment, validateAttachmentSet } from "../../lib/attachments";
import { attachExplicitPromptImages } from "../../lib/pathAttachments";
import { BlackHole } from "../fx/BlackHole";
import { StageTransition } from "../fx/StageTransition";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "../common/ChipSelect";
import { PromptOptionsMenu, ProviderSwitcher } from "../common/PromptControls";
import { useI18n } from "../../lib/i18n";
import { useImeGuard } from "../../lib/ime";
import { clearDraftBuffer, loadDraftBuffer, saveDraftBuffer } from "../../lib/draftPersistence";
import { cleanApiError } from "../../lib/runtimeNotice";

const MediaStudio = lazy(() => import("./MediaStudio").then((module) => ({ default: module.MediaStudio })));
const AutomationsStudio = lazy(() => import("./AutomationsStudio").then((module) => ({ default: module.AutomationsStudio })));

export function Home() {
  const { language, t } = useI18n();
  const [workspaceMode, setWorkspaceMode] = useState<"conversation" | "image" | "video" | "automations">("conversation");
  const [q, setQ] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingFiles, setReadingFiles] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const draftScopeRef = useRef("");
  const draftLoadedRef = useRef(false);
  const { onCompositionStart, onCompositionEnd, isImeBlocking } = useImeGuard();
  const sessionIndex = useDesktop((s) => s.sessionIndex);
  const sessions = useDesktop((s) => s.sessions);
  const newSession = useDesktop((s) => s.newSession);
  const openSession = useDesktop((s) => s.openSession);
  const workspace = useDesktop((s) => s.workspace);
  const startupError = useDesktop((s) => s.startupError);
  const auth = useDesktop((s) => s.auth);
  const cancelAuthentication = useDesktop((s) => s.cancelAuthentication);
  const setAccountSetupOpen = useDesktop((s) => s.setAccountSetupOpen);
  const model = useDesktop((s) => s.model);
  const models = useDesktop((s) => s.models);
  const effort = useDesktop((s) => s.effort);
  const permissionMode = useDesktop((s) => s.permissionMode);
  const mode = useDesktop((s) => s.mode);
  const setModel = useDesktop((s) => s.setModel);
  const setEffort = useDesktop((s) => s.setEffort);
  const setPermissionMode = useDesktop((s) => s.setPermissionMode);
  const setMode = useDesktop((s) => s.setMode);
  const setSettingsOpen = useDesktop((s) => s.setSettingsOpen);

  const recent = sessionIndex.filter((session) => !session.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

  useEffect(() => {
    let disposed = false;
    draftScopeRef.current = workspace;
    draftLoadedRef.current = false;
    setQ("");
    setAttachments([]);
    void loadDraftBuffer(workspace, "home")
      .then((draft) => {
        if (disposed || draftScopeRef.current !== workspace) return;
        setQ(draft?.text ?? "");
        setAttachments((draft?.attachments ?? []).map((item) => ({ ...item })));
        draftLoadedRef.current = true;
      })
      .catch((cause) => {
        if (disposed || draftScopeRef.current !== workspace) return;
        draftLoadedRef.current = true;
        setAttachmentError(cleanApiError(cause));
      });
    return () => { disposed = true; };
  }, [workspace]);

  useEffect(() => {
    if (!draftLoadedRef.current || draftScopeRef.current !== workspace) return;
    void saveDraftBuffer(workspace, q, attachments, "home").catch((cause) => setAttachmentError(cleanApiError(cause)));
  }, [attachments, q, workspace]);

  const slashCommands = [
    { id: "/plan", hint: language === "zh-CN" ? "计划模式 — 操作前先规划" : "Plan mode — think before acting" },
    { id: "/agent", hint: language === "zh-CN" ? "Agent 模式 — 完整工具访问" : "Agent mode — full tool access" },
    { id: "/ask", hint: language === "zh-CN" ? "问答模式 — 不编辑文件" : "Ask mode — answers, no edits" },
    { id: "/deep-research", hint: language === "zh-CN" ? "深度研究 — 后台检索、核验并生成带引用报告" : "Deep research — background research with cited report" },
    { id: "/settings", hint: language === "zh-CN" ? "打开设置" : "Open settings" },
  ];
  const slashOpen = q.startsWith("/") && !q.includes(" ");
  const slashMatches = slashOpen
    ? slashCommands.filter((command) => command.id.slice(1).startsWith(q.slice(1).toLowerCase()))
    : [];

  const chooseSlash = (id: string) => {
    if (id === "/settings") {
      setSettingsOpen(true);
      setQ("");
      return;
    }
    setQ(`${id} `);
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const launch = async () => {
    const rawPrompt = q.trim();
    const modeCommand = rawPrompt.match(/^\/(plan|agent|ask)(?:\s+([\s\S]+))?$/i);
    if (modeCommand && !modeCommand[2]?.trim()) {
      setMode(modeCommand[1].toLowerCase() as "plan" | "agent" | "ask");
      setQ("");
      return;
    }
    if (rawPrompt === "/settings") {
      setSettingsOpen(true);
      setQ("");
      return;
    }
    const prompt = modeCommand?.[2]?.trim() ?? rawPrompt;
    if ((!prompt && attachments.length === 0) || readingFiles) return;
    // 账号配置是发送前的软门槛，而不是浏览首页和整理输入的硬门槛。
    if (auth.required) {
      setAccountSetupOpen(true);
      return;
    }
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const turnAttachments = await attachExplicitPromptImages(workspace, prompt, attachments);
      if (modeCommand) setMode(modeCommand[1].toLowerCase() as "plan" | "agent" | "ask");
      await newSession({ text: prompt, attachments: turnAttachments });
      await clearDraftBuffer(workspace, "home");
      setQ("");
      setAttachments([]);
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReadingFiles(false);
    }
  };

  const appendFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const prepared: PromptAttachment[] = [];
      for (const file of files) prepared.push(await prepareAttachment(file));
      const next = [...attachments, ...prepared];
      validateAttachmentSet(next);
      setAttachments(next);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      setAttachmentError(code === "attachment_count"
        ? (language === "zh-CN" ? "每次最多上传 8 个附件" : "Up to 8 attachments per prompt")
        : code === "attachment_size"
          ? (language === "zh-CN" ? "附件总大小不能超过 32 MB" : "Attachments cannot exceed 32 MB in total")
          : language === "zh-CN" ? code.replace(" exceeds 16 MB", " 超过 16 MB") : code);
    } finally {
      setReadingFiles(false);
    }
  };

  const currentModel = models.find((item) => item.id === model);

  if (workspaceMode !== "conversation") {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-base">
        <div className="home-nebula opacity-40" />
        <WorkspaceTabs mode={workspaceMode} onChange={setWorkspaceMode} />
        <StageTransition stageKey={workspaceMode} variant="panel" className="relative z-[1]">
          <Suspense fallback={<div className="flex flex-1 items-center justify-center"><BlackHole size={28} spin /></div>}>
            {workspaceMode === "automations"
              ? <AutomationsStudio key={`automations:${workspace}`} />
              : <MediaStudio key={`${workspaceMode}:${workspace}`} mode={workspaceMode} />}
          </Suspense>
        </StageTransition>
      </div>
    );
  }

  const hasPrompt = Boolean(q.trim() || attachments.length > 0);

  return (
    <div className="relative flex-1 overflow-x-hidden overflow-y-auto bg-base">
      <div className="home-nebula opacity-65" />
      <WorkspaceTabs mode={workspaceMode} onChange={setWorkspaceMode} />

      <div className="relative z-[1] mx-auto flex min-h-full w-full max-w-[980px] flex-col items-center justify-center px-6 pb-16 pt-24 sm:px-10">
        <div className="animate-mission-in animate-bh-breathe" style={{ animationDelay: "0.04s" }}>
          <BlackHole size={92} spin="slow" />
        </div>
        <h1 className="mt-5 animate-mission-in text-[30px] font-semibold tracking-[0.32em] text-fg" style={{ animationDelay: "0.11s", marginRight: "-0.32em" }}>
          GROX
        </h1>
        <p className="mt-3 animate-mission-in text-center text-[14px] text-mute" style={{ animationDelay: "0.17s" }}>
          {language === "zh-CN" ? "把想做的事交给 Grok Build" : "Give Grok Build something worth making"}
        </p>

        {startupError && (
          <div className="mt-7 flex w-full max-w-[820px] animate-mission-in items-start gap-3 rounded-[14px] border border-red/35 bg-red/5 px-4 py-3" style={{ animationDelay: "0.22s" }}>
            <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-red" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-red">{language === "zh-CN" ? "Grok Build 连接失败" : "Could not connect to Grok Build"}</p>
              <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-fg2">{startupError}</p>
            </div>
          </div>
        )}

        <div className="aurora-rim relative mt-8 w-full max-w-[860px] animate-mission-in" style={{ animationDelay: "0.25s" }}>
          <div className="aurora-rim__core overflow-visible">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void appendFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2.5">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="flex h-9 max-w-[220px] items-center gap-2 rounded-full border border-line2 bg-high/70 px-3">
                    {attachment.kind === "image" && attachment.data ? <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" className="h-6 w-6 rounded-full object-cover" /> : <Icon name="file" size={11} className="text-dim" />}
                    <span className="min-w-0 flex-1 truncate text-[11px] text-fg2">{attachment.name}</span>
                    <button onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))} className="text-faint hover:text-fg" title={language === "zh-CN" ? "移除" : "Remove"}><Icon name="x" size={9} /></button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={promptRef}
              value={q}
              onChange={(event) => { setQ(event.target.value); setSlashIndex(0); }}
              onPaste={(event) => {
                const images = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
                if (images.length > 0) { event.preventDefault(); void appendFiles(images); }
              }}
              onKeyDown={(event) => {
                if (isImeBlocking(event)) return;
                if (slashMatches.length > 0 && event.key === "ArrowDown") { event.preventDefault(); setSlashIndex((index) => (index + 1) % slashMatches.length); return; }
                if (slashMatches.length > 0 && event.key === "ArrowUp") { event.preventDefault(); setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length); return; }
                if (slashMatches.length > 0 && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); chooseSlash(slashMatches[slashIndex]?.id ?? slashMatches[0]?.id ?? ""); return; }
                if (event.key === "Escape" && slashMatches.length > 0) { event.preventDefault(); setQ(""); return; }
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void launch(); }
              }}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              rows={4}
              autoFocus
              placeholder={language === "zh-CN" ? "描述你要完成的任务。支持粘贴截图、拖入文件，或输入 / 选择模式…" : "Describe what you want to get done. Paste screenshots, attach files, or type / for modes…"}
              className="block min-h-[112px] w-full resize-none bg-transparent px-5 pb-2 pt-4 text-[16px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
            />
            {slashMatches.length > 0 && (
              <div className="absolute z-30 mt-1.5 w-[min(640px,calc(100%-32px))] animate-fade-up rounded-[14px] border border-line2 bg-raise p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.45)]">
                {slashMatches.map((command, index) => <button key={command.id} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSlash(command.id)} className={`flex w-full items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-left ${index === slashIndex ? "bg-high text-fg" : "text-dim hover:bg-high hover:text-fg2"}`}><span className="font-mono text-[12px] text-acc">{command.id}</span><span className="min-w-0 flex-1 truncate text-[12px]">{command.hint}</span></button>)}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1.5">
              <ProviderSwitcher />
              <ChipSelect label={<span className="text-fg2">{currentModel?.label ?? model.toUpperCase()}</span>} items={models.map((item) => ({ id: item.id, label: item.label, hint: item.tagline }))} activeId={model} onSelect={setModel} width={260} />
              <PromptOptionsMenu mode={mode} effort={effort} efforts={models.find((item) => item.id === model)?.efforts} permissionMode={permissionMode} onMode={setMode} onEffort={setEffort} onPermission={setPermissionMode} />
              <button onClick={() => fileRef.current?.click()} disabled={readingFiles || attachments.length >= MAX_ATTACHMENTS} className="flex h-8 items-center gap-1.5 rounded-full border border-line2 px-3 text-[11px] text-dim hover:border-line3 hover:text-fg2 disabled:opacity-40" title={language === "zh-CN" ? "上传文件；也支持粘贴剪贴板图片" : "Attach files; clipboard images are also supported"}><Icon name="clip" size={12} />{readingFiles ? (language === "zh-CN" ? "读取中" : "Reading") : (language === "zh-CN" ? "附件" : "Attach")}</button>
              <button onClick={() => void launch()} disabled={!hasPrompt || readingFiles} className={`ml-auto flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200 ${hasPrompt ? (auth.required ? "border border-gold/50 bg-gold/10 text-gold hover:bg-gold/15" : "bg-acc text-base hover:bg-acc-deep") : "bg-high text-faint"}`} title={auth.required ? (language === "zh-CN" ? "配置账户后发送" : "Connect an account to send") : (language === "zh-CN" ? "开始任务" : "Start")}><Icon name="arrowUp" size={15} strokeWidth={2} /></button>
            </div>
            {attachmentError && <p className="border-t border-red/20 px-4 py-2 text-[11px] text-red">{attachmentError}</p>}
          </div>
        </div>

        {auth.required && (
          <button onClick={() => auth.inProgress ? void cancelAuthentication() : setAccountSetupOpen(true)} className="mt-3 flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] text-gold hover:bg-gold/5">
            <span className={`h-1.5 w-1.5 rounded-full ${auth.inProgress ? "animate-pulse bg-gold" : "bg-gold"}`} />
            {auth.inProgress ? (language === "zh-CN" ? "正在连接账户…" : "Connecting account…") : (auth.error ?? (language === "zh-CN" ? "发送前需要登录或配置服务" : "Sign in or configure a provider before sending"))}
            <span className="text-fg2">{auth.inProgress ? (language === "zh-CN" ? "取消" : "Cancel") : `${t("account")} →`}</span>
          </button>
        )}

        {recent.length > 0 && (
          <div className="mt-10 w-full max-w-[820px] animate-mission-in" style={{ animationDelay: "0.34s" }}>
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="text-[12px] font-medium text-mute">{language === "zh-CN" ? "继续最近任务" : "Continue recent work"}</span>
              <span className="text-[11px] text-faint">{recent.length}</span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recent.map((mission, index) => {
                const tokens = (sessions[mission.id]?.usage.inputTokens ?? 0) + (sessions[mission.id]?.usage.outputTokens ?? 0);
                const status = sessions[mission.id]?.status ?? mission.lastStatus ?? "idle";
                const attention = recentStatusPresentation(status, language === "zh-CN");
                const title = mission.title?.trim()
                  || mission.summary?.trim().slice(0, 48)
                  || (language === "zh-CN" ? "未命名任务" : "Untitled task");
                return (
                  <button key={mission.id} onClick={() => openSession(mission.id)} className="mission-card group animate-mission-card rounded-[14px] border border-line2 bg-raise/55 px-4 py-3 text-left hover:border-line3 hover:bg-raise" style={{ animationDelay: `${0.38 + index * 0.04}s` }}>
                    <p className="flex items-center gap-1.5 text-[13px] text-fg2 group-hover:text-fg">
                      {attention && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${attention.tone}`} title={attention.label} aria-label={attention.label} />}
                      <span className="min-w-0 truncate">{title}</span>
                    </p>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
                      <span>{fmtRelTime(mission.updatedAt)}</span>
                      {tokens > 0 && <span className="font-mono">{fmtTokens(tokens)} tokens</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function recentStatusPresentation(status: SessionStatus, zh: boolean): { tone: string; label: string } | null {
  switch (status) {
    case "running":
      return { tone: "bg-acc animate-pulse-dot", label: zh ? "运行中" : "Running" };
    case "connecting":
      return { tone: "bg-status-blue animate-pulse-dot", label: zh ? "正在恢复" : "Restoring" };
    case "stopping":
      return { tone: "bg-gold animate-pulse-dot", label: zh ? "正在停止" : "Stopping" };
    case "awaiting_permission":
    case "awaiting_input":
      return { tone: "bg-status-blue animate-pulse-dot", label: zh ? "等待你的决定" : "Awaiting your decision" };
    case "failed":
      return { tone: "bg-red", label: zh ? "上次执行失败" : "Failed" };
    case "disconnected":
      return { tone: "bg-red", label: zh ? "连接已中断" : "Disconnected" };
    case "cancelled":
      return { tone: "bg-gold", label: zh ? "已停止" : "Stopped" };
    default:
      return null;
  }
}

function WorkspaceTabs({ mode, onChange }: { mode: "conversation" | "image" | "video" | "automations"; onChange(mode: "conversation" | "image" | "video" | "automations"): void }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  return (
    <div role="tablist" aria-label={zh ? "工作台类型" : "Workspace type"} className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line2 bg-panel/90 p-1 shadow-lg backdrop-blur animate-mission-in" style={{ animationDelay: "0.02s" }}>
      {([
        ["conversation", zh ? "对话" : "CHAT"],
        ["image", zh ? "图片" : "IMAGE"],
        ["video", zh ? "视频" : "VIDEO"],
        ["automations", zh ? "已安排" : "SCHEDULED"],
      ] as const).map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={mode === id}
          onClick={() => onChange(id)}
          className={`flex h-8 items-center gap-1.5 rounded-full px-4 text-[12px] transition-colors ${mode === id ? "bg-acc text-base" : "text-dim hover:bg-high hover:text-fg2"}`}
        >
          {id === "conversation" ? <Icon name="command" size={11} /> : id === "image" ? <Icon name="layers" size={11} /> : id === "video" ? <Icon name="play" size={11} /> : <Icon name="clock" size={11} />}
          {label}
        </button>
      ))}
    </div>
  );
}
