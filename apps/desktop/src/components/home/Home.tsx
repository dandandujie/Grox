/* ─────────────────────────────────────────────────────────────────────────
   Home — mission control. Deep field, the orbital mark, one input, and
   the last few missions. Everything else is silence.
   ───────────────────────────────────────────────────────────────────────── */

import { useRef, useState, type CSSProperties } from "react";
import { useDesktop } from "../../state/store";
import type { PromptAttachment } from "../../bridge/types";
import { fmtRelTime, fmtTokens } from "../../lib/format";
import { MAX_ATTACHMENTS, prepareAttachment, validateAttachmentSet } from "../../lib/attachments";
import { attachExplicitPromptImages } from "../../lib/pathAttachments";
import { BlackHole } from "../fx/BlackHole";
import { Starfield } from "../fx/Starfield";
import { StageTransition } from "../fx/StageTransition";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "../common/ChipSelect";
import { PromptOptionsMenu, ProviderSwitcher } from "../common/PromptControls";
import { useI18n } from "../../lib/i18n";
import { MediaStudio } from "./MediaStudio";
import { useImeGuard } from "../../lib/ime";

export function Home() {
  const { language, t } = useI18n();
  const [workspaceMode, setWorkspaceMode] = useState<"conversation" | "image" | "video">("conversation");
  const [q, setQ] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingFiles, setReadingFiles] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const { onCompositionStart, onCompositionEnd, isImeBlocking } = useImeGuard();
  const sessionIndex = useDesktop((s) => s.sessionIndex);
  const sessions = useDesktop((s) => s.sessions);
  const newSession = useDesktop((s) => s.newSession);
  const openSession = useDesktop((s) => s.openSession);
  const workspace = useDesktop((s) => s.workspace);
  const startupError = useDesktop((s) => s.startupError);
  const auth = useDesktop((s) => s.auth);
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

  const recent = [...sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

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
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const turnAttachments = await attachExplicitPromptImages(workspace, prompt, attachments);
      if (modeCommand) setMode(modeCommand[1].toLowerCase() as "plan" | "agent" | "ask");
      await newSession({ text: prompt, attachments: turnAttachments });
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
        <Starfield density={90} interactive={false} className="opacity-50" />
        <div className="home-nebula opacity-40" />
        <WorkspaceTabs mode={workspaceMode} onChange={setWorkspaceMode} />
        <StageTransition stageKey={workspaceMode} variant="panel" className="relative z-[1]">
          <MediaStudio mode={workspaceMode} />
        </StageTransition>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden bg-base">
      <Starfield density={190} interactive />
      <div className="home-nebula" />
      <WorkspaceTabs mode={workspaceMode} onChange={setWorkspaceMode} />

      {/* engineering crosshairs */}
      <Crosshair className="left-3 top-3 animate-mission-in" style={{ animationDelay: "0.05s" }} />
      <Crosshair className="right-3 top-3 animate-mission-in" style={{ animationDelay: "0.08s" }} />
      <Crosshair className="bottom-3 left-3 animate-mission-in" style={{ animationDelay: "0.1s" }} />
      <Crosshair className="bottom-3 right-3 animate-mission-in" style={{ animationDelay: "0.12s" }} />

      <div className="relative z-[1] flex h-full flex-col items-center justify-center px-10 pb-16">
        <div className="animate-mission-in" style={{ animationDelay: "0.04s" }}>
          <div className="animate-bh-breathe">
            <BlackHole size={168} spin="slow" />
          </div>
        </div>

        <div className="animate-mission-in mt-8" style={{ animationDelay: "0.14s" }}>
          <h1
            className="animate-wordmark-pulse font-sans font-semibold text-fg"
            style={{ fontSize: 52, letterSpacing: "0.48em", marginRight: "-0.48em" }}
          >
            GROX
          </h1>
        </div>
        <p className="lbl mt-3.5 animate-mission-in" style={{ letterSpacing: "0.28em", animationDelay: "0.22s" }}>
          {language === "zh-CN" ? "任务控制台 · GROK-BUILD 已连接" : "MISSION CONTROL · GROK-BUILD LINK"}
        </p>

        {startupError && (
          <div className="mt-7 w-full max-w-[760px] animate-mission-in rounded-[18px] border border-red/40 bg-red/5 px-5 py-3.5" style={{ animationDelay: "0.28s" }}>
            <div className="flex items-start gap-3">
              <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-red" />
              <div className="min-w-0">
                <p className="lbl !text-[10px] !text-red">{language === "zh-CN" ? "连接失败" : "LINK FAILURE"}</p>
                <p className="mt-1.5 break-words font-mono text-[12px] leading-relaxed text-fg2">
                  {startupError}
                </p>
                <p className="mt-1.5 text-[11px] text-dim">
                  {language === "zh-CN" ? "请安装 Grok CLI，或设置 GROK_DESKTOP_CLI 后重启 Grox。" : "Install Grok CLI or set GROK_DESKTOP_CLI, then restart Grox."}
                </p>
              </div>
            </div>
          </div>
        )}

        {auth.required && (
          <div className="mt-7 flex w-full max-w-[760px] animate-mission-in items-center gap-4 rounded-[18px] border border-gold/40 bg-gold/5 px-5 py-3.5" style={{ animationDelay: "0.28s" }}>
            <BlackHole size={28} spin={auth.inProgress} />
            <div className="min-w-0 flex-1">
              <p className="lbl !text-[10px] !text-gold">{language === "zh-CN" ? "需要账户设置" : "AUTHENTICATION REQUIRED"}</p>
              <p className="mt-1.5 text-[12px] text-fg2">
                {auth.error ?? (language === "zh-CN" ? "请先选择 OAuth、官方 API 或 OpenAI 兼容服务。" : "Connect your xAI account before launching a mission.")}
              </p>
            </div>
            <button
              onClick={() => setAccountSetupOpen(true)}
              disabled={auth.inProgress}
              className="h-9 rounded-full border border-gold/50 px-4 font-mono text-[10.5px] tracking-[0.12em] text-gold transition-colors hover:bg-gold/10 disabled:opacity-50"
            >
              {auth.inProgress ? (language === "zh-CN" ? "连接中" : "CONNECTING") : t("account")}
            </button>
          </div>
        )}

        {/* pre-project uplink */}
        <div className="aurora-rim relative mt-9 w-full max-w-[860px] animate-mission-in" style={{ animationDelay: "0.32s" }}>
          <div className="aurora-rim__core">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void appendFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          {attachments.length > 0 && <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2.5">{attachments.map((attachment) => <div key={attachment.id} className="flex h-9 max-w-[220px] items-center gap-2 rounded-full border border-line2 bg-high/70 px-3">{attachment.kind === "image" && attachment.data ? <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" className="h-6 w-6 rounded-full object-cover" /> : <Icon name="file" size={11} className="text-dim" />}<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg2">{attachment.name}</span><button onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))} className="text-faint hover:text-fg" title={language === "zh-CN" ? "移除" : "Remove"}><Icon name="x" size={9} /></button></div>)}</div>}
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
            rows={3}
            placeholder={language === "zh-CN" ? "描述任务；可直接粘贴截图或上传文件…" : "Describe the mission; paste screenshots or attach files…"}
            disabled={auth.required}
            className="block min-h-[84px] w-full resize-none bg-transparent px-5 pb-1.5 pt-4 text-[16px] leading-relaxed text-fg placeholder:text-faint focus:outline-none disabled:opacity-50"
          />
          {slashMatches.length > 0 && <div className="absolute z-30 mt-1.5 w-[min(640px,calc(100%-32px))] animate-fade-up rounded-[16px] border border-line2 bg-raise p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.45)]">{slashMatches.map((command, index) => <button key={command.id} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSlash(command.id)} className={`flex w-full items-center gap-3 rounded-full px-3.5 py-2.5 text-left ${index === slashIndex ? "bg-high text-fg" : "text-dim hover:bg-high hover:text-fg2"}`}><span className="font-mono text-[11px] text-acc">{command.id}</span><span className="min-w-0 flex-1 truncate text-[11px]">{command.hint}</span></button>)}</div>}
          <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1.5">
            <ProviderSwitcher />
            <ChipSelect label={<span className="text-fg2">{currentModel?.label ?? model.toUpperCase()}</span>} items={models.map((item) => ({ id: item.id, label: item.label, hint: item.tagline }))} activeId={model} onSelect={setModel} width={260} />
            <PromptOptionsMenu mode={mode} effort={effort} efforts={models.find((item) => item.id === model)?.efforts} permissionMode={permissionMode} onMode={setMode} onEffort={setEffort} onPermission={setPermissionMode} />
            <button onClick={() => fileRef.current?.click()} disabled={auth.required || readingFiles || attachments.length >= MAX_ATTACHMENTS} className="flex h-8 items-center gap-1.5 rounded-full border border-line2 px-3 font-mono text-[10.5px] text-dim hover:border-line3 hover:text-fg2 disabled:opacity-40" title={language === "zh-CN" ? "上传文件；也支持粘贴剪贴板图片" : "Attach files; clipboard images are also supported"}><Icon name="clip" size={12} />{readingFiles ? (language === "zh-CN" ? "读取中" : "READING") : (language === "zh-CN" ? "附件" : "ATTACH")}</button>
            <div className="flex-1" />
            <button onClick={() => void launch()} disabled={(!q.trim() && attachments.length === 0) || auth.required || readingFiles} className={`flex h-9 w-9 items-center justify-center rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)] ${(q.trim() || attachments.length > 0) && !auth.required ? "scale-100 bg-acc text-base hover:scale-110 hover:bg-acc-deep active:scale-95" : "bg-high text-faint"}`} title={language === "zh-CN" ? "开始任务" : "Launch mission"}><Icon name="arrowUp" size={15} strokeWidth={2} /></button>
          </div>
          {attachmentError && <p className="border-t border-red/20 px-4 py-2 text-[10.5px] text-red">{attachmentError}</p>}
          </div>
        </div>

        {/* recent missions */}
        {recent.length > 0 && (
          <div className="mt-12 w-full max-w-[760px] animate-mission-in" style={{ animationDelay: "0.42s" }}>
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="lbl !text-[10px]">{language === "zh-CN" ? "最近任务" : "RECENT MISSIONS"}</span>
              <span className="tnum text-[10.5px] text-faint">{recent.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {recent.map((m, index) => {
                const tokens =
                  (sessions[m.id]?.usage.inputTokens ?? 0) + (sessions[m.id]?.usage.outputTokens ?? 0);
                return (
                  <button
                    key={m.id}
                    onClick={() => openSession(m.id)}
                    className="mission-card group animate-mission-card rounded-[18px] border border-line2 bg-raise/60 px-4 py-3.5 text-left hover:border-line3 hover:bg-raise"
                    style={{ animationDelay: `${0.48 + index * 0.06}s` }}
                  >
                    <p className="truncate text-[13px] text-fg2 group-hover:text-fg">{m.title}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="lbl !text-[10px]">{fmtRelTime(m.updatedAt)}</span>
                      {tokens > 0 && (
                        <span className="tnum text-[10px] text-faint">{fmtTokens(tokens)} TOK</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ground strip */}
      <div className="absolute inset-x-0 bottom-0 z-[1] flex h-9 animate-mission-in items-center justify-between px-5" style={{ animationDelay: "0.55s" }}>
        <span className="tnum max-w-[60%] truncate text-[10.5px] text-mute">{workspace}</span>
        <span className="lbl !text-[10px]">⌘K {language === "zh-CN" ? "命令" : "PALETTE"} · ⌘N {t("newProject")}</span>
      </div>
    </div>
  );
}

function WorkspaceTabs({ mode, onChange }: { mode: "conversation" | "image" | "video"; onChange(mode: "conversation" | "image" | "video"): void }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  return (
    <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line2 bg-panel/90 p-1.5 shadow-lg backdrop-blur animate-mission-in" style={{ animationDelay: "0.02s" }}>
      {([
        ["conversation", zh ? "对话" : "CHAT"],
        ["image", zh ? "图片" : "IMAGE"],
        ["video", zh ? "视频" : "VIDEO"],
      ] as const).map(([id, label]) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex h-8 items-center gap-1.5 rounded-full px-4 font-mono text-[10.5px] tracking-[0.08em] transition-all duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)] ${mode === id ? "scale-100 bg-acc text-base shadow-[0_0_18px_color-mix(in_srgb,var(--color-acc)_35%,transparent)]" : "text-dim hover:scale-[1.03] hover:bg-high hover:text-fg2"}`}
        >
          {id === "conversation" ? <Icon name="command" size={11} /> : id === "image" ? <Icon name="layers" size={11} /> : <Icon name="play" size={11} />}
          {label}
        </button>
      ))}
    </div>
  );
}

const Crosshair = ({ className = "", style }: { className?: string; style?: CSSProperties }) => (
  <span className={`pointer-events-none absolute select-none font-mono text-[11px] text-faint ${className}`} style={style}>
    +
  </span>
);
