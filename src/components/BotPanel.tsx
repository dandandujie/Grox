import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity as ActivityIcon, ChevronLeft, ChevronRight, Clock3, FolderOpen, ImagePlus,
  Laptop, Moon, Play, Plus, ShieldCheck, Sparkles, Trash2, X,
} from "lucide-react";
import { useApp } from "@/state/store";
import type { Bot, BotPatch, Model } from "@/lib/bridge";
import { Mascot } from "@/components/Mascot";
import { currentModel } from "@/components/ModelPicker";
import { ProviderMark } from "@/components/Icons";
import { IconButton, Segmented, Switch } from "@/components/ui";
import { cn } from "@/lib/cn";
import { COLOR_NAMES, EXPRESSIONS, EXPRESSION_NAMES, MAUS_COLORS, swatch } from "@/lib/mascot";
import { clock, relative, sidebarTime } from "@/lib/format";

function useBotDrafts(bot: Bot) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [soul, setSoul] = useState(bot.soul);
  const [folder, setFolder] = useState(bot.workingDir ?? "");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(bot.name);
    setTitle(bot.title);
    setDescription(bot.description);
    setSoul(bot.soul);
    setFolder(bot.workingDir ?? "");
  }, [bot.id]);
  return {
    name, setName, title, setTitle, description, setDescription, soul, setSoul, folder, setFolder, saved, setSaved,
  };
}

function AvatarCard({ bot }: { bot: Bot }) {
  const { updateBot, toast } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const shapes = [
    { value: "cursor", label: "Mascot" },
    { value: "blob", label: "Blob" },
    { value: "circle", label: "Circle" },
    { value: "rounded", label: "Rounded" },
    { value: "square", label: "Square" },
  ] as const;

  const upload = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      toast({ kind: "error", title: "That image is too large", body: "Use an image under 4 MB." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      void updateBot(bot.id, { avatarUrl: String(reader.result) });
      toast({ kind: "success", title: "Avatar updated" });
    };
    reader.readAsDataURL(file);
  };

  return (
    <section className="avatar-card">
      <div className="avatar-card-head">
        <span>Avatar</span>
        <button
          type="button"
          className="link-button"
          onClick={() => void updateBot(bot.id, { avatarUrl: "", mascotShape: "cursor", expression: "idle" })}
        >
          Reset mascot
        </button>
      </div>
      <button type="button" className="avatar-hero" onClick={() => inputRef.current?.click()} title="Upload an image">
        <Mascot
          color={bot.color}
          shape={bot.mascotShape}
          expression={bot.expression}
          size={116}
          avatarUrl={bot.avatarUrl}
          title={bot.name}
        />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        onChange={(event) => upload(event.target.files?.[0])}
      />
      <button type="button" className="upload-button" onClick={() => inputRef.current?.click()}>
        <ImagePlus size={15} /> Upload image
      </button>
      <p className="avatar-hint">PNG, JPEG, GIF, or WebP · up to 4 MB</p>

      <div className="avatar-section-label">Shape</div>
      <Segmented
        label="Mascot shape"
        value={bot.mascotShape || "cursor"}
        options={shapes.map((shape) => ({ value: shape.value, label: shape.label }))}
        onChange={(shape) => void updateBot(bot.id, { mascotShape: shape })}
        size="sm"
      />

      <div className="avatar-section-label">Expression</div>
      <div className="expression-grid" role="group" aria-label="Expression">
        {EXPRESSIONS.map((expression) => (
          <button
            key={expression}
            type="button"
            className={cn("expression-button", bot.expression === expression && "is-selected")}
            title={EXPRESSION_NAMES[expression]}
            aria-label={EXPRESSION_NAMES[expression]}
            onClick={() => void updateBot(bot.id, { expression })}
          >
            <Mascot color={bot.color} shape={bot.mascotShape} expression={expression} size={34} avatarUrl={bot.avatarUrl} />
          </button>
        ))}
      </div>

      <div className="avatar-section-label">Color</div>
      <div className="color-grid" role="group" aria-label="Mascot color">
        {Object.keys(MAUS_COLORS).map((color) => (
          <button
            key={color}
            type="button"
            title={COLOR_NAMES[color]}
            aria-label={COLOR_NAMES[color]}
            aria-pressed={bot.color === color}
            className={cn("color-swatch", bot.color === color && "is-selected")}
            style={{ background: swatch(color) }}
            onClick={() => void updateBot(bot.id, { color })}
          />
        ))}
      </div>
    </section>
  );
}

