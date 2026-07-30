/* Bottom workbench: terminal output + side-agent launcher for parallel missions. */

import { useState } from "react";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { TerminalPanel } from "../terminal/TerminalPanel";

type Tab = "terminal" | "side";

export function WorkbenchPanel() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [tab, setTab] = useState<Tab>("terminal");
  const [draft, setDraft] = useState("");
  const toggleTerminal = useDesktop((state) => state.toggleTerminal);
  const activeId = useDesktop((state) => state.activeId);
  const session = useDesktop((state) => (state.activeId ? state.sessions[state.activeId] : null));
  const newSession = useDesktop((state) => state.newSession);
  const running = Object.values(useDesktop((state) => state.sessions)).filter((item) => item.status === "running").length;

  const launchSide = () => {
    const text = draft.trim();
    if (!text) return;
    const context = session
      ? (zh
          ? `【并行侧任务】主会话 ${session.title} 仍在进行。请独立完成：\n${text}`
          : `[Side agent] Main mission "${session.title}" continues in parallel. Complete independently:\n${text}`)
      : text;
    setDraft("");
    void newSession({ text: context });
  };

  return (
    <section className="flex h-[min(300px,44vh)] shrink-0 flex-col overflow-hidden border-t border-line2 bg-void animate-fade-up">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <button
          onClick={() => setTab("terminal")}
          className={`flex h-7 items-center gap-1.5 rounded-full px-3 font-mono text-[9.5px] ${tab === "terminal" ? "bg-high text-fg" : "text-dim hover:text-fg2"}`}
        >
          <Icon name="terminal" size={11} />
          {zh ? "终端" : "TERMINAL"}
        </button>
        <button
          onClick={() => setTab("side")}
          className={`flex h-7 items-center gap-1.5 rounded-full px-3 font-mono text-[9.5px] ${tab === "side" ? "bg-high text-fg" : "text-dim hover:text-fg2"}`}
        >
          <Icon name="layers" size={11} />
          {zh ? "侧任务" : "SIDE AGENT"}
          {running > 1 && <span className="tnum text-acc">{running}</span>}
        </button>
        <span className="ml-auto font-mono text-[9px] text-faint">
          {zh ? "并行会话共用同一 ACP 进程" : "Parallel sessions share one ACP process"}
        </span>
        <button
          onClick={toggleTerminal}
          className="flex h-6 w-6 items-center justify-center text-dim hover:bg-high hover:text-fg"
          title={zh ? "关闭工作台" : "Close workbench"}
        >
          <Icon name="x" size={10} />
        </button>
      </div>

      {tab === "terminal" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <TerminalPanel embedded />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <p className="text-[11px] leading-relaxed text-dim">
            {zh
              ? "侧任务会新建独立会话并立即发送，主会话可继续运行。适合并行调研、测试或修小问题。"
              : "Side agents open a fresh session and send immediately while the main mission keeps running — useful for research, tests, or small fixes."}
          </p>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            placeholder={zh ? "描述侧任务…" : "Describe the side task…"}
            className="min-h-0 flex-1 resize-none rounded-[14px] border border-line2 bg-raise px-3 py-2 text-[13px] text-fg outline-none placeholder:text-faint focus:border-line3"
          />
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9.5px] text-faint">
              {activeId ? `MAIN · ${activeId.slice(0, 8)}` : (zh ? "无主会话" : "NO MAIN SESSION")}
            </span>
            <button
              disabled={!draft.trim()}
              onClick={launchSide}
              className="flex h-8 items-center gap-1.5 rounded-full bg-acc px-3.5 font-mono text-[10px] text-base disabled:opacity-35"
            >
              <Icon name="play" size={11} />
              {zh ? "启动侧任务" : "LAUNCH SIDE"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
