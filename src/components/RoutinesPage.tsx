import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Copy, Pencil, Play, Plus, Trash2, Webhook, XCircle,
} from "lucide-react";
import { useApp } from "@/state/store";
import type { Routine, Webhook as WebhookTrigger } from "@/lib/bridge";
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
  const [continuity, setContinuity] = useState(false);
  const [checkRuns, setCheckRuns] = useState(false);
  const [overlap, setOverlap] = useState<"skip" | "queue">("skip");
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
    setContinuity(Boolean(routine?.continuity));
    setCheckRuns(Boolean(routine?.checks?.includes("runs")));
    setOverlap(routine?.overlap === "queue" ? "queue" : "skip");
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
      await updateRoutine(routine.id, { name: name.trim(), prompt: prompt.trim(), cadence, timeOfDay, weekday, continuity, checks: checkRuns ? ["runs"] : [], overlap, enabled });
    } else {
      await createRoutine({ botId, name: name.trim(), prompt: prompt.trim(), cadence, timeOfDay, weekday, continuity, checks: checkRuns ? ["runs"] : [], overlap, enabled });
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
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">Keep one thread</span>
            <span className="row-sub">Continue the previous routine thread instead of creating a fresh task each run.</span>
          </span>
          <Switch checked={continuity} label="Keep one routine thread" onChange={setContinuity} />
        </div>
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">Only when there is news</span>
            <span className="row-sub">Check other routines' finished runs first; skip the turn when nothing new finished.</span>
          </span>
          <Switch checked={checkRuns} label="Check routine runs" onChange={setCheckRuns} />
        </div>
        <div className="panel-field">
          <span>While busy</span>
          <Segmented
            label="While busy"
            value={overlap}
            options={[{ value: "skip", label: "Skip this run" }, { value: "queue", label: "Retry shortly" }]}
            onChange={setOverlap}
          />
        </div>
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

function WebhookEditor({ hook, open, onClose, onSaved }: {
  hook: WebhookTrigger | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { state, backend, toast } = useApp();
  const [botId, setBotId] = useState(hook?.botId ?? state.bots[0]?.id ?? "");
  const [name, setName] = useState(hook?.name ?? "");
  const [prompt, setPrompt] = useState(hook?.prompt ?? "");
  const [enabled, setEnabled] = useState(hook?.enabled ?? true);
  const [requireSignature, setRequireSignature] = useState(hook?.requireSignature ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setBotId(hook?.botId ?? state.bots[0]?.id ?? "");
    setName(hook?.name ?? "");
    setPrompt(hook?.prompt ?? "");
    setEnabled(hook?.enabled ?? true);
    setRequireSignature(hook?.requireSignature ?? false);
    setError("");
    setBusy(false);
  }, [open, hook?.id]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !botId) {
      setError("A webhook needs a bot and a name.");
      return;
    }
    setBusy(true);
    try {
      if (hook) {
        await backend.updateWebhook(hook.id, { name: name.trim(), prompt: prompt.trim(), enabled, requireSignature });
      } else {
        await backend.createWebhook({ botId, name: name.trim(), prompt: prompt.trim(), enabled, requireSignature });
      }
      onSaved();
      onClose();
      toast({ kind: "success", title: hook ? "Webhook updated" : "Webhook created" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the webhook.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={hook ? "Edit webhook" : "New webhook"} width={620}>
      <form className="routine-form" onSubmit={submit}>
        <div className="form-two">
          <label className="panel-field">
            <span>Bot</span>
            <select value={botId} onChange={(event) => setBotId(event.target.value)} disabled={Boolean(hook)}>
              {state.bots.filter((bot) => !bot.archived).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </label>
          <label className="panel-field">
            <span>Name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Deploy finished" />
          </label>
        </div>
        <label className="panel-field">
          <span>Instruction</span>
          <textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the bot do with the incoming payload?" />
        </label>
        <div className="switch-row">
          <span className="row-copy"><span className="row-title">Enabled</span><span className="row-sub">A disabled trigger keeps its URL but rejects requests.</span></span>
          <Switch checked={enabled} label="Enable webhook" onChange={setEnabled} />
        </div>
        <div className="switch-row">
          <span className="row-copy"><span className="row-title">Require HMAC signature</span><span className="row-sub">Use the URL token as the signing key and send X-Grox-Timestamp and X-Grox-Signature.</span></span>
          <Switch checked={requireSignature} label="Require HMAC signature" onChange={setRequireSignature} />
        </div>
        <p className="panel-note">The endpoint receives one JSON or text payload, creates a task conversation, and starts the bot. The token in the URL is the capability; treat the URL as a password.</p>
        {error && <p className="panel-note is-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : hook ? "Save webhook" : "Create webhook"}</button>
        </div>
      </form>
    </Modal>
  );
}

function WebhooksPanel() {
  const { backend, state, toast, requestConfirm } = useApp();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof backend.getWebhookInfo>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookTrigger | undefined>();
  const [replaying, setReplaying] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      setInfo(await backend.getWebhookInfo());
    } catch (cause) {
      toast({ kind: "error", title: "Could not read webhooks", body: cause instanceof Error ? cause.message : "Try again." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const botName = (id: string) => state.bots.find((bot) => bot.id === id)?.name ?? "Bot";
  const endpointFor = (hook: WebhookTrigger) => info?.baseUrl ? info.baseUrl + "/hooks/" + hook.token : "";

  const copy = (hook: WebhookTrigger) => {
    const endpoint = endpointFor(hook);
    if (!endpoint) return;
    void navigator.clipboard?.writeText(endpoint);
    toast({ kind: "success", title: "Webhook URL copied" });
  };

  const toggle = async (hook: WebhookTrigger, enabled: boolean) => {
    try {
      await backend.updateWebhook(hook.id, { enabled });
      await load();
    } catch (cause) {
      toast({ kind: "error", title: "Webhook not updated", body: cause instanceof Error ? cause.message : "Try again." });
    }
  };

  const replay = async (deliveryId: string) => {
    setReplaying(deliveryId);
    try {
      await backend.replayWebhookDelivery(deliveryId);
      await load();
      toast({ kind: "success", title: "Webhook replayed", body: "A fresh task was started from the retained payload." });
    } catch (cause) {
      toast({ kind: "error", title: "Could not replay", body: cause instanceof Error ? cause.message : "Try again." });
    } finally {
      setReplaying("");
    }
  };

  const remove = (hook: WebhookTrigger) => {
    requestConfirm({
      title: "Delete webhook?",
      body: hook.name + " will stop accepting requests. Its URL token becomes invalid.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        void backend.deleteWebhook(hook.id).then(load).catch((cause: unknown) => {
          toast({ kind: "error", title: "Webhook not deleted", body: cause instanceof Error ? cause.message : "Try again." });
        });
      },
    });
  };

  return (
    <div className="webhook-panel">
      <div className="webhook-panel-head">
        <div>
          <h3>Inbound webhooks</h3>
          <p>Wake a bot from a local script or an outside service. Requests are accepted only on the loopback receiver.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => { setEditing(undefined); setEditorOpen(true); }} disabled={!info?.baseUrl}>
          <Plus size={14} /> New webhook
        </button>
      </div>
      {info?.baseUrl && <code className="webhook-base">{info.baseUrl}</code>}
      {info?.error && <p className="panel-note is-warning">{info.error}</p>}
      {loading ? (
        <p className="panel-note">Reading webhook receiver…</p>
      ) : info && info.items.length === 0 ? (
        <div className="webhook-empty">
          <Webhook size={22} />
          <h3>No inbound webhooks</h3>
          <p>Create one to get a local URL with a private capability token.</p>
        </div>
      ) : (
        <div className="webhook-list">
          {info?.items.map((hook) => (
            <section key={hook.id} className={cn("webhook-card", hook.enabled && "is-enabled")}>
              <div className="webhook-card-head">
                <span className="webhook-icon"><Webhook size={16} /></span>
                <div className="webhook-title">
                  <strong>{hook.name}</strong>
                  <span>{botName(hook.botId)} · {hook.eventCount} event{hook.eventCount === 1 ? "" : "s"}</span>
                </div>
                <Switch checked={hook.enabled} label={"Enable " + hook.name} onChange={(value) => void toggle(hook, value)} />
              </div>
              <div className="webhook-endpoint">
                <code title={endpointFor(hook)}>{endpointFor(hook) || "Receiver unavailable"}</code>
                <button type="button" className="icon-button" aria-label="Copy webhook URL" onClick={() => copy(hook)} disabled={!endpointFor(hook)}><Copy size={13} /></button>
              </div>
              <p className="webhook-prompt">{hook.prompt || "Uses the request body as the task."}</p>
              <div className="webhook-meta">
                <span>{hook.lastEventAt ? "Last event " + relative(hook.lastEventAt) : "No events yet"} · {hook.requireSignature ? "signed" : "token only"}</span>
                <div className="webhook-actions">
                  <button type="button" className="link-button" onClick={() => { setEditing(hook); setEditorOpen(true); }}><Pencil size={11} /> Edit</button>
                  <button type="button" className="link-button is-danger" onClick={() => remove(hook)}><Trash2 size={11} /> Delete</button>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
      {info && (info.deliveries?.length ?? 0) > 0 && (
        <section className="webhook-deliveries">
          <div className="panel-card-title"><span>Recent deliveries</span><span className="avatar-seed">{info.deliveries?.length}</span></div>
          {info.deliveries?.map((delivery) => (
            <div key={delivery.id} className="webhook-delivery">
              <div className="webhook-delivery-copy">
                <strong>{delivery.webhookName}</strong>
                <span>{relative(delivery.at)} · {delivery.status}{delivery.error ? " · " + delivery.error : ""}</span>
              </div>
              <button type="button" className="link-button" onClick={() => void replay(delivery.id)} disabled={replaying === delivery.id}>
                {replaying === delivery.id ? "Replaying…" : "Replay"}
              </button>
            </div>
          ))}
        </section>
      )}
      <WebhookEditor hook={editing} open={editorOpen} onClose={() => setEditorOpen(false)} onSaved={() => void load()} />
    </div>
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
          {tab === "routines" && (
            <button type="button" className="btn btn-secondary" onClick={() => setUI({ newRoutineOpen: true, editingRoutineId: null })}>
              <Plus size={15} /> New routine
            </button>
          )}
        </div>
      </header>

      <div className="page-scroll">
        <div className="routines-toolbar">
          <div className="tab-row">
            <button type="button" className={cn("tab", tab === "routines" && "is-active")} onClick={() => setTab("routines")}><CalendarDays size={14} /> Routines</button>
            <button type="button" className={cn("tab", tab === "webhooks" && "is-active")} onClick={() => setTab("webhooks")}><Webhook size={14} /> Webhooks</button>
          </div>
          {tab === "routines" && <div className="toolbar-right">
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
          </div>}
        </div>

        {tab === "webhooks" ? (
          <WebhooksPanel />
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
