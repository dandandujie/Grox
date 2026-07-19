/* ─────────────────────────────────────────────────────────────────────────
   Composer — the uplink. One bordered instrument: text field on top,
   control strip below (mode · model · effort · attach · voice · send).
   Slash opens the command menu; Enter transmits; ⌘↵ too.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import {
  EFFORTS,
  type PromptAttachment,
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
import { RewindMenu } from "./RewindMenu";

interface SlashCmd {
  id: string;
  hint: string;
  run: () => void;
}

export function Composer() {
  const { language } = useI18n();
  const [slashIdx, setSlashIdx] = useState(0);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingFiles, setReadingFiles] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const sendPrompt = useDesktop((s) => s.sendPrompt);
  const composer = useDesktop((s) => s.activeId ? s.sessionComposers[s.activeId] : undefined);
  const text = composer?.text ?? "";
  const attachments = composer?.attachments ?? [];
  const setText = useDesktop((s) => s.setDraft);
  const setAttachments = useDesktop((s) => s.setComposerAttachments);
  const stop = useDesktop((s) => s.stop);
  const compact = useDesktop((s) => s.compact);
  const status = useDesktop((s) => (s.activeId ? s.sessions[s.activeId]?.status : null));
  const model = useDesktop((s) => s.model);
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

  const running =
    status === "running" || status === "awaiting_permission" || status === "awaiting_input";

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

  const slashOpen = text.startsWith("/") && !text.includes(" ");
  const query = slashOpen ? text.slice(1).toLowerCase() : "";
  const matches = slashOpen ? slashCommands.filter((c) => c.id.slice(1).startsWith(query)) : [];

  useEffect(() => setSlashIdx(0), [query]);

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

  const send = () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || running || readingFiles) return;
    sendPrompt(t, attachments);
    setText("");
    setAttachments([]);
    setAttachmentError("");
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
        matches[Math.min(slashIdx, matches.length - 1)].run();
        setText("");
        return;
      }
      if (e.key === "Escape") {
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const currentModel = models.find((m) => m.id === model);

  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="relative mx-auto max-w-[760px]">
        {/* slash menu */}
        {slashOpen && matches.length > 0 && (
          <div className="absolute bottom-full left-0 z-40 mb-2 w-full overflow-hidden rounded-[6px] border border-line2 bg-raise py-1 shadow-[0_8px_28px_rgba(0,0,0,0.55)] animate-fade-up">
            {matches.map((c, i) => (
              <button
                key={c.id}
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => {
                  c.run();
                  setText("");
                }}
                className={`flex w-full items-center gap-3 px-3 py-1.5 text-left ${
                  i === slashIdx ? "bg-high" : ""
                }`}
              >
                <span className="w-20 shrink-0 font-mono text-[11px] text-acc">{c.id}</span>
                <span className="text-[11px] text-mute">{c.hint}</span>
              </button>
            ))}
          </div>
        )}

        <div className="rounded-[8px] border border-line2 bg-raise transition-colors focus-within:border-acc-dim">
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
                <div key={attachment.id} className="group flex h-9 max-w-[220px] items-center gap-2 rounded-[5px] border border-line2 bg-high/70 pl-1.5 pr-1">
                  {attachment.kind === "image" && attachment.data ? (
                    <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" className="h-6 w-6 rounded-[3px] object-cover" />
                  ) : (
                    <span className="flex h-6 w-6 items-center justify-center rounded-[3px] bg-raise text-dim"><Icon name="file" size={11} /></span>
                  )}
                  <div className="min-w-0 flex-1"><p className="truncate font-mono text-[9.5px] text-fg2">{attachment.name}</p><p className="font-mono text-[8.5px] text-faint">{attachment.size < 1024 * 1024 ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : `${(attachment.size / 1024 / 1024).toFixed(1)} MB`}</p></div>
                  <button onClick={() => setAttachments(attachments.filter((item) => item.id !== attachment.id))} className="flex h-6 w-6 items-center justify-center rounded-[3px] text-faint hover:bg-raise hover:text-fg" title={language === "zh-CN" ? "移除附件" : "Remove attachment"}><Icon name="x" size={9} /></button>
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
            rows={1}
            placeholder={
              running
                ? (language === "zh-CN" ? "Grok 正在处理 — 可以准备下一条请求…" : "Grok is working — queue the next directive…")
                : (language === "zh-CN" ? "发送给 Grok…" : "Transmit to Grok…")
            }
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
          />

          {/* control strip */}
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1">
            <ProviderSwitcher />

            <ChipSelect
              label={
                <span className="text-fg2">{currentModel?.label ?? model.toUpperCase()}</span>
              }
              items={models.map((m) => ({ id: m.id, label: m.label, hint: m.tagline }))}
              activeId={model}
              onSelect={setModel}
              width={240}
            />

            <PromptOptionsMenu mode={mode} effort={effort} permissionMode={permissionMode} onMode={setMode} onEffort={setEffort} onPermission={setPermissionMode} />

            <button
              onClick={() => fileRef.current?.click()}
              disabled={running || readingFiles || attachments.length >= MAX_ATTACHMENTS}
              title={language === "zh-CN" ? "上传文件；也可直接粘贴剪贴板图片" : "Upload files; clipboard images can also be pasted"}
              className="flex h-7 items-center gap-1.5 rounded-[5px] border border-line2 px-2 font-mono text-[9.5px] text-dim transition-colors hover:border-line3 hover:text-fg2 disabled:opacity-40"
            >
              <Icon name="clip" size={11} />
              {readingFiles ? (language === "zh-CN" ? "读取中" : "READING") : (language === "zh-CN" ? "附件" : "ATTACH")}
            </button>

            <div className="flex-1" />

            {!running && (
              <RewindMenu onComplete={() => taRef.current?.focus()} />
            )}

            {running ? (
              <button
                onClick={stop}
                title="Abort turn"
                className="flex h-7 w-7 items-center justify-center rounded-[5px] border border-red/50 text-red transition-colors hover:bg-red/10"
              >
                <Icon name="stop" size={11} />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={(!text.trim() && attachments.length === 0) || readingFiles}
                title="Transmit"
                className={`flex h-7 w-7 items-center justify-center rounded-[5px] transition-colors ${
                  text.trim() || attachments.length > 0
                    ? "bg-acc text-base hover:bg-acc-deep"
                    : "bg-high text-faint"
                }`}
              >
                <Icon name="arrowUp" size={13} strokeWidth={2} />
              </button>
            )}
          </div>
          {attachmentError && <p className="border-t border-red/20 px-3 py-1.5 text-[9.5px] text-red">{attachmentError}</p>}
        </div>

        <div className="mt-1.5 flex items-center justify-between px-1">
          <span className="lbl !text-[9.5px]">
            {language === "zh-CN" ? "⏎ 发送 · ⇧⏎ 换行 · 粘贴图片 · / 命令" : "⏎ SEND · ⇧⏎ NEWLINE · PASTE IMAGE · / COMMANDS"}
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
