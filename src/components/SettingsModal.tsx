import { localizePreset } from "@/lib/presets";
import { useT } from "@/i18n";
import { LanguageSelect } from "@/components/LanguageSelect";
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight, Cloud, Database, Eye, EyeOff, FolderOpen, Globe, Info, KeyRound, Laptop,
  Languages, Layers, MonitorSpeaker, Palette, Play, Plug, Plus, RefreshCw, Save, ShieldCheck, Smartphone, Sparkles, Terminal, Trash2,
  Upload, Volume2, X,
} from "lucide-react";
import { useApp, type SettingsSection } from "@/state/store";
import { Modal, Segmented, Switch, Spinner } from "@/components/ui";
import { speak } from "@/lib/speech";
import { GroxLogo, ProviderMark } from "@/components/Icons";
import { cn } from "@/lib/cn";
import { COLOR_NAMES, MAUS_COLORS, swatch } from "@/lib/mascot";
import type { APIInfo, Department, MCPServer, Settings, TeamImportResult } from "@/lib/bridge";

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Palette size={16} /> },
  { id: "connections", label: "Connections", icon: <KeyRound size={16} /> },
  { id: "engines", label: "Engines", icon: <Sparkles size={16} /> },
  { id: "mcp", label: "MCP servers", icon: <Plug size={16} /> },
  { id: "computer", label: "Computers", icon: <Laptop size={16} /> },
  { id: "phone", label: "Phone", icon: <Smartphone size={16} /> },
  { id: "automation", label: "Automation", icon: <Terminal size={16} /> },
  { id: "departments", label: "Departments", icon: <Layers size={16} /> },
  { id: "voice", label: "Voice", icon: <Volume2 size={16} /> },
  { id: "data", label: "Data & privacy", icon: <Database size={16} /> },
  { id: "about", label: "About", icon: <Info size={16} /> },
];

const SKINS = [
  { id: "midnight", label: "Midnight", colors: ["#0e0e0e", "#202020", "#1084fe"] },
  { id: "daylight", label: "Daylight", colors: ["#f5f5f5", "#ffffff", "#126fd4"] },
  { id: "atelier", label: "Atelier", colors: ["#fbf8f2", "#ffffff", "#a05f25"] },
  { id: "foundry", label: "Foundry", colors: ["#171410", "#262019", "#d99a3e"] },
];

const KEY_FIELDS = [
  { name: "xai", label: "xAI API key", hint: "For Grok models over the xAI API.", placeholder: "xai-…" },
  { name: "anthropic", label: "Anthropic API key", hint: "Used by the Claude engine.", placeholder: "sk-ant-…" },
  { name: "openai", label: "OpenAI API key", hint: "For OpenAI models over the API.", placeholder: "sk-…" },
  { name: "google", label: "Google AI API key", hint: "Used by Gemini models.", placeholder: "AIza…" },
  { name: "composio", label: "Composio project key", hint: "Enables real OAuth links and the live tool runner in Connected apps.", placeholder: "ak_…" },
  { name: "api", label: "Custom API key", hint: "For an OpenAI-compatible gateway or a local model.", placeholder: "Optional" },
];

const ENGINE_LABEL: Record<string, string> = {
  grok: "Grok CLI",
  claude: "Claude Code",
  openai: "Codex CLI",
  google: "Gemini CLI",
};

