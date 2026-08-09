/* ─────────────────────────────────────────────────────────────────────────
   Composer — the uplink. One bordered instrument: text field on top,
   control strip below (mode · model · effort · attach · voice · send).
   Slash opens the command menu; Enter transmits after IME composition commits.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from "react";
import { useDesktop, type QueuedPrompt } from "../../state/store";
import {
  EFFORTS,
  isSessionTerminal,
  type PromptAttachment,
  type SlashCommand,
} from "../../bridge/types";
import { ChipSelect } from "../common/ChipSelect";
import { PromptOptionsMenu, ProviderSwitcher } from "../common/PromptControls";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";
import {
  MAX_ATTACHMENTS,
  prepareAttachment,
  validateAttachmentSet,
} from "../../lib/attachments";
import { attachExplicitPromptImages } from "../../lib/pathAttachments";
import { RewindMenu } from "./RewindMenu";
import { useImeGuard } from "../../lib/ime";
import { bridge } from "../../bridge";

interface SlashCmd {
  id: string;
  hint: string;
  run: () => void;
  source?: "gui" | "runtime";
  tag?: string;
}

const NO_RUNTIME_COMMANDS: SlashCommand[] = [];
const NO_QUEUED_PROMPTS: QueuedPrompt[] = [];

export function Composer() {
  const { language } = useI18n();
  const [slashIdx, setSlashIdx] = useState(0);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingFiles, setReadingFiles] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackError, setFeedbackError] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { onCompositionStart, onCompositionEnd, isImeBlocking } = useImeGuard();

  const sendPrompt = useDesktop((s) => s.sendPrompt);
  const interjectPrompt = useDesktop((s) => s.interjectPrompt);
  const removeQueuedPrompt = useDesktop((s) => s.removeQueuedPrompt);
  const updateQueuedPrompt = useDesktop((s) => s.updateQueuedPrompt);
  const moveQueuedPrompt = useDesktop((s) => s.moveQueuedPrompt);
  const moveQueuedAttachment = useDesktop((s) => s.moveQueuedAttachment);
  const clearPromptQueue = useDesktop((s) => s.clearPromptQueue);
  const activeId = useDesktop((s) => s.activeId);
  const workspace = useDesktop((s) => s.workspace);
  const composer = useDesktop((s) => s.activeId ? s.sessionComposers[s.activeId] : undefined);
  const text = composer?.text ?? "";
  const attachments = composer?.attachments ?? [];
  const setText = useDesktop((s) => s.setDraft);
  const setAttachments = useDesktop((s) => s.setComposerAttachments);
  const stop = useDesktop((s) => s.stop);
  const emergencyStopComputer = useDesktop((s) => s.emergencyStopComputer);
  const compact = useDesktop((s) => s.compact);
  const status = useDesktop((s) => (s.activeId ? s.sessions[s.activeId]?.status : null));
  const restoring = useDesktop((s) => Boolean(s.activeId && s.restoringSessionId === s.activeId));
  const creating = useDesktop((s) => Boolean(s.activeId?.startsWith("pending-")));
  const computerRunning = useDesktop((s) => {
    const session = s.activeId ? s.sessions[s.activeId] : undefined;
    return session?.blocks.some((block) =>
      block.type === "tool" &&
      block.call.kind === "computer" &&
      block.call.status === "running"
    ) ?? false;
  });
  const model = useDesktop((s) => s.model);
  const pendingModel = useDesktop((s) => s.activeId ? s.pendingSessionModels[s.activeId] : undefined);
  const models = useDesktop((s) => s.models);
  const effort = useDesktop((s) => s.effort);
  const permissionMode = useDesktop((s) => s.permissionMode);
  const mode = useDesktop((s) => s.mode);
  const setModel = useDesktop((s) => s.setModel);
  const setEffort = useDesktop((s) => s.setEffort);
  const setPermissionMode = useDesktop((s) => s.setPermissionMode);
  const setMode = useDesktop((s) => s.setMode);
  const newProject = useDesktop((s) => s.newProject);
  const goHome = useDesktop((s) => s.goHome);
  const setSettingsOpen = useDesktop((s) => s.setSettingsOpen);
  const setInspectorTab = useDesktop((s) => s.setInspectorTab);
  const setPlanPreviewOpen = useDesktop((s) => s.setPlanPreviewOpen);
  const runtimeCommands = useDesktop((s) => s.activeId ? s.slashCommands[s.activeId] ?? NO_RUNTIME_COMMANDS : NO_RUNTIME_COMMANDS);
  const promptQueues = useDesktop((s) => s.promptQueues);
  const queue = activeId ? promptQueues[activeId] ?? NO_QUEUED_PROMPTS : NO_QUEUED_PROMPTS;

  const openExtensionSettings = (section: "mcp" | "skills" | "plugins") => {
    setSettingsOpen(true);
    window.dispatchEvent(new CustomEvent("grox:settings-section", { detail: section }));
  };

  const running = status ? !isSessionTerminal(status) : false;
  const deepResearchAvailable = runtimeCommands.some((command) => command.name === "deep-research");

  const slashCommands: SlashCmd[] = [
    { id: "/plan", hint: language === "zh-CN" ? "计划模式 — 操作前先规划" : "plan mode — think before acting", run: () => setMode("plan") },
    { id: "/agent", hint: language === "zh-CN" ? "Agent 模式 — 完整工具访问" : "agent mode — full tool access", run: () => setMode("agent") },
    { id: "/ask", hint: language === "zh-CN" ? "问答模式 — 不编辑文件" : "ask mode — answers, no edits", run: () => setMode("ask") },
    {
      id: "/compact",
      hint: language === "zh-CN" ? "压缩会话上下文" : "compress conversation context",
      run: compact,
    },
    { id: "/new", hint: language === "zh-CN" ? "创建新项目" : "start a new project", run: () => void newProject() },
    { id: "/home", hint: language === "zh-CN" ? "返回任务控制台" : "return to mission control", run: goHome },
    { id: "/settings", hint: language === "zh-CN" ? "打开设置" : "open settings", run: () => setSettingsOpen(true) },
    { id: "/view-plan", hint: language === "zh-CN" ? "在右侧重新打开计划" : "reopen plan preview", run: () => setPlanPreviewOpen(true) },
    { id: "/auto", hint: language === "zh-CN" ? "自动批准安全工具" : "auto-approve safe tools", run: () => setPermissionMode(permissionMode === "auto" ? "default" : "auto") },
    { id: "/always-approve", hint: language === "zh-CN" ? "切换始终批准" : "toggle always approve", run: () => setPermissionMode(permissionMode === "bypass" ? "default" : "bypass") },
    { id: "/tasks", hint: language === "zh-CN" ? "查看任务和工具活动" : "show tasks and tool activity", run: () => setInspectorTab("tasks") },
    { id: "/workflows", hint: language === "zh-CN" ? "打开后台工作流面板（深度研究进度）" : "open background workflow runs", run: () => setInspectorTab("tasks") },
    { id: "/context", hint: language === "zh-CN" ? "查看上下文和用量" : "show context and usage", run: () => setInspectorTab("usage") },
    { id: "/usage", hint: language === "zh-CN" ? "查看用量" : "show usage", run: () => setInspectorTab("usage") },
    { id: "/session-info", hint: language === "zh-CN" ? "查看当前任务信息" : "show current mission info", run: () => setInspectorTab("usage") },
    { id: "/skills", hint: language === "zh-CN" ? "管理 Skill" : "manage skills", run: () => openExtensionSettings("skills") },
    { id: "/mcps", hint: language === "zh-CN" ? "管理 MCP Server" : "manage MCP servers", run: () => openExtensionSettings("mcp") },
    { id: "/plugins", hint: language === "zh-CN" ? "管理 Plugin 与市场" : "manage plugins and marketplace", run: () => openExtensionSettings("plugins") },
    { id: "/feedback", hint: language === "zh-CN" ? "向 Grok Build 提交反馈" : "send feedback to Grok Build", run: () => setFeedbackOpen(true) },
    {
      id: "/model",
      hint: "cycle model",
      run: () => {
        const i = models.findIndex((m) => m.id === model);
        setModel(models[(i + 1 + models.length) % models.length].id);
      },
    },
    {
      id: "/effort",
      hint: "cycle reasoning effort",
      run: () => {
        const i = EFFORTS.indexOf(effort);
        setEffort(EFFORTS[(i + 1) % EFFORTS.length]);
      },
    },
  ];

  const localIds = new Set(slashCommands.map((command) => command.id));
  const commands: SlashCmd[] = [
    ...slashCommands,
    ...runtimeCommands
      .filter((command) => !localIds.has(`/${command.name}`))
      .map((command) => ({
        id: `/${command.name}`,
        hint: command.name === "deep-research" && language === "zh-CN"
          ? "深度研究 — 并行检索、独立核验并生成带引用报告"
          : command.description || command.inputHint || (language === "zh-CN" ? "由 Grok Runtime 提供" : "Provided by Grok Runtime"),
        source: "runtime" as const,
        tag: command.tag ?? (command.name === "deep-research" ? "NEW" : undefined),
        run: () => {
          setText(`/${command.name}${command.inputHint ? " " : ""}`);
          requestAnimationFrame(() => taRef.current?.focus());
        },
      })),
  ];

  const slashOpen = text.startsWith("/") && !text.includes(" ");
  const query = slashOpen ? text.slice(1).toLowerCase() : "";
  const matches = slashOpen ? commands.filter((c) => c.id.slice(1).toLowerCase().startsWith(query)) : [];
  const chooseSlashCommand = (command: SlashCmd) => {
    command.run();
    if (command.source !== "runtime") setText("");
  };

  useEffect(() => setSlashIdx(0), [query]);

  // Keep the keyboard selection in view. The runtime can expose more commands
  // than fit above the composer, so a selected command must never be hidden.
  useEffect(() => {
    if (!slashOpen) return;
    slashOptionRefs.current[slashIdx]?.scrollIntoView({ block: "nearest" });
  }, [slashIdx, slashOpen, matches.length]);

  // auto-grow
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

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
      const message = code === "attachment_count"
        ? (language === "zh-CN" ? "每次最多上传 8 个附件" : "Up to 8 attachments per prompt")
        : code === "attachment_size"
          ? (language === "zh-CN" ? "附件总大小不能超过 32 MB" : "Attachments cannot exceed 32 MB in total")
          : code;
      setAttachmentError(language === "zh-CN" ? message.replace(" exceeds 16 MB", " 超过 16 MB") : message);
    } finally {
      setReadingFiles(false);
    }
  };

  const send = async () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || creating || restoring || readingFiles) return;
    // Path attachments are resolved asynchronously. Pin this turn to the
    // session that owned the composer when Enter was pressed; otherwise a
    // quick session switch can redirect it to a different task.
    const targetSessionId = activeId;
    if (!targetSessionId) return;
    if (t === "/workflow" || t === "/workflows") {
      setInspectorTab("tasks");
      setText("");
      return;
    }
    if (/^\/deep-research(?:\s|$)/i.test(t)) {
      setInspectorTab("tasks");
    }
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const turnAttachments = await attachExplicitPromptImages(workspace, t, attachments);
      const modeCommand = t.match(/^\/(plan|agent|ask)(?:\s+([\s\S]+))?$/i);
      let accepted: boolean;
      if (modeCommand?.[2]) {
        const nextMode = modeCommand[1].toLowerCase() as "plan" | "agent" | "ask";
        accepted = sendPrompt(modeCommand[2].trim(), turnAttachments, targetSessionId, nextMode);
      } else {
        accepted = sendPrompt(t, turnAttachments, targetSessionId);
      }
      // sendPrompt clears the targeted session's persisted draft itself. If
      // the provider started switching while we were reading, leave this
      // draft untouched so the user can send it after the switch completes.
      if (!accepted) return;
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReadingFiles(false);
    }
  };

  const interject = async () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || creating || restoring || readingFiles || !activeId) return;
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const turnAttachments = await attachExplicitPromptImages(workspace, t, attachments);
      await interjectPrompt(t, turnAttachments, activeId);
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReadingFiles(false);
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (images.length > 0) {
      event.preventDefault();
      void appendFiles(images);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isImeBlocking(e)) return;
    if (slashOpen && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        chooseSlashCommand(matches[Math.min(slashIdx, matches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void interject();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const currentModel = models.find((m) => m.id === model);

  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="composer-shell relative mx-auto">
        {/* slash menu */}
        {slashOpen && matches.length > 0 && (
          <div
            ref={slashMenuRef}
            role="listbox"
            aria-label={language === "zh-CN" ? "斜杠命令" : "Slash commands"}
            className="absolute bottom-full left-0 z-40 mb-2 w-full overflow-y-auto overflow-x-hidden overscroll-contain rounded-[16px] border border-line2 bg-raise p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.55)] animate-fade-up"
            style={{ maxHeight: "min(24rem, calc(100dvh - 13rem))" }}
          >
            {matches.map((c, i) => (
              <button
                key={c.id}
                ref={(element) => { slashOptionRefs.current[i] = element; }}
                role="option"
                aria-selected={i === slashIdx}
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => {
                  chooseSlashCommand(c);
                }}
                className={`flex w-full items-center gap-3 rounded-full px-3 py-1.5 text-left transition-colors ${
                  i === slashIdx ? "bg-high" : "hover:bg-high/60"
                }`}
              >
                <span className="w-20 shrink-0 font-mono text-[11px] text-acc">{c.id}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-mute">{c.hint}</span>
                {c.tag && <span className="rounded-full bg-acc/10 px-1.5 py-0.5 font-mono text-[8.5px] tracking-[0.08em] text-acc">{c.tag}</span>}
                {c.source === "runtime" && <span className="rounded-full border border-line2 px-1.5 py-0.5 font-mono text-[8.5px] tracking-[0.08em] text-faint">RUNTIME</span>}
              </button>
            ))}
          </div>
        )}

        <div className="aurora-rim">
        <div className="aurora-rim__core">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void appendFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2.5">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="group flex h-9 max-w-[220px] items-center gap-2 rounded-full border border-line2 bg-high/70 pl-1.5 pr-1">
                  {attachment.kind === "image" && attachment.data ? (
                    <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" className="h-6 w-6 rounded-full object-cover" />
                  ) : (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-raise text-dim"><Icon name="file" size={11} /></span>
                  )}
                  <div className="min-w-0 flex-1"><p className="truncate font-mono text-[9.5px] text-fg2">{attachment.name}</p><p className="font-mono text-[8.5px] text-faint">{attachment.size < 1024 * 1024 ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : `${(attachment.size / 1024 / 1024).toFixed(1)} MB`}</p></div>
                  <button onClick={() => setAttachments(attachments.filter((item) => item.id !== attachment.id))} className="flex h-6 w-6 items-center justify-center rounded-full text-faint hover:bg-raise hover:text-fg" title={language === "zh-CN" ? "移除附件" : "Remove attachment"}><Icon name="x" size={9} /></button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            disabled={creating}
            rows={1}
            placeholder={
              creating
                ? (language === "zh-CN" ? "正在创建会话…" : "Creating conversation…")
                : restoring
                ? (language === "zh-CN" ? "正在同步当前会话，稍后即可发送…" : "Synchronizing this session — ready to send shortly…")
                : running
                ? (language === "zh-CN" ? "Grok 正在处理 — 可以准备下一条请求…" : "Grok is working — queue the next directive…")
                : (language === "zh-CN" ? "发送给 Grok…" : "Transmit to Grok…")
            }
            className="block w-full resize-none bg-transparent px-5 pb-1.5 pt-3.5 text-[16px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
          />

          {queue.length > 0 && (
            <div className="border-t border-line px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-mono text-[9.5px] text-dim">
                  {language === "zh-CN" ? `等待发送 ${queue.length}` : `${queue.length} queued`}
                </span>
                <button onClick={() => clearPromptQueue(activeId ?? undefined)} className="font-mono text-[9px] text-faint hover:text-red">
                  {language === "zh-CN" ? "清空" : "Clear"}
                </button>
              </div>
              <div className="space-y-1">
                {queue.map((item, index) => (
                  <div key={item.id} className="rounded-lg bg-high/60 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                    <input
                      value={item.text}
                      onChange={(event) => activeId && updateQueuedPrompt(activeId, item.id, event.target.value)}
                      placeholder={item.attachments.length > 0 ? (language === "zh-CN" ? "图片消息" : "Image prompt") : undefined}
                      className="min-w-0 flex-1 bg-transparent text-[10.5px] text-fg2 outline-none placeholder:text-faint"
                    />
                    <button disabled={index === 0} onClick={() => activeId && moveQueuedPrompt(activeId, item.id, -1)} className="text-faint enabled:hover:text-fg disabled:opacity-25" title={language === "zh-CN" ? "上移" : "Move up"}><Icon name="arrowUp" size={9} /></button>
                    <button disabled={index === queue.length - 1} onClick={() => activeId && moveQueuedPrompt(activeId, item.id, 1)} className="rotate-180 text-faint enabled:hover:text-fg disabled:opacity-25" title={language === "zh-CN" ? "下移" : "Move down"}><Icon name="arrowUp" size={9} /></button>
                    <button onClick={() => activeId && removeQueuedPrompt(activeId, item.id)} className="text-faint hover:text-red" title={language === "zh-CN" ? "移出队列" : "Remove from queue"}>
                      <Icon name="x" size={9} />
                    </button>
                    </div>
                    {item.attachments.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{item.attachments.map((attachment, attachmentIndex) => (
                      <span key={attachment.id} className="flex items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 font-mono text-[8.5px] text-mute">
                        <span className="max-w-28 truncate">{attachment.name}</span>
                        <button disabled={attachmentIndex === 0} onClick={() => activeId && moveQueuedAttachment(activeId, item.id, attachment.id, -1)} className="disabled:opacity-20" aria-label="上移附件">↑</button>
                        <button disabled={attachmentIndex === item.attachments.length - 1} onClick={() => activeId && moveQueuedAttachment(activeId, item.id, attachment.id, 1)} className="disabled:opacity-20" aria-label="下移附件">↓</button>
                      </span>
                    ))}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* control strip */}
          <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1.5">
            <ProviderSwitcher />

            <ChipSelect
              label={
                <span
                  className="text-fg2"
                  title={pendingModel
                    ? (language === "zh-CN" ? `当前：${model}；本轮完成后切换至：${pendingModel}` : `Current: ${model}; switches after this turn: ${pendingModel}`)
                    : undefined}
                >
                  {currentModel?.label ?? model.toUpperCase()}
                  {pendingModel && <span className="text-gold"> · {language === "zh-CN" ? "等待" : "QUEUED"}</span>}
                </span>
              }
              items={models.map((m) => ({ id: m.id, label: m.label, hint: m.tagline }))}
              activeId={model}
              onSelect={setModel}
              width={240}
            />

            <PromptOptionsMenu mode={mode} effort={effort} efforts={models.find((item) => item.id === model)?.efforts} permissionMode={permissionMode} onMode={setMode} onEffort={setEffort} onPermission={setPermissionMode} />

            {deepResearchAvailable && <button
              onClick={() => {
                setText("/deep-research ");
                requestAnimationFrame(() => taRef.current?.focus());
              }}
              disabled={running}
              title={language === "zh-CN" ? "启动 Deep Research" : "Start Deep Research"}
              className="flex h-8 items-center gap-1.5 rounded-full border border-acc/30 bg-acc/5 px-3 font-mono text-[10.5px] text-acc transition-colors hover:border-acc/60 hover:bg-acc/10 disabled:opacity-40"
            >
              <Icon name="search" size={11} />
              {language === "zh-CN" ? "深度研究" : "RESEARCH"}
            </button>}

            <button
              onClick={() => fileRef.current?.click()}
              disabled={creating || readingFiles || attachments.length >= MAX_ATTACHMENTS}
              title={language === "zh-CN" ? "上传文件；也可直接粘贴剪贴板图片" : "Upload files; clipboard images can also be pasted"}
              className="flex h-8 items-center gap-1.5 rounded-full border border-line2 px-3 font-mono text-[10.5px] text-dim transition-colors hover:border-line3 hover:text-fg2 disabled:opacity-40"
            >
              <Icon name="clip" size={11} />
              {readingFiles && <span className="plan-spinner !h-[10px] !w-[10px] !basis-[10px]" />}
              {readingFiles ? (language === "zh-CN" ? "读取中" : "READING") : (language === "zh-CN" ? "附件" : "ATTACH")}
            </button>

            <div className="flex-1" />

            {!creating && !running && !restoring && (
              <RewindMenu onComplete={() => taRef.current?.focus()} />
            )}

            {running ? (
              <>
                <button
                  onClick={() => void send()}
                  disabled={!text.trim() && attachments.length === 0}
                  title={language === "zh-CN" ? "当前回合结束后发送" : "Send after current turn"}
                  className="flex h-8 items-center gap-1.5 rounded-full border border-line2 px-3 font-mono text-[10px] text-fg2 disabled:opacity-40"
                >
                  {language === "zh-CN" ? "加入队列" : "QUEUE"}
                </button>
                {status === "running" && <button
                    onClick={() => void interject()}
                    disabled={!text.trim() && attachments.length === 0}
                    title={language === "zh-CN" ? "插入当前回合（⌘/Ctrl+Enter）" : "Interject (Cmd/Ctrl+Enter)"}
                    className="flex h-8 items-center gap-1.5 rounded-full border border-acc/40 px-3 font-mono text-[10px] text-acc disabled:opacity-40"
                  >
                    {language === "zh-CN" ? "插话" : "INTERJECT"}
                  </button>}
                {computerRunning && <button
                  onClick={emergencyStopComputer}
                  title={language === "zh-CN" ? "紧急停止 Computer Use，并锁定当前控制租约" : "Emergency stop Computer Use and lock this control lease"}
                  className="flex h-8 items-center gap-1.5 rounded-full border border-red/70 bg-red/5 px-3 font-mono text-[10px] text-red transition-colors hover:bg-red/10"
                >
                  <Icon name="stop" size={10} />
                  {language === "zh-CN" ? "紧急停止" : "E-STOP"}
                </button>}
                <button
                  onClick={stop}
                  title="Abort turn"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-red/50 text-red transition-colors hover:bg-red/10"
                >
                  <Icon name="stop" size={11} />
                </button>
              </>
            ) : (
              <button
                onClick={send}
                disabled={creating || (!text.trim() && attachments.length === 0) || readingFiles}
                title="Transmit"
                className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                  text.trim() || attachments.length > 0
                    ? "bg-acc text-base hover:bg-acc-deep"
                    : "bg-high text-faint"
                }`}
              >
                <Icon name="arrowUp" size={13} strokeWidth={2} />
              </button>
            )}
          </div>
          {feedbackOpen && (
            <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-6" onMouseDown={(event) => event.target === event.currentTarget && setFeedbackOpen(false)}>
              <div className="w-full max-w-lg rounded-[7px] border border-line3 bg-raise p-4 shadow-2xl">
                <div className="flex items-center justify-between"><span className="lbl !text-gold">{language === "zh-CN" ? "提交 GROK BUILD 反馈" : "GROK BUILD FEEDBACK"}</span><button onClick={() => setFeedbackOpen(false)} className="text-faint hover:text-fg"><Icon name="x" size={11} /></button></div>
                <p className="mt-2 text-[10.5px] leading-relaxed text-dim">{language === "zh-CN" ? "反馈会通过官方 x.ai/feedback 通道提交，并关联当前任务上下文。" : "Feedback is submitted through the official x.ai/feedback channel with this mission context."}</p>
                <textarea autoFocus value={feedbackText} onChange={(event) => setFeedbackText(event.target.value)} rows={6} className="mt-3 w-full resize-y rounded-[5px] border border-line2 bg-void p-3 text-[12px] text-fg outline-none focus:border-gold/60" placeholder={language === "zh-CN" ? "请描述问题或建议…" : "Describe the issue or suggestion…"} />
                {feedbackError && <p className="mt-2 text-[10px] text-red">{feedbackError}</p>}
                <div className="mt-3 flex justify-end gap-2"><button onClick={() => setFeedbackOpen(false)} className="rounded-[4px] border border-line2 px-3 py-2 text-[10.5px] text-mute hover:text-fg">{language === "zh-CN" ? "取消" : "Cancel"}</button><button disabled={!feedbackText.trim() || feedbackSending || !activeId} onClick={() => { if (!activeId) return; setFeedbackSending(true); setFeedbackError(""); void bridge.callExtension("x.ai/feedback", { session_id: activeId, feedback_text: feedbackText.trim() }).then(() => { setFeedbackText(""); setFeedbackOpen(false); }).catch((error) => setFeedbackError(error instanceof Error ? error.message : String(error))).finally(() => setFeedbackSending(false)); }} className="rounded-[4px] bg-gold px-3 py-2 text-[10.5px] font-medium text-base disabled:opacity-40">{feedbackSending ? (language === "zh-CN" ? "提交中…" : "Sending…") : (language === "zh-CN" ? "提交" : "Submit")}</button></div>
              </div>
            </div>
          )}
          {attachmentError && <p className="border-t border-red/20 px-3 py-1.5 text-[9.5px] text-red">{attachmentError}</p>}
        </div>
        </div>

        <div className="mt-1.5 flex items-center justify-between px-1">
          <span className="lbl !text-[9.5px]">
            {creating
              ? (language === "zh-CN" ? "正在创建会话…" : "CREATING CONVERSATION…")
              : restoring
              ? (language === "zh-CN" ? "正在同步当前会话…" : "SYNCHRONIZING CURRENT SESSION…")
              : (language === "zh-CN" ? "⏎ 发送/排队 · ⌘/Ctrl+⏎ 插话 · ⇧⏎ 换行 · 输入法确认不发送" : "⏎ SEND/QUEUE · CMD/CTRL+⏎ INTERJECT · ⇧⏎ NEWLINE · IME SAFE")}
          </span>
          <span className="lbl !text-[9.5px]">
            {language === "zh-CN"
              ? mode === "plan" ? "计划模式 · 批准前只读" : mode === "ask" ? "问答模式 · 不使用工具" : "AGENT 模式 · 完整工具权限"
              : mode === "plan" ? "PLAN MODE · READ-ONLY UNTIL APPROVED" : mode === "ask" ? "ASK MODE · NO TOOLS" : "AGENT MODE · FULL TOOL ACCESS"}
          </span>
        </div>
      </div>
    </div>
  );
}
