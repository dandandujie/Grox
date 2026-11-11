import { useEffect, useMemo, useState } from "react";
import {
  Activity as ActivityIcon, BookOpen, ChevronLeft, ChevronRight, Clock3, FileText, Folder, FolderOpen,
  Laptop, Loader2, Play, Plus, RefreshCw, ShieldCheck, Sparkles, Terminal, Trash2, X,
} from "lucide-react";
import { useApp } from "@/state/store";
import type { Bot, BotPatch, CommandResult, FilePreview, FolderListing, MemoryState, Model, Skill } from "@/lib/bridge";
import { Mascot } from "@/components/Mascot";
import { currentModel } from "@/components/ModelPicker";
import { ProviderMark } from "@/components/Icons";
import { IconButton, Modal, Segmented, Switch } from "@/components/ui";
import { cn } from "@/lib/cn";
import { generateAvatar } from "@/lib/pixel-avatar";
import { clock, relative, sidebarTime } from "@/lib/format";
import { getVoices } from "@/lib/speech";
import { formatBytes } from "@/components/Attachments";

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
  const avatar = generateAvatar(bot.name);
  return (
    <section className="avatar-card generated-avatar-card">
      <div className="avatar-card-head">
        <span>Portrait</span>
        <span className="avatar-seed">seed: {avatar.seed}</span>
      </div>
      <div className="avatar-hero generated-avatar-hero">
        <Mascot seed={bot.name} title={bot.name} size={128} />
      </div>
      <p className="avatar-hint">A deterministic 1-bit portrait built from layered pixel matrices. Rename the bot to change its seed and combination.</p>
      <div className="avatar-section-label">Layer recipe</div>
      <div className="avatar-recipe">
        <div><span>Hair</span><strong>{avatar.hair.name}</strong></div>
        <div><span>Eyes</span><strong>{avatar.eyes.name}</strong></div>
        <div><span>Facial hair / mouth</span><strong>{avatar.facial.name}</strong></div>
        <div><span>Hash</span><strong>{avatar.hash.toString(16)}</strong></div>
      </div>
    </section>
  );
}

