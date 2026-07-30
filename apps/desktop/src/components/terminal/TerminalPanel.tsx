import { useEffect, useMemo, useRef } from "react";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";

export function TerminalPanel({ embedded = false }: { embedded?: boolean }) {
  const { t, language } = useI18n();
  const session = useDesktop((state) => (state.activeId ? state.sessions[state.activeId] : null));
  const toggleTerminal = useDesktop((state) => state.toggleTerminal);
  const scrollRef = useRef<HTMLDivElement>(null);
  const calls = useMemo(
    () => (session?.blocks ?? []).flatMap((block) =>
      block.type === "tool" && block.call.terminal ? [block.call] : [],
    ),
    [session],
  );
  const lineCount = calls.reduce((count, call) => count + (call.terminal?.lines.length ?? 0), 0);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [calls, lineCount]);

  const body = (
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-[1.65] select-text">
        {calls.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="lbl !text-[9.5px]">{t("noTerminal").toUpperCase()}</span>
          </div>
        ) : (
          <div className="space-y-3">
            {calls.map((call) => {
              const terminal = call.terminal;
              if (!terminal) return null;
              return (
                <div key={call.id}>
                  <div className="flex items-center gap-2">
                    <span className="text-acc">$</span>
                    <span className="min-w-0 flex-1 truncate text-fg">{terminal.cmd}</span>
                    {call.status === "running" && <span className="h-1 w-1 animate-pulse-dot rounded-full bg-fg" />}
                    {terminal.exitCode !== undefined && (
                      <span className={terminal.exitCode === 0 ? "text-green" : "text-red"}>
                        EXIT {terminal.exitCode}
                      </span>
                    )}
                  </div>
                  {terminal.lines.map((line, index) => (
                    <div
                      key={index}
                      className={
                        line.endsWith("... ok") || line.startsWith("test result:")
                          ? "text-green/90"
                          : line.includes("FAILED") || line.startsWith("failures")
                            ? "text-red/90"
                            : "text-mute"
                      }
                    >
                      {line || " "}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
  );

  if (embedded) {
    return <div className="flex h-full min-h-0 flex-col overflow-hidden">{body}</div>;
  }

  return (
    <section
      className="flex h-[min(280px,42vh)] shrink-0 flex-col overflow-hidden border-t border-line2 bg-void animate-fade-up"
      aria-label={t("terminal")}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Icon name="terminal" size={12} className="text-acc" />
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg2">{t("terminal").toUpperCase()}</span>
        {calls.length > 0 && (
          <span className="font-mono text-[9px] text-faint">
            {calls.length} {language === "zh-CN" ? "条命令" : calls.length === 1 ? "COMMAND" : "COMMANDS"}
          </span>
        )}
        <button
          onClick={toggleTerminal}
          className="ml-auto flex h-6 w-6 items-center justify-center text-dim transition-colors hover:bg-high hover:text-fg"
          title={language === "zh-CN" ? "关闭终端" : "Close terminal"}
          aria-label={language === "zh-CN" ? "关闭终端" : "Close terminal"}
        >
          <Icon name="x" size={10} />
        </button>
      </div>
      {body}
    </section>
  );
}