function ProfileTab({ bot }: { bot: Bot }) {
  const { updateBot, providers, setUI, apps, deleteBot, state, runRoutine } = useApp();
  const drafts = useBotDrafts(bot);
  const model: Model | undefined = currentModel(providers, bot.modelId);
  const connectedApps = apps.filter((app) => app.connected);
  const botRoutines = state.routines.filter((routine) => routine.botId === bot.id);

  const commitText = () => {
    const patch: BotPatch = {};
    if (drafts.name !== bot.name) patch.name = drafts.name.trim() || bot.name;
    if (drafts.title !== bot.title) patch.title = drafts.title;
    if (drafts.description !== bot.description) patch.description = drafts.description;
    if (drafts.soul !== bot.soul) patch.soul = drafts.soul;
    if (drafts.folder !== (bot.workingDir ?? "")) patch.workingDir = drafts.folder;
    if (Object.keys(patch).length) {
      void updateBot(bot.id, patch);
      drafts.setSaved(true);
      setTimeout(() => drafts.setSaved(false), 1400);
    }
  };

  return (
    <div className="panel-body">
      <AvatarCard bot={bot} />

      <section className="panel-card">
        <label className="panel-field">
          <span>Name</span>
          <input
            value={drafts.name}
            onChange={(event) => drafts.setName(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
            placeholder="Bot name"
          />
        </label>
        <label className="panel-field">
          <span>Role</span>
          <input
            value={drafts.title}
            onChange={(event) => drafts.setTitle(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
            placeholder="Research & data"
          />
        </label>
        <label className="panel-field">
          <span>What it does</span>
          <textarea
            rows={2}
            value={drafts.description}
            onChange={(event) => drafts.setDescription(event.target.value)}
            onBlur={commitText}
            placeholder="A short description for this bot"
          />
        </label>
        <label className="panel-field">
          <span>Instructions</span>
          <textarea
            rows={5}
            value={drafts.soul}
            onChange={(event) => drafts.setSoul(event.target.value)}
            onBlur={commitText}
            placeholder={"How should " + bot.name + " think and speak?"}
          />
        </label>
        <div className="panel-field-foot">
          <span className="save-note">{drafts.saved ? "Saved" : "Changes save when you leave a field"}</span>
        </div>
      </section>

      <section className="panel-card">
        <button type="button" className="row-button" onClick={() => setUI({ modelPickerOpen: true })}>
          <span className="row-icon"><Sparkles size={16} /></span>
          <span className="row-copy">
            <span className="row-title">Model</span>
            <span className="row-sub"><ProviderMark provider={model?.provider ?? "local"} size={12} /> {model?.name ?? bot.modelId}</span>
          </span>
          <ChevronRight size={15} className="row-chevron" />
        </button>
        <div className="row-divider" />
        <div className="panel-col">
          <div className="row-copy">
            <span className="row-title">Before it acts</span>
            <span className="row-sub">Approvals for commands, files, and external services.</span>
          </div>
          <Segmented
            label="Approval mode"
            value={(bot.approval as "ask" | "auto" | "full") || "ask"}
            options={[
              { value: "ask", label: "Ask" },
              { value: "auto", label: "Auto" },
              { value: "full", label: "Full" },
            ]}
            onChange={(approval) => void updateBot(bot.id, { approval })}
          />
        </div>
        <div className="row-divider" />
        <label className="panel-field compact">
          <span>Working folder</span>
          <div className="input-with-icon">
            <FolderOpen size={14} />
            <input
              value={drafts.folder}
              onChange={(event) => drafts.setFolder(event.target.value)}
              onBlur={commitText}
              placeholder="Home folder"
            />
          </div>
        </label>
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">Notifications</span>
            <span className="row-sub">A system notification when this bot finishes a background task.</span>
          </span>
          <Switch checked={bot.notifications} label="Notifications" onChange={(value) => void updateBot(bot.id, { notifications: value })} />
        </div>
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">Read replies aloud</span>
            <span className="row-sub">Use the system voice for new answers.</span>
          </span>
          <Switch checked={bot.speakReplies} label="Read replies aloud" onChange={(value) => void updateBot(bot.id, { speakReplies: value })} />
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-card-title">
          <span>Connected apps</span>
          <button type="button" className="link-button" onClick={() => setUI({ view: "apps", panel: null })}>Manage</button>
        </div>
        {connectedApps.length === 0 ? (
          <p className="panel-empty-line">No apps connected yet. Add one in Connected apps.</p>
        ) : (
          <div className="app-chip-row">
            {connectedApps.map((app) => (
              <span key={app.id} className="app-chip"><span className="app-chip-dot" style={{ background: app.color }} />{app.name}</span>
            ))}
          </div>
        )}
      </section>

      <section className="panel-card">
        <div className="panel-card-title">
          <span>Routines</span>
          <button type="button" className="link-button" onClick={() => setUI({ newRoutineOpen: true, view: "routines", panel: null })}>Create</button>
        </div>
        {botRoutines.length === 0 ? (
          <p className="panel-empty-line">No routines for {bot.name} yet.</p>
        ) : (
          botRoutines.map((routine) => (
            <div key={routine.id} className="mini-routine">
              <span className={cn("routine-dot", routine.enabled && "is-on")} />
              <span className="mini-routine-copy">
                <span>{routine.name}</span>
                <span>{routine.enabled ? relative(routine.nextRun) : "Paused"}</span>
              </span>
              <button type="button" className="icon-button" title="Run now" aria-label="Run now" onClick={() => void runRoutine(routine.id)}>
                <Play size={13} />
              </button>
            </div>
          ))
        )}
      </section>

      <section className="panel-card danger-card">
        <button type="button" className="danger-row" onClick={() => deleteBot(bot.id)}>
          <Trash2 size={15} /> Delete {bot.name}
        </button>
      </section>

      <div className="panel-end">
        <span>{bot.description || "This bot keeps its own memory and model."}</span>
      </div>
    </div>
  );
}

function ComputerTab({ bot }: { bot: Bot }) {
  const { apps, state, setUI, runRoutine, updateRoutine, toast, revealWorkingFolder } = useApp();
  const [mode, setMode] = useState<"cloud" | "mac" | "off">(() => (localStorage.getItem("grox.computer." + bot.id) as "cloud" | "mac" | "off") || "mac");
  const [asleep, setAsleep] = useState(false);
  const routines = state.routines.filter((routine) => routine.botId === bot.id);
  const connectedApps = apps.filter((app) => app.connected);
  const changeMode = (value: "cloud" | "mac" | "off") => {
    if (value === "cloud") {
      toast({ kind: "info", title: "Cloud computers are not in this build", body: "Grox runs each agent on this Mac. The panel is here for the shape of the product." });
      return;
    }
    setMode(value);
    localStorage.setItem("grox.computer." + bot.id, value);
  };
  return (
    <div className="panel-body">
      <section className="computer-card">
        <div className="computer-card-head">
          <span>{bot.name}'s screen</span>
          <span className={cn("computer-live", !asleep && "is-on")}>{asleep ? "Asleep" : "Local"}</span>
        </div>
        <div className={cn("computer-preview", asleep && "is-asleep")}>
          <div className="computer-menubar"><span>Grox</span><span>{new Date().toLocaleDateString("en", { month: "short", day: "numeric" })}</span></div>
          <div className="computer-wallpaper">
            <div className="computer-window">
              <span className="computer-window-bar" />
              <span className="computer-line wide" />
              <span className="computer-line" />
              <span className="computer-line short" />
            </div>
            <Mascot color={bot.color} shape={bot.mascotShape} expression={asleep ? "sleeping" : "working"} size={38} animated={!asleep} />
          </div>
        </div>
        <div className="computer-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void revealWorkingFolder(bot.id)}>
            <Laptop size={14} /> Open folder
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setAsleep((value) => !value)}>
            <Moon size={14} /> {asleep ? "Wake" : "Sleep"}
          </button>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-card-title"><span>Runs on</span></div>
        <p className="panel-sub">Pick where this bot's computer lives.</p>
        <Segmented
          label="Where this bot runs"
          value={mode}
          options={[
            { value: "cloud", label: "Cloud box", disabled: true, title: "Not included in this build" },
            { value: "mac", label: "This Mac" },
            { value: "off", label: "Off" },
          ]}
          onChange={changeMode}
        />
        <p className="panel-note">
          {mode === "mac"
            ? "The agent runs locally with your own CLI login. Files, approvals and credentials stay on this machine."
            : mode === "off"
              ? "The computer is off. Bots can still answer, but cannot read files or run commands."
              : "Cloud computers are not part of this open-source build."}
        </p>
      </section>

      <section className="panel-card">
        <div className="panel-card-title">
          <span><ActivityIcon size={14} /> Routines</span>
          <button type="button" className="link-button" onClick={() => setUI({ newRoutineOpen: true, view: "routines", panel: null })}>Create</button>
        </div>
        {routines.length === 0 ? (
          <p className="panel-empty-line">Routines are recurring tasks this bot runs on a schedule.</p>
        ) : (
          routines.map((routine) => (
            <div key={routine.id} className="routine-panel-row">
              <span className="routine-panel-copy">
                <span>{routine.name}</span>
                <span>{routine.enabled ? relative(routine.nextRun) : "Paused"} · {routine.timeOfDay}</span>
              </span>
              <Switch
                checked={routine.enabled}
                label={"Enable " + routine.name}
                onChange={(enabled) => void updateRoutine(routine.id, { enabled })}
              />
              <button type="button" className="icon-button" title="Run now" aria-label="Run now" onClick={() => void runRoutine(routine.id)}>
                <Play size={13} />
              </button>
            </div>
          ))
        )}
      </section>

      <section className="panel-card">
        <div className="panel-card-title"><span>Working folder</span></div>
        <p className="panel-mono">{bot.workingDir || "Home folder"}</p>
      </section>

      <section className="panel-card">
        <div className="panel-card-title"><span>Apps on this computer</span></div>
        {connectedApps.length === 0 ? <p className="panel-empty-line">Connect apps from Connected apps.</p> : (
          <div className="app-chip-row">
            {connectedApps.map((app) => <span key={app.id} className="app-chip"><span className="app-chip-dot" style={{ background: app.color }} />{app.name}</span>)}
          </div>
        )}
      </section>
    </div>
  );
}

function ActivityTab({ bot }: { bot: Bot }) {
  const { state, openThread, setUI } = useApp();
  const runs = state.runs.filter((run) => run.botId === bot.id);
  const activities = bot.threads.flatMap((thread) =>
    thread.messages.flatMap((message) => (message.activities ?? []).map((activity) => ({ thread, message, activity }))),
  ).sort((a, b) => Date.parse(b.activity.startedAt) - Date.parse(a.activity.startedAt)).slice(0, 20);
  return (
    <div className="panel-body">
      <section className="panel-card">
        <div className="panel-card-title"><span>Routine runs</span></div>
        {runs.length === 0 ? <p className="panel-empty-line">No routine runs yet. Create one in Tasks &amp; routines.</p> : runs.map((run) => (
          <button key={run.id} type="button" className="activity-row" onClick={() => { setUI({ panel: null, view: "chat" }); openThread(run.botId, run.threadId); }}>
            <span className={cn("activity-status", run.status === "completed" && "ok", run.status === "failed" && "error")} />
            <span className="activity-copy">
              <span className="activity-title">{run.title}</span>
              <span className="activity-sub">{run.summary || "Working"} · {sidebarTime(run.startedAt)}</span>
            </span>
            <ChevronRight size={14} className="row-chevron" />
          </button>
        ))}
      </section>
      <section className="panel-card">
        <div className="panel-card-title"><span>Tool activity</span></div>
        {activities.length === 0 ? <p className="panel-empty-line">No tool runs in this bot's conversations yet.</p> : activities.map(({ thread, message, activity }, index) => (
          <div key={message.id + index} className="activity-row static">
            <span className={cn("activity-status", activity.status === "ok" && "ok", activity.status === "error" && "error")} />
            <span className="activity-copy">
              <span className="activity-title">{activity.label}</span>
              <span className="activity-sub">{activity.detail || thread.title} · {clock(activity.startedAt)}</span>
            </span>
          </div>
        ))}
      </section>
      <section className="panel-card">
        <div className="panel-card-title"><span>This bot</span></div>
        <div className="panel-kv"><span>Model</span><span>{bot.modelId}</span></div>
        <div className="panel-kv"><span>Approval</span><span>{bot.approval === "ask" ? "Ask" : bot.approval === "auto" ? "Auto" : "Full"}</span></div>
        <div className="panel-kv"><span>Conversations</span><span>{bot.threads.length}</span></div>
        <div className="panel-kv"><span>Created</span><span>{sidebarTime(bot.createdAt)}</span></div>
      </section>
    </div>
  );
}

export function BotPanel() {
  const { activeBot, ui, setUI, state } = useApp();
  if (!activeBot) return null;
  const advanced = state.settings.advanced;
  const panel = ui.panel === "activity" && !advanced ? "profile" : ui.panel;
  const title = panel === "profile" ? "Agent profile" : panel === "computer" ? "Computer" : "Activity";
  return (
    <aside className="side-panel">
      <header className="side-panel-head drag-region">
        <div className="no-drag">
          <IconButton label="Back" size={30} onClick={() => setUI({ panel: null })}>
            <ChevronLeft size={18} />
          </IconButton>
        </div>
        <h2>{title}</h2>
        <div className="no-drag">
          <IconButton label="Close" size={30} onClick={() => setUI({ panel: null })}>
            <X size={17} />
          </IconButton>
        </div>
      </header>
      {panel === "profile" && <ProfileTab bot={activeBot} />}
      {panel === "computer" && <ComputerTab bot={activeBot} />}
      {panel === "activity" && <ActivityTab bot={activeBot} />}
      <div className="side-panel-tabs">
        <button type="button" className={cn(panel === "profile" && "is-active")} onClick={() => setUI({ panel: "profile" })}>Profile</button>
        <button type="button" className={cn(panel === "computer" && "is-active")} onClick={() => setUI({ panel: "computer" })}>Computer</button>
        {advanced && <button type="button" className={cn(panel === "activity" && "is-active")} onClick={() => setUI({ panel: "activity" })}>Activity</button>}
      </div>
    </aside>
  );
}
