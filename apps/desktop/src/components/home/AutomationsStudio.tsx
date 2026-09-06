import { useEffect, useMemo, useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import { useAutomationCapability } from "../../state/automationCapabilityStore";
import { nextAutomationRun, type AutomationFrequency } from "../../lib/automations";
import type { AutomationRunOutcome } from "../../lib/automationRunHistory";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

function id() {
  return crypto.randomUUID?.() ?? `automation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const AUTOMATION_DRAFT_PREFIX = "grox.automationDraft.v1";

interface AutomationDraft {
  title: string;
  prompt: string;
  frequency: AutomationFrequency;
  time: string;
  weekday: number;
}

function automationDraftKey(workspace: string) {
  return `${AUTOMATION_DRAFT_PREFIX}:${workspace}`;
}

function loadAutomationDraft(workspace: string): AutomationDraft | null {
  try {
    const raw = localStorage.getItem(automationDraftKey(workspace));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AutomationDraft>;
    if (typeof value.title !== "string" || typeof value.prompt !== "string") return null;
    const frequency = ["once", "daily", "weekdays", "weekly"].includes(value.frequency ?? "")
      ? value.frequency as AutomationFrequency
      : "daily";
    return {
      title: value.title.slice(0, 500),
      prompt: value.prompt.slice(0, 20_000),
      frequency,
      time: typeof value.time === "string" && /^\d{2}:\d{2}$/.test(value.time) ? value.time : "09:00",
      weekday: Number.isInteger(value.weekday) ? Math.min(6, Math.max(0, value.weekday!)) : new Date().getDay(),
    };
  } catch {
    return null;
  }
}

export function AutomationsStudio() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const automations = useAutomationCapability((state) => state.automations);
  const runningId = useAutomationCapability((state) => state.runningId);
  const runHistory = useAutomationCapability((state) => state.runHistory);
  const lastTickAt = useAutomationCapability((state) => state.lastTickAt);
  const workspace = useDesktop((state) => state.workspace);
  const model = useDesktop((state) => state.model);
  const effort = useDesktop((state) => state.effort);
  const mode = useDesktop((state) => state.mode);
  const permissionMode = useDesktop((state) => state.permissionMode);
  const save = useDesktop((state) => state.saveAutomation);
  const remove = useDesktop((state) => state.deleteAutomation);
  const setEnabled = useDesktop((state) => state.setAutomationEnabled);
  const run = useDesktop((state) => state.runAutomation);
  const clearRunHistory = useDesktop((state) => state.clearAutomationRunHistory);
  const loadCapabilities = useDesktop((state) => state.loadCapabilities);
  const openSession = useDesktop((state) => state.openSession);
  useEffect(() => { void loadCapabilities(); }, [loadCapabilities]);
  const initialDraft = useRef(loadAutomationDraft(workspace)).current;
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? "");
  const [frequency, setFrequency] = useState<AutomationFrequency>(initialDraft?.frequency ?? "daily");
  const [time, setTime] = useState(initialDraft?.time ?? "09:00");
  const [weekday, setWeekday] = useState(initialDraft?.weekday ?? new Date().getDay());
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [section, setSection] = useState<"tasks" | "runs">("tasks");
  const [clearHistoryConfirm, setClearHistoryConfirm] = useState(false);

  useEffect(() => {
    localStorage.setItem(automationDraftKey(workspace), JSON.stringify({
      title,
      prompt,
      frequency,
      time,
      weekday,
    } satisfies AutomationDraft));
  }, [frequency, prompt, time, title, weekday, workspace]);

  const sorted = useMemo(() => [...automations].sort((a, b) => a.nextRunAt - b.nextRunAt), [automations]);
  const create = () => {
    const cleanTitle = title.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanTitle || !cleanPrompt) return;
    save({
      id: id(),
      title: cleanTitle,
      prompt: cleanPrompt,
      cwd: workspace,
      model,
      effort,
      mode,
      permissionMode,
      frequency,
      time,
      ...(frequency === "weekly" ? { weekday } : {}),
      enabled: true,
      nextRunAt: nextAutomationRun(frequency, time, Date.now(), weekday),
    });
    setTitle("");
    setPrompt("");
  };

  return (
    <div className="relative z-[1] mx-auto flex min-h-0 w-full max-w-[980px] flex-1 flex-col overflow-y-auto px-6 pb-10 pt-20 sm:px-10">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] tracking-[0.16em] text-acc">SCHEDULED WORK</p>
            <h1 className="mt-2 text-[26px] font-semibold text-fg">{zh ? "已安排" : "Automations"}</h1>
          </div>
          <div className={`mt-1 rounded-full border px-3 py-1.5 font-mono text-[9px] ${lastTickAt && Date.now() - lastTickAt < 90_000 ? "border-green/25 bg-green/5 text-green" : "border-line2 bg-high/55 text-dim"}`}>
            {lastTickAt
              ? `${zh ? "Host 调度上次检查" : "Host scheduler checked"} ${new Date(lastTickAt).toLocaleTimeString()}`
              : (zh ? "等待 Host 调度首次检查" : "Waiting for first Host scheduler check")}
          </div>
        </div>
        <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-mute">
          {zh
            ? "任务在 Grox 进程存活时每 30 秒检查一次；启用任务后关闭主窗口会转入托盘，流式会话、权限门禁、恢复和停止期间不会抢跑。托盘中明确退出后暂停调度。"
            : "Due tasks are checked every 30 seconds while Grox is running. Closing the main window keeps enabled schedules in the tray; busy turns and human gates are never pre-empted. Explicitly quitting from the tray pauses scheduling."}
        </p>
        <div className="mt-5 flex items-center gap-1 rounded-[8px] border border-line2 bg-panel/55 p-1">
          {(["tasks", "runs"] as const).map((item) => (
            <button
              key={item}
              onClick={() => setSection(item)}
              className={`rounded-[5px] px-3 py-1.5 text-[10.5px] transition-colors ${section === item ? "bg-high text-fg" : "text-dim hover:text-fg2"}`}
            >
              {item === "tasks"
                ? (zh ? `任务 ${automations.length}` : `Tasks ${automations.length}`)
                : (zh ? `运行记录 ${runHistory.length}` : `Runs ${runHistory.length}`)}
            </button>
          ))}
        </div>
      </header>

      {section === "tasks" ? <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-2">
          {sorted.length === 0 ? (
            <div className="rounded-[14px] border border-dashed border-line2 bg-raise/40 p-8 text-center text-[12px] text-dim">
              {zh ? "还没有已安排任务。右侧创建的任务会在独立后台会话中运行。" : "No scheduled work yet. New tasks run in independent background sessions."}
            </div>
          ) : sorted.map((automation) => (
            <article key={automation.id} className="rounded-[12px] border border-line2 bg-raise/65 p-4">
              <div className="flex items-start gap-3">
                <button
                  onClick={() => setEnabled(automation.id, !automation.enabled)}
                  className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${automation.enabled ? "bg-green" : "bg-faint"}`}
                  title={automation.enabled ? (zh ? "暂停" : "Pause") : (zh ? "启用" : "Enable")}
                />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[13px] font-medium text-fg2">{automation.title}</h2>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-mute">{automation.prompt}</p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9.5px] text-faint">
                    <span>{scheduleLabel(automation.frequency, automation.time, automation.weekday, zh)}</span>
                    <span>{automation.enabled ? `${zh ? "下次" : "Next"} ${new Date(automation.nextRunAt).toLocaleString()}` : (zh ? "已暂停" : "Paused")}</span>
                    {automation.lastSessionId && <span>{zh ? "会话" : "Session"} {automation.lastSessionId.slice(0, 8)}</span>}
                  </div>
                  {automation.lastError && <p className="mt-2 text-[10px] text-red">{automation.lastError}</p>}
                </div>
                <button
                  onClick={() => void run(automation.id)}
                  disabled={Boolean(runningId)}
                  className="flex h-7 items-center gap-1 rounded-full border border-line2 px-2.5 text-[9.5px] text-fg2 hover:border-line3 disabled:opacity-40"
                >
                  <Icon name="play" size={9} />
                  {runningId === automation.id ? (zh ? "启动中" : "Starting") : (zh ? "立即运行" : "Run now")}
                </button>
                <button onClick={() => setDeleteId(automation.id)} className="flex h-7 w-7 items-center justify-center text-faint hover:text-red" title={zh ? "删除" : "Delete"}>
                  <Icon name="trash" size={10} />
                </button>
              </div>
            </article>
          ))}
        </div>

        <aside className="h-fit rounded-[14px] border border-line2 bg-panel/80 p-4">
          <h2 className="text-[13px] font-medium text-fg2">{zh ? "创建自动化" : "Create automation"}</h2>
          <label className="mt-4 block text-[10px] text-dim">{zh ? "标题" : "Title"}</label>
          <input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 h-9 w-full rounded-[6px] border border-line2 bg-base px-3 text-[12px] text-fg outline-none focus:border-acc/50" />
          <label className="mt-3 block text-[10px] text-dim">{zh ? "指令" : "Prompt"}</label>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} className="mt-1 w-full resize-y rounded-[6px] border border-line2 bg-base px-3 py-2 text-[12px] leading-relaxed text-fg outline-none focus:border-acc/50" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <select value={frequency} onChange={(event) => setFrequency(event.target.value as AutomationFrequency)} className="h-9 rounded-[6px] border border-line2 bg-base px-2 text-[11px] text-fg2">
              <option value="once">{zh ? "仅一次" : "Once"}</option>
              <option value="daily">{zh ? "每天" : "Daily"}</option>
              <option value="weekdays">{zh ? "工作日" : "Weekdays"}</option>
              <option value="weekly">{zh ? "每周" : "Weekly"}</option>
            </select>
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="h-9 rounded-[6px] border border-line2 bg-base px-2 text-[11px] text-fg2" />
          </div>
          {frequency === "weekly" && (
            <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} className="mt-2 h-9 w-full rounded-[6px] border border-line2 bg-base px-2 text-[11px] text-fg2">
              {(zh ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]).map((label, index) => <option key={label} value={index}>{label}</option>)}
            </select>
          )}
          <p className="mt-3 truncate font-mono text-[9.5px] text-faint" title={workspace}>{workspace}</p>
          <button onClick={create} disabled={!title.trim() || !prompt.trim()} className="mt-4 h-9 w-full rounded-full bg-acc text-[11px] font-medium text-base hover:bg-acc-deep disabled:opacity-40">
            {zh ? "创建并启用" : "Create and enable"}
          </button>
        </aside>
      </section> : (
        <section className="min-h-[260px] rounded-[14px] border border-line2 bg-panel/65">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <h2 className="text-[12px] font-medium text-fg2">{zh ? "最近 50 次启动尝试" : "Latest 50 launch attempts"}</h2>
              <p className="mt-1 text-[9.5px] text-faint">
                {zh ? "“已启动”表示已交给当前 Agent 运行时，不代表任务已完成。" : "Started means handed to the current Agent runtime; it does not mean completed."}
              </p>
            </div>
            {runHistory.length > 0 && (
              <button onClick={() => setClearHistoryConfirm(true)} className="font-mono text-[9px] text-faint hover:text-red">
                {zh ? "清空记录" : "Clear history"}
              </button>
            )}
          </div>
          {runHistory.length === 0 ? (
            <div className="flex min-h-[210px] items-center justify-center px-6 text-center text-[11px] leading-relaxed text-dim">
              {zh ? "还没有运行记录。定时触发和“立即运行”都会在这里留下本机可见的结果。" : "No runs yet. Scheduled and Run now attempts will leave a locally observed result here."}
            </div>
          ) : (
            <div className="divide-y divide-line">
              {runHistory.map((record) => {
                const visual = runOutcomeVisual(record.outcome, zh);
                return (
                  <article key={record.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[108px_minmax(0,1fr)_auto] sm:items-start">
                    <div>
                      <span className={`inline-flex rounded-full border px-2 py-1 font-mono text-[8.5px] ${visual.className}`}>{visual.label}</span>
                      <p className="mt-1.5 font-mono text-[8.5px] text-faint">{record.source === "scheduled" ? (zh ? "定时" : "Scheduled") : (zh ? "手动" : "Run now")}</p>
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-[11.5px] font-medium text-fg2">{record.title}</h3>
                      <p className="mt-1 font-mono text-[9px] text-faint">{new Date(record.at).toLocaleString()}</p>
                      {record.detail && <p className="mt-1.5 text-[10px] leading-relaxed text-mute">{record.detail}</p>}
                    </div>
                    {record.sessionId && (
                      <button onClick={() => void openSession(record.sessionId!)} className="rounded-full border border-line2 px-2.5 py-1.5 font-mono text-[9px] text-fg2 hover:border-line3 hover:text-fg">
                        {zh ? "打开会话" : "Open session"}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {deleteId && (
        <ConfirmDialog
          title={zh ? "删除自动化？" : "Delete automation?"}
          description={zh ? "任务及其排程会被删除，已经生成的会话仍会保留。" : "The schedule will be removed; previously created sessions remain."}
          confirmLabel={zh ? "删除" : "Delete"}
          cancelLabel={zh ? "取消" : "Cancel"}
          workingLabel={zh ? "删除中" : "Deleting"}
          onCancel={() => setDeleteId(null)}
          onConfirm={async () => { remove(deleteId); setDeleteId(null); }}
        />
      )}
      {clearHistoryConfirm && (
        <ConfirmDialog
          title={zh ? "清空运行记录？" : "Clear run history?"}
          description={zh ? "只删除本机可见的自动化运行记录，不会删除任务或已生成的会话。" : "This only removes locally visible run records. Tasks and generated sessions remain."}
          confirmLabel={zh ? "清空" : "Clear"}
          cancelLabel={zh ? "取消" : "Cancel"}
          workingLabel={zh ? "清空中" : "Clearing"}
          onCancel={() => setClearHistoryConfirm(false)}
          onConfirm={async () => { clearRunHistory(); setClearHistoryConfirm(false); }}
        />
      )}
    </div>
  );
}

function runOutcomeVisual(outcome: AutomationRunOutcome, zh: boolean) {
  const values: Record<AutomationRunOutcome, { label: string; className: string }> = {
    starting: { label: zh ? "启动中" : "Starting", className: "border-acc/25 bg-acc/5 text-acc" },
    started: { label: zh ? "已启动" : "Started", className: "border-green/25 bg-green/5 text-green" },
    completed: { label: zh ? "已完成" : "Completed", className: "border-green/25 bg-green/5 text-green" },
    skipped: { label: zh ? "已跳过" : "Skipped", className: "border-gold/25 bg-gold/5 text-gold" },
    error: { label: zh ? "错误" : "Error", className: "border-red/25 bg-red/5 text-red" },
    unknown: { label: zh ? "结果未知" : "Unknown", className: "border-line3 bg-high text-dim" },
  };
  return values[outcome];
}

function scheduleLabel(frequency: AutomationFrequency, time: string, weekday: number | undefined, zh: boolean) {
  if (frequency === "once") return `${zh ? "仅一次" : "Once"} · ${time}`;
  if (frequency === "daily") return `${zh ? "每天" : "Daily"} · ${time}`;
  if (frequency === "weekdays") return `${zh ? "工作日" : "Weekdays"} · ${time}`;
  const labels = zh ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${zh ? "每周" : "Weekly"} ${labels[weekday ?? 0]} · ${time}`;
}