function SectionCard({ title, hint, children, action }: { title: string; hint?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function GeneralSection() {
  const t = useT();
  const { state, patchSettings, backend, toast, requestConfirm } = useApp();
  const settings = state.settings;
  return (
    <>
      <SectionCard title={t("Interface")}>
        <LanguageSelect />
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">{t("Advanced mode")}</span>
            <span className="row-sub">{t("Show model routing, engine detail, and activity panels.")}</span>
          </span>
          <Switch checked={settings.advanced} label={t("Advanced mode")} onChange={(advanced) => void patchSettings({ advanced })} />
        </div>
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">{t("Reduce motion")}</span>
            <span className="row-sub">{t("Stop message arrival and interface animations.")}</span>
          </span>
          <Switch checked={settings.reduceMotion} label={t("Reduce motion")} onChange={(reduceMotion) => void patchSettings({ reduceMotion })} />
        </div>
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">{t("Notifications")}</span>
            <span className="row-sub">{t("Notify you when a background task finishes.")}</span>
          </span>
          <Switch checked={settings.notifications} label={t("Notifications")} onChange={(notifications) => {
            if (notifications && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
            void patchSettings({ notifications });
          }} />
        </div>
      </SectionCard>

      <SectionCard title={t("Appearance")} hint={t("The skin changes every surface, including menus and the transcript.")}>
        <div className="skin-grid">
          {SKINS.map((skin) => (
            <button
              key={skin.id}
              type="button"
              className={cn("skin-option", settings.theme === skin.id && "is-selected")}
              onClick={() => void patchSettings({ theme: skin.id })}
            >
              <span className="skin-preview" style={{ background: skin.colors[0] }}>
                <span className="skin-side" style={{ background: skin.colors[1] }} />
                <span className="skin-dot" style={{ background: skin.colors[2] }} />
              </span>
              <span>{t(skin.label)}</span>
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard title={t("New bot presets")} hint={t("Persona-only starting points. Model, folder, approval and credentials are never copied.")}>
        {(state.presets ?? []).length === 0 ? (
          <p className="panel-note">{t("No presets. Open a bot profile and choose Save as preset.")}</p>
        ) : (
          <div className="preset-manage-list">
            {(state.presets ?? []).map((preset) => localizePreset(preset, t)).map((preset) => (
              <div key={preset.id} className="preset-manage-row">
                <span className="mcp-icon"><Sparkles size={14} /></span>
                <div className="mcp-copy"><strong>{preset.name}</strong><span>{preset.title || t("No role")}</span></div>
                <button
                  type="button"
                  className="link-button is-danger"
                  onClick={() => requestConfirm({
                    title: t("Delete preset?"),
                    body: t("New bot will no longer offer ") + preset.name + t(". Existing bots are not changed."),
                    confirmLabel: t("Delete"),
                    danger: true,
                    onConfirm: () => {
                      void backend.deletePreset(preset.id).catch((cause: unknown) => {
                        toast({ kind: "error", title: t("Preset not deleted"), body: cause instanceof Error ? cause.message : t("Try again.") });
                      });
                    },
                  })}
                >
                  <Trash2 size={12} /> {t("Delete")}
                </button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t("Sidebar")} hint={t("Drag the edge of the sidebar at any time.")}>
        <div className="settings-inline">
          <span className="settings-inline-label">{t("Width")}</span>
          <input
            type="range"
            min={252}
            max={420}
            value={settings.sidebarWidth}
            onChange={(event) => void patchSettings({ sidebarWidth: Number(event.target.value) })}
          />
          <span className="settings-inline-value">{settings.sidebarWidth}px</span>
        </div>
        <div className="row-divider" />
        <div className="settings-inline">
          <span className="settings-inline-label">{t("Accent")}</span>
          <span className="settings-inline-value">{t("Follows the skin")}</span>
        </div>
      </SectionCard>
    </>
  );
}

function ConnectionsSection() {
  const t = useT();
  const { secrets, saveSecret, clearSecret } = useApp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const save = async (name: string) => {
    const value = values[name]?.trim();
    if (!value) return;
    setBusy(name);
    const ok = await saveSecret(name, value);
    setBusy(null);
    if (ok) setValues((previous) => ({ ...previous, [name]: "" }));
  };

  return (
    <>
      <SectionCard title={t("Keys")} hint={t("Stored locally in your Grox workspace. The page only ever sees whether a key exists.")}>
        <div className="key-list">
          {KEY_FIELDS.map((field) => {
            const configured = secrets.configured[field.name];
            return (
              <div className="key-row" key={field.name}>
                <div className="key-head">
                  <div className="key-title">
                    <span className={cn("key-dot", configured && "is-on")} />
                    <span>{t(field.label)}</span>
                    <span className="key-optional">{t("Optional")}</span>
                    {configured && <span className="key-configured">{t("Configured")} {secrets.hints[field.name]}</span>}
                  </div>
                  {configured && (
                    <button type="button" className="link-button danger-text" onClick={() => void clearSecret(field.name)}>{t("Clear")}</button>
                  )}
                </div>
                <p className="key-hint">{t(field.hint)}</p>
                <div className="key-input-row">
                  <div className="input-with-icon">
                    <KeyRound size={14} />
                    <input
                      type={show[field.name] ? "text" : "password"}
                      value={values[field.name] ?? ""}
                      onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
                      onKeyDown={(event) => { if (event.key === "Enter") void save(field.name); }}
                      placeholder={configured ? t("Paste a new key to replace") : t(field.placeholder)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={show[field.name] ? t("Hide key") : t("Show key")}
                    onClick={() => setShow((previous) => ({ ...previous, [field.name]: !previous[field.name] }))}
                  >
                    {show[field.name] ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={!values[field.name]?.trim() || busy === field.name} onClick={() => void save(field.name)}>
                    {busy === field.name ? <Spinner size={13} /> : <Save size={13} />} {t("Save")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>
    </>
  );
}

function EnginesSection() {
  const t = useT();
  const { engines, state, patchSettings, refreshCatalog, providers, setUI, toast } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(state.settings.apiBaseUrl);
  const [apiModel, setApiModel] = useState(state.settings.apiModel);
  const [apiError, setAPIError] = useState("");
  const [apiSaving, setAPISaving] = useState(false);
  const [inputPrice, setInputPrice] = useState(String(state.settings.inputPricePerMillion ?? 0));
  const [outputPrice, setOutputPrice] = useState(String(state.settings.outputPricePerMillion ?? 0));

  useEffect(() => {
    setBaseUrl(state.settings.apiBaseUrl);
    setApiModel(state.settings.apiModel);
    setInputPrice(String(state.settings.inputPricePerMillion ?? 0));
    setOutputPrice(String(state.settings.outputPricePerMillion ?? 0));
  }, [state.settings.apiBaseUrl, state.settings.apiModel, state.settings.inputPricePerMillion, state.settings.outputPricePerMillion]);

  const refresh = async () => {
    setRefreshing(true);
    await refreshCatalog();
    setRefreshing(false);
  };

  const useAPI = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const url = new URL(baseUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch {
      setAPIError(t("Enter an HTTP or HTTPS base URL without credentials, query parameters or a fragment."));
      return;
    }
    if (!apiModel.trim()) { setAPIError(t("Enter the model ID served by this endpoint.")); return; }
    setAPIError("");
    setAPISaving(true);
    try {
      if (await patchSettings({ apiBaseUrl: baseUrl.trim(), apiModel: apiModel.trim(), engineMode: "api" })) {
        toast({ kind: "success", title: t("API settings saved") });
        if (!state.settings.onboarded) setUI({ settingsOpen: false });
      }
    } finally {
      setAPISaving(false);
    }
  };

  return (
    <>
      <SectionCard
        title={t("Local engines")}
        hint={t("Sign in to your CLI before using it in Grox.")}
        action={<button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />} {t("Refresh")}</button>}
      >
        <div className="engine-list">
          {["grok", "claude", "openai", "google"].map((provider) => {
            const engine = engines.find((item) => item.providerId === provider);
            const ready = engine?.status === "ready";
            return (
              <div className="engine-row" key={provider}>
                <span className="engine-mark"><ProviderMark provider={provider} size={18} /></span>
                <span className="engine-copy">
                  <span className="engine-name">{ENGINE_LABEL[provider]}</span>
                  <span className="engine-detail">{ready ? (engine?.version || engine?.command) : t("Not installed")}</span>
                </span>
                <span className={cn("engine-status", ready ? "is-ready" : "is-missing")}>{ready ? t("Installed") : t("Missing")}</span>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title={t("Engine preference")} hint={t("Auto follows each bot's model. Other choices override all bots.")}>
        <Segmented
          label={t("Engine preference")}
          value={state.settings.engineMode}
          options={[
            { value: "auto", label: t("Auto") },
            { value: "demo", label: t("Demo") },
            { value: "grok", label: "Grok" },
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
            { value: "gemini", label: "Gemini" },
            { value: "api", label: "API" },
          ]}
          onChange={(engineMode) => void patchSettings({ engineMode })}
        />
      </SectionCard>

      <SectionCard title={t("OpenAI-compatible API")} hint={t("Use your own endpoint for all bots.")}>
        <form className="settings-form" onSubmit={(event) => void useAPI(event)}>
          <label className="panel-field">
            <span>{t("Base URL")}</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:11434/v1" spellCheck={false} />
          </label>
          <label className="panel-field">
            <span>{t("Model ID")}</span>
            <input value={apiModel} onChange={(event) => setApiModel(event.target.value)} placeholder="qwen3.5:8b" spellCheck={false} />
          </label>
          <div className="settings-form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setUI({ settingsSection: "connections" })}>{t("Manage API keys")}</button>
            <button type="submit" className="btn btn-primary" disabled={apiSaving}><Save size={14} /> {apiSaving ? t("Saving…") : t("Use API for all bots")}</button>
          </div>
          {apiError && <p className="form-error" role="alert">{apiError}</p>}
        </form>
      </SectionCard>

      <SectionCard title={t("Token pricing")} hint={t("Optional USD prices per one million tokens. Grox only uses them to label message cost; it never invents a provider price.")}>
        <div className="settings-form">
          <label className="panel-field">
            <span>{t("Input USD / 1M")}</span>
            <input type="number" min="0" max="10000" step="0.01" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} />
          </label>
          <label className="panel-field">
            <span>{t("Output USD / 1M")}</span>
            <input type="number" min="0" max="10000" step="0.01" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} />
          </label>
          <div className="settings-form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void patchSettings({ inputPricePerMillion: Math.max(0, Number(inputPrice) || 0), outputPricePerMillion: Math.max(0, Number(outputPrice) || 0) })}><Save size={14} /> {t("Save pricing")}</button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("Model catalog")} hint={t("Every model in the picker. A dimmed provider is not connected.")}>
        <div className="catalog-list">
          {providers.map((provider) => (
            <div className="catalog-group" key={provider.id}>
              <div className="catalog-head"><ProviderMark provider={provider.id} size={15} /> {provider.name}<span>{t("{0} models", provider.models.length)}</span></div>
              <div className="catalog-models">
                {provider.models.map((model) => (
                  <span key={model.id} className={cn("catalog-chip", !model.available && "is-dim")}>{t(model.name)}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </>
  );
}

function ComputerSection() {
  const t = useT();
  const { boot, revealDataFolder } = useApp();
  return (
    <>
      <SectionCard title={t("This Mac")} hint={t("Agents run as local processes under your account. Grox does not upload your files.")}>
        <div className="computer-info">
          <span className="computer-info-icon"><Laptop size={22} /></span>
          <div>
            <div className="row-title">{t("Local workspace")}</div>
            <div className="panel-mono">{boot.dataDir}</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={revealDataFolder}><FolderOpen size={14} /> {t("Reveal")}</button>
        </div>
      </SectionCard>
      <SectionCard title={t("Cloud computers")} hint={t("Not included in this build.")}>
        <div className="empty-cloud">
          <Cloud size={24} />
          <div>
            <strong>{t("Cloud computers are intentionally absent.")}</strong>
            <p>{t("The original product this UI is modeled on spins up a remote desktop for each bot. Grox is local-first: the CLI runs on your machine, with your login and your folder. A hosted computer would need a separate service and is not faked here.")}</p>
          </div>
        </div>
      </SectionCard>
      <SectionCard title={t("Safety")} hint={t("The boundaries the app enforces today.")}>
        <ul className="settings-bullets">
          <li><ShieldCheck size={14} /> {t("Approval mode is passed to the CLI; the demo engine asks in-app.")}</li>
          <li><ShieldCheck size={14} /> {t("API keys are written to a 0600 file and never sent back to the page.")}</li>
          <li><ShieldCheck size={14} /> {t("The app never opens a browser or executes a network tool on its own.")}</li>
        </ul>
      </SectionCard>
    </>
  );
}

function DepartmentsSection() {
  const t = useT();
  const { backend, toast, requestConfirm } = useApp();
  const [items, setItems] = useState<Department[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState("");
  const [editName, setEditName] = useState("");

  const load = async () => {
    try {
      setItems(await backend.listDepartments());
    } catch (cause) {
      toast({ kind: "error", title: t("Could not read departments"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await backend.createDepartment(name.trim());
      setName("");
      await load();
    } catch (cause) {
      toast({ kind: "error", title: t("Department not created"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };

  const saveRename = async () => {
    if (!editing || !editName.trim()) return;
    try {
      await backend.renameDepartment(editing, editName.trim());
      setEditing("");
      await load();
    } catch (cause) {
      toast({ kind: "error", title: t("Department not renamed"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };

  const remove = (department: Department) => {
    requestConfirm({
      title: t("Delete department?"),
      body: department.name + t(" will be removed. Its bots move to General."),
      confirmLabel: t("Delete"),
      danger: true,
      onConfirm: () => {
        void backend.deleteDepartment(department.id).then(load).catch((cause: unknown) => {
          toast({ kind: "error", title: t("Department not deleted"), body: cause instanceof Error ? cause.message : t("Try again.") });
        });
      },
    });
  };

  return (
    <SectionCard title={t("Departments")} hint={t("Standalone shelves for the bot roster. Bots keep a department name; deleting a shelf moves its bots to General.")}>
      <div className="inline-field">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("New department")} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} />
        <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={!name.trim()}><Plus size={14} /> {t("Add")}</button>
      </div>
      <div className="department-list">
        {items.map((department) => (
          <div className="department-row" key={department.id}>
            {editing === department.id ? (
              <div className="inline-field">
                <input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(); }} />
                <button type="button" className="btn btn-secondary" onClick={() => void saveRename()}>{t("Save")}</button>
                <button type="button" className="btn btn-ghost" onClick={() => setEditing("")}>{t("Cancel")}</button>
              </div>
            ) : (
              <>
                <div><strong>{department.name === "General" ? t("General") : department.name}</strong><span>{t("{0} bots", department.botCount ?? 0)}</span></div>
                <div className="settings-actions">
                  <button type="button" className="link-button" onClick={() => { setEditing(department.id); setEditName(department.name); }}>{t("Rename")}</button>
                  <button type="button" className="link-button is-danger" onClick={() => remove(department)}>{t("Delete")}</button>
                </div>
              </>
            )}
          </div>
        ))}
        {items.length === 0 && <p className="panel-note">{t("No departments yet.")}</p>}
      </div>
    </SectionCard>
  );
}

function AutomationSection() {
  const t = useT();
  const { backend, toast } = useApp();
  const [info, setInfo] = useState<APIInfo | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setInfo(await backend.getAPIInfo());
    } catch (cause) {
      toast({ kind: "error", title: t("Could not read the automation API"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };
  useEffect(() => { void load(); }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await backend.setAPIEnabled(enabled);
      setInfo(next);
      setToken(next.token ?? "");
      toast({ kind: "success", title: enabled ? t("Automation API enabled") : t("Automation API disabled") });
    } catch (cause) {
      toast({ kind: "error", title: t("Automation API unchanged"), body: cause instanceof Error ? cause.message : t("Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    try {
      const next = await backend.rotateAPIToken();
      setInfo(next);
      setToken(next.token ?? "");
      toast({ kind: "success", title: t("API token rotated"), body: t("The previous token no longer works.") });
    } catch (cause) {
      toast({ kind: "error", title: t("Token not rotated"), body: cause instanceof Error ? cause.message : t("Try again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title={t("Automation API")} hint={t("A loopback JSON API for local scripts and CI. The bearer token is stored in secrets.json and is never loaded into a bot prompt.")}>
      <div className="switch-row">
        <span className="row-copy">
          <span className="row-title">{t("Enable the loopback API")}</span>
          <span className="row-sub">{t("127.0.0.1 only. Every request needs Authorization: Bearer <token>.")}</span>
        </span>
        <Switch checked={Boolean(info?.enabled)} label={t("Enable automation API")} onChange={(value) => void toggle(value)} disabled={busy} />
      </div>
      {info?.error && <p className="panel-note is-warning">{info.error}</p>}
      {info?.url && <code className="webhook-base">{info.url}</code>}
      {token && (
        <label className="panel-field">
          <span>{t("New token (shown once)")}</span>
          <div className="inline-field">
            <input readOnly value={token} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="btn btn-secondary" onClick={() => { void navigator.clipboard?.writeText(token); toast({ kind: "success", title: t("Token copied") }); }}>{t("Copy")}</button>
          </div>
        </label>
      )}
      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" onClick={() => void rotate()} disabled={busy || !info?.enabled}>{t("Rotate token")}</button>
      </div>
      <div className="settings-callout">
        <Terminal size={14} />
        <span>{t("GET /v1/state, GET /v1/bots, and POST /v1/bots/<id>/threads/<id>/messages. This is a local control surface, not a hosted service.")}</span>
      </div>
    </SectionCard>
  );
}

function PhoneSection() {
  const t = useT();
  const { phone, setPhoneEnabled, toast } = useApp();
  const [busy, setBusy] = useState(false);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    await setPhoneEnabled(enabled);
    setBusy(false);
  };
  const copy = () => {
    if (!phone.url) return;
    void navigator.clipboard?.writeText(phone.url);
    toast({ kind: "success", title: t("Phone link copied") });
  };

  return (
    <>
      <SectionCard title={t("Phone companion")} hint={t("A small web chat for a phone on the same Wi-Fi. The desktop app stays open and owns the workspace.")}>
        <div className="settings-form">
          <div className="switch-row">
            <span className="row-copy">
              <span className="row-title">{t("Local phone link")}</span>
              <span className="row-sub">{t("Serves a private page on this Mac's network address.")}</span>
            </span>
            <Switch checked={phone.enabled} label={t("Local phone link")} onChange={(value) => void toggle(value)} disabled={busy} />
          </div>
          {phone.error && <p className="settings-note is-error">{phone.error}</p>}
          {phone.enabled && phone.url ? (
            <>
              {phone.qr && <img className="phone-qr" src={phone.qr} alt={t("QR code for the phone companion link")} />}
              <label className="panel-field">
                <span>{t("Open on your phone")}</span>
                <div className="phone-url-row">
                  <code className="phone-url">{phone.url}</code>
                  <button type="button" className="btn btn-secondary" onClick={copy}>{t("Copy")}</button>
                </div>
              </label>
              <p className="phone-warning">{t("Anyone with this link on the same network can read and send these conversations. Turn it off when you are done.")}</p>
              <p className="settings-note">{t("Connected phones:")} {phone.connected}{t(". The link uses plain HTTP on your local network; it is not exposed to the internet by Grox.")}</p>
            </>
          ) : (
            <p className="settings-note">{t("Turn the link on, then open the address on a phone that is on the same Wi-Fi. No account, QR service, or cloud relay is involved.")}</p>
          )}
        </div>
      </SectionCard>
      <SectionCard title={t("What the phone can do")} hint={t("A deliberately small surface.")}>
        <ul className="phone-list">
          <li>{t("See the bot roster and channels.")}</li>
          <li>{t("Read the latest conversation.")}</li>
          <li>{t("Send a message and receive the streaming reply.")}</li>
          <li>{t("Open the page from any browser; no app install.")}</li>
        </ul>
        <p className="settings-note">{t("Approval cards and computer controls stay on the desktop app. The phone page cannot read local files or run commands.")}</p>
      </SectionCard>
    </>
  );
}

function VoiceSection() {
  const t = useT();
  const { state, patchSettings, toast } = useApp();
  const [voiceName, setVoiceName] = useState(state.settings.voiceName ?? "");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
  }, []);

  const test = () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      toast({ kind: "error", title: t("No system voice available") });
      return;
    }
    speak(t("This is how a Grox reply sounds on this machine."), voiceName);
  };

  return (
    <>
      <SectionCard title={t("System voice")} hint={t("Grox uses the voices already installed on this machine. A bot can override this in its profile.")}>
        <div className="settings-form">
          <label className="panel-field">
            <span>{t("Default voice")}</span>
            <select
              value={voiceName}
              onChange={(event) => {
                setVoiceName(event.target.value);
                void patchSettings({ voiceName: event.target.value });
              }}
            >
              <option value="">{t("System default")}</option>
              {voices.map((voice) => <option key={voice.name} value={voice.name}>{voice.name} · {voice.lang}</option>)}
            </select>
          </label>
          <div className="settings-form-actions">
            <button type="button" className="btn btn-secondary" onClick={test}><Play size={14} /> {t("Test voice")}</button>
          </div>
        </div>
      </SectionCard>
      <SectionCard title={t("Voice calls")} hint={t("A local, speech-to-speech call mode — no call transport and no speech service in the middle.")}>
        <p className="settings-note">
          {t("Start a call from the phone button in any conversation. Grox listens through the system speech-recognition service, sends the transcript to the bot, and speaks the reply with the voice above. The microphone is used only while the call or dictation button is active. Availability of live listening depends on the webview; typing in the call sheet always works.")}
        </p>
      </SectionCard>
    </>
  );
}

function MCPEditor({ server, open, onClose, onSaved }: {
  server: MCPServer | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { backend, toast, state } = useApp();
  const [name, setName] = useState(server?.name ?? "");
  const [mcpBotIDs, setMcpBotIDs] = useState<string[]>(server?.botIds ?? []);
  const [transport, setTransport] = useState<"http" | "stdio">(server?.transport === "stdio" ? "stdio" : "http");
  const [url, setUrl] = useState(server?.url ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState("");
  const [oauthTokenURL, setOAuthTokenURL] = useState(server?.oauthTokenUrl ?? "");
  const [oauthAuthorizationURL, setOAuthAuthorizationURL] = useState(server?.oauthAuthorizationUrl ?? "");
  const [oauthClientID, setOAuthClientID] = useState("");
  const [oauthClientSecret, setOAuthClientSecret] = useState("");
  const [oauthScopes, setOAuthScopes] = useState("");
  const [oauthRefreshToken, setOAuthRefreshToken] = useState("");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setMcpBotIDs(server?.botIds ?? []);
    setTransport(server?.transport === "stdio" ? "stdio" : "http");
    setUrl(server?.url ?? "");
    setCommand(server?.command ?? "");
    setArgs((server?.args ?? []).join("\n"));
    setToken("");
    setHeaders("");
    setOAuthTokenURL(server?.oauthTokenUrl ?? "");
    setOAuthAuthorizationURL(server?.oauthAuthorizationUrl ?? "");
    setOAuthClientID("");
    setOAuthClientSecret("");
    setOAuthScopes("");
    setOAuthRefreshToken("");
    setEnabled(server?.enabled ?? true);
    setError("");
    setBusy(false);
  }, [open, server?.id]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t("Give the server a name."));
      return;
    }
    if (transport === "http" && !url.trim()) {
      setError(t("Enter a full MCP URL."));
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      setError(t("Enter the local MCP command."));
      return;
    }
    const argList = args.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const headerMap: Record<string, string> = {};
    for (const line of headers.split("\n")) {
      const separator = line.indexOf(":");
      if (separator < 1) continue;
      headerMap[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    setBusy(true);
    try {
      if (server) {
        await backend.updateMCPServer(server.id, {
          name: name.trim(), transport, enabled,
          ...(transport === "stdio" ? { command: command.trim(), args: argList, botIds: mcpBotIDs } : { url: url.trim(), botIds: mcpBotIDs }),
          ...(transport === "http" && token.trim() ? { token: token.trim() } : {}),
          ...(transport === "http" && headers.trim() ? { headers: headerMap } : {}),
          ...(transport === "http" ? {
            oauthTokenUrl: oauthTokenURL.trim(),
            oauthAuthorizationUrl: oauthAuthorizationURL.trim(),
            oauthClientId: oauthClientID.trim(),
            oauthClientSecret,
            oauthScopes: oauthScopes.trim(),
            oauthRefreshToken,
          } : {}),
        });
      } else {
        await backend.createMCPServer({
          name: name.trim(), transport, enabled,
          ...(transport === "stdio" ? { command: command.trim(), args: argList, botIds: mcpBotIDs } : { url: url.trim(), token: token.trim(), headers: headerMap, botIds: mcpBotIDs, oauthTokenUrl: oauthTokenURL.trim(), oauthAuthorizationUrl: oauthAuthorizationURL.trim(), oauthClientId: oauthClientID.trim(), oauthClientSecret, oauthScopes: oauthScopes.trim(), oauthRefreshToken }),
        });
      }
      onSaved();
      onClose();
      toast({ kind: "success", title: server ? t("MCP server updated") : t("MCP server added") });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not save the MCP server."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={server ? t("Edit MCP server") : t("Add MCP server")} width={620}>
      <form className="routine-form" onSubmit={submit}>
        <div className="form-two">
          <label className="panel-field">
            <span>{t("Name")}</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="linear" />
          </label>
          <label className="panel-field">
            <span>{t("Enabled")}</span>
            <div className="switch-row-inline"><Switch checked={enabled} label={t("Enable MCP server")} onChange={setEnabled} /></div>
          </label>
        </div>
        <div className="panel-field">
          <span>{t("Transport")}</span>
          <Segmented
            label={t("MCP transport")}
            value={transport}
            options={[{ value: "http", label: "HTTP" }, { value: "stdio", label: t("Local command") }]}
            onChange={(value) => setTransport(value as "http" | "stdio")}
          />
        </div>
        {transport === "http" ? (
          <>
            <label className="panel-field">
              <span>{t("Streamable HTTP URL")}</span>
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
            </label>
            <label className="panel-field">
              <span>{t("Bearer token (optional)")}</span>
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={server?.authConfigured ? t("Configured; leave blank to keep") : t("Stored in secrets.json")} autoComplete="off" />
            </label>
            <label className="panel-field">
              <span>{t("Additional headers (optional)")}</span>
              <textarea rows={2} value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={"X-API-Key: ...\nX-Org: ..."} spellCheck={false} />
            </label>
            {server?.headerNames?.length ? <p className="panel-note">{t("Existing headers:")} {server.headerNames.join(", ")}{t(". Enter values only to replace all headers.")}</p> : null}
            <div className="mcp-oauth">
              <span className="panel-note">{t("OAuth client credentials (optional). When a token URL is set, Grox fetches a bearer token and ignores the static bearer field.")}</span>
              <label className="panel-field">
                <span>{t("OAuth token URL")}</span>
                <input value={oauthTokenURL} onChange={(event) => setOAuthTokenURL(event.target.value)} placeholder="https://auth.example.com/oauth/token" spellCheck={false} />
              </label>
              <label className="panel-field">
                <span>{t("OAuth authorization URL")}</span>
                <input value={oauthAuthorizationURL} onChange={(event) => setOAuthAuthorizationURL(event.target.value)} placeholder="https://auth.example.com/oauth/authorize" spellCheck={false} />
              </label>
              <div className="form-two">
                <label className="panel-field">
                  <span>{t("OAuth client ID")}</span>
                  <input value={oauthClientID} onChange={(event) => setOAuthClientID(event.target.value)} placeholder={server?.oauthConfigured ? t("Configured; leave blank to keep") : t("Client ID")} spellCheck={false} />
                </label>
                <label className="panel-field">
                  <span>{t("OAuth client secret")}</span>
                  <input type="password" value={oauthClientSecret} onChange={(event) => setOAuthClientSecret(event.target.value)} placeholder={server?.oauthConfigured ? t("Configured; leave blank to keep") : t("Optional for public clients")} autoComplete="off" />
                </label>
              </div>
              {server?.oauthConfigured && (
                <button type="button" className="btn btn-secondary" onClick={() => {
                  void backend.beginMCPOAuth(server.id).then((start) => {
                    window.open(start.url, "_blank", "noopener,noreferrer");
                    toast({ kind: "info", title: t("OAuth opened"), body: t("Finish authorization in the browser; this window will pick up the new token.") });
                  }).catch((cause: unknown) => {
                    toast({ kind: "error", title: t("OAuth could not start"), body: cause instanceof Error ? cause.message : t("Try again.") });
                  });
                }}>{t("Authorize in browser")}</button>
              )}
              <label className="panel-field">
                <span>{t("OAuth scopes")}</span>
                <input value={oauthScopes} onChange={(event) => setOAuthScopes(event.target.value)} placeholder={t("optional, space-separated")} spellCheck={false} />
              </label>
              <label className="panel-field">
                <span>{t("OAuth refresh token")}</span>
                <input type="password" value={oauthRefreshToken} onChange={(event) => setOAuthRefreshToken(event.target.value)} placeholder={server?.oauthConfigured ? t("Configured; leave blank to keep") : t("Optional refresh token")} autoComplete="off" />
              </label>
            </div>
          </>
        ) : (
          <>
            <label className="panel-field">
              <span>{t("Command")}</span>
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="/usr/local/bin/mcp-server" spellCheck={false} />
            </label>
            <label className="panel-field">
              <span>{t("Arguments (one per line)")}</span>
              <textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} placeholder={"--stdio\n--profile\nwork"} spellCheck={false} />
            </label>
          </>
        )}
        <div className="panel-field">
          <span>{t("Applies to")}</span>
          <div className="mcp-bot-scope">
            {state.bots.map((bot) => {
              const checked = mcpBotIDs.includes(bot.id);
              return (
                <label key={bot.id} className="mcp-bot-scope-row">
                  <input type="checkbox" checked={checked} onChange={(event) => setMcpBotIDs((current) => event.target.checked ? [...current, bot.id] : current.filter((id) => id !== bot.id))} />
                  <span>{bot.name}</span>
                </label>
              );
            })}
          </div>
          <p className="panel-note">{t("No selection means all bots. This only filters the per-turn CLI config; it is not an access control boundary.")}</p>
        </div>
        <p className="panel-note">{t("HTTP tokens are stored in the 0600 secrets file, never in AppState or the page. A local command is launched by the selected CLI, not by Grox; only enable a command you trust. Servers are enabled per turn only when this switch is on.")}</p>
        {error && <p className="panel-note is-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t("Saving…") : t("Save server")}</button>
        </div>
      </form>
    </Modal>
  );
}

function MCPSection() {
  const t = useT();
  const { backend, toast, requestConfirm } = useApp();
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MCPServer | undefined>();

  const load = async () => {
    setLoading(true);
    try {
      setServers(await backend.listMCPServers());
    } catch (cause) {
      toast({ kind: "error", title: t("Could not read MCP servers"), body: cause instanceof Error ? cause.message : t("Try again.") });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const toggle = async (server: MCPServer, enabled: boolean) => {
    try {
      await backend.updateMCPServer(server.id, { enabled });
      await load();
    } catch (cause) {
      toast({ kind: "error", title: t("MCP server not updated"), body: cause instanceof Error ? cause.message : t("Try again.") });
    }
  };

  const remove = (server: MCPServer) => {
    requestConfirm({
      title: t("Delete MCP server?"),
      body: server.name + t(" will stop being added to new CLI turns. Its stored token is removed."),
      confirmLabel: t("Delete"),
      danger: true,
      onConfirm: () => {
        void backend.deleteMCPServer(server.id).then(load).catch((cause: unknown) => {
          toast({ kind: "error", title: t("MCP server not deleted"), body: cause instanceof Error ? cause.message : t("Try again.") });
        });
      },
    });
  };

  return (
    <>
      <SectionCard
        title={t("Remote MCP servers")}
        hint={t("Add a streamable-HTTP MCP server to every CLI turn. Grox never installs or executes a local MCP command.")}
        action={<button type="button" className="btn btn-secondary" onClick={() => { setEditing(undefined); setEditorOpen(true); }}><Plus size={14} /> {t("Add server")}</button>}
      >
        {loading ? <p className="panel-note">{t("Reading servers…")}</p> : servers.length === 0 ? (
          <p className="panel-note">{t("No remote MCP servers. The per-turn Composio gateway and ask_user tool are still available.")}</p>
        ) : (
          <div className="mcp-list">
            {servers.map((server) => (
              <div key={server.id} className={cn("mcp-row", server.enabled && "is-enabled")}>
                <span className="mcp-icon"><Plug size={15} /></span>
                <div className="mcp-copy">
                  <strong>{server.name}</strong>
                  <span>{server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url}</span>
                  <small>{server.transport === "stdio" ? t("Local command") : (server.botIds?.length ?? 0) > 0 ? (server.botIds?.length + " bot(s)") : server.oauthConfigured ? t("OAuth client credentials") : (server.headerNames?.length ?? 0) > 0 ? (server.headerNames?.length + t(" header(s) configured")) : server.authConfigured ? t("Bearer token configured") : t("No auth headers")}</small>
                  {!!server.requiredHeaders?.length && <small>{t("Requested headers:")} {server.requiredHeaders.join(", ")}</small>}
                </div>
                <Switch checked={server.enabled} label={t("Enable ") + server.name} onChange={(value) => void toggle(server, value)} />
                <button type="button" className="link-button" onClick={() => { setEditing(server); setEditorOpen(true); }}>{t("Edit")}</button>
                <button type="button" className="link-button is-danger" onClick={() => remove(server)}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <MCPEditor server={editing} open={editorOpen} onClose={() => setEditorOpen(false)} onSaved={() => void load()} />
    </>
  );
}

const grokExportPrompt = `Give me a machine-readable copy of this Grok Bot. Keep the bot, its skills and routines unchanged.

Output JSON with this shape:
{
  "format": "grok-bot-export",
  "version": 1,
  "bots": [{
    "name": "", "title": "", "description": "", "instructions": "",
    "memories": [], "user_facts": [],
    "skills": [{"name": "", "description": "", "instructions": ""}],
    "routines": [{"name": "", "instruction": "", "trigger": "", "schedule_cron": "", "schedule_text": "", "timezone": "", "trigger_details": ""}],
    "apps": [{"name": "", "mcp_url": ""}]
  }]
}

Include full instructions, all enabled skills, and scheduled or paused routines. Omit keys, passwords, cookies and private URLs. Leave unknown fields empty. If needed, split the export into multiple complete JSON documents using the same bot name.`;

function DataSection() {
  const t = useT();
  const { boot, exportWorkspace, resetWorkspace, revealDataFolder, backend, toast } = useApp();
  const importRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [teamImport, setTeamImport] = useState<TeamImportResult | null>(null);
  const [grokReply, setGrokReply] = useState("");

  const importTeam = async (read: () => Promise<string>) => {
    if (importing) return;
    setImporting(true);
    setTeamImport(null);
    try {
      const result = await backend.importTeam(await read());
      setTeamImport(result);
      toast({ kind: "success", title: result.bots > 0 ? t("Team package imported") : t("These bots were already imported") });
    } catch (cause) {
      toast({ kind: "error", title: t("Could not import the team"), body: cause instanceof Error ? cause.message : t("Try again.") });
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
  };
  const importFiles = (files: File[]) => {
    if (files.length === 0) return;
    void importTeam(async () => {
      if (files.reduce((size, file) => size + file.size, 0) > 4 * 1024 * 1024) throw new Error(t("Choose files totaling at most 4 MB."));
      const texts = await Promise.all(files.map((file) => file.text()));
      if (texts.length > 1 && texts.some((text) => /^\s*---|["']format["']\s*:\s*["'](?:grox\.team|openmaus\.package)["']/.test(text))) {
        throw new Error(t("Choose one team package at a time. Grok Bot export parts can be added together."));
      }
      return texts.join("\n");
    });
  };
  const copyGrokPrompt = async () => {
    try {
      await navigator.clipboard.writeText(grokExportPrompt);
      toast({ kind: "success", title: t("Export prompt copied") });
    } catch {
      toast({ kind: "error", title: t("Could not copy. Select the prompt below.") });
    }
  };
  return (
    <>
      <SectionCard title={t("Workspace")} hint={t("The single JSON document that holds bots, conversations, routines, and connections.")}>
        <div className="data-row">
          <span className="data-label">{t("Location")}</span>
          <span className="panel-mono">{boot.dataDir}</span>
          <button type="button" className="btn btn-secondary" onClick={revealDataFolder}><FolderOpen size={14} /> {t("Reveal")}</button>
        </div>
        <div className="row-divider" />
        <div className="data-row">
          <span className="data-label">{t("Version")}</span>
          <span>{boot.version}</span>
        </div>
        <div className="row-divider" />
        <div className="data-row">
          <span className="data-label">{t("Export")}</span>
          <span className="data-hint">{t("A readable JSON copy, without keys.")}</span>
          <button type="button" className="btn btn-secondary" onClick={() => void exportWorkspace()}>{t("Export workspace")}</button>
        </div>
      </SectionCard>
      <SectionCard title={t("Team packages")} hint={t("Import a Grox or OpenMaus JSON file, a BotMRR blueprint, or a Grok Bot export.")}>
        <div className="data-row">
          <span className="data-label">{t("Import")}</span>
          <span className="data-hint">{t("New bots start on Ask, with routines paused and skills disabled.")}</span>
          <button type="button" className="btn btn-secondary" disabled={importing} onClick={() => importRef.current?.click()}>
            {importing ? <Spinner size={14} /> : <Upload size={14} />} {importing ? t("Importing…") : t("Import team")}
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".json,.md,.txt,application/json,text/plain,text/markdown"
            multiple
            className="sr-only"
            onChange={(event) => importFiles(Array.from(event.target.files ?? []))}
          />
        </div>
        <details>
          <summary>{t("Move from Grok Bot")}</summary>
          <label className="panel-field">
            <span>{t("Export prompt")}</span>
            <textarea rows={4} readOnly value={grokExportPrompt} />
          </label>
          <button type="button" className="btn btn-secondary" onClick={() => void copyGrokPrompt()}>{t("Copy prompt")}</button>
          <label className="panel-field">
            <span>{t("Grok Bot replies")}</span>
            <textarea rows={5} value={grokReply} onChange={(event) => setGrokReply(event.target.value)} />
          </label>
          <button type="button" className="btn btn-secondary" disabled={importing || !grokReply.trim()} onClick={() => void importTeam(async () => grokReply)}>
            {t("Import Grok Bot")}
          </button>
        </details>
        {teamImport && (
          <>
            <div className="row-divider" />
            <div className="data-row" role="status">
              <span className="data-label">{teamImport.name}</span>
              <span className="data-hint">
                {teamImport.bots} {t("bots ·")} {teamImport.groups} {t("channels ·")} {teamImport.routines} {t("paused routines ·")} {teamImport.skills} {t("skills ·")} {teamImport.memories} notes
                {teamImport.playbooks ? " · " + teamImport.playbooks + " playbooks" : ""}
                {teamImport.connections ? " · " + teamImport.connections + t(" disabled connections") : ""}
              </span>
            </div>
            {teamImport.warnings?.length ? (
              <ul className="about-note">
                {teamImport.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
              </ul>
            ) : null}
          </>
        )}
      </SectionCard>
      <SectionCard title={t("Reset")} hint={t("Replace the workspace with the first-run team. Keys are kept.")}>
        <div className="data-row">
          <span className="data-label">{t("Danger zone")}</span>
          <span className="data-hint">{t("This removes every conversation and routine you have made.")}</span>
          <button type="button" className="btn btn-danger" onClick={() => resetWorkspace()}><Trash2 size={14} /> {t("Reset workspace")}</button>
        </div>
      </SectionCard>
    </>
  );
}

function AboutSection() {
  const t = useT();
  const { boot, patchSettings, setUI } = useApp();
  return (
    <div className="about">
      <GroxLogo size={64} />
      <h2>Grox</h2>
      <p className="about-version">{t("Version")} {boot.version} · {boot.platform}</p>
      <p className="about-copy">
        {t("A local-first chat app for a team of AI agents. Each bot has a personality, a model, its own conversations, an approval boundary, and a deterministic 1-bit portrait generated from its name. Built with Go and MyGo.")}
      </p>
      <div className="about-meta">
        <div><span>{t("Runtime")}</span><span>Go · MyGo</span></div>
        <div><span>{t("Frontend")}</span><span>React · Vite</span></div>
        <div><span>{t("License")}</span><span>Apache-2.0</span></div>
        <div><span>{t("Data")}</span><span>{t("On this machine")}</span></div>
      </div>
      <p className="about-note">{t("Grox is an independent project. Portraits are generated locally from each bot’s name.")}</p>
      <button type="button" className="btn btn-secondary" onClick={() => { void patchSettings({ onboarded: false }); setUI({ settingsOpen: false }); }}>{t("Show welcome again")}</button>
    </div>
  );
}

export function SettingsModal() {
  const t = useT();
  const { ui, setUI, state, boot, refreshCatalog } = useApp();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!ui.settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUI({ settingsOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui.settingsOpen, setUI]);

  if (!ui.settingsOpen) return null;
  const section = ui.settingsSection;
  const sectionLabel = SECTIONS.find((item) => item.id === section)?.label ?? t("Settings");

  const refresh = async () => {
    setRefreshing(true);
    await refreshCatalog();
    setRefreshing(false);
  };

  return (
    <div className="modal-layer settings-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUI({ settingsOpen: false }); }}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label={t("Settings")}>
        <aside className="settings-nav">
          <h2>{t("Settings")}</h2>
          <nav>
            {SECTIONS.map((item) => (
              <button key={item.id} type="button" className={cn("settings-nav-row", section === item.id && "is-active")} onClick={() => setUI({ settingsSection: item.id })}>
                {item.icon}
                <span>{t(item.label)}</span>
                <ChevronRight size={14} className="settings-nav-chevron" />
              </button>
            ))}
          </nav>
          <div className="settings-nav-foot">
            <GroxLogo size={22} />
            <span>Grox {boot.version}</span>
            <button type="button" className="icon-button" title={t("Refresh engines")} aria-label={t("Refresh engines")} onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
            </button>
          </div>
        </aside>
        <section className="settings-content">
          <header className="settings-head">
            <h1>{t(sectionLabel)}</h1>
            <button type="button" className="icon-button" aria-label={t("Close settings")} onClick={() => setUI({ settingsOpen: false })}><X size={18} /></button>
          </header>
          <div className="settings-scroll">
            {section === "general" && <GeneralSection />}
            {section === "connections" && <ConnectionsSection />}
            {section === "engines" && <EnginesSection />}
            {section === "computer" && <ComputerSection />}
            {section === "phone" && <PhoneSection />}
            {section === "automation" && <AutomationSection />}
            {section === "departments" && <DepartmentsSection />}
            {section === "voice" && <VoiceSection />}
            {section === "data" && <DataSection />}
            {section === "about" && <AboutSection />}
          </div>
        </section>
      </div>
    </div>
  );
}
