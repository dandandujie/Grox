/* ─────────────────────────────────────────────────────────────────────────
   Home — mission control. Deep field, the orbital mark, one input, and
   the last few missions. Everything else is silence.
   ───────────────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { useDesktop } from "../../state/store";
import { fmtRelTime, fmtTokens } from "../../lib/format";
import { BlackHole } from "../fx/BlackHole";
import { Starfield } from "../fx/Starfield";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

export function Home() {
  const { language, t } = useI18n();
  const [q, setQ] = useState("");
  const sessionIndex = useDesktop((s) => s.sessionIndex);
  const sessions = useDesktop((s) => s.sessions);
  const newSession = useDesktop((s) => s.newSession);
  const openSession = useDesktop((s) => s.openSession);
  const sendPrompt = useDesktop((s) => s.sendPrompt);
  const workspace = useDesktop((s) => s.workspace);
  const startupError = useDesktop((s) => s.startupError);
  const auth = useDesktop((s) => s.auth);
  const setAccountSetupOpen = useDesktop((s) => s.setAccountSetupOpen);

  const recent = [...sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

  const launch = async () => {
    const t = q.trim();
    if (!t) return;
    await newSession();
    sendPrompt(t);
  };

  return (
    <div className="relative flex-1 overflow-hidden bg-base">
      <Starfield />

      {/* engineering crosshairs */}
      <Crosshair className="left-3 top-3" />
      <Crosshair className="right-3 top-3" />
      <Crosshair className="bottom-3 left-3" />
      <Crosshair className="bottom-3 right-3" />

      <div className="relative flex h-full flex-col items-center justify-center px-8 pb-16">
        <BlackHole size={136} spin="slow" />

        <h1
          className="mt-7 font-sans font-semibold text-fg"
          style={{ fontSize: 42, letterSpacing: "0.52em", marginRight: "-0.52em" }}
        >
          GROX
        </h1>
        <p className="lbl mt-3" style={{ letterSpacing: "0.3em" }}>
          {language === "zh-CN" ? "任务控制台 · GROK-BUILD 已连接" : "MISSION CONTROL · GROK-BUILD LINK"}
        </p>

        {startupError && (
          <div className="mt-6 w-[560px] rounded-[6px] border border-red/40 bg-red/5 px-4 py-3">
            <div className="flex items-start gap-3">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-red" />
              <div className="min-w-0">
                <p className="lbl !text-[9.5px] !text-red">{language === "zh-CN" ? "连接失败" : "LINK FAILURE"}</p>
                <p className="mt-1 break-words font-mono text-[10.5px] leading-relaxed text-fg2">
                  {startupError}
                </p>
                <p className="mt-1.5 text-[10px] text-dim">
                  {language === "zh-CN" ? "请安装 Grok CLI，或设置 GROK_DESKTOP_CLI 后重启 Grox。" : "Install Grok CLI or set GROK_DESKTOP_CLI, then restart Grox."}
                </p>
              </div>
            </div>
          </div>
        )}

        {auth.required && (
          <div className="mt-6 flex w-[560px] items-center gap-4 rounded-[6px] border border-gold/40 bg-gold/5 px-4 py-3">
            <BlackHole size={24} spin={auth.inProgress} />
            <div className="min-w-0 flex-1">
              <p className="lbl !text-[9.5px] !text-gold">{language === "zh-CN" ? "需要账户设置" : "AUTHENTICATION REQUIRED"}</p>
              <p className="mt-1 text-[10.5px] text-fg2">
                {auth.error ?? (language === "zh-CN" ? "请先选择 OAuth、官方 API 或 OpenAI 兼容服务。" : "Connect your xAI account before launching a mission.")}
              </p>
            </div>
            <button
              onClick={() => setAccountSetupOpen(true)}
              disabled={auth.inProgress}
              className="h-8 rounded-[4px] border border-gold/50 px-3 font-mono text-[9.5px] tracking-[0.12em] text-gold transition-colors hover:bg-gold/10 disabled:opacity-50"
            >
              {auth.inProgress ? (language === "zh-CN" ? "连接中" : "CONNECTING") : t("account")}
            </button>
          </div>
        )}

        {/* quick launch */}
        <div className="mt-9 flex w-[480px] items-center gap-3 rounded-[8px] border border-line2 bg-raise px-4 transition-colors focus-within:border-acc-dim">
          <span className="text-acc">›</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void launch();
            }}
            placeholder={language === "zh-CN" ? "描述你要交给 Grok 的任务…" : "Describe the mission…"}
            disabled={auth.required}
            className="h-11 flex-1 bg-transparent text-[14px] text-fg placeholder:text-faint focus:outline-none"
          />
          <button
            onClick={() => void launch()}
            disabled={!q.trim() || auth.required}
            className={`flex h-7 w-7 items-center justify-center rounded-[5px] transition-colors ${
              q.trim() && !auth.required
                ? "bg-acc text-base hover:bg-acc-deep"
                : "bg-high text-faint"
            }`}
            title={language === "zh-CN" ? "开始任务" : "Launch mission"}
          >
            <Icon name="arrowUp" size={13} strokeWidth={2} />
          </button>
        </div>

        {/* recent missions */}
        {recent.length > 0 && (
          <div className="mt-11 w-[560px]">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="lbl !text-[9.5px]">{language === "zh-CN" ? "最近任务" : "RECENT MISSIONS"}</span>
              <span className="tnum text-[9.5px] text-faint">{recent.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {recent.map((m) => {
                const tokens =
                  (sessions[m.id]?.usage.inputTokens ?? 0) + (sessions[m.id]?.usage.outputTokens ?? 0);
                return (
                  <button
                    key={m.id}
                    onClick={() => openSession(m.id)}
                    className="group rounded-[6px] border border-line2 bg-raise/60 px-3.5 py-3 text-left transition-colors hover:border-line3 hover:bg-raise"
                  >
                    <p className="truncate text-[12px] text-fg2 group-hover:text-fg">{m.title}</p>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="lbl !text-[9.5px]">{fmtRelTime(m.updatedAt)}</span>
                      {tokens > 0 && (
                        <span className="tnum text-[9.5px] text-faint">{fmtTokens(tokens)} TOK</span>
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
      <div className="absolute inset-x-0 bottom-0 flex h-8 items-center justify-between px-4">
        <span className="tnum max-w-[60%] truncate text-[9.5px] text-mute">{workspace}</span>
        <span className="lbl !text-[9.5px]">⌘K {language === "zh-CN" ? "命令" : "PALETTE"} · ⌘N {t("newProject")}</span>
      </div>
    </div>
  );
}

const Crosshair = ({ className = "" }: { className?: string }) => (
  <span className={`pointer-events-none absolute select-none font-mono text-[11px] text-faint ${className}`}>
    +
  </span>
);