function ProfileTab({ bot }: { bot: Bot }) {
  const { updateBot, providers, setUI, apps, deleteBot, state, runRoutine, backend, toast } = useApp();
  const drafts = useBotDrafts(bot);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => setVoices(getVoices());
    load();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.addEventListener?.("voiceschanged", load);
      return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
    }
    return undefined;
  }, []);
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

  const savePreset = async () => {
    try {
      const preset = await backend.createPreset({
        name: bot.name, title: bot.title, description: bot.description, soul: bot.soul, color: bot.color,
      });
      toast({ kind: "success", title: "Preset saved", body: preset.name + " now appears in New bot." });
    } catch (cause) {
      toast({ kind: "error", title: "Could not save the preset", body: cause instanceof Error ? cause.message : "Try again." });
    }
  };

  return (
    <div className="panel-body">
      <AvatarCard bot={bot} />
      <section className="panel-card">
        <div className="panel-card-title"><span>New bot preset</span><span className="avatar-seed">persona only</span></div>
        <p className="panel-note">Save this bot's role, description and instructions as a starting point. Model, folder, approval and credentials are not copied.</p>
        <button type="button" className="btn btn-secondary" onClick={() => void savePreset()}>Save as preset</button>
      </section>

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
          <p className="panel-note">Connected-app tools run automatically only in Auto or Full. In Ask mode the API agent never receives tool calls; use Connected apps → Tools to run one manually.</p>
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
        {bot.speakReplies && (
          <label className="panel-field voice-field">
            <span>Voice</span>
            <select value={bot.voice ?? ""} onChange={(event) => void updateBot(bot.id, { voice: event.target.value })}>
              <option value="">Use the default voice</option>
              {voices.map((voice) => <option key={voice.name} value={voice.name}>{voice.name} · {voice.lang}</option>)}
            </select>
          </label>
        )}
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
  const { apps, state, setUI, runRoutine, updateRoutine, toast, revealWorkingFolder, backend, updateBot } = useApp();
  const [tab, setTab] = useState<"screen" | "files" | "terminal">("screen");
  const [screen, setScreen] = useState("");
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenError, setScreenError] = useState("");
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [filesBusy, setFilesBusy] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [mode, setMode] = useState<"local" | "ssh">(bot.computerMode === "ssh" ? "ssh" : "local");
  const [sshHost, setSshHost] = useState(bot.sshHost ?? "");
  const [sshUser, setSshUser] = useState(bot.sshUser ?? "");
  const [sshPort, setSshPort] = useState(String(bot.sshPort || 22));
  const [sshRoot, setSshRoot] = useState(bot.sshRoot ?? "");
  const [sshKeyPath, setSshKeyPath] = useState(bot.sshKeyPath ?? "");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteNote, setRemoteNote] = useState("");
  const routines = state.routines.filter((routine) => routine.botId === bot.id);
  const connectedApps = apps.filter((app) => app.connected);

  const loadFolder = async (path: string) => {
    setFilesBusy(true);
    setFilesError("");
    try {
      const next = await backend.listComputerFiles(bot.id, path);
      setListing(next);
      setPreview(null);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : String(error));
    } finally {
      setFilesBusy(false);
    }
  };

  useEffect(() => {
    if (tab === "files" && !listing && !filesBusy) void loadFolder("");
  }, [tab]);

  const openFile = async (path: string) => {
    setFilesBusy(true);
    setFilesError("");
    try {
      setPreview(await backend.readComputerFile(bot.id, path));
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : String(error));
    } finally {
      setFilesBusy(false);
    }
  };

  const capture = async () => {
    setScreenBusy(true);
    setScreenError("");
    try {
      const value = await backend.captureComputerScreen(bot.id);
      setScreen("data:image/png;base64," + value);
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : String(error));
    } finally {
      setScreenBusy(false);
    }
  };

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = command.trim();
    if (!value || running) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await backend.runComputerCommand(bot.id, value));
    } catch (error) {
      setResult({ command: value, stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1, durationMs: 0 });
    } finally {
      setRunning(false);
    }
  };

  const relativePath = listing ? listing.path.replace(listing.root, "") || "/" : "/";

  return (
    <div className="panel-body">
      <section className="panel-card remote-computer-card">
        <div className="panel-card-title">
          <span>Runs on</span>
          <Segmented
            label="Computer location"
            value={mode}
            options={[{ value: "local", label: "This Mac" }, { value: "ssh", label: "SSH box" }]}
            onChange={(value) => {
              const next = value === "ssh" ? "ssh" : "local";
              setMode(next);
              void updateBot(bot.id, { computerMode: next });
            }}
            size="sm"
          />
        </div>
        {mode === "local" ? (
          <p className="panel-note">Screen capture, files and the terminal run on this Mac under your user account.</p>
        ) : (
          <div className="remote-fields">
            <div className="form-two">
              <label className="panel-field"><span>Host</span><input value={sshHost} onChange={(event) => setSshHost(event.target.value)} placeholder="203.0.113.10" spellCheck={false} /></label>
              <label className="panel-field"><span>User</span><input value={sshUser} onChange={(event) => setSshUser(event.target.value)} placeholder="ubuntu" spellCheck={false} /></label>
            </div>
            <div className="form-two">
              <label className="panel-field"><span>Port</span><input value={sshPort} onChange={(event) => setSshPort(event.target.value)} inputMode="numeric" /></label>
              <label className="panel-field"><span>Remote root</span><input value={sshRoot} onChange={(event) => setSshRoot(event.target.value)} placeholder="/home/ubuntu" spellCheck={false} /></label>
            </div>
            <label className="panel-field"><span>Private key path</span><input value={sshKeyPath} onChange={(event) => setSshKeyPath(event.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} /></label>
            <p className="computer-hint">The key stays on this Mac. The host key is checked against ~/.ssh/known_hosts when that file exists. Screen capture needs grim, scrot or ImageMagick on the remote box.</p>
            {remoteNote && <pre className="remote-note">{remoteNote}</pre>}
            <button type="button" className="btn btn-secondary remote-save" disabled={remoteBusy} onClick={async () => {
              setRemoteBusy(true);
              setRemoteNote("");
              await updateBot(bot.id, {
                computerMode: "ssh", sshHost: sshHost.trim(), sshUser: sshUser.trim(),
                sshRoot: sshRoot.trim(), sshKeyPath: sshKeyPath.trim(), sshPort: Number(sshPort) || 22,
              });
              try {
                const value = await backend.testRemoteComputer(bot.id);
                setRemoteNote(value);
                toast({ kind: "success", title: "Remote computer connected" });
              } catch (error) {
                setRemoteNote(error instanceof Error ? error.message : String(error));
              } finally {
                setRemoteBusy(false);
              }
            }}>
              {remoteBusy ? <Loader2 size={14} className="spin" /> : <Terminal size={14} />} Save and test
            </button>
          </div>
        )}
      </section>

      <div className="computer-tabs" role="tablist" aria-label="Computer">
        <button type="button" role="tab" aria-selected={tab === "screen"} className={cn(tab === "screen" && "is-active")} onClick={() => setTab("screen")}>Screen</button>
        <button type="button" role="tab" aria-selected={tab === "files"} className={cn(tab === "files" && "is-active")} onClick={() => setTab("files")}>Files</button>
        <button type="button" role="tab" aria-selected={tab === "terminal"} className={cn(tab === "terminal" && "is-active")} onClick={() => setTab("terminal")}>Terminal</button>
      </div>

      {tab === "screen" && (
        <section className="computer-card">
          <div className="computer-card-head">
            <span>{bot.name}'s screen</span>
            <span className={cn("computer-live", screen && "is-on")}>{screen ? "Captured" : mode === "ssh" ? "Remote" : "Local"}</span>
          </div>
          {screen ? (
            <button type="button" className="computer-screen-wrap" onClick={() => void backend.openComputerPath(bot.id, "")} title="Open the folder">
              <img className="computer-screen-img" src={screen} alt="Local desktop" />
            </button>
          ) : (
            <div className="computer-preview">
              <div className="computer-menubar"><span>Grox</span><span>{new Date().toLocaleDateString("en", { month: "short", day: "numeric" })}</span></div>
              <div className="computer-wallpaper">
                <div className="computer-window">
                  <span className="computer-window-bar" />
                  <span className="computer-line wide" />
                  <span className="computer-line" />
                  <span className="computer-line short" />
                </div>
                <Mascot seed={bot.name} size={38} />
              </div>
            </div>
          )}
          {screenError && <p className="computer-hint is-error">{screenError}</p>}
          <div className="computer-actions">
            <button type="button" className="btn btn-secondary" onClick={() => void capture()} disabled={screenBusy}>
              {screenBusy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {screen ? "Capture again" : "Capture screen"}
            </button>
            {mode === "local" ? (
              <button type="button" className="btn btn-ghost" onClick={() => void revealWorkingFolder(bot.id)}>
                <Laptop size={14} /> Open folder
              </button>
            ) : (
              <span className="computer-hint">Remote root: {sshRoot || "/home/" + (sshUser || "user")}</span>
            )}
          </div>
          <p className="computer-hint">{mode === "ssh" ? "A real screenshot of the SSH box. It needs an active desktop session and grim, scrot or ImageMagick on the remote host." : "A real screenshot of this Mac. macOS may ask for Screen Recording permission the first time. Nothing leaves this machine."}</p>
        </section>
      )}

      {tab === "files" && (
        <section className="panel-card computer-files">
          <div className="computer-card-head">
            <span>Working folder</span>
            <button type="button" className="link-button" onClick={() => void loadFolder("")}>Home</button>
          </div>
          <div className="file-breadcrumb">
            <button type="button" onClick={() => void loadFolder(listing?.root ?? "")} title="Root">{bot.name}</button>
            <span>{relativePath === "/" ? "/" : relativePath}</span>
          </div>
          {filesError && <p className="computer-hint is-error">{filesError}</p>}
          <div className="file-list">
            {filesBusy && !listing && <p className="panel-empty-line"><Loader2 size={13} className="spin" /> Reading folder…</p>}
            {listing?.entries.length === 0 && <p className="panel-empty-line">This folder is empty.</p>}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="file-row"
                onClick={() => entry.dir ? void loadFolder(entry.path) : void openFile(entry.path)}
              >
                {entry.dir ? <Folder size={16} /> : <FileText size={16} />}
                <span className="file-name">{entry.name}</span>
                {!entry.dir && <span className="file-size">{formatBytes(entry.size)}</span>}
              </button>
            ))}
          </div>
          {preview && (
            <div className="file-preview">
              <div className="file-preview-head">
                <span>{preview.name}</span>
                <div>
                  <button type="button" className="link-button" onClick={() => void backend.openComputerPath(bot.id, preview.path)}>Open</button>
                  <button type="button" className="link-button" onClick={() => setPreview(null)}>Close</button>
                </div>
              </div>
              {preview.kind === "image" && <img className="file-preview-image" src={"data:" + preview.mime + ";base64," + preview.data} alt={preview.name} />}
              {preview.kind === "text" && <pre className="file-preview-text">{preview.text}</pre>}
              {preview.kind === "binary" && <p className="panel-empty-line">Binary file · {formatBytes(preview.size)}. Open it with the system app.</p>}
              {preview.truncated && <p className="computer-hint">Showing the first 256 KB.</p>}
            </div>
          )}
        </section>
      )}

      {tab === "terminal" && (
        <section className="panel-card computer-terminal">
          <div className="computer-card-head">
            <span>Terminal</span>
            <span className="terminal-badge">local</span>
          </div>
          <p className="computer-hint">Runs in the bot's working folder. You type every command; the agent cannot use this terminal on its own.</p>
          <form className="terminal-form" onSubmit={run}>
            <span className="terminal-prompt">$</span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="ls"
              spellCheck={false}
              autoCapitalize="none"
              aria-label="Terminal command"
            />
            <button type="submit" className="terminal-run" disabled={!command.trim() || running}>
              {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            </button>
          </form>
          {result && (
            <div className="terminal-output">
              <div className="terminal-meta">{result.command} · exit {result.exitCode} · {result.durationMs} ms</div>
              {result.stdout && <pre>{result.stdout}</pre>}
              {result.stderr && <pre className="terminal-stderr">{result.stderr}</pre>}
              {!result.stdout && !result.stderr && <pre className="terminal-empty">(no output)</pre>}
            </div>
          )}
        </section>
      )}

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
        <p className="panel-mono">{mode === "ssh" ? (sshRoot || "/home/" + (sshUser || "user")) : (bot.workingDir || "Home folder")}</p>
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

function MemoryTab({ bot }: { bot: Bot }) {
  const { backend, boot, toast } = useApp();
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await backend.getMemory(bot.id);
      setMemory(next);
      setDraft(next.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read memory.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const toggle = async (enabled: boolean) => {
    if (!memory) return;
    try {
      await backend.setMemoryEnabled(bot.id, enabled);
      setMemory(await backend.getMemory(bot.id));
    } catch (cause) {
      toast({ kind: "error", title: "Memory switch not updated", body: cause instanceof Error ? cause.message : "Try again." });
    }
  };

  const save = async () => {
    if (!memory) return;
    setSaving(true);
    setError("");
    try {
      const next = await backend.saveMemory(bot.id, draft, memory.revision);
      setMemory(next);
      setDraft(next.content);
      toast({ kind: "success", title: "Memory saved", body: "It will be loaded at the start of the next turn." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save memory.");
    } finally {
      setSaving(false);
    }
  };

  const linePercent = memory ? Math.min(100, Math.round((memory.loadedLines / memory.limitLines) * 100)) : 0;
  const bytePercent = memory ? Math.min(100, Math.round((memory.loadedBytes / memory.limitBytes) * 100)) : 0;
  const percent = Math.max(linePercent, bytePercent);
  const cut = Boolean(memory && (memory.lines > memory.loadedLines || memory.bytes > memory.loadedBytes));

  return (
    <div className="panel-scroll">
      <section className="panel-card">
        <div className="panel-card-title"><span>Memory</span><span className="avatar-seed">MEMORY.md</span></div>
        <div className="switch-row memory-switch">
          <span className="row-copy">
            <span className="row-title">Let this bot use memory</span>
            <span className="row-sub">Load its private MEMORY.md at the start of every turn.</span>
          </span>
          <Switch checked={Boolean(memory?.enabled)} label="Use memory" onChange={(value) => void toggle(value)} />
        </div>
        <p className="panel-note">
          Notes live only on this machine. {memory?.enabled ? "This file is loaded into the next turn." : "The file is kept, but nothing is loaded while memory is off."}
        </p>
        {loading && <div className="skill-loading"><Loader2 size={15} className="spin" /> Reading memory…</div>}
        {memory && !loading && (
          <>
            <div className="memory-meter">
              <div className="memory-meter-fill" style={{ width: percent + "%" }} />
            </div>
            <div className="memory-stats">
              <span>{memory.loadedLines}/{memory.limitLines} lines</span>
              <span>{formatBytes(memory.loadedBytes)}/{formatBytes(memory.limitBytes)}</span>
              <span>{percent}%</span>
            </div>
            {cut && <p className="panel-note is-warning">Only the first {memory.limitLines} lines or {formatBytes(memory.limitBytes)} load each turn; the rest stays on disk.</p>}
            <code className="memory-path" title={memory.path}>{memory.path}</code>
          </>
        )}
        {error && <p className="panel-note is-error">{error}</p>}
      </section>

      <section className="panel-card memory-editor-card">
        <div className="panel-card-title"><span>Notes</span><span className="avatar-seed">{boot.dataDir}/memory/{bot.id}</span></div>
        <textarea
          className="memory-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={"# What this bot should remember\n\n- A preference or fact it should carry into future conversations.\n"}
          spellCheck
        />
        <div className="memory-actions">
          <span className="memory-actions-note">Saving checks that the file did not change underneath you.</span>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || loading || !memory}>
            {saving ? <Loader2 size={14} className="spin" /> : null} Save memory
          </button>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-card-title"><span>Topic files</span><span className="avatar-seed">{memory?.topics.length ?? 0}</span></div>
        {memory && memory.topics.length > 0 ? (
          <div className="memory-topics">
            {memory.topics.map((topic) => (
              <div key={topic.name} className="memory-topic">
                <div><strong>{topic.title}</strong><span>{topic.description}</span></div>
                <span>{formatBytes(topic.bytes)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="panel-note">Topic notes in memory/{bot.id}/topics are indexed here but never loaded automatically.</p>
        )}
      </section>
    </div>
  );
}

function SkillsTab({ bot }: { bot: Bot }) {
  const { backend, toast, boot } = useApp();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<Skill | null>(null);
  const [viewingLoading, setViewingLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setSkills(await backend.listSkills(bot.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read skills.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const toggle = async (skill: Skill, enabled: boolean) => {
    setSkills((current) => current.map((item) => item.id === skill.id ? { ...item, enabled } : item));
    try {
      await backend.setSkillEnabled(bot.id, skill.id, enabled);
    } catch (cause) {
      setSkills((current) => current.map((item) => item.id === skill.id ? { ...item, enabled: !enabled } : item));
      toast({ kind: "error", title: "Skill not updated", body: cause instanceof Error ? cause.message : "Try again." });
    }
  };

  const view = async (skill: Skill) => {
    setViewing({ ...skill, body: "" });
    setViewingLoading(true);
    try {
      setViewing(await backend.readSkill(bot.id, skill.id));
    } catch (cause) {
      toast({ kind: "error", title: "Could not read skill", body: cause instanceof Error ? cause.message : "Try again." });
      setViewing(null);
    } finally {
      setViewingLoading(false);
    }
  };

  const enabledCount = skills.filter((skill) => skill.enabled).length;
  return (
    <>
      <div className="panel-scroll">
        <section className="panel-card">
          <div className="panel-card-title">
            <span><BookOpen size={14} /> Skills</span>
            <button type="button" className="link-button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={12} /> Rescan
            </button>
          </div>
          <p className="panel-note">
            SKILL.md folders add reusable instructions to this bot. Skills start off; only enabled skills are
            included in the next prompt. Nothing is executed. Only enable text you trust — skill instructions are
            sent to the model.
          </p>
          <div className="skill-summary">
            <span>{skills.length} discovered</span>
            <span>{enabledCount} enabled</span>
          </div>
        </section>

        {error && <section className="panel-card"><p className="panel-note is-error">{error}</p></section>}
        {loading && <section className="panel-card"><div className="skill-loading"><Loader2 size={15} className="spin" /> Reading SKILL.md files…</div></section>}
        {!loading && !error && skills.length === 0 && (
          <section className="panel-card skill-empty">
            <BookOpen size={24} />
            <strong>No skills found</strong>
            <p>Add a folder with a SKILL.md file, then rescan.</p>
            <code>{boot.dataDir}/skills/&lt;name&gt;/SKILL.md</code>
            <code>{bot.workingDir || "Working folder"}/.grox/skills/&lt;name&gt;/SKILL.md</code>
          </section>
        )}
        {!loading && skills.map((skill) => (
          <section key={skill.id} className={cn("panel-card skill-card", skill.enabled && "is-enabled")}>
            <div className="skill-card-head">
              <span className="skill-file-icon"><FileText size={15} /></span>
              <div className="skill-title">
                <strong>{skill.name}</strong>
                <span>{skill.source}</span>
              </div>
              <Switch checked={skill.enabled} label={"Enable " + skill.name} onChange={(value) => void toggle(skill, value)} />
            </div>
            <p className="skill-description">{skill.description || "No description in the frontmatter."}</p>
            <div className="skill-meta">
              <span>{formatBytes(skill.bytes)}</span>
              <span className="skill-path" title={skill.path}>{skill.path}</span>
              <button type="button" className="link-button" onClick={() => void view(skill)}>View</button>
            </div>
          </section>
        ))}
      </div>
      <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} title={viewing?.name ?? "Skill"} width={720}>
        {viewingLoading ? <div className="skill-loading"><Loader2 size={15} className="spin" /> Reading skill…</div> : (
          <pre className="skill-body">{viewing?.body}</pre>
        )}
      </Modal>
    </>
  );
}

export function BotPanel() {
  const { activeBot, ui, setUI, state } = useApp();
  if (!activeBot) return null;
  const advanced = state.settings.advanced;
  const panel = ui.panel === "activity" && !advanced ? "profile" : ui.panel;
  const title = panel === "profile" ? "Agent profile" : panel === "skills" ? "Skills" : panel === "memory" ? "Memory" : panel === "computer" ? "Computer" : "Activity";
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
      {panel === "skills" && <SkillsTab bot={activeBot} />}
      {panel === "memory" && <MemoryTab bot={activeBot} />}
      {panel === "computer" && <ComputerTab bot={activeBot} />}
      {panel === "activity" && <ActivityTab bot={activeBot} />}
      <div className="side-panel-tabs">
        <button type="button" className={cn(panel === "profile" && "is-active")} onClick={() => setUI({ panel: "profile" })}>Profile</button>
        <button type="button" className={cn(panel === "skills" && "is-active")} onClick={() => setUI({ panel: "skills" })}>Skills</button>
        <button type="button" className={cn(panel === "memory" && "is-active")} onClick={() => setUI({ panel: "memory" })}>Memory</button>
        <button type="button" className={cn(panel === "computer" && "is-active")} onClick={() => setUI({ panel: "computer" })}>Computer</button>
        {advanced && <button type="button" className={cn(panel === "activity" && "is-active")} onClick={() => setUI({ panel: "activity" })}>Activity</button>}
      </div>
    </aside>
  );
}
