import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Play, Plus, Trash2, Webhook, XCircle,
} from "lucide-react";
import { useApp } from "@/state/store";
import type { Routine } from "@/lib/bridge";
import { Mascot } from "@/components/Mascot";
import { Modal, Segmented, Switch } from "@/components/ui";
import { cn } from "@/lib/cn";
import { relative, shortDate, weekdayShort } from "@/lib/format";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function startOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - day);
  return copy;
}

function addDays(date: Date, amount: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function occursOn(routine: Routine, day: Date): boolean {
  if (!routine.enabled) return false;
  const weekday = ((day.getDay() + 6) % 7) + 1;
  switch (routine.cadence) {
    case "weekdays":
      return weekday <= 5;
    case "weekly":
      return routine.weekday === weekday;
    default:
      return true;
  }
}

function timeLabel(value: string): string {
  const [hours, minutes] = (value || "09:00").split(":").map(Number);
  const date = new Date();
  date.setHours(Number.isFinite(hours) ? hours! : 9, Number.isFinite(minutes) ? minutes! : 0, 0, 0);
  return date.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
}

function scheduleCopy(routine: Routine): string {
  switch (routine.cadence) {
    case "hourly": return "Every hour";
    case "weekdays": return "Weekdays · " + timeLabel(routine.timeOfDay);
    case "weekly": return DAY_NAMES[(routine.weekday || 1) - 1] + " · " + timeLabel(routine.timeOfDay);
    default: return "Daily · " + timeLabel(routine.timeOfDay);
  }
}

function RoutineEditor({ routine, open, onClose }: { routine: Routine | undefined; open: boolean; onClose: () => void }) {
  const { activeBot, state, createRoutine, updateRoutine, deleteRoutine, runRoutine } = useApp();
  const [botId, setBotId] = useState(activeBot?.id ?? state.bots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekdays" | "weekly" | "hourly">("weekdays");
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setBotId(routine?.botId ?? activeBot?.id ?? state.bots[0]?.id ?? "");
    setName(routine?.name ?? "");
    setPrompt(routine?.prompt ?? "");
    setCadence((routine?.cadence as typeof cadence) ?? "weekdays");
    setTimeOfDay(routine?.timeOfDay ?? "09:00");
    setWeekday(routine?.weekday || 1);
    setEnabled(routine?.enabled ?? true);
    setError("");
    setBusy(false);
  }, [open, routine?.id]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !prompt.trim() || !botId) {
      setError("A routine needs a bot, a name, and a prompt.");
      return;
    }
    setBusy(true);
    if (routine) {
      await updateRoutine(routine.id, { name: name.trim(), prompt: prompt.trim(), cadence, timeOfDay, weekday, enabled });
    } else {
      await createRoutine({ botId, name: name.trim(), prompt: prompt.trim(), cadence, timeOfDay, weekday, enabled });
    }
    setBusy(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={routine ? "Edit routine" : "New routine"} width={620}>
      <form className="routine-form" onSubmit={submit}>
        <div className="form-two">
          <label className="panel-field">
            <span>Bot</span>
            <select value={botId} onChange={(event) => setBotId(event.target.value)}>
              {state.bots.filter((bot) => !bot.archived).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </label>
          <label className="panel-field">
            <span>Name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning research brief" />
          </label>
        </div>
        <label className="panel-field">
          <span>Prompt</span>
          <textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What should this bot do each time? Write it as if you were sending a message." />
        </label>
        <div className="panel-field">
          <span>Schedule</span>
          <Segmented
            label="Cadence"
            value={cadence}
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekdays", label: "Weekdays" },
              { value: "weekly", label: "Weekly" },
              { value: "hourly", label: "Hourly" },
            ]}
            onChange={setCadence}
          />
        </div>
        {cadence !== "hourly" && (
          <div className="form-two">
            <label className="panel-field">
              <span>Time</span>
              <input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} />
            </label>
            {cadence === "weekly" && (
              <label className="panel-field">
                <span>Day</span>
                <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
                  {DAY_NAMES.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
        <div className="switch-row routine-enabled">
          <span className="row-copy">
            <span className="row-title">Enabled</span>
            <span className="row-sub">Runs create a fresh task with this prompt.</span>
          </span>
          <Switch checked={enabled} label="Enabled" onChange={setEnabled} />
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions split">
          <div>
            {routine && (
              <button type="button" className="btn btn-ghost danger-text" onClick={() => { void deleteRoutine(routine.id); onClose(); }}>
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>
          <div className="action-cluster">
            {routine && (
              <button type="button" className="btn btn-secondary" onClick={() => { void runRoutine(routine.id); onClose(); }}>
                <Play size={14} /> Run now
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save routine"}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function RoutinesPage() {
  const { state, ui, setUI, runRoutine, updateRoutine, openThread } = useApp();
  const [view, setView] = useState<"day" | "3day" | "week">("week");
  const [anchor, setAnchor] = useState(new Date());
  const [tab, setTab] = useState<"routines" | "webhooks">("routines");
  const [botFilter, setBotFilter] = useState("all");
  const [recentOnly, setRecentOnly] = useState(false);

  const days = useMemo(() => {
    if (view === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
    if (view === "3day") return Array.from({ length: 3 }, (_, index) => addDays(anchor, index));
    const start = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [anchor, view]);

  const routines = useMemo(
    () => state.routines.filter((routine) => botFilter === "all" || routine.botId === botFilter),
    [state.routines, botFilter],
  );

  const runs = useMemo(() => {
    const list = state.runs.filter((run) => botFilter === "all" || run.botId === botFilter);
    return [...list].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, recentOnly ? 4 : 6);
  }, [state.runs, botFilter, recentOnly]);

  const editing = ui.editingRoutineId ? state.routines.find((routine) => routine.id === ui.editingRoutineId) : undefined;
  const editorOpen = ui.newRoutineOpen || Boolean(ui.editingRoutineId);
  const closeEditor = () => setUI({ newRoutineOpen: false, editingRoutineId: null });

  const shift = (direction: number) => {
    const next = new Date(anchor);
    if (view === "week") next.setDate(next.getDate() + 7 * direction);
    else if (view === "3day") next.setDate(next.getDate() + 3 * direction);
    else next.setDate(next.getDate() + direction);
    setAnchor(next);
  };

  const label = view === "day"
    ? anchor.toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric" })
    : days[0]!.toLocaleDateString("en", { month: "long", day: "numeric" }) + " – " + days[days.length - 1]!.toLocaleDateString("en", { month: "long", day: "numeric" });

  const botName = (id: string) => state.bots.find((bot) => bot.id === id)?.name ?? "Bot";
  const botColor = (id: string) => state.bots.find((bot) => bot.id === id)?.color ?? "green";

  return (
    <section className="routines-page">
      <header className="page-head drag-region">
        <div className="page-head-copy no-drag">
          <div className="page-title"><CalendarDays size={20} /> Tasks &amp; routines</div>
          <p>Routines start fresh agent tasks on a schedule. Every run is its own conversation.</p>
        </div>
        <div className="page-head-actions no-drag">
          <button type="button" className="btn btn-secondary" onClick={() => setUI({ newRoutineOpen: true, editingRoutineId: null })}>
            <Plus size={15} /> New routine
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="routines-toolbar">
          <div className="tab-row">
            <button type="button" className={cn("tab", tab === "routines" && "is-active")} onClick={() => setTab("routines")}><CalendarDays size={14} /> Routines</button>
            <button type="button" className={cn("tab", tab === "webhooks" && "is-active")} onClick={() => setTab("webhooks")}><Webhook size={14} /> Webhooks</button>
          </div>
          <div className="toolbar-right">
            <label className="toolbar-select">
              <select value={botFilter} onChange={(event) => setBotFilter(event.target.value)} aria-label="Filter by bot">
                <option value="all">All bots</option>
                {state.bots.filter((bot) => !bot.archived).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
            </label>
            <Segmented
              label="Calendar range"
              size="sm"
              value={view}
              options={[{ value: "day", label: "Day" }, { value: "3day", label: "3 days" }, { value: "week", label: "Week" }]}
              onChange={setView}
            />
          </div>
        </div>

        {tab === "webhooks" ? (
          <div className="webhook-empty">
            <Webhook size={22} />
            <h3>Webhooks are not in this build</h3>
            <p>A webhook would let an outside service wake a bot with a signed request. This surface is intentionally empty rather than simulated.</p>
          </div>
        ) : (
          <>
            <div className="calendar-bar">
              <div className="calendar-nav">
                <button type="button" className="icon-button" aria-label="Previous" onClick={() => shift(-1)}><ChevronLeft size={16} /></button>
                <button type="button" className="btn btn-ghost" onClick={() => setAnchor(new Date())}>Today</button>
                <button type="button" className="icon-button" aria-label="Next" onClick={() => shift(1)}><ChevronRight size={16} /></button>
                <span className="calendar-label">{label}</span>
              </div>
              <div className="calendar-legend">
                <span><span className="legend-dot is-on" /> Enabled</span>
                <span><span className="legend-dot" /> Paused</span>
              </div>
            </div>

            <div className={cn("calendar-grid", "is-" + view)}>
              {routines.length === 0 ? (
                <div className="calendar-empty">
                  <Mascot seed="Grox" size={60} />
                  <h3>Put your team on a rhythm</h3>
                  <p>Plan research briefs, daily check-ins, recurring reviews, or one-time work. Every run becomes a separate task with its own result.</p>
                  <button type="button" className="btn btn-primary" onClick={() => setUI({ newRoutineOpen: true, editingRoutineId: null })}><Plus size={15} /> Create your first routine</button>
                </div>
              ) : (
                days.map((day) => {
                  const today = sameDay(day, new Date());
                  const dayRoutines = routines
                    .filter((routine) => occursOn(routine, day))
                    .sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay));
                  return (
                    <div key={day.toISOString()} className={cn("calendar-day", today && "is-today")}>
                      <div className="calendar-day-head">
                        <span>{weekdayShort(day)}</span>
                        <span className={cn("calendar-date", today && "is-today")}>{day.getDate()}</span>
                      </div>
                      <div className="calendar-day-body">
                        {dayRoutines.map((routine) => (
                          <button
                            key={routine.id + day.toDateString()}
                            type="button"
                            className={cn("routine-chip", !routine.enabled && "is-paused")}
                            onClick={() => setUI({ editingRoutineId: routine.id, newRoutineOpen: false })}
                          >
                            <span className="routine-chip-time">{routine.cadence === "hourly" ? "Hourly" : timeLabel(routine.timeOfDay)}</span>
                            <span className="routine-chip-name"><span className="routine-dot" style={{ background: "var(--identity-" + botColor(routine.botId) + ")" }} />{routine.name}</span>
                            <span className="routine-chip-bot">{botName(routine.botId)}</span>
                          </button>
                        ))}
                        {dayRoutines.length === 0 && <span className="calendar-day-empty">No runs</span>}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="routines-lower">
              <section className="routines-list-card">
                <div className="list-card-head">
                  <div>
                    <h3>All routines</h3>
                    <p>Each schedule sends one prompt to one bot.</p>
                  </div>
                </div>
                {routines.length === 0 ? (
                  <p className="panel-empty-line">No routines yet.</p>
                ) : routines.map((routine) => (
                  <div className="routine-list-row" key={routine.id}>
                    <span className={cn("routine-dot", routine.enabled && "is-on")} style={routine.enabled ? { background: "var(--identity-" + botColor(routine.botId) + ")" } : undefined} />
                    <button type="button" className="routine-list-main" onClick={() => setUI({ editingRoutineId: routine.id, newRoutineOpen: false })}>
                      <span className="routine-list-title">{routine.name}</span>
                      <span className="routine-list-sub">{botName(routine.botId)} · {scheduleCopy(routine)} · next {relative(routine.nextRun)}</span>
                    </button>
                    <button type="button" className="icon-button" aria-label={"Run " + routine.name + " now"} title="Run now" onClick={() => void runRoutine(routine.id)}><Play size={14} /></button>
                    <Switch checked={routine.enabled} label={"Enable " + routine.name} onChange={(enabled) => void updateRoutine(routine.id, { enabled })} />
                  </div>
                ))}
              </section>

              <section className="routines-list-card runs-card">
                <div className="list-card-head">
                  <div>
                    <h3>Recent runs</h3>
                    <p>Each run is a task conversation you can open.</p>
                  </div>
                  <button type="button" className="link-button" onClick={() => setRecentOnly((value) => !value)}>{recentOnly ? "Show more" : "Show less"}</button>
                </div>
                {runs.length === 0 ? (
                  <p className="panel-empty-line">Nothing has run yet.</p>
                ) : runs.map((run) => {
                  const failed = run.status === "failed";
                  return (
                    <button type="button" className="run-row" key={run.id} onClick={() => { setUI({ view: "chat", panel: null }); openThread(run.botId, run.threadId); }}>
                      {failed ? <XCircle size={15} className="run-icon error" /> : <CheckCircle2 size={15} className="run-icon ok" />}
                      <span className="run-copy">
                        <span className="run-title">{run.title}</span>
                        <span className="run-sub">{run.summary || "Completed"} · {shortDate(run.startedAt)}</span>
                      </span>
                      <span className={cn("run-status", failed && "is-error")}>{failed ? "Failed" : "Completed"}</span>
                    </button>
                  );
                })}
              </section>
            </div>
          </>
        )}
      </div>

      <RoutineEditor routine={editing} open={editorOpen} onClose={closeEditor} />
    </section>
  );
}
