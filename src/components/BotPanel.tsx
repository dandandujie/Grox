import { localeTag, useLanguage, useT } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import {
  Activity as ActivityIcon, Archive, BookOpen, ChevronLeft, ChevronRight, Clock3, FileText, Folder, FolderOpen,
  Laptop, Loader2, Play, Plus, RefreshCw, ShieldCheck, Sparkles, Terminal, Trash2, X,
} from "lucide-react";
import { useApp } from "@/state/store";
import type { Bot, BotPatch, CommandResult, FilePreview, FolderListing, MemoryState, MemoryTopic, Model, Playbook, Skill } from "@/lib/bridge";
import { Mascot } from "@/components/Mascot";
import { currentModel } from "@/components/ModelPicker";
import { ProviderMark } from "@/components/Icons";
import { IconButton, Modal, Segmented, Switch } from "@/components/ui";
import { cn } from "@/lib/cn";
import { clock, relative, sidebarTime } from "@/lib/format";
import { getVoices } from "@/lib/speech";
import { formatBytes } from "@/components/Attachments";

function useBotDrafts(bot: Bot) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [department, setDepartment] = useState(bot.department ?? "General");
  const [description, setDescription] = useState(bot.description);
  const [soul, setSoul] = useState(bot.soul);
  const [folder, setFolder] = useState(bot.workingDir ?? "");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(bot.name);
    setTitle(bot.title);
    setDepartment(bot.department ?? "General");
    setDescription(bot.description);
    setSoul(bot.soul);
    setFolder(bot.workingDir ?? "");
  }, [bot.id]);
  return {
    name, setName, title, setTitle, department, setDepartment, description, setDescription, soul, setSoul, folder, setFolder, saved, setSaved,
  };
}

function AvatarCard({ bot }: { bot: Bot }) {
  const t = useT();
  return (
    <section className="avatar-card generated-avatar-card">
      <div className="avatar-card-head">{t("Portrait")}</div>
      <div className="avatar-hero generated-avatar-hero">
        <Mascot seed={bot.name} title={bot.name} size={128} />
      </div>
    </section>
  );
}

