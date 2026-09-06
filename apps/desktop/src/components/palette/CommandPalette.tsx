/* ─────────────────────────────────────────────────────────────────────────
   CommandPalette — ⌘K. A single mono column: actions first, then recent
   missions. Keyboard-only navigation, the way instruments should be.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import { EFFORTS } from "../../bridge/types";
import { fmtRelTime } from "../../lib/format";
import { Icon, type IconProps } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";
import { useImeGuard } from "../../lib/ime";

interface Item {
  id: string;
  icon: IconProps["name"];
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const { language, t } = useI18n();
  const open = useDesktop((s) => s.paletteOpen);
  const setOpen = useDesktop((s) => s.setPaletteOpen);
  const sessionIndex = useDesktop((s) => s.sessionIndex);
  const newProject = useDesktop((s) => s.newProject);
  const openSession = useDesktop((s) => s.openSession);
  const goHome = useDesktop((s) => s.goHome);
  const toggleInspector = useDesktop((s) => s.toggleInspector);
  const setSettingsOpen = useDesktop((s) => s.setSettingsOpen);
  const compact = useDesktop((s) => s.compact);
  const stop = useDesktop((s) => s.stop);
  const activeStatus = useDesktop((s) => (s.activeId ? s.sessions[s.activeId]?.status ?? null : null));
  const turnRunning = activeStatus === "running";
  const model = useDesktop((s) => s.model);
  const models = useDesktop((s) => s.models);
  const setModel = useDesktop((s) => s.setModel);
  const effort = useDesktop((s) => s.effort);
  const setEffort = useDesktop((s) => s.setEffort);

  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { onCompositionStart, onCompositionEnd, isImeBlocking } = useImeGuard();

  useEffect(() => {
    if (open) {
      setQuery("");
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const close = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const actions: Item[] = [
      ...(turnRunning
        ? [{
            id: "stop",
            icon: "stop" as const,
            label: language === "zh-CN" ? "停止当前回合" : "Stop current turn",
            hint: "ESC",
            run: close(stop),
          }]
        : []),
      { id: "new", icon: "plus", label: t("newProject"), hint: "⌘N", run: close(() => void newProject()) },
      { id: "home", icon: "home", label: language === "zh-CN" ? "任务控制台" : "Mission control", hint: "", run: close(goHome) },
      { id: "inspector", icon: "panelRight", label: language === "zh-CN" ? "显示/隐藏检查器" : "Toggle inspector", hint: "⌘J", run: close(toggleInspector) },
      { id: "settings", icon: "gear", label: t("settings"), hint: "⌘,", run: close(() => setSettingsOpen(true)) },
      {
        id: "model",
        icon: "bolt",
        label: language === "zh-CN"
          ? `切换模型 — ${models.find((m) => m.id === model)?.label ?? model}`
          : `Cycle model — ${models.find((m) => m.id === model)?.label ?? model}`,
        run: close(() => {
          if (models.length === 0) return;
          const i = models.findIndex((m) => m.id === model);
          setModel(models[(i + 1 + models.length) % models.length].id);
        }),
      },
      {
        id: "effort",
        icon: "layers",
        label: language === "zh-CN" ? `切换推理强度 — ${effort.toUpperCase()}` : `Cycle effort — ${effort.toUpperCase()}`,
        run: close(() => {
          const i = EFFORTS.indexOf(effort);
          setEffort(EFFORTS[(i + 1) % EFFORTS.length]);
        }),
      },
      {
        id: "compact",
        icon: "refresh",
        label: language === "zh-CN" ? "压缩当前会话上下文" : "Compact context",
        run: close(compact),
      },
    ];
    const q = query.trim().toLowerCase();
    const missionCandidates: Item[] = [...sessionIndex]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => ({
        id: `s-${m.id}`,
        icon: "clock" as const,
        label: m.title,
        hint: fmtRelTime(m.updatedAt),
        run: close(() => openSession(m.id)),
      }));

    // 先搜索完整索引、再限制渲染数量；先截断会让较旧但精确匹配的任务消失。
    const missions = q
      ? missionCandidates.filter((item) => item.label.toLowerCase().includes(q)).slice(0, 50)
      : missionCandidates.slice(0, 6);
    return q
      ? [...actions.filter((item) => item.label.toLowerCase().includes(q)), ...missions]
      : [...actions, ...missions];
  }, [query, sessionIndex, model, models, effort, turnRunning, stop, newProject, openSession, goHome, toggleInspector, setSettingsOpen, setModel, setEffort, compact, setOpen, language, t]);

  useEffect(() => setIdx(0), [query]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (isImeBlocking(e)) return;
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (i + 1) % Math.max(1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (i - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[Math.min(idx, items.length - 1)]?.run();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={language === "zh-CN" ? "命令面板" : "Command palette"}
      className="fixed inset-0 z-50 bg-void/70 backdrop-blur-[2px]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="mx-auto mt-[15vh] w-[540px] overflow-hidden rounded-[8px] border border-line3 bg-raise shadow-[0_24px_64px_rgba(0,0,0,0.6)] animate-fade-up"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line2 px-3.5">
          <Icon name="search" size={13} className="text-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            onKeyDown={onKey}
            placeholder={language === "zh-CN" ? "输入命令或搜索任务…" : "Type a command or search missions…"}
            aria-label={language === "zh-CN" ? "输入命令或搜索任务" : "Type a command or search missions"}
            aria-controls="command-palette-results"
            className="h-11 flex-1 bg-transparent font-mono text-[12px] text-fg placeholder:text-faint focus:outline-none"
          />
          <kbd className="lbl !text-[9.5px] !text-faint">ESC</kbd>
        </div>
        <div id="command-palette-results" role="listbox" className="max-h-[320px] overflow-y-auto py-1.5">
          {items.length === 0 && (
            <p className="px-4 py-6 text-center font-mono text-[11px] text-dim">
              {language === "zh-CN" ? "没有匹配结果。" : "No matches in this sector."}
            </p>
          )}
          {items.map((item, i) => (
            <button
              key={item.id}
              role="option"
              aria-selected={i === idx}
              onMouseEnter={() => setIdx(i)}
              onClick={item.run}
              className={`flex w-full items-center gap-3 px-3.5 py-2 text-left ${
                i === idx ? "bg-high" : ""
              }`}
            >
              <Icon name={item.icon} size={13} className={i === idx ? "text-acc" : "text-dim"} />
              <span className={`flex-1 truncate text-[12px] ${i === idx ? "text-fg" : "text-fg2"}`}>
                {item.label}
              </span>
              {item.hint && <span className="tnum text-[10px] text-faint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
