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
import type { APIInfo, Department, MCPServer, Settings } from "@/lib/bridge";

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
  { name: "openai", label: "OpenAI API key", hint: "Used by the Codex engine.", placeholder: "sk-…" },
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
  const { state, patchSettings, backend, toast, requestConfirm } = useApp();
  const settings = state.settings;
  return (
    <>
      <SectionCard title="Appearance" hint="The skin changes every surface, including menus and the transcript.">
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
              <span>{skin.label}</span>
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="New bot presets" hint="Persona-only starting points. Model, folder, approval and credentials are never copied.">
        {(state.presets ?? []).length === 0 ? (
          <p className="panel-note">No presets. Open a bot profile and choose Save as preset.</p>
        ) : (
          <div className="preset-manage-list">
            {(state.presets ?? []).map((preset) => (
              <div key={preset.id} className="preset-manage-row">
                <span className="mcp-icon"><Sparkles size={14} /></span>
                <div className="mcp-copy"><strong>{preset.name}</strong><span>{preset.title || "No role"}</span></div>
                <button
                  type="button"
                  className="link-button is-danger"
                  onClick={() => requestConfirm({
                    title: "Delete preset?",
                    body: "New bot will no longer offer " + preset.name + ". Existing bots are not changed.",
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm: () => {
                      void backend.deletePreset(preset.id).catch((cause: unknown) => {
                        toast({ kind: "error", title: "Preset not deleted", body: cause instanceof Error ? cause.message : "Try again." });
                      });
                    },
                  })}
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Interface" hint="Grox starts with the whole surface visible. Advanced mode adds engine and routing detail.">
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">Advanced mode</span>
            <span className="row-sub">Show model routing, engine detail, and activity panels.</span>
          </span>
          <Switch checked={settings.advanced} label="Advanced mode" onChange={(advanced) => void patchSettings({ advanced })} />
        </div>
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">Reduce motion</span>
            <span className="row-sub">Stop message arrival and interface animations.</span>
          </span>
          <Switch checked={settings.reduceMotion} label="Reduce motion" onChange={(reduceMotion) => void patchSettings({ reduceMotion })} />
        </div>
        <div className="row-divider" />
        <div className="switch-row">
          <span className="row-copy">
            <span className="row-title">Notifications</span>
            <span className="row-sub">Notify you when a background task finishes.</span>
          </span>
          <Switch checked={settings.notifications} label="Notifications" onChange={(notifications) => {
            if (notifications && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
            void patchSettings({ notifications });
          }} />
        </div>
      </SectionCard>

      <SectionCard title="Sidebar" hint="Drag the edge of the sidebar at any time.">
        <div className="settings-inline">
          <span className="settings-inline-label">Width</span>
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
          <span className="settings-inline-label">Accent</span>
          <span className="settings-inline-value">Follows the skin</span>
        </div>
      </SectionCard>
    </>
  );
}

function ConnectionsSection() {
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
      <SectionCard title="Keys" hint="Stored locally in your Grox workspace. The page only ever sees whether a key exists.">
        <div className="key-list">
          {KEY_FIELDS.map((field) => {
            const configured = secrets.configured[field.name];
            return (
              <div className="key-row" key={field.name}>
                <div className="key-head">
                  <div className="key-title">
                    <span className={cn("key-dot", configured && "is-on")} />
                    <span>{field.label}</span>
                    <span className="key-optional">optional</span>
                    {configured && <span className="key-configured">Configured {secrets.hints[field.name]}</span>}
                  </div>
                  {configured && (
                    <button type="button" className="link-button danger-text" onClick={() => void clearSecret(field.name)}>Clear</button>
                  )}
                </div>
                <p className="key-hint">{field.hint}</p>
                <div className="key-input-row">
                  <div className="input-with-icon">
                    <KeyRound size={14} />
                    <input
                      type={show[field.name] ? "text" : "password"}
                      value={values[field.name] ?? ""}
                      onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
                      onKeyDown={(event) => { if (event.key === "Enter") void save(field.name); }}
                      placeholder={configured ? "Paste a new key to replace" : field.placeholder}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={show[field.name] ? "Hide key" : "Show key"}
                    onClick={() => setShow((previous) => ({ ...previous, [field.name]: !previous[field.name] }))}
                  >
                    {show[field.name] ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={!values[field.name]?.trim() || busy === field.name} onClick={() => void save(field.name)}>
                    {busy === field.name ? <Spinner size={13} /> : <Save size={13} />} Save
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>
      <SectionCard title="Connected apps" hint="A Composio project key turns the Connected apps page into real OAuth links and a live tool runner. Without it, no account is marked connected.">
        <p className="settings-note">Keys never leave this machine. For a real app session, add the Composio key above and wire the connector in a later iteration.</p>
      </SectionCard>
    </>
  );
}

function EnginesSection() {
  const { engines, state, patchSettings, refreshCatalog, providers } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(state.settings.apiBaseUrl);
  const [apiModel, setApiModel] = useState(state.settings.apiModel);
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

  const saveAPI = () => {
    void patchSettings({ apiBaseUrl: baseUrl.trim(), apiModel: apiModel.trim() });
  };

  return (
    <>
      <SectionCard
        title="Local engines"
        hint="Grox uses the agent CLIs installed on this Mac, with their own logins. An installed CLI may still need signing in."
        action={<button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />} Refresh</button>}
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
                  <span className="engine-detail">{ready ? (engine?.version || engine?.command) : "Not installed · connect a key or install the CLI"}</span>
                </span>
                <span className={cn("engine-status", ready ? "is-ready" : "is-missing")}>{ready ? "Installed" : "Missing"}</span>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="Engine preference" hint="Auto uses the engine behind the bot's model. Pick one engine to route every bot there.">
        <Segmented
          label="Engine preference"
          value={state.settings.engineMode}
          options={[
            { value: "auto", label: "Auto" },
            { value: "demo", label: "Demo" },
            { value: "grok", label: "Grok" },
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
            { value: "gemini", label: "Gemini" },
            { value: "api", label: "API" },
          ]}
          onChange={(engineMode) => void patchSettings({ engineMode })}
        />
        <p className="settings-note">
          Approval stays honest: Ask installs a per-turn tool hook and gates every tool through a Grox card. Auto accepts edits, Full bypasses the CLI's own checks. The app itself also asks before the demo engine touches anything.
        </p>
      </SectionCard>

      <SectionCard title="OpenAI-compatible API" hint="Use a gateway, a local Ollama/LM Studio server, or an OpenAI/xAI key.">
        <div className="settings-form">
          <label className="panel-field">
            <span>Base URL</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:11434/v1" spellCheck={false} />
          </label>
          <label className="panel-field">
            <span>Model ID</span>
            <input value={apiModel} onChange={(event) => setApiModel(event.target.value)} placeholder="qwen3.5:8b" spellCheck={false} />
          </label>
          <div className="settings-form-actions">
            <button type="button" className="btn btn-primary" onClick={saveAPI}><Save size={14} /> Save API settings</button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Token pricing" hint="Optional USD prices per one million tokens. Grox only uses them to label message cost; it never invents a provider price.">
        <div className="settings-form">
          <label className="panel-field">
            <span>Input USD / 1M</span>
            <input type="number" min="0" max="10000" step="0.01" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} />
          </label>
          <label className="panel-field">
            <span>Output USD / 1M</span>
            <input type="number" min="0" max="10000" step="0.01" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} />
          </label>
          <div className="settings-form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void patchSettings({ inputPricePerMillion: Math.max(0, Number(inputPrice) || 0), outputPricePerMillion: Math.max(0, Number(outputPrice) || 0) })}><Save size={14} /> Save pricing</button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Model catalog" hint="Every model in the picker. A dimmed provider is not connected.">
        <div className="catalog-list">
          {providers.map((provider) => (
            <div className="catalog-group" key={provider.id}>
              <div className="catalog-head"><ProviderMark provider={provider.id} size={15} /> {provider.name}<span>{provider.models.length} models</span></div>
              <div className="catalog-models">
                {provider.models.map((model) => (
                  <span key={model.id} className={cn("catalog-chip", !model.available && "is-dim")}>{model.name}</span>
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
  const { boot, revealDataFolder } = useApp();
  return (
    <>
      <SectionCard title="This Mac" hint="Agents run as local processes under your account. Grox does not upload your files.">
        <div className="computer-info">
          <span className="computer-info-icon"><Laptop size={22} /></span>
          <div>
            <div className="row-title">Local workspace</div>
            <div className="panel-mono">{boot.dataDir}</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={revealDataFolder}><FolderOpen size={14} /> Reveal</button>
        </div>
      </SectionCard>
      <SectionCard title="Cloud computers" hint="Not included in this build.">
        <div className="empty-cloud">
          <Cloud size={24} />
          <div>
            <strong>Cloud computers are intentionally absent.</strong>
            <p>The original product this UI is modeled on spins up a remote desktop for each bot. Grox is local-first: the CLI runs on your machine, with your login and your folder. A hosted computer would need a separate service and is not faked here.</p>
          </div>
        </div>
      </SectionCard>
      <SectionCard title="Safety" hint="The boundaries the app enforces today.">
        <ul className="settings-bullets">
          <li><ShieldCheck size={14} /> Approval mode is passed to the CLI; the demo engine asks in-app.</li>
          <li><ShieldCheck size={14} /> API keys are written to a 0600 file and never sent back to the page.</li>
          <li><ShieldCheck size={14} /> The app never opens a browser or executes a network tool on its own.</li>
        </ul>
      </SectionCard>
    </>
  );
}

function DepartmentsSection() {
  const { backend, toast, requestConfirm } = useApp();
  const [items, setItems] = useState<Department[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState("");
  const [editName, setEditName] = useState("");

  const load = async () => {
    try {
      setItems(await backend.listDepartments());
    } catch (cause) {
      toast({ kind: "error", title: "Could not read departments", body: cause instanceof Error ? cause.message : "Try again." });
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
      toast({ kind: "error", title: "Department not created", body: cause instanceof Error ? cause.message : "Try again." });
    }
  };

  const saveRename = async () => {
    if (!editing || !editName.trim()) return;
    try {
      await backend.renameDepartment(editing, editName.trim());
      setEditing("");
      await load();
    } catch (cause) {
      toast({ kind: "error", title: "Department not renamed", body: cause instanceof Error ? cause.message : "Try again." });
    }
  };

  const remove = (department: Department) => {
    requestConfirm({
      title: "Delete department?",
      body: department.name + " will be removed. Its bots move to General.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        void backend.deleteDepartment(department.id).then(load).catch((cause: unknown) => {
          toast({ kind: "error", title: "Department not deleted", body: cause instanceof Error ? cause.message : "Try again." });
        });
      },
    });
  };

  return (
    <SectionCard title="Departments" hint="Standalone shelves for the bot roster. Bots keep a department name; deleting a shelf moves its bots to General.">
      <div className="inline-field">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="New department" onKeyDown={(event) => { if (event.key === "Enter") void create(); }} />
        <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={!name.trim()}><Plus size={14} /> Add</button>
      </div>
      <div className="department-list">
        {items.map((department) => (
          <div className="department-row" key={department.id}>
            {editing === department.id ? (
              <div className="inline-field">
                <input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(); }} />
                <button type="button" className="btn btn-secondary" onClick={() => void saveRename()}>Save</button>
                <button type="button" className="btn btn-ghost" onClick={() => setEditing("")}>Cancel</button>
              </div>
            ) : (
              <>
                <div><strong>{department.name}</strong><span>{department.botCount ?? 0} bots</span></div>
                <div className="settings-actions">
                  <button type="button" className="link-button" onClick={() => { setEditing(department.id); setEditName(department.name); }}>Rename</button>
                  <button type="button" className="link-button is-danger" onClick={() => remove(department)}>Delete</button>
                </div>
              </>
            )}
          </div>
        ))}
        {items.length === 0 && <p className="panel-note">No departments yet.</p>}
      </div>
    </SectionCard>
  );
}

function AutomationSection() {
  const { backend, toast } = useApp();
  const [info, setInfo] = useState<APIInfo | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setInfo(await backend.getAPIInfo());
    } catch (cause) {
      toast({ kind: "error", title: "Could not read the automation API", body: cause instanceof Error ? cause.message : "Try again." });
    }
  };
  useEffect(() => { void load(); }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await backend.setAPIEnabled(enabled);
      setInfo(next);
      setToken(next.token ?? "");
      toast({ kind: "success", title: enabled ? "Automation API enabled" : "Automation API disabled" });
    } catch (cause) {
      toast({ kind: "error", title: "Automation API unchanged", body: cause instanceof Error ? cause.message : "Try again." });
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
      toast({ kind: "success", title: "API token rotated", body: "The previous token no longer works." });
    } catch (cause) {
      toast({ kind: "error", title: "Token not rotated", body: cause instanceof Error ? cause.message : "Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title="Automation API" hint="A loopback JSON API for local scripts and CI. The bearer token is stored in secrets.json and is never loaded into a bot prompt.">
      <div className="switch-row">
        <span className="row-copy">
          <span className="row-title">Enable the loopback API</span>
          <span className="row-sub">127.0.0.1 only. Every request needs Authorization: Bearer &lt;token&gt;.</span>
        </span>
        <Switch checked={Boolean(info?.enabled)} label="Enable automation API" onChange={(value) => void toggle(value)} disabled={busy} />
      </div>
      {info?.error && <p className="panel-note is-warning">{info.error}</p>}
      {info?.url && <code className="webhook-base">{info.url}</code>}
      {token && (
        <label className="panel-field">
          <span>New token (shown once)</span>
          <div className="inline-field">
            <input readOnly value={token} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="btn btn-secondary" onClick={() => { void navigator.clipboard?.writeText(token); toast({ kind: "success", title: "Token copied" }); }}>Copy</button>
          </div>
        </label>
      )}
      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" onClick={() => void rotate()} disabled={busy || !info?.enabled}>Rotate token</button>
      </div>
      <div className="settings-callout">
        <Terminal size={14} />
        <span>GET /v1/state, GET /v1/bots, and POST /v1/bots/&lt;id&gt;/threads/&lt;id&gt;/messages. This is a local control surface, not a hosted service.</span>
      </div>
    </SectionCard>
  );
}

function PhoneSection() {
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
    toast({ kind: "success", title: "Phone link copied" });
  };

  return (
    <>
      <SectionCard title="Phone companion" hint="A small web chat for a phone on the same Wi-Fi. The desktop app stays open and owns the workspace.">
        <div className="settings-form">
          <div className="switch-row">
            <span className="row-copy">
              <span className="row-title">Local phone link</span>
              <span className="row-sub">Serves a private page on this Mac's network address.</span>
            </span>
            <Switch checked={phone.enabled} label="Local phone link" onChange={(value) => void toggle(value)} disabled={busy} />
          </div>
          {phone.error && <p className="settings-note is-error">{phone.error}</p>}
          {phone.enabled && phone.url ? (
            <>
              {phone.qr && <img className="phone-qr" src={phone.qr} alt="QR code for the phone companion link" />}
              <label className="panel-field">
                <span>Open on your phone</span>
                <div className="phone-url-row">
                  <code className="phone-url">{phone.url}</code>
                  <button type="button" className="btn btn-secondary" onClick={copy}>Copy</button>
                </div>
              </label>
              <p className="phone-warning">Anyone with this link on the same network can read and send these conversations. Turn it off when you are done.</p>
              <p className="settings-note">Connected phones: {phone.connected}. The link uses plain HTTP on your local network; it is not exposed to the internet by Grox.</p>
            </>
          ) : (
            <p className="settings-note">Turn the link on, then open the address on a phone that is on the same Wi-Fi. No account, QR service, or cloud relay is involved.</p>
          )}
        </div>
      </SectionCard>
      <SectionCard title="What the phone can do" hint="A deliberately small surface.">
        <ul className="phone-list">
          <li>See the bot roster and channels.</li>
          <li>Read the latest conversation.</li>
          <li>Send a message and receive the streaming reply.</li>
          <li>Open the page from any browser; no app install.</li>
        </ul>
        <p className="settings-note">Approval cards and computer controls stay on the desktop app. The phone page cannot read local files or run commands.</p>
      </SectionCard>
    </>
  );
}

function VoiceSection() {
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
      toast({ kind: "error", title: "No system voice available" });
      return;
    }
    speak("This is how a Grox reply sounds on this machine.", voiceName);
  };

  return (
    <>
      <SectionCard title="System voice" hint="Grox uses the voices already installed on this machine. A bot can override this in its profile.">
        <div className="settings-form">
          <label className="panel-field">
            <span>Default voice</span>
            <select
              value={voiceName}
              onChange={(event) => {
                setVoiceName(event.target.value);
                void patchSettings({ voiceName: event.target.value });
              }}
            >
              <option value="">System default</option>
              {voices.map((voice) => <option key={voice.name} value={voice.name}>{voice.name} · {voice.lang}</option>)}
            </select>
          </label>
          <div className="settings-form-actions">
            <button type="button" className="btn btn-secondary" onClick={test}><Play size={14} /> Test voice</button>
          </div>
        </div>
      </SectionCard>
      <SectionCard title="Voice calls" hint="A local, speech-to-speech call mode — no call transport and no speech service in the middle.">
        <p className="settings-note">
          Start a call from the phone button in any conversation. Grox listens through the system speech-recognition service,
          sends the transcript to the bot, and speaks the reply with the voice above. The microphone is used only while the
          call or dictation button is active. Availability of live listening depends on the webview; typing in the call sheet
          always works.
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
  const { backend, toast } = useApp();
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<"http" | "stdio">(server?.transport === "stdio" ? "stdio" : "http");
  const [url, setUrl] = useState(server?.url ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState("");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setTransport(server?.transport === "stdio" ? "stdio" : "http");
    setUrl(server?.url ?? "");
    setCommand(server?.command ?? "");
    setArgs((server?.args ?? []).join("\n"));
    setToken("");
    setHeaders("");
    setEnabled(server?.enabled ?? true);
    setError("");
    setBusy(false);
  }, [open, server?.id]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the server a name.");
      return;
    }
    if (transport === "http" && !url.trim()) {
      setError("Enter a full MCP URL.");
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      setError("Enter the local MCP command.");
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
          ...(transport === "stdio" ? { command: command.trim(), args: argList } : { url: url.trim() }),
          ...(transport === "http" && token.trim() ? { token: token.trim() } : {}),
          ...(transport === "http" && headers.trim() ? { headers: headerMap } : {}),
        });
      } else {
        await backend.createMCPServer({
          name: name.trim(), transport, enabled,
          ...(transport === "stdio" ? { command: command.trim(), args: argList } : { url: url.trim(), token: token.trim(), headers: headerMap }),
        });
      }
      onSaved();
      onClose();
      toast({ kind: "success", title: server ? "MCP server updated" : "MCP server added" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the MCP server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={server ? "Edit MCP server" : "Add MCP server"} width={620}>
      <form className="routine-form" onSubmit={submit}>
        <div className="form-two">
          <label className="panel-field">
            <span>Name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="linear" />
          </label>
          <label className="panel-field">
            <span>Enabled</span>
            <div className="switch-row-inline"><Switch checked={enabled} label="Enable MCP server" onChange={setEnabled} /></div>
          </label>
        </div>
        <div className="panel-field">
          <span>Transport</span>
          <Segmented
            label="MCP transport"
            value={transport}
            options={[{ value: "http", label: "HTTP" }, { value: "stdio", label: "Local command" }]}
            onChange={(value) => setTransport(value as "http" | "stdio")}
          />
        </div>
        {transport === "http" ? (
          <>
            <label className="panel-field">
              <span>Streamable HTTP URL</span>
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
            </label>
            <label className="panel-field">
              <span>Bearer token (optional)</span>
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={server?.authConfigured ? "Configured; leave blank to keep" : "Stored in secrets.json"} autoComplete="off" />
            </label>
            <label className="panel-field">
              <span>Additional headers (optional)</span>
              <textarea rows={2} value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={"X-API-Key: ...\nX-Org: ..."} spellCheck={false} />
            </label>
            {server?.headerNames?.length ? <p className="panel-note">Existing headers: {server.headerNames.join(", ")}. Enter values only to replace all headers.</p> : null}
          </>
        ) : (
          <>
            <label className="panel-field">
              <span>Command</span>
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="/usr/local/bin/mcp-server" spellCheck={false} />
            </label>
            <label className="panel-field">
              <span>Arguments (one per line)</span>
              <textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} placeholder={"--stdio\n--profile\nwork"} spellCheck={false} />
            </label>
          </>
        )}
        <p className="panel-note">HTTP tokens are stored in the 0600 secrets file, never in AppState or the page. A local command is launched by the selected CLI, not by Grox; only enable a command you trust. Servers are enabled per turn only when this switch is on.</p>
        {error && <p className="panel-note is-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save server"}</button>
        </div>
      </form>
    </Modal>
  );
}

function MCPSection() {
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
      toast({ kind: "error", title: "Could not read MCP servers", body: cause instanceof Error ? cause.message : "Try again." });
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
      toast({ kind: "error", title: "MCP server not updated", body: cause instanceof Error ? cause.message : "Try again." });
    }
  };

  const remove = (server: MCPServer) => {
    requestConfirm({
      title: "Delete MCP server?",
      body: server.name + " will stop being added to new CLI turns. Its stored token is removed.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        void backend.deleteMCPServer(server.id).then(load).catch((cause: unknown) => {
          toast({ kind: "error", title: "MCP server not deleted", body: cause instanceof Error ? cause.message : "Try again." });
        });
      },
    });
  };

  return (
    <>
      <SectionCard
        title="Remote MCP servers"
        hint="Add a streamable-HTTP MCP server to every CLI turn. Grox never installs or executes a local MCP command."
        action={<button type="button" className="btn btn-secondary" onClick={() => { setEditing(undefined); setEditorOpen(true); }}><Plus size={14} /> Add server</button>}
      >
        {loading ? <p className="panel-note">Reading servers…</p> : servers.length === 0 ? (
          <p className="panel-note">No remote MCP servers. The per-turn Composio gateway and ask_user tool are still available.</p>
        ) : (
          <div className="mcp-list">
            {servers.map((server) => (
              <div key={server.id} className={cn("mcp-row", server.enabled && "is-enabled")}>
                <span className="mcp-icon"><Plug size={15} /></span>
                <div className="mcp-copy">
                  <strong>{server.name}</strong>
                  <span>{server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url}</span>
                  <small>{server.transport === "stdio" ? "Local command" : (server.headerNames?.length ?? 0) > 0 ? (server.headerNames?.length + " header(s) configured") : server.authConfigured ? "Bearer token configured" : "No auth headers"}</small>
                </div>
                <Switch checked={server.enabled} label={"Enable " + server.name} onChange={(value) => void toggle(server, value)} />
                <button type="button" className="link-button" onClick={() => { setEditing(server); setEditorOpen(true); }}>Edit</button>
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

function DataSection() {
  const { boot, exportWorkspace, resetWorkspace, revealDataFolder, backend, toast } = useApp();
  const importRef = useRef<HTMLInputElement>(null);

  const importTeam = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      toast({ kind: "error", title: "Team package is too large", body: "Use a file under 4 MB." });
      return;
    }
    try {
      const result = await backend.importTeam(await file.text());
      toast({
        kind: "success",
        title: "Team package imported",
        body: result.bots + " bots, " + result.groups + " channel, " + result.routines + " paused routines, " + result.skills + " skills.",
      });
    } catch (cause) {
      toast({ kind: "error", title: "Could not import the team", body: cause instanceof Error ? cause.message : "Try again." });
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };
  return (
    <>
      <SectionCard title="Workspace" hint="The single JSON document that holds bots, conversations, routines, and connections.">
        <div className="data-row">
          <span className="data-label">Location</span>
          <span className="panel-mono">{boot.dataDir}</span>
          <button type="button" className="btn btn-secondary" onClick={revealDataFolder}><FolderOpen size={14} /> Reveal</button>
        </div>
        <div className="row-divider" />
        <div className="data-row">
          <span className="data-label">Version</span>
          <span>{boot.version}</span>
        </div>
        <div className="row-divider" />
        <div className="data-row">
          <span className="data-label">Export</span>
          <span className="data-hint">A readable JSON copy, without keys.</span>
          <button type="button" className="btn btn-secondary" onClick={() => void exportWorkspace()}>Export workspace</button>
        </div>
      </SectionCard>
      <SectionCard title="Team packages" hint="Move one channel with its bots, enabled skills, memory and routines. The file carries no keys or app connections.">
        <div className="data-row">
          <span className="data-label">Import</span>
          <span className="data-hint">Adds new bots and a channel; imported routines arrive paused and skills start off. Nothing existing is overwritten.</span>
          <button type="button" className="btn btn-secondary" onClick={() => importRef.current?.click()}><Upload size={14} /> Import team</button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => void importTeam(event.target.files?.[0])}
          />
        </div>
      </SectionCard>
      <SectionCard title="Reset" hint="Replace the workspace with the first-run team. Keys are kept.">
        <div className="data-row">
          <span className="data-label">Danger zone</span>
          <span className="data-hint">This removes every conversation and routine you have made.</span>
          <button type="button" className="btn btn-danger" onClick={() => resetWorkspace()}><Trash2 size={14} /> Reset workspace</button>
        </div>
      </SectionCard>
    </>
  );
}

function AboutSection() {
  const { boot } = useApp();
  return (
    <div className="about">
      <GroxLogo size={64} />
      <h2>Grox</h2>
      <p className="about-version">Version {boot.version} · {boot.platform}</p>
      <p className="about-copy">
        A local-first chat app for a team of AI agents. Each bot has a personality, a model, its own conversations,
        an approval boundary, and a deterministic 1-bit portrait generated from its name. Built with Go and MyGo.
      </p>
      <div className="about-meta">
        <div><span>Runtime</span><span>Go · MyGo</span></div>
        <div><span>Frontend</span><span>React · Vite</span></div>
        <div><span>License</span><span>Apache-2.0</span></div>
        <div><span>Data</span><span>On this machine</span></div>
      </div>
      <p className="about-note">Grox is an independent project. Every portrait is generated locally from layered pixel matrices; no avatar image is uploaded or fetched.</p>
    </div>
  );
}

export function SettingsModal() {
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
  const sectionLabel = SECTIONS.find((item) => item.id === section)?.label ?? "Settings";

  const refresh = async () => {
    setRefreshing(true);
    await refreshCatalog();
    setRefreshing(false);
  };

  return (
    <div className="modal-layer settings-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUI({ settingsOpen: false }); }}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <aside className="settings-nav">
          <h2>Settings</h2>
          <nav>
            {SECTIONS.map((item) => (
              <button key={item.id} type="button" className={cn("settings-nav-row", section === item.id && "is-active")} onClick={() => setUI({ settingsSection: item.id })}>
                {item.icon}
                <span>{item.label}</span>
                <ChevronRight size={14} className="settings-nav-chevron" />
              </button>
            ))}
          </nav>
          <div className="settings-nav-foot">
            <GroxLogo size={22} />
            <span>Grox {boot.version}</span>
            <button type="button" className="icon-button" title="Refresh engines" aria-label="Refresh engines" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
            </button>
          </div>
        </aside>
        <section className="settings-content">
          <header className="settings-head">
            <h1>{sectionLabel}</h1>
            <button type="button" className="icon-button" aria-label="Close settings" onClick={() => setUI({ settingsOpen: false })}><X size={18} /></button>
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