function ToolPolicyCard({ bot }: { bot: Bot }) {
  const t = useT();
  const { updateBot, toast } = useApp();
  const [allow, setAllow] = useState((bot.toolPolicy?.allow ?? []).join("\n"));
  const [deny, setDeny] = useState((bot.toolPolicy?.deny ?? []).join("\n"));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAllow((bot.toolPolicy?.allow ?? []).join("\n"));
    setDeny((bot.toolPolicy?.deny ?? []).join("\n"));
  }, [bot.id]);

  const patterns = (value: string) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  const save = async () => {
    setSaving(true);
    try {
      await updateBot(bot.id, { toolPolicy: { allow: patterns(allow), deny: patterns(deny) } });
      toast({ kind: "success", title: t("Tool policy saved") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel-card">
      <div className="panel-card-title"><span><ShieldCheck size={14} /> {t("Tool policy")}</span><span className="avatar-seed">{t("per bot")}</span></div>
      <p className="panel-note">{t("Limit the tools exposed to this bot. One pattern per line or comma-separated; * is a wildcard. Empty allow means every tool. Deny always wins. Remote MCP tools are configured by the CLI, not this gateway.")}</p>
      <label className="panel-field">
        <span>{t("Allow")}</span>
        <textarea rows={3} value={allow} onChange={(event) => setAllow(event.target.value)} placeholder={"GITHUB_*\nask_user\nmemory_*"} spellCheck={false} />
      </label>
      <label className="panel-field">
        <span>{t("Deny")}</span>
        <textarea rows={3} value={deny} onChange={(event) => setDeny(event.target.value)} placeholder={"GITHUB_DELETE_*"} spellCheck={false} />
      </label>
      <button type="button" className="btn btn-secondary" onClick={() => void save()} disabled={saving}>{saving ? t("Saving…") : t("Save tool policy")}</button>
    </section>
  );
}

function ProfileTab({ bot }: { bot: Bot }) {
  const t = useT();
  const language = useLanguage();
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
    if (drafts.department !== (bot.department ?? "General")) patch.department = drafts.department.trim() || "General";
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
      toast({ kind: "success", title: t("Preset saved"), body: preset.name + t(" now appears in New bot.") });
    } catch (cause) {
      toast({ kind: "error", title: t("Could not save the preset"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };

  return (
    <div className="panel-body">
      <AvatarCard bot={bot} />
      <ToolPolicyCard bot={bot} />
      <section className="panel-card">
        <div className="panel-card-title"><span>{t("New bot preset")}</span><span className="avatar-seed">{t("persona only")}</span></div>
        <p className="panel-note">{t("Save this bot's role, description and instructions as a starting point. Model, folder, approval and credentials are not copied.")}</p>
        <button type="button" className="btn btn-secondary" onClick={() => void savePreset()}>{t("Save as preset")}</button>
      </section>

      <section className="panel-card">
        <label className="panel-field">
          <span>{t("Name")}</span>
          <input
            value={drafts.name}
            onChange={(event) => drafts.setName(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
            placeholder={t("Bot name")}
          />
        </label>
        <label className="panel-field">
          <span>{t("Role")}</span>
          <input
            value={drafts.title}
            onChange={(event) => drafts.setTitle(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
            placeholder={t("Research & data")}
          />
        </label>
        <label className="panel-field">
          <span>{t("Department")}</span>
          <input
            value={drafts.department}
            onChange={(event) => drafts.setDepartment(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
            placeholder={t("General")}
          />
        </label>
        <label className="panel-field">
          <span>{t("What it does")}</span>
          <textarea
            rows={2}
            value={drafts.description}
            onChange={(event) => drafts.setDescription(event.target.value)}
            onBlur={commitText}
            placeholder={t("A short description for this bot")}
          />
        </label>
        <label className="panel-field">
          <span>{t("Instructions")}</span>
          <textarea
            rows={5}
            value={drafts.soul}
            onChange={(event) => drafts.setSoul(event.target.value)}
            onBlur={commitText}
            placeholder={t("How should ") + bot.name + t(" think and speak?")}
          />
        </label>
        <div className="panel-field-foot">
          <span className="save-note">{drafts.saved ? t("Saved") : t("Changes save when you leave a field")}</span>
        </div>
      </section>

      <section className="panel-card">
        <button type="button" className="row-button" onClick={() => setUI({ modelPickerOpen: true })}>
          <span className="row-icon"><Sparkles size={16} /></span>
          <span className="row-copy">
            <span className="row-title">{t("Model")}</span>
            <span className="row-sub"><ProviderMark provider={model?.provider ?? "local"} size={12} /> {model?.name ?? bot.modelId}</span>
          </span>
          <ChevronRight size={15} className="row-chevron" />
        </button>
        <div className="row-divider" />
        <div className="panel-col">
          <div className="row-copy">
            <span className="row-title">{t("Before it acts")}</span>
            <span className="row-sub">{t("Approvals for commands, files, and external services.")}</span>
          </div>
          <Segmented
            label={t("Approval mode")}
            value={(bot.approval as "ask" | "auto" | "full") || "ask"}
            options={[
              { value: "ask", label: t("Ask") },
              { value: "auto", label: t("Auto") },
              { value: "full", label: t("Full") },
            ]}
            onChange={(approval) => void updateBot(bot.id, { approval })}
          />
          <p className="panel-note">{t("Connected-app tools run automatically only in Auto or Full. In Ask mode the API agent never receives tool calls; use Connected apps → Tools to run one manually.")}</p>
        </div>
        <div className="row-divider" />
        <label className="panel-field compact">
          <span>{t("Working folder")}</span>
          <div className="input-with-icon">
            <FolderOpen size={14} />
            <input
              value={drafts.folder}
              onChange={(event) => drafts.setFolder(event.target.value)}
              onBlur={commitText}
              placeholder={t("Home folder")}
            />
          </div>
        </label>
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">{t("Notifications")}</span>
            <span className="row-sub">{t("A system notification when this bot finishes a background task.")}</span>
          </span>
          <Switch checked={bot.notifications} label={t("Notifications")} onChange={(value) => void updateBot(bot.id, { notifications: value })} />
        </div>
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">{t("Read replies aloud")}</span>
            <span className="row-sub">{t("Use the system voice for new answers.")}</span>
          </span>
          <Switch checked={bot.speakReplies} label={t("Read replies aloud")} onChange={(value) => void updateBot(bot.id, { speakReplies: value })} />
        </div>
        {bot.speakReplies && (
          <label className="panel-field voice-field">
            <span>{t("Voice")}</span>
            <select value={bot.voice ?? ""} onChange={(event) => void updateBot(bot.id, { voice: event.target.value })}>
              <option value="">{t("Use the default voice")}</option>
              {voices.map((voice) => <option key={voice.name} value={voice.name}>{voice.name} · {voice.lang}</option>)}
            </select>
          </label>
        )}
      </section>

      <section className="panel-card">
        <div className="panel-card-title">
          <span>{t("Connected apps")}</span>
          <button type="button" className="link-button" onClick={() => setUI({ view: "apps", panel: null })}>{t("Manage")}</button>
        </div>
        {connectedApps.length === 0 ? (
          <p className="panel-empty-line">{t("No apps connected yet. Add one in Connected apps.")}</p>
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
          <span>{t("Routines")}</span>
          <button type="button" className="link-button" onClick={() => setUI({ newRoutineOpen: true, view: "routines", panel: null })}>{t("Create")}</button>
        </div>
        {botRoutines.length === 0 ? (
          <p className="panel-empty-line">{t("No routines for {0} yet.", bot.name)}</p>
        ) : (
          botRoutines.map((routine) => (
            <div key={routine.id} className="mini-routine">
              <span className={cn("routine-dot", routine.enabled && "is-on")} />
              <span className="mini-routine-copy">
                <span>{routine.name}</span>
                <span>{routine.enabled ? relative(routine.nextRun, language) : t("Paused")}</span>
              </span>
              <button type="button" className="icon-button" title={t("Run now")} aria-label={t("Run now")} onClick={() => void runRoutine(routine.id)}>
                <Play size={13} />
              </button>
            </div>
          ))
        )}
      </section>

      <section className="panel-card danger-card">
        <button type="button" className="danger-row" onClick={() => deleteBot(bot.id)}>
          <Trash2 size={15} /> {t("Delete")} {bot.name}
        </button>
      </section>

      <div className="panel-end">
        <span>{bot.description || t("This bot keeps its own memory and model.")}</span>
      </div>
    </div>
  );
}

function ComputerTab({ bot }: { bot: Bot }) {
  const t = useT();
  const language = useLanguage();
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
          <span>{t("Runs on")}</span>
          <Segmented
            label={t("Computer location")}
            value={mode}
            options={[{ value: "local", label: t("This computer") }, { value: "ssh", label: t("SSH box") }]}
            onChange={(value) => {
              const next = value === "ssh" ? "ssh" : "local";
              setMode(next);
              void updateBot(bot.id, { computerMode: next });
            }}
            size="sm"
          />
        </div>
        {mode === "local" ? (
          <p className="panel-note">{t("Agent tools use this computer and follow the bot’s approval settings.")}</p>
        ) : (
          <div className="remote-fields">
            <div className="form-two">
              <label className="panel-field"><span>{t("Host")}</span><input value={sshHost} onChange={(event) => setSshHost(event.target.value)} placeholder="203.0.113.10" spellCheck={false} /></label>
              <label className="panel-field"><span>{t("User")}</span><input value={sshUser} onChange={(event) => setSshUser(event.target.value)} placeholder="ubuntu" spellCheck={false} /></label>
            </div>
            <div className="form-two">
              <label className="panel-field"><span>{t("Port")}</span><input value={sshPort} onChange={(event) => setSshPort(event.target.value)} inputMode="numeric" /></label>
              <label className="panel-field"><span>{t("Remote root")}</span><input value={sshRoot} onChange={(event) => setSshRoot(event.target.value)} placeholder="/home/ubuntu" spellCheck={false} /></label>
            </div>
            <label className="panel-field"><span>{t("Private key path")}</span><input value={sshKeyPath} onChange={(event) => setSshKeyPath(event.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} /></label>
            <p className="computer-hint">{t("The host key must match ~/.ssh/known_hosts. Screen capture needs an active display and grim, scrot or ImageMagick on the remote box.")}</p>
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
                toast({ kind: "success", title: t("Remote computer connected") });
              } catch (error) {
                setRemoteNote(error instanceof Error ? error.message : String(error));
              } finally {
                setRemoteBusy(false);
              }
            }}>
              {remoteBusy ? <Loader2 size={14} className="spin" /> : <Terminal size={14} />} {t("Save and test")}
            </button>
          </div>
        )}
      </section>

      <div className="computer-tabs" role="tablist" aria-label={t("Computer")}>
        <button type="button" role="tab" aria-selected={tab === "screen"} className={cn(tab === "screen" && "is-active")} onClick={() => setTab("screen")}>{t("Screen")}</button>
        <button type="button" role="tab" aria-selected={tab === "files"} className={cn(tab === "files" && "is-active")} onClick={() => setTab("files")}>{t("Files")}</button>
        <button type="button" role="tab" aria-selected={tab === "terminal"} className={cn(tab === "terminal" && "is-active")} onClick={() => setTab("terminal")}>{t("Terminal")}</button>
      </div>

      {tab === "screen" && (
        <section className="computer-card">
          <div className="computer-card-head">
            <span>{bot.name}{t("'s screen")}</span>
            <span className={cn("computer-live", screen && "is-on")}>{screen ? t("Captured") : mode === "ssh" ? t("Remote") : t("Local")}</span>
          </div>
          {screen ? (
            <button type="button" className="computer-screen-wrap" onClick={() => void backend.openComputerPath(bot.id, "")} title={t("Open the folder")}>
              <img className="computer-screen-img" src={screen} alt={t("Local desktop")} />
            </button>
          ) : (
            <div className="computer-preview">
              <div className="computer-menubar"><span>Grox</span><span>{new Date().toLocaleDateString(localeTag(language), { month: "short", day: "numeric" })}</span></div>
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
              {screenBusy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {screen ? t("Capture again") : t("Capture screen")}
            </button>
            {mode === "local" ? (
              <button type="button" className="btn btn-ghost" onClick={() => void revealWorkingFolder(bot.id)}>
                <Laptop size={14} /> {t("Open folder")}
              </button>
            ) : (
              <span className="computer-hint">{t("Remote root:")} {sshRoot || "/home/" + (sshUser || "user")}</span>
            )}
          </div>
          <p className="computer-hint">{mode === "ssh" ? t("A real screenshot of the SSH box. It needs an active desktop session and grim, scrot or ImageMagick on the remote host.") : t("A real screenshot of this Mac. macOS may ask for Screen Recording permission the first time. Nothing leaves this machine.")}</p>
        </section>
      )}

      {tab === "files" && (
        <section className="panel-card computer-files">
          <div className="computer-card-head">
            <span>{t("Working folder")}</span>
            <button type="button" className="link-button" onClick={() => void loadFolder("")}>{t("Home")}</button>
          </div>
          <div className="file-breadcrumb">
            <button type="button" onClick={() => void loadFolder(listing?.root ?? "")} title={t("Root")}>{bot.name}</button>
            <span>{relativePath === "/" ? "/" : relativePath}</span>
          </div>
          {filesError && <p className="computer-hint is-error">{filesError}</p>}
          <div className="file-list">
            {filesBusy && !listing && <p className="panel-empty-line"><Loader2 size={13} className="spin" /> {t("Reading folder…")}</p>}
            {listing?.entries.length === 0 && <p className="panel-empty-line">{t("This folder is empty.")}</p>}
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
                  <button type="button" className="link-button" onClick={() => void backend.openComputerPath(bot.id, preview.path)}>{t("Open")}</button>
                  <button type="button" className="link-button" onClick={() => setPreview(null)}>{t("Close")}</button>
                </div>
              </div>
              {preview.kind === "image" && <img className="file-preview-image" src={"data:" + preview.mime + ";base64," + preview.data} alt={preview.name} />}
              {preview.kind === "text" && <pre className="file-preview-text">{preview.text}</pre>}
              {preview.kind === "binary" && <p className="panel-empty-line">{t("Binary file ·")} {formatBytes(preview.size)}{t(". Open it with the system app.")}</p>}
              {preview.truncated && <p className="computer-hint">{t("Showing the first 256 KB.")}</p>}
            </div>
          )}
        </section>
      )}

      {tab === "terminal" && (
        <section className="panel-card computer-terminal">
          <div className="computer-card-head">
            <span>{t("Terminal")}</span>
            <span className="terminal-badge">local</span>
          </div>
          <p className="computer-hint">{t("Runs in the bot's working folder. You type every command; the agent cannot use this terminal on its own.")}</p>
          <form className="terminal-form" onSubmit={run}>
            <span className="terminal-prompt">$</span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="ls"
              spellCheck={false}
              autoCapitalize="none"
              aria-label={t("Terminal command")}
            />
            <button type="submit" className="terminal-run" disabled={!command.trim() || running}>
              {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            </button>
          </form>
          {result && (
            <div className="terminal-output">
              <div className="terminal-meta">{result.command} {t("· exit")} {result.exitCode} · {result.durationMs} ms</div>
              {result.stdout && <pre>{result.stdout}</pre>}
              {result.stderr && <pre className="terminal-stderr">{result.stderr}</pre>}
              {!result.stdout && !result.stderr && <pre className="terminal-empty">{t("(no output)")}</pre>}
            </div>
          )}
        </section>
      )}

      <section className="panel-card">
        <div className="panel-card-title">
          <span><ActivityIcon size={14} /> {t("Routines")}</span>
          <button type="button" className="link-button" onClick={() => setUI({ newRoutineOpen: true, view: "routines", panel: null })}>{t("Create")}</button>
        </div>
        {routines.length === 0 ? (
          <p className="panel-empty-line">{t("Routines are recurring tasks this bot runs on a schedule.")}</p>
        ) : (
          routines.map((routine) => (
            <div key={routine.id} className="routine-panel-row">
              <span className="routine-panel-copy">
                <span>{routine.name}</span>
                <span>{routine.enabled ? relative(routine.nextRun, language) : t("Paused")} · {routine.timeOfDay}</span>
              </span>
              <Switch
                checked={routine.enabled}
                label={t("Enable ") + routine.name}
                onChange={(enabled) => void updateRoutine(routine.id, { enabled })}
              />
              <button type="button" className="icon-button" title={t("Run now")} aria-label={t("Run now")} onClick={() => void runRoutine(routine.id)}>
                <Play size={13} />
              </button>
            </div>
          ))
        )}
      </section>

      <section className="panel-card">
        <div className="panel-card-title"><span>{t("Working folder")}</span></div>
        <p className="panel-mono">{mode === "ssh" ? (sshRoot || "/home/" + (sshUser || "user")) : (bot.workingDir || t("Home folder"))}</p>
      </section>

      <section className="panel-card">
        <div className="panel-card-title"><span>{t("Apps on this computer")}</span></div>
        {connectedApps.length === 0 ? <p className="panel-empty-line">{t("Connect apps from Connected apps.")}</p> : (
          <div className="app-chip-row">
            {connectedApps.map((app) => <span key={app.id} className="app-chip"><span className="app-chip-dot" style={{ background: app.color }} />{app.name}</span>)}
          </div>
        )}
      </section>
    </div>
  );
}

function ActivityTab({ bot }: { bot: Bot }) {
  const t = useT();
  const language = useLanguage();
  const { state, openThread, setUI } = useApp();
  const runs = state.runs.filter((run) => run.botId === bot.id);
  const activities = bot.threads.flatMap((thread) =>
    thread.messages.flatMap((message) => (message.activities ?? []).map((activity) => ({ thread, message, activity }))),
  ).sort((a, b) => Date.parse(b.activity.startedAt) - Date.parse(a.activity.startedAt)).slice(0, 20);
  return (
    <div className="panel-body">
      <section className="panel-card">
        <div className="panel-card-title"><span>{t("Routine runs")}</span></div>
        {runs.length === 0 ? <p className="panel-empty-line">{t("No routine runs yet. Create one in Tasks & routines.")}</p> : runs.map((run) => (
          <button key={run.id} type="button" className="activity-row" onClick={() => { setUI({ panel: null, view: "chat" }); openThread(run.botId, run.threadId); }}>
            <span className={cn("activity-status", run.status === "completed" && "ok", run.status === "failed" && "error")} />
            <span className="activity-copy">
              <span className="activity-title">{run.title}</span>
              <span className="activity-sub">{t(run.summary || "Working")} · {sidebarTime(run.startedAt, language)}</span>
            </span>
            <ChevronRight size={14} className="row-chevron" />
          </button>
        ))}
      </section>
      <section className="panel-card">
        <div className="panel-card-title"><span>{t("Tool activity")}</span></div>
        {activities.length === 0 ? <p className="panel-empty-line">{t("No tool runs in this bot's conversations yet.")}</p> : activities.map(({ thread, message, activity }, index) => (
          <div key={message.id + index} className="activity-row static">
            <span className={cn("activity-status", activity.status === "ok" && "ok", activity.status === "error" && "error")} />
            <span className="activity-copy">
              <span className="activity-title">{t(activity.label)}</span>
              <span className="activity-sub">{activity.detail || thread.title} · {clock(activity.startedAt, language)}</span>
            </span>
          </div>
        ))}
      </section>
      <section className="panel-card">
        <div className="panel-card-title"><span>{t("This bot")}</span></div>
        <div className="panel-kv"><span>{t("Model")}</span><span>{bot.modelId}</span></div>
        <div className="panel-kv"><span>{t("Approval")}</span><span>{bot.approval === "ask" ? t("Ask") : bot.approval === "auto" ? t("Auto") : t("Full")}</span></div>
        <div className="panel-kv"><span>{t("Conversations")}</span><span>{bot.threads.length}</span></div>
        <div className="panel-kv"><span>{t("Created")}</span><span>{sidebarTime(bot.createdAt, language)}</span></div>
      </section>
    </div>
  );
}

function MemoryTab({ bot }: { bot: Bot }) {
  const t = useT();
  const { backend, boot, toast, requestConfirm, updateBot } = useApp();
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [error, setError] = useState("");
  const [topic, setTopic] = useState<MemoryTopic | null>(null);
  const [topicDraft, setTopicDraft] = useState("");
  const [topicSaving, setTopicSaving] = useState(false);
  const [topicError, setTopicError] = useState("");
  const [forgetQuery, setForgetQuery] = useState("");
  const [forgetting, setForgetting] = useState(false);
  const [log, setLog] = useState<{ date: string; content: string } | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await backend.getMemory(bot.id);
      setMemory(next);
      setDraft(next.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not read memory."));
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
      toast({ kind: "error", title: t("Memory switch not updated"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };

  const openLog = async (date: string) => {
    setLogLoading(true);
    try {
      const content = await backend.readMemoryLog(bot.id, date);
      setLog({ date, content });
    } catch (cause) {
      toast({ kind: "error", title: t("Could not read log"), body: cause instanceof Error ? cause.message : t("Try again.") });
    } finally {
      setLogLoading(false);
    }
  };

  const forget = async () => {
    if (forgetQuery.trim().length < 3) return;
    setForgetting(true);
    try {
      const result = await backend.forgetMemory(bot.id, forgetQuery.trim());
      if (result.removed > 0) {
        setForgetQuery("");
        await load();
        toast({ kind: "success", title: t("Memory forgotten"), body: result.removed + t(" entries moved to topics/archive.md.") });
      } else {
        toast({ kind: "info", title: t("Nothing matched"), body: t("No top-level MEMORY.md entries contain that phrase.") });
      }
    } catch (cause) {
      toast({ kind: "error", title: t("Could not forget"), body: cause instanceof Error ? cause.message : t("Try again.") });
    } finally {
      setForgetting(false);
    }
  };

  const openTopic = async (name: string) => {
    setTopicError("");
    try {
      const next = await backend.readMemoryTopic(bot.id, name);
      setTopic(next);
      setTopicDraft(next.content ?? "");
    } catch (cause) {
      toast({ kind: "error", title: t("Could not read topic"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };

  const saveTopic = async () => {
    if (!topic) return;
    setTopicSaving(true);
    setTopicError("");
    try {
      const next = await backend.saveMemoryTopic(bot.id, topic.name, topicDraft, topic.revision ?? "");
      setTopic(next);
      await load();
      toast({ kind: "success", title: t("Topic saved") });
    } catch (cause) {
      setTopicError(cause instanceof Error ? cause.message : t("Could not save the topic."));
    } finally {
      setTopicSaving(false);
    }
  };

  const deleteTopic = () => {
    if (!topic) return;
    requestConfirm({
      title: t("Delete topic?"),
      body: topic.title + t(" will be removed from this bot's memory. This cannot be undone."),
      confirmLabel: t("Delete"),
      danger: true,
      onConfirm: () => {
        void backend.deleteMemoryTopic(bot.id, topic.name).then(async () => {
          setTopic(null);
          await load();
        }).catch((cause: unknown) => {
          toast({ kind: "error", title: t("Topic not deleted"), body: cause instanceof Error ? cause.message : t("Try again.") });
        });
      },
    });
  };

  const tidy = async () => {
    setTidying(true);
    try {
      const result = await backend.tidyMemory(bot.id);
      await load();
      toast({ kind: "success", title: result.archived ? t("Memory archived") : t("Memory already fits"), body: result.archived ? result.archived + t(" entries moved to topics/archive.md.") : t("Nothing needed to move.") });
    } catch (cause) {
      toast({ kind: "error", title: t("Could not tidy memory"), body: cause instanceof Error ? cause.message : t("Try again.") });
    } finally {
      setTidying(false);
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
      toast({ kind: "success", title: t("Memory saved"), body: t("It will be loaded at the start of the next turn.") });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not save memory."));
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
        <div className="panel-card-title"><span>{t("Memory")}</span><div className="memory-head-actions"><button type="button" className="link-button" onClick={() => void tidy()} disabled={tidying || loading}><Archive size={11} /> {t("Tidy")}</button><button type="button" className="link-button" onClick={() => void load()} disabled={loading}><RefreshCw size={11} /> {t("Reload")}</button></div></div>
        <div className="switch-row memory-switch">
          <span className="row-copy">
            <span className="row-title">{t("Let this bot use memory")}</span>
            <span className="row-sub">{t("Load its private MEMORY.md at the start of every turn.")}</span>
          </span>
          <Switch checked={Boolean(memory?.enabled)} label={t("Use memory")} onChange={(value) => void toggle(value)} />
        </div>
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">{t("Automatically archive")}</span>
            <span className="row-sub">{t("Once an hour, move the oldest dated entries to topics/archive.md when over budget.")}</span>
          </span>
          <Switch checked={Boolean(bot.memoryAutoTidy)} label={t("Automatically archive memory")} onChange={(value) => void updateBot(bot.id, { memoryAutoTidy: value })} />
        </div>
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">{t("Daily conversation log")}</span>
            <span className="row-sub">{t("Append each finished turn to memory/")}{bot.id}{t("/logs/YYYY-MM-DD.md. Logs are never loaded into prompts.")}</span>
          </span>
          <Switch checked={Boolean(bot.memoryDailyLog)} label={t("Daily conversation log")} onChange={(value) => void updateBot(bot.id, { memoryDailyLog: value })} />
        </div>
        <p className="panel-note">
          {t("Notes live only on this machine.")} {memory?.enabled ? t("This file is loaded into the next turn.") : t("The file is kept, but nothing is loaded while memory is off.")}
        </p>
        {loading && <div className="skill-loading"><Loader2 size={15} className="spin" /> {t("Reading memory…")}</div>}
        {memory && !loading && (
          <>
            <div className="memory-meter">
              <div className="memory-meter-fill" style={{ width: percent + "%" }} />
            </div>
            <div className="memory-stats">
              <span>{t("{0}/{1} lines", memory.loadedLines, memory.limitLines)}</span>
              <span>{formatBytes(memory.loadedBytes)}/{formatBytes(memory.limitBytes)}</span>
              <span>{percent}%</span>
            </div>
            {cut && <p className="panel-note is-warning">{t("Only the first {0} lines or {1} load each turn; the rest stays on disk.", memory.limitLines, formatBytes(memory.limitBytes))}</p>}
            {Boolean(memory.expired) && <p className="panel-note">{t(memory.expired === 1 ? "Skipping {0} expired entry." : "Skipping {0} expired entries.", memory.expired)}</p>}
            <code className="memory-path" title={memory.path}>{memory.path}</code>
          </>
        )}
        {error && <p className="panel-note is-error">{error}</p>}
      </section>

      <section className="panel-card memory-editor-card">
        <div className="panel-card-title"><span>{t("Notes")}</span><span className="avatar-seed">{boot.dataDir}/memory/{bot.id}</span></div>
        <textarea
          className="memory-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={"# What this bot should remember\n\n- A preference or fact it should carry into future conversations.\n"}
          spellCheck
        />
        <div className="memory-actions">
          <span className="memory-actions-note">{t("Saving checks that the file did not change underneath you.")}</span>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || loading || !memory}>
            {saving ? <Loader2 size={14} className="spin" /> : null} {t("Save memory")}
          </button>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-card-title"><span>{t("Forget")}</span><span className="avatar-seed">{t("MEMORY.md entries")}</span></div>
        <p className="panel-note">{t("Remove top-level entries containing a phrase. A copy stays in topics/archive.md for audit.")}</p>
        <div className="memory-forget-row">
          <input value={forgetQuery} onChange={(event) => setForgetQuery(event.target.value)} placeholder={t("phrase to forget")} />
          <button type="button" className="btn btn-danger" onClick={() => void forget()} disabled={forgetting || forgetQuery.trim().length < 3}>{forgetting ? t("Forgetting…") : t("Forget")}</button>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-card-title"><span>{t("Topic files")}</span><span className="avatar-seed">{memory?.topics.length ?? 0}</span></div>
        {memory && memory.topics.length > 0 ? (
          <div className="memory-topics">
            {memory.topics.map((item) => (
              <button type="button" key={item.name} className="memory-topic" onClick={() => void openTopic(item.name)}>
                <div><strong>{item.title}</strong><span>{item.description}</span></div>
                <span>{formatBytes(item.bytes)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="panel-note">{t("Topic notes in memory/")}{bot.id}{t("/topics are indexed here but never loaded automatically.")}</p>
        )}
      </section>
      <section className="panel-card">
        <div className="panel-card-title"><span>{t("Daily logs")}</span><span className="avatar-seed">{memory?.logs?.length ?? 0}</span></div>
        {memory && (memory.logs?.length ?? 0) > 0 ? (
          <div className="memory-topics">
            {memory.logs?.map((item) => (
              <button type="button" key={item.date} className="memory-topic" onClick={() => void openLog(item.date)} disabled={logLoading}>
                <div><strong>{item.date}</strong><span>{t("Conversation log")}</span></div>
                <span>{formatBytes(item.bytes)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="panel-note">{t("Turn on Daily conversation log to keep a local day-by-day transcript.")}</p>
        )}
      </section>
      <Modal open={Boolean(log)} onClose={() => setLog(null)} title={log ? t("Log · ") + log.date : t("Daily log")} width={760}>
        {log && <pre className="memory-log">{log.content}</pre>}
      </Modal>
      <Modal open={Boolean(topic)} onClose={() => setTopic(null)} title={topic?.title ?? t("Memory topic")} width={720}>
        {topic && (
          <>
            <textarea className="memory-editor" value={topicDraft} onChange={(event) => setTopicDraft(event.target.value)} spellCheck />
            <p className="panel-note">{t("Writes are checked against the revision you opened. A topic does not load into a prompt wholesale; matching passages can be recalled.")}</p>
            {topicError && <p className="panel-note is-error">{topicError}</p>}
            <div className="modal-actions split">
              <button type="button" className="btn btn-danger" onClick={deleteTopic}>{t("Delete topic")}</button>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setTopic(null)}>{t("Cancel")}</button>
                <button type="button" className="btn btn-primary" onClick={() => void saveTopic()} disabled={topicSaving}>{topicSaving ? t("Saving…") : t("Save topic")}</button>
              </div>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

function SkillsTab({ bot }: { bot: Bot }) {
  const t = useT();
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
      setError(cause instanceof Error ? cause.message : t("Could not read skills."));
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
      toast({ kind: "error", title: t("Skill not updated"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };

  const view = async (skill: Skill) => {
    setViewing({ ...skill, body: "" });
    setViewingLoading(true);
    try {
      setViewing(await backend.readSkill(bot.id, skill.id));
    } catch (cause) {
      toast({ kind: "error", title: t("Could not read skill"), body: cause instanceof Error ? cause.message : t("Try again.") });
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
            <span><BookOpen size={14} /> {t("Skills")}</span>
            <button type="button" className="link-button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={12} /> {t("Rescan")}
            </button>
          </div>
          <p className="panel-note">
            {t("SKILL.md folders add reusable instructions to this bot. Skills start off; only enabled skills are included in the next prompt. Nothing is executed. Only enable text you trust — skill instructions are sent to the model.")}
          </p>
          <div className="skill-summary">
            <span>{t("{0} discovered", skills.length)}</span>
            <span>{t("{0} enabled", enabledCount)}</span>
          </div>
        </section>

        {error && <section className="panel-card"><p className="panel-note is-error">{error}</p></section>}
        {loading && <section className="panel-card"><div className="skill-loading"><Loader2 size={15} className="spin" /> {t("Reading SKILL.md files…")}</div></section>}
        {!loading && !error && skills.length === 0 && (
          <section className="panel-card skill-empty">
            <BookOpen size={24} />
            <strong>{t("No skills found")}</strong>
            <p>{t("Add a folder with a SKILL.md file, then rescan.")}</p>
            <code>{boot.dataDir}/skills/&lt;name&gt;/SKILL.md</code>
            <code>{bot.workingDir || t("Working folder")}/.grox/skills/&lt;name&gt;/SKILL.md</code>
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
              <Switch checked={skill.enabled} label={t("Enable ") + skill.name} onChange={(value) => void toggle(skill, value)} />
            </div>
            <p className="skill-description">{skill.description || t("No description in the frontmatter.")}</p>
            <div className="skill-meta">
              <span>{formatBytes(skill.bytes)}</span>
              <span className="skill-path" title={skill.path}>{skill.path}</span>
              <button type="button" className="link-button" onClick={() => void view(skill)}>{t("View")}</button>
            </div>
          </section>
        ))}
      </div>
      <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} title={viewing?.name ?? t("Skill")} width={720}>
        {viewingLoading ? <div className="skill-loading"><Loader2 size={15} className="spin" /> {t("Reading skill…")}</div> : (
          <pre className="skill-body">{viewing?.body}</pre>
        )}
      </Modal>
    </>
  );
}

function PlaybooksTab({ bot }: { bot: Bot }) {
  const t = useT();
  const { backend, toast, requestConfirm } = useApp();
  const [items, setItems] = useState<Playbook[]>([]);
  const [editing, setEditing] = useState<Playbook | null>(null);
  const [name, setName] = useState("");
  const [triggers, setTriggers] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setItems(await backend.listPlaybooks(bot.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not read playbooks."));
    }
  };
  useEffect(() => { void load(); }, [bot.id]);

  const openNew = () => {
    setEditing({ id: "", name: "", triggers: [], instructions: "", updatedAt: "" });
    setName("");
    setTriggers("");
    setInstructions("");
    setError("");
  };
  const openEdit = (playbook: Playbook) => {
    setEditing(playbook);
    setName(playbook.name);
    setTriggers(playbook.triggers.join(", "));
    setInstructions(playbook.instructions);
    setError("");
  };
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await backend.savePlaybook(bot.id, { name, triggers: triggers.split(","), instructions });
      setEditing(null);
      await load();
      toast({ kind: "success", title: t("Playbook saved") });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not save the playbook."));
    } finally {
      setSaving(false);
    }
  };
  const remove = (playbook: Playbook) => {
    requestConfirm({
      title: t("Delete playbook?"),
      body: playbook.name + t(" will no longer be selected for this bot."),
      confirmLabel: t("Delete"),
      danger: true,
      onConfirm: () => {
        void backend.deletePlaybook(bot.id, playbook.id).then(load).catch((cause: unknown) => {
          toast({ kind: "error", title: t("Playbook not deleted"), body: cause instanceof Error ? cause.message : t("Try again.") });
        });
      },
    });
  };

  return (
    <div className="panel-body">
      <section className="panel-card">
        <div className="panel-card-title"><span>{t("Playbooks")}</span><button type="button" className="link-button" onClick={openNew}><Plus size={12} /> {t("New")}</button></div>
        <p className="panel-note">{t("A playbook is process guidance selected by trigger words in the message. It grants no tools or permissions. Up to three are included per turn.")}</p>
        {items.length === 0 ? <p className="panel-note">{t("No playbooks yet.")}</p> : (
          <div className="memory-topics">
            {items.map((playbook) => (
              <button type="button" key={playbook.id} className="memory-topic" onClick={() => openEdit(playbook)}>
                <div><strong>{playbook.name}</strong><span>{playbook.triggers.join(", ")}</span></div>
                <span>{formatBytes(playbook.instructions.length)}</span>
              </button>
            ))}
          </div>
        )}
        {error && <p className="panel-note is-error">{error}</p>}
      </section>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? t("Edit playbook") : t("New playbook")} width={720}>
        {editing && (
          <>
            <label className="panel-field"><span>{t("Name")}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Launch checklist")} /></label>
            <label className="panel-field"><span>{t("Triggers (comma separated)")}</span><input value={triggers} onChange={(event) => setTriggers(event.target.value)} placeholder={t("launch, release, ship")} /></label>
            <label className="panel-field"><span>{t("Instructions")}</span><textarea rows={12} className="memory-editor" value={instructions} onChange={(event) => setInstructions(event.target.value)} spellCheck /></label>
            {error && <p className="panel-note is-error">{error}</p>}
            <div className="modal-actions split">
              {editing.id ? <button type="button" className="btn btn-danger" onClick={() => remove(editing)}>{t("Delete")}</button> : <span />}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{t("Cancel")}</button>
                <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? t("Saving…") : t("Save playbook")}</button>
              </div>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

export function BotPanel() {
  const t = useT();
  const { activeBot, ui, setUI, state } = useApp();
  if (!activeBot) return null;
  const advanced = state.settings.advanced;
  const panel = ui.panel === "activity" && !advanced ? "profile" : ui.panel;
  const title = panel === "profile" ? t("Agent profile") : panel === "skills" ? t("Skills") : panel === "playbooks" ? t("Playbooks") : panel === "memory" ? t("Memory") : panel === "computer" ? t("Computer") : t("Activity");
  return (
    <aside className="side-panel">
      <header className="side-panel-head drag-region">
        <div className="no-drag">
          <IconButton label={t("Back")} size={30} onClick={() => setUI({ panel: null })}>
            <ChevronLeft size={18} />
          </IconButton>
        </div>
        <h2>{title}</h2>
        <div className="no-drag">
          <IconButton label={t("Close")} size={30} onClick={() => setUI({ panel: null })}>
            <X size={17} />
          </IconButton>
        </div>
      </header>
      {panel === "profile" && <ProfileTab bot={activeBot} />}
      {panel === "skills" && <SkillsTab bot={activeBot} />}
      {panel === "playbooks" && <PlaybooksTab bot={activeBot} />}
      {panel === "memory" && <MemoryTab bot={activeBot} />}
      {panel === "computer" && <ComputerTab bot={activeBot} />}
      {panel === "activity" && <ActivityTab bot={activeBot} />}
      <div className="side-panel-tabs">
        <button type="button" className={cn(panel === "profile" && "is-active")} onClick={() => setUI({ panel: "profile" })}>{t("Profile")}</button>
        <button type="button" className={cn(panel === "skills" && "is-active")} onClick={() => setUI({ panel: "skills" })}>{t("Skills")}</button>
        <button type="button" className={cn(panel === "playbooks" && "is-active")} onClick={() => setUI({ panel: "playbooks" })}>{t("Playbooks")}</button>
        <button type="button" className={cn(panel === "memory" && "is-active")} onClick={() => setUI({ panel: "memory" })}>{t("Memory")}</button>
        <button type="button" className={cn(panel === "computer" && "is-active")} onClick={() => setUI({ panel: "computer" })}>{t("Computer")}</button>
        {advanced && <button type="button" className={cn(panel === "activity" && "is-active")} onClick={() => setUI({ panel: "activity" })}>{t("Activity")}</button>}
      </div>
    </aside>
  );
}
