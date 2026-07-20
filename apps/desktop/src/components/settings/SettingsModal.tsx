import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../../bridge";
import type { ConfigDocument, ProviderApiBackend, ProviderKind } from "../../bridge/types";
import { EFFORTS } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { usePreferences } from "../../state/preferences";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { Wordmark } from "../fx/Wordmark";

type Section = "general" | "account" | "appearance" | "mcp" | "skills" | "plugins";
type Json = Record<string, unknown>;

const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const bool = (value: unknown) => value === true;

export function SettingsModal() {
  const { t, language } = useI18n();
  const open = useDesktop((state) => state.settingsOpen);
  const setOpen = useDesktop((state) => state.setSettingsOpen);
  const [section, setSection] = useState<Section>("general");
  if (!open) return null;

  const sections: { id: Section; label: string; icon: React.ComponentProps<typeof Icon>["name"] }[] = [
    { id: "general", label: t("settings"), icon: "gear" },
    { id: "account", label: language === "zh-CN" ? "账户与配置" : "Account & config", icon: "user" },
    { id: "appearance", label: t("appearance"), icon: "sun" },
    { id: "mcp", label: t("mcp"), icon: "globe" },
    { id: "skills", label: t("skills"), icon: "bolt" },
    { id: "plugins", label: `${t("plugins")} / ${t("marketplace")}`, icon: "layers" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/75 p-5 backdrop-blur-[3px]" onMouseDown={() => setOpen(false)}>
      <div className="flex h-[min(760px,88vh)] w-[min(1040px,92vw)] overflow-hidden rounded-[9px] border border-line3 bg-panel shadow-2xl animate-fade-up" onMouseDown={(event) => event.stopPropagation()}>
        <nav className="flex w-[190px] shrink-0 flex-col border-r border-line bg-void py-3">
          <div className="px-4 pb-3"><Wordmark size={11} withMark={false} /></div>
          {sections.map((item) => (
            <button key={item.id} onClick={() => setSection(item.id)} className={`flex items-center gap-2 px-4 py-2 text-left font-mono text-[10px] transition-colors ${section === item.id ? "bg-high text-acc" : "text-dim hover:text-fg2"}`}>
              <Icon name={item.icon} size={11} />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
          <div className="flex-1" />
          <button onClick={() => setOpen(false)} className="mx-3 flex h-8 items-center justify-center rounded-[4px] border border-line2 text-[10px] text-mute hover:border-line3 hover:text-fg">{language === "zh-CN" ? "关闭" : "Close"}</button>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {section === "general" && <General />}
          {section === "account" && <Account />}
          {section === "appearance" && <Appearance />}
          {section === "mcp" && <McpPanel />}
          {section === "skills" && <SkillsPanel />}
          {section === "plugins" && <PluginsPanel />}
        </div>
      </div>
    </div>
  );
}

function Heading({ title, description }: { title: string; description?: string }) {
  return <div className="mb-5"><h2 className="text-[15px] font-medium text-fg">{title}</h2>{description && <p className="mt-1 text-[10.5px] leading-relaxed text-dim">{description}</p>}</div>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between border-b border-line py-3"><div className="min-w-0 pr-4"><p className="text-[11.5px] text-fg2">{label}</p>{hint && <p className="mt-0.5 text-[10px] text-dim">{hint}</p>}</div><div className="shrink-0">{children}</div></div>;
}

function Toggle({ on, onChange, disabled = false }: { on: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <button disabled={disabled} onClick={() => onChange(!on)} className={`relative h-[18px] w-8 rounded-full border transition-colors disabled:opacity-40 ${on ? "border-acc-dim bg-acc-wash" : "border-line3 bg-high"}`}><span className={`absolute top-[2px] h-[12px] w-[12px] rounded-full transition-all ${on ? "left-[16px] bg-acc" : "left-[2px] bg-dim"}`} /></button>;
}

function ActionButton({ children, onClick, tone = "normal", disabled = false }: { children: React.ReactNode; onClick(): void; tone?: "normal" | "danger" | "accent"; disabled?: boolean }) {
  return <button disabled={disabled} onClick={onClick} className={`h-8 rounded-[4px] border px-3 font-mono text-[9.5px] disabled:opacity-40 ${tone === "danger" ? "border-red/30 text-red hover:bg-red/5" : tone === "accent" ? "border-acc-dim bg-acc-wash text-acc" : "border-line2 text-fg2 hover:border-line3 hover:text-fg"}`}>{children}</button>;
}

function Input({ value, onChange, placeholder, type = "text" }: { value: string; onChange(value: string): void; placeholder?: string; type?: string }) {
  return <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-8 w-full min-w-0 rounded-[4px] border border-line2 bg-void px-2.5 font-mono text-[10px] text-fg outline-none placeholder:text-faint focus:border-acc-dim" />;
}

function General() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const workspace = useDesktop((state) => state.workspace);
  const bridgeKind = useDesktop((state) => state.bridgeKind);
  const effort = useDesktop((state) => state.effort);
  const setEffort = useDesktop((state) => state.setEffort);
  const permission = useDesktop((state) => state.permissionMode);
  const setPermission = useDesktop((state) => state.setPermissionMode);
  const runtime = useDesktop((state) => state.runtime);
  const runtimeBusy = useDesktop((state) => state.runtimeBusy);
  const refreshRuntime = useDesktop((state) => state.refreshRuntime);
  const installOfficialRuntime = useDesktop((state) => state.installOfficialRuntime);
  const [runtimeError, setRuntimeError] = useState("");
  const runtimeSource = runtime?.source === "system"
    ? (zh ? "本机 CLI" : "System CLI")
    : runtime?.source === "bundled"
      ? (zh ? "Grox 内置" : "Bundled with Grox")
      : runtime?.source === "override"
        ? (zh ? "自定义路径" : "Custom path")
        : (zh ? "正在检测" : "Detecting");
  return <div>
    <Heading title="Agent" description={zh ? "Grok Build ACP 运行时和默认执行策略；模型与接入服务在账户模块管理。" : "Grok Build ACP runtime and execution defaults. Models and providers live under Account."} />
    <Row label={zh ? "当前项目" : "Current project"} hint={workspace}><span className="chip">{bridgeKind.toUpperCase()}</span></Row>
    <Row label={zh ? "Grok Build 运行时" : "Grok Build runtime"} hint={runtime?.path}><div className="flex items-center gap-2"><span className="chip">{runtimeSource}</span><ActionButton disabled={runtimeBusy} onClick={() => void refreshRuntime()}>{zh ? "重新检测" : "Detect"}</ActionButton>{runtime && runtime.source !== "override" && <ActionButton tone="accent" disabled={runtimeBusy} onClick={() => { setRuntimeError(""); void installOfficialRuntime().catch((cause) => setRuntimeError(cause instanceof Error ? cause.message : String(cause))); }}>{runtimeBusy ? (zh ? "安装中" : "Installing") : runtime.systemPath ? (zh ? "更新官方 CLI" : "Update official CLI") : (zh ? "安装官方 CLI" : "Install official CLI")}</ActionButton>}</div></Row>
    {runtime && <Row label={zh ? "版本来源" : "Version provenance"} hint={zh ? "同时追踪官方基线与 Grox 自身补丁，便于升级和回归。" : "Tracks the official baseline and Grox patch revision independently."}><div className="max-w-[440px] space-y-1 text-right font-mono text-[9px] text-dim"><p className="truncate" title={runtime.version}>{runtime.version ?? (zh ? "无法读取 CLI 版本" : "CLI version unavailable")}</p><p className="truncate" title={runtime.upstreamCommit}>{zh ? "官方" : "UPSTREAM"} · {runtime.upstreamCommit?.slice(0, 12) ?? "unknown"}　{zh ? "Grox" : "GROX"} · {runtime.groxCommit}</p></div></Row>}
    {runtimeError && <p className="mb-4 rounded-[4px] border border-red/30 bg-red/5 px-3 py-2 text-[10px] text-red">{runtimeError}</p>}
    <Row label={zh ? "推理强度" : "Reasoning effort"}><div className="flex gap-1">{EFFORTS.map((item) => <button key={item} onClick={() => setEffort(item)} className={`h-7 rounded-[3px] border px-2 font-mono text-[9.5px] ${effort === item ? "border-acc-dim bg-acc-wash text-acc" : "border-line2 text-dim"}`}>{item.toUpperCase()}</button>)}</div></Row>
    <Row label={zh ? "权限模式" : "Permission mode"} hint={zh ? "Default 保留审批；Auto 交给 Agent 策略；Bypass 仅用于可信环境。" : "Default keeps approvals; Auto follows the Agent policy; use Bypass only in trusted environments."}><select value={permission} onChange={(event) => setPermission(event.target.value as typeof permission)} className="h-8 rounded-[4px] border border-line2 bg-void px-2 font-mono text-[9.5px] text-fg2"><option value="default">DEFAULT</option><option value="auto">AUTO</option><option value="bypass">BYPASS / YOLO</option></select></Row>
  </div>;
}

function Account() {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const account = useDesktop((state) => state.account);
  const billing = useDesktop((state) => state.billing);
  const provider = useDesktop((state) => state.provider);
  const models = useDesktop((state) => state.models);
  const loading = useDesktop((state) => state.accountLoading);
  const refresh = useDesktop((state) => state.refreshAccount);
  const openSetup = useDesktop((state) => state.setAccountSetupOpen);
  const logout = useDesktop((state) => state.logout);
  return <div>
    <Heading title={zh ? "账户与配置" : "Account & configuration"} description={zh ? "身份、模型服务与 Grok 本地配置集中在这里管理。OAuth 目录实时跟随 Grok，API 模式由你控制端点与常驻模型。" : "Manage identity, model providers, and local Grok configuration in one place. OAuth follows Grok live; API modes keep endpoints and the resident model under your control."} />
    <div className="rounded-[6px] border border-line2 bg-raise p-4">
      <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-line2 bg-high">{account?.profileImageUrl ? <img src={account.profileImageUrl} className="h-full w-full object-cover" alt="" /> : <Icon name={provider.kind === "oauth" ? "user" : "bolt"} size={16} className="text-dim" />}</div><div className="min-w-0 flex-1"><p className="truncate text-[12px] text-fg">{account?.email ?? (provider.kind === "official" ? "xAI API" : provider.kind === "compatible" ? (provider.baseUrl ?? t("compatibleApi")) : t("signInRequired"))}</p><p className="mt-0.5 font-mono text-[9.5px] text-acc">{provider.kind === "oauth" ? (billing?.subscriptionTier ?? account?.subscriptionTier ?? "GROK OAUTH") : provider.kind === "official" ? "XAI OFFICIAL API" : "OPENAI COMPATIBLE"}</p></div><ActionButton onClick={() => void refresh()}>{loading ? t("loading") : t("refresh")}</ActionButton></div>
      <div className="mt-4 grid grid-cols-2 gap-2">{provider.kind === "oauth" ? <><Metric label={t("fiveHour")} value={t("unavailable")} /><Metric label={t("weekly")} value={billing?.creditUsagePercent !== undefined ? `${Math.round(billing.creditUsagePercent)}%` : t("unavailable")} /></> : <><Metric label={zh ? "API 密钥" : "API key"} value={provider.hasApiKey ? (zh ? "已安全保存" : "Stored securely") : (zh ? "未设置" : "Not configured")} /><Metric label={zh ? "可用模型" : "Available models"} value={`${models.length}`} /></>}</div>
    </div>
    <div className="mt-3 flex gap-2">{provider.kind === "oauth" && !account?.authenticated && <ActionButton tone="accent" onClick={() => openSetup(true)}>{t("login")}</ActionButton>}{provider.kind === "oauth" && account?.authenticated && <ActionButton tone="danger" onClick={() => void logout()}>{t("logout")}</ActionButton>}<ActionButton onClick={() => void invoke("open_external", { url: "https://grok.com/supergrok?referrer=grok-build" })}>{t("upgrade")}</ActionButton></div>
    <ProviderAndModels />
    <div className="mt-8 border-t border-line pt-6"><ConfigDocumentsPanel /></div>
  </div>;
}

function ProviderAndModels() {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const provider = useDesktop((state) => state.provider);
  const models = useDesktop((state) => state.models);
  const model = useDesktop((state) => state.model);
  const modelsUpdatedAt = useDesktop((state) => state.modelsUpdatedAt);
  const setModel = useDesktop((state) => state.setModel);
  const refreshModels = useDesktop((state) => state.refreshModels);
  const configure = useDesktop((state) => state.configureProvider);
  const profiles = useDesktop((state) => state.providerProfiles);
  const activeProfileId = useDesktop((state) => state.activeProviderProfileId);
  const saveProfile = useDesktop((state) => state.saveProviderProfile);
  const refreshProfileModels = useDesktop((state) => state.refreshProviderModels);
  const activateProfile = useDesktop((state) => state.activateProviderProfile);
  const deleteProfile = useDesktop((state) => state.deleteProviderProfile);
  const [kind, setKind] = useState<ProviderKind>(provider.kind);
  const [editingProfileId, setEditingProfileId] = useState<string | undefined>();
  const [profileName, setProfileName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiBackend, setApiBackend] = useState<ProviderApiBackend>("auto");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [residentModels, setResidentModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setKind(provider.kind);
    setBaseUrl(provider.baseUrl ?? "");
  }, [provider]);

  const editProfile = (id: string) => {
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return;
    setKind("compatible");
    setEditingProfileId(profile.id);
    setProfileName(profile.name);
    setBaseUrl(profile.baseUrl);
    setApiBackend(profile.apiBackend);
    setAvailableModels(profile.availableModels);
    setResidentModels(profile.residentModels);
    setApiKey("");
    setCustomModel("");
    setModelQuery("");
  };

  const startNewProfile = () => {
    setKind("compatible");
    setEditingProfileId(undefined);
    setProfileName("");
    setApiKey("");
    setBaseUrl("");
    setApiBackend("responses");
    setAvailableModels([]);
    setResidentModels([]);
    setCustomModel("");
  };

  const addResident = (id: string) => {
    const value = id.trim();
    if (value && !residentModels.includes(value)) setResidentModels((items) => [...items, value]);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (kind === "compatible") {
        const saved = await saveProfile({
          id: editingProfileId,
          name: profileName,
          apiKey,
          baseUrl,
          apiBackend,
          residentModels,
        });
        setEditingProfileId(saved.id);
        setAvailableModels(saved.availableModels);
        setResidentModels(saved.residentModels);
        setApiKey("");
      } else {
        await configure({ kind, apiKey, baseUrl });
      }
      setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const refreshCompatibleModels = async () => {
    if (!editingProfileId) return;
    setBusy(true);
    setError("");
    try {
      const profile = await refreshProfileModels(editingProfileId);
      setAvailableModels(profile.availableModels);
      setResidentModels(profile.residentModels);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const filteredModels = availableModels.filter((id) => id.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()));

  return <div className="mt-7" data-testid="provider-manager">
    <div className="mb-3 flex items-end justify-between"><div><h3 className="text-[12px] font-medium text-fg">{zh ? "模型服务" : "Model provider"}</h3><p className="mt-1 text-[10px] text-dim">{zh ? "供应商切换只重连后台 Grok Build ACP，会话与界面保持不动；密钥不会回传到 WebView。" : "Provider changes reconnect only the Grok Build ACP process. The session and UI stay in place, and secrets never return to the WebView."}</p></div><span className="chip">{provider.kind.toUpperCase()}</span></div>
    <div className="grid grid-cols-3 gap-2">
      {(["oauth", "official", "compatible"] as ProviderKind[]).map((item) => <button key={item} onClick={() => item === "compatible" ? startNewProfile() : setKind(item)} className={`min-w-0 rounded-[5px] border px-3 py-2.5 text-left transition-colors ${kind === item ? "border-acc-dim bg-acc-wash" : "border-line2 bg-raise hover:border-line3"}`}><Icon name={item === "oauth" ? "user" : item === "official" ? "bolt" : "globe"} size={12} className={kind === item ? "text-acc" : "text-dim"} /><p className="mt-2 truncate font-mono text-[9.5px] text-fg2">{item === "oauth" ? t("oauth") : item === "official" ? t("officialApi") : t("compatibleApi")}</p></button>)}
    </div>
    {kind === "oauth" ? <div className="mt-3 rounded-[5px] border border-line bg-raise p-3 text-[10px] leading-relaxed text-dim"><span className="mr-2 inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-acc" />{zh ? "模型目录由 Grok OAuth 实时提供；上游目录变化会自动同步到设置和输入框。" : "The model catalog is supplied live by Grok OAuth and synchronized with every composer."}</div> : <div className="mt-3 rounded-[6px] border border-line2 bg-raise p-3">
      <div className="grid grid-cols-2 gap-3">
        {kind === "compatible" && <label className="block"><span className="lbl !text-[9px]">{zh ? "供应商名称" : "PROVIDER NAME"}</span><Input value={profileName} onChange={setProfileName} placeholder={zh ? "例如：公司中转 / OpenRouter" : "e.g. Company gateway / OpenRouter"} /></label>}
        <label className="block"><span className="lbl !text-[9px]">API KEY</span><Input value={apiKey} onChange={setApiKey} type="password" placeholder={(editingProfileId ? profiles.find((item) => item.id === editingProfileId)?.hasApiKey : provider.hasApiKey) ? (zh ? "已保存 · 留空保持" : "Stored · leave blank") : "xai-…"} /></label>
        {kind === "official" ? <div><span className="lbl !text-[9px]">BASE URL</span><div className="h-8 rounded-[4px] border border-line bg-void px-2.5 font-mono text-[10px] leading-8 text-dim">https://api.x.ai/v1</div></div> : <label className="block"><span className="lbl !text-[9px]">BASE URL</span><Input value={baseUrl} onChange={setBaseUrl} placeholder="https://example.com/v1" /></label>}
        {kind === "compatible" && <label className="col-span-2 block"><span className="lbl !text-[9px]">{zh ? "接口协议" : "API PROTOCOL"}</span><select value={apiBackend} onChange={(event) => setApiBackend(event.target.value as ProviderApiBackend)} className="mt-1 h-8 w-full rounded-[4px] border border-line2 bg-void px-2.5 font-mono text-[9.5px] text-fg2 outline-none focus:border-acc-dim"><option value="responses">Responses · {zh ? "推荐，保留搜索工具与可公开的推理摘要" : "recommended; preserves search and reasoning summaries"}</option><option value="chat_completions">Chat Completions · {zh ? "旧服务兼容；代理可能丢弃托管工具事件" : "legacy compatibility; hosted tool events may be dropped"}</option><option value="auto">AUTO · grok2api / CLIProxyAPI / NewAPI → Responses</option></select></label>}
      </div>
      {kind === "compatible" && <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2"><div className="min-w-0 flex-1"><p className="text-[10.5px] text-fg2">{zh ? "自动获取的可用模型" : "Discovered models"}</p><p className="truncate font-mono text-[8.5px] text-faint">{baseUrl ? `${baseUrl.replace(/\/$/, "")}/models` : (zh ? "保存后自动获取" : "Fetched after save")}</p></div><ActionButton disabled={!editingProfileId || busy} onClick={() => void refreshCompatibleModels()}>{zh ? "重新获取" : "FETCH"}</ActionButton></div>
          <Input value={modelQuery} onChange={setModelQuery} placeholder={zh ? "筛选模型…" : "Filter models…"} />
          <div className="mt-2 max-h-48 overflow-y-auto rounded-[5px] border border-line bg-void/60 p-1">
            {filteredModels.length === 0 ? <p className="px-2 py-5 text-center text-[9.5px] text-faint">{editingProfileId ? (zh ? "暂无模型；可重新获取或添加自定义模型" : "No models; fetch again or add a custom model") : (zh ? "先保存供应商以获取模型" : "Save the provider to discover models")}</p> : filteredModels.map((id) => <div key={id} className="flex h-7 min-w-0 items-center gap-2 rounded-[3px] px-2 hover:bg-high"><span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-fg2" title={id}>{id}</span><button disabled={residentModels.includes(id)} onClick={() => addResident(id)} className="shrink-0 font-mono text-[8.5px] text-acc disabled:text-faint">{residentModels.includes(id) ? (zh ? "已常驻" : "ADDED") : (zh ? "加入" : "ADD")}</button></div>)}
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-2"><p className="text-[10.5px] text-fg2">{zh ? "常驻模型" : "Resident models"}</p><p className="font-mono text-[8.5px] text-faint">{residentModels.length} {zh ? "个；会出现在模型选择器中" : "shown in model selectors"}</p></div>
          <div className="flex gap-1.5"><div className="min-w-0 flex-1"><Input value={customModel} onChange={setCustomModel} placeholder={zh ? "添加自定义模型 ID" : "Custom model ID"} /></div><ActionButton onClick={() => { addResident(customModel); setCustomModel(""); }}>{zh ? "添加" : "ADD"}</ActionButton></div>
          <div className="mt-2 max-h-48 overflow-y-auto rounded-[5px] border border-line bg-void/60 p-1">
            {residentModels.length === 0 ? <p className="px-2 py-5 text-center text-[9.5px] text-faint">{zh ? "尚未选择常驻模型" : "No resident models selected"}</p> : residentModels.map((id) => <div key={id} className="flex h-7 min-w-0 items-center gap-2 rounded-[3px] px-2 hover:bg-high"><span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-fg2" title={id}>{id}</span><button onClick={() => setResidentModels((items) => items.filter((item) => item !== id))} className="shrink-0 text-faint hover:text-red" title={zh ? "移除" : "Remove"}><Icon name="x" size={9} /></button></div>)}
          </div>
        </div>
      </div>}
    </div>}
    {error && <p className="mt-2 rounded-[4px] border border-red/30 bg-red/5 px-3 py-2 text-[10px] text-red">{error}</p>}
    <div className="mt-3 flex justify-end"><ActionButton tone="accent" disabled={busy} onClick={() => void save()}>{busy ? t("loading") : kind === "oauth" ? (zh ? "使用 Grok OAuth" : "Use Grok OAuth") : (zh ? "保存" : "Save")}</ActionButton></div>

    {profiles.length > 0 && <div className="mt-5"><div className="mb-2 flex items-center justify-between"><p className="lbl !text-[9.5px]">{zh ? "已保存的第三方供应商" : "SAVED COMPATIBLE PROVIDERS"}</p><span className="tnum text-[9px] text-faint">{profiles.length}</span></div><div className="space-y-1.5">{profiles.map((profile) => <div key={profile.id} className={`flex min-w-0 items-center gap-3 rounded-[5px] border px-3 py-2.5 ${activeProfileId === profile.id ? "border-acc-dim bg-acc-wash" : "border-line2 bg-raise"}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeProfileId === profile.id ? "bg-acc" : "bg-faint"}`} /><div className="min-w-0 flex-1"><p className="truncate text-[10.5px] text-fg2" title={profile.name}>{profile.name}</p><p className="mt-0.5 truncate font-mono text-[8.5px] text-faint" title={profile.baseUrl}>{profile.baseUrl} · {profile.residentModels.length} {zh ? "个常驻模型" : "resident"}</p></div>{activeProfileId === profile.id && <span className="chip shrink-0">{zh ? "使用中" : "ACTIVE"}</span>}<button onClick={() => editProfile(profile.id)} className="shrink-0 font-mono text-[9px] text-dim hover:text-fg">{zh ? "编辑" : "EDIT"}</button>{activeProfileId !== profile.id && <button onClick={() => void activateProfile(profile.id).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))} className="shrink-0 font-mono text-[9px] text-acc hover:text-fg">{zh ? "切换" : "USE"}</button>}<button onClick={() => { if (window.confirm(zh ? `删除供应商“${profile.name}”？` : `Delete provider “${profile.name}”?`)) void deleteProfile(profile.id); }} className="shrink-0 text-faint hover:text-red" title={zh ? "删除" : "Delete"}><Icon name="trash" size={10} /></button></div>)}</div></div>}

    <div className="mt-5 rounded-[6px] border border-line2 bg-raise p-3">
      <div className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${provider.kind === "oauth" ? "animate-pulse-dot bg-acc" : "bg-gold"}`} /><div className="min-w-0 flex-1"><p className="text-[11px] text-fg2">{zh ? "常驻模型" : "Resident model"}</p><p className="mt-0.5 text-[9.5px] text-dim">{provider.kind === "oauth" ? (zh ? "实时目录" : "Live catalog") : (zh ? "API 模型目录" : "API catalog")} · {models.length} {zh ? "个模型" : "models"}{modelsUpdatedAt ? ` · ${new Date(modelsUpdatedAt).toLocaleTimeString()}` : ""}</p></div><ActionButton onClick={() => void refreshModels()}>{t("refresh")}</ActionButton></div>
      <select value={model} onChange={(event) => setModel(event.target.value)} className="mt-3 h-9 w-full rounded-[4px] border border-line2 bg-void px-3 font-mono text-[10px] text-fg2 outline-none focus:border-acc-dim">{models.map((item) => <option key={item.id} value={item.id}>{item.label} — {item.id}</option>)}</select>
      <p className="mt-2 text-[9.5px] leading-relaxed text-dim">{zh ? "该选择会持久保存，并作为新任务及后续请求的默认模型；若目录移除该模型，会自动回退到 Grok 当前可用模型。" : "This choice persists for new missions and later turns. If the catalog removes it, Grox falls back to an available Grok model."}</p>
    </div>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-[5px] border border-line bg-high/60 p-3"><p className="lbl !text-[9.5px]">{label}</p><p className="mt-2 font-mono text-[11px] text-fg2">{value}</p></div>; }

function Appearance() {
  const { t, language: uiLanguage } = useI18n();
  const language = usePreferences((state) => state.language);
  const setLanguage = usePreferences((state) => state.setLanguage);
  const theme = usePreferences((state) => state.theme);
  const setTheme = usePreferences((state) => state.setTheme);
  const fontSize = usePreferences((state) => state.fontSize);
  const setFontSize = usePreferences((state) => state.setFontSize);
  const fontWeight = usePreferences((state) => state.fontWeight);
  const setFontWeight = usePreferences((state) => state.setFontWeight);
  const [reduceMotion, setReduceMotion] = useState(localStorage.getItem("grok.pref.reduceMotion") === "1");
  const updateMotion = (value: boolean) => { localStorage.setItem("grok.pref.reduceMotion", value ? "1" : "0"); document.documentElement.dataset.reduceMotion = value ? "1" : "0"; window.dispatchEvent(new Event("grox-motion-change")); setReduceMotion(value); };
  return <div><Heading title={t("appearance")} description={uiLanguage === "zh-CN" ? "语言默认为中文，主题默认为 GrokNight 暗黑模式。" : "The default language is Chinese and the default theme is GrokNight dark."} />
    <Row label={t("language")}><div className="flex gap-1"><Choice active={language === "zh-CN"} onClick={() => setLanguage("zh-CN")}>{t("chinese")}</Choice><Choice active={language === "en-US"} onClick={() => setLanguage("en-US")}>{t("english")}</Choice></div></Row>
    <Row label={t("theme")}><div className="flex gap-1"><Choice active={theme === "dark"} onClick={() => setTheme("dark")}><Icon name="moon" size={10} /> {t("dark")}</Choice><Choice active={theme === "light"} onClick={() => setTheme("light")}><Icon name="sun" size={10} /> {t("light")}</Choice></div></Row>
    <Row label={uiLanguage === "zh-CN" ? "字体大小" : "Font size"} hint={uiLanguage === "zh-CN" ? "统一调整正文、工具信息、侧栏标签和代码字号。" : "Adjust text, tool details, sidebar labels, and code together."}><RangeControl value={fontSize} min={0} max={6} step={0.25} display={`+${fontSize.toFixed(2).replace(/\.00$/, "").replace(/0$/, "")} px`} onChange={setFontSize} label={uiLanguage === "zh-CN" ? "字体大小" : "Font size"} /></Row>
    <Row label={uiLanguage === "zh-CN" ? "字体粗细" : "Font weight"}><RangeControl value={fontWeight} min={400} max={700} step={25} display={String(fontWeight)} onChange={setFontWeight} label={uiLanguage === "zh-CN" ? "字体粗细" : "Font weight"} /></Row>
    <Row label={uiLanguage === "zh-CN" ? "减少动态效果" : "Reduce motion"} hint={uiLanguage === "zh-CN" ? "停用轨道动画和进入过渡。" : "Disable orbital animations and entrance transitions."}><Toggle on={reduceMotion} onChange={updateMotion} /></Row>
  </div>;
}

function Choice({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) { return <button onClick={onClick} className={`flex h-8 items-center gap-1.5 rounded-[4px] border px-3 font-mono text-[9.5px] ${active ? "border-acc-dim bg-acc-wash text-acc" : "border-line2 text-dim"}`}>{children}</button>; }

function RangeControl({ value, min, max, step, display, label, onChange }: { value: number; min: number; max: number; step: number; display: string; label: string; onChange(value: number): void }) {
  return <div className="w-[260px]"><div className="mb-1 flex items-center justify-between font-mono text-[9.5px] text-faint"><span>{min}</span><output className="rounded-[3px] border border-line2 bg-void px-2 py-0.5 text-acc">{display}</output><span>{max}</span></div><input aria-label={label} className="grox-range block w-full appearance-none bg-transparent" type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}

function useExtension<T>(loader: () => Promise<T>, dependencies: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => { let live = true; setError(null); void loader().then((value) => live && setData(value)).catch((cause) => live && setError(cause instanceof Error ? cause.message : String(cause))); return () => { live = false; }; }, [...dependencies, version]);
  return { data, error, reload: () => setVersion((value) => value + 1) };
}

function ExtensionState({ error, empty }: { error: string | null; empty: string }) { return error ? <p className="rounded-[5px] border border-red/30 bg-red/5 p-3 text-[10px] text-red">{error}</p> : <p className="rounded-[5px] border border-line bg-raise p-5 text-center text-[10px] text-dim">{empty}</p>; }

function McpPanel() {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const sessionId = useDesktop((state) => state.activeId);
  const [name, setName] = useState(""); const [endpoint, setEndpoint] = useState(""); const [kind, setKind] = useState<"http" | "stdio">("http");
  const state = useExtension(async () => object(await bridge.callExtension("x.ai/mcp/list", { ...(sessionId ? { sessionId } : {}), cache: false })), [sessionId]);
  const servers = list(state.data?.servers).map(object);
  const action = async (method: string, params: Json) => { if (!sessionId) throw new Error(zh ? "请先打开一个项目任务，以便 Grok Build 创建运行时上下文。" : "Open a project mission first so Grok Build can create its runtime context."); await bridge.callExtension(method, { session_id: sessionId, ...params }); state.reload(); };
  const add = async () => { if (!name.trim() || !endpoint.trim()) return; await action("x.ai/mcp/upsert", { server_name: name.trim(), ...(kind === "http" ? { type: "http", url: endpoint.trim(), enabled: true } : { command: endpoint.trim(), args: [], enabled: true }) }); setName(""); setEndpoint(""); };
  return <div><Heading title={t("mcp")} description={zh ? "直接读写 Grok Build 的 MCP 配置；启停和删除会同步到 config.toml。" : "Manage Grok Build MCP configuration directly; toggles and deletions sync to config.toml."} />
    <div className="mb-4 grid grid-cols-[120px_1fr_90px_auto] gap-2"><Input value={name} onChange={setName} placeholder="server-name" /><Input value={endpoint} onChange={setEndpoint} placeholder={kind === "http" ? "https://server/mcp" : "command"} /><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="rounded-[4px] border border-line2 bg-void px-2 font-mono text-[9.5px] text-fg2"><option value="http">HTTP</option><option value="stdio">STDIO</option></select><ActionButton tone="accent" disabled={!sessionId} onClick={() => void add()}>{t("add")}</ActionButton></div>
    {servers.length === 0 ? <ExtensionState error={state.error} empty={zh ? "尚未配置 MCP Server" : "No MCP servers configured"} /> : <div className="space-y-2">{servers.map((server) => { const session = object(server.session); const enabled = bool(session.enabled); const serverName = text(server.name); return <div key={serverName} className="flex items-center gap-3 rounded-[5px] border border-line2 bg-raise p-3"><Icon name="globe" size={13} className="text-mute" /><div className="min-w-0 flex-1"><p className="truncate text-[11px] text-fg2">{text(server.displayName, serverName)}</p><p className="truncate font-mono text-[9.5px] text-dim">{text(server.url) || text(server.command) || text(server.sourceLabel)}</p></div><span className="font-mono text-[9.5px] text-faint">{text(session.status).toUpperCase()}</span><Toggle on={enabled} disabled={!sessionId} onChange={(value) => void action("x.ai/mcp/toggle", { server_name: serverName, enabled: value })} />{text(server.source) === "local" && <ActionButton tone="danger" disabled={!sessionId} onClick={() => void action("x.ai/mcp/delete", { server_name: serverName })}>{t("delete")}</ActionButton>}</div>; })}</div>}
    <MarketLinks kind="mcp" />
  </div>;
}

function SkillsPanel() {
  const { t, language } = useI18n(); const zh = language === "zh-CN"; const cwd = useDesktop((state) => state.workspace); const [path, setPath] = useState("");
  const state = useExtension(async () => object(await bridge.callExtension("x.ai/skills/list", { cwd })), [cwd]);
  const skills = list(state.data?.skills).map(object);
  const run = async (method: string, params: Json) => { await bridge.callExtension(method, { ...params, cwd }); state.reload(); };
  return <div><Heading title={t("skills")} description={zh ? "从 Grok Build 的用户、项目和插件作用域发现 Skill，可视化启停与移除。" : "Discover Skills from Grok Build user, project, and plugin scopes; toggle or remove them visually."} /><div className="mb-4 flex gap-2"><div className="flex-1"><Input value={path} onChange={setPath} placeholder={zh ? "C:\\path\\to\\skill 或 SKILL.md" : "C:\\path\\to\\skill or SKILL.md"} /></div><ActionButton tone="accent" onClick={() => void run("x.ai/skills/add", { path }).then(() => setPath(""))}>{t("add")}</ActionButton></div>
    {skills.length === 0 ? <ExtensionState error={state.error} empty={zh ? "尚未发现 Skill" : "No Skills discovered"} /> : <div className="grid grid-cols-2 gap-2">{skills.map((skill) => { const name = text(skill.name); const enabled = skill.enabled !== false; return <div key={`${name}-${text(skill.path)}`} className="rounded-[5px] border border-line2 bg-raise p-3"><div className="flex items-start gap-2"><Icon name="bolt" size={12} className="mt-0.5 text-gold" /><div className="min-w-0 flex-1"><p className="truncate text-[11px] text-fg2">{text(skill.displayName, name)}</p><p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-dim">{text(skill.description, text(skill.path))}</p></div><Toggle on={enabled} onChange={(value) => void run("x.ai/skills/toggle", { name, enabled: value })} /></div>{text(skill.scope) !== "bundled" && <button onClick={() => void run("x.ai/skills/remove", { path: text(skill.path) })} className="mt-2 font-mono text-[9.5px] text-red/70 hover:text-red">{t("remove")}</button>}</div>; })}</div>}
    <MarketLinks kind="skills" />
  </div>;
}

function PluginsPanel() {
  const { t, language } = useI18n(); const zh = language === "zh-CN"; const sessionId = useDesktop((state) => state.activeId);
  const pluginsState = useExtension(async () => sessionId ? object(await bridge.callExtension("x.ai/plugins/list", { sessionId })) : { plugins: [] }, [sessionId]);
  const marketState = useExtension(async () => object(await bridge.callExtension("x.ai/marketplace/list", sessionId ? { sessionId } : {})), [sessionId]);
  const plugins = list(pluginsState.data?.plugins).map(object);
  const sources = list(marketState.data?.sources).map(object);
  const action = async (action: Json) => { if (!sessionId) throw new Error(zh ? "请先打开一个任务" : "Open a mission first"); await bridge.callExtension("x.ai/plugins/action", { sessionId, action }); pluginsState.reload(); marketState.reload(); };
  const marketAction = async (source: Json, plugin: Json) => { if (!sessionId) throw new Error(zh ? "请先打开一个任务" : "Open a mission first"); await bridge.callExtension("x.ai/marketplace/action", { sessionId, action: { type: "install", source_url_or_path: text(source.sourceUrlOrPath), plugin_relative_path: text(plugin.relativePath) } }); pluginsState.reload(); marketState.reload(); };
  return <div><Heading title={`${t("plugins")} / ${t("marketplace")}`} description={zh ? "使用 Grok Build 原生 Plugin 与 Marketplace 扩展，安装后可即时刷新技能、Hook 与 MCP。" : "Use native Grok Build Plugins and Marketplace sources; installed Skills, hooks, and MCP refresh immediately."} />
    <h3 className="lbl mb-2 !text-[9.5px]">{t("plugins")}</h3>{!sessionId ? <ExtensionState error={null} empty={zh ? "请先打开一个项目任务后管理 Plugin" : "Open a project mission before managing Plugins"} /> : plugins.length === 0 ? <ExtensionState error={pluginsState.error} empty={zh ? "尚未安装 Plugin" : "No Plugins installed"} /> : <div className="grid grid-cols-2 gap-2">{plugins.map((plugin) => { const id = text(plugin.id); const enabled = plugin.enabled !== false; return <div key={id} className="rounded-[5px] border border-line2 bg-raise p-3"><div className="flex gap-2"><Icon name="layers" size={12} className="text-acc" /><div className="min-w-0 flex-1"><p className="truncate text-[11px] text-fg2">{text(plugin.name, id)}</p><p className="mt-1 line-clamp-2 text-[9.5px] text-dim">{text(plugin.description)} · {Number(plugin.skillCount ?? 0)} skills</p></div><Toggle on={enabled} onChange={(value) => void action({ type: value ? "enable" : "disable", plugin_id: id })} /></div><button onClick={() => void action({ type: "uninstall", plugin_id: id, confirmed: true })} className="mt-2 font-mono text-[9.5px] text-red/70 hover:text-red">{t("uninstall")}</button></div>; })}</div>}
    <h3 className="lbl mb-2 mt-6 !text-[9.5px]">{t("marketplace")}</h3><div className="space-y-3">{sources.flatMap((source) => list(source.plugins).map(object).slice(0, 30).map((plugin) => <div key={`${text(source.sourceName)}-${text(plugin.relativePath)}`} className="flex items-center gap-3 rounded-[5px] border border-line bg-raise px-3 py-2"><div className="min-w-0 flex-1"><p className="text-[10.5px] text-fg2">{text(plugin.name)}</p><p className="truncate text-[9.5px] text-dim">{text(plugin.description)} · {text(source.sourceName)}</p></div><span className="font-mono text-[9.5px] text-faint">{text(plugin.installStatus)}</span>{text(plugin.installStatus) === "not_installed" && <ActionButton disabled={!sessionId} onClick={() => void marketAction(source, plugin)}>{t("install")}</ActionButton>}</div>))}</div>
    {sources.length === 0 && <ExtensionState error={marketState.error} empty={zh ? "Marketplace 暂无可用来源" : "No Marketplace sources available"} />}<MarketLinks kind="plugins" />
  </div>;
}

function MarketLinks({ kind }: { kind: "mcp" | "skills" | "plugins" }) {
  const { language } = useI18n();
  const links = kind === "mcp" ? [{ label: "Smithery", url: "https://smithery.ai/" }, { label: "MCP.so", url: "https://mcp.so/" }, { label: "GitHub MCP", url: "https://github.com/topics/mcp" }] : kind === "skills" ? [{ label: "skills.sh", url: "https://skills.sh/" }, { label: "GitHub", url: "https://github.com/topics/agent-skills" }] : [{ label: "xAI GitHub", url: "https://github.com/xai-org" }, { label: "GitHub", url: "https://github.com/topics/ai-plugins" }];
  return <div className="mt-5 flex items-center gap-2 border-t border-line pt-4"><span className="lbl !text-[9.5px]">{language === "zh-CN" ? "发现更多" : "DISCOVER"}</span>{links.map((link) => <button key={link.url} onClick={() => void invoke("open_external", { url: link.url })} className="chip">{link.label}<Icon name="external" size={9} /></button>)}</div>;
}

function ConfigDocumentsPanel() {
  const { t, language } = useI18n(); const zh = language === "zh-CN"; const cwd = useDesktop((state) => state.workspace);
  const [documents, setDocuments] = useState<ConfigDocument[]>([]); const [active, setActive] = useState<ConfigDocument["id"]>("config"); const [drafts, setDrafts] = useState<Record<string, string>>({}); const [dirty, setDirty] = useState<Record<string, boolean>>({}); const [status, setStatus] = useState("");
  useEffect(() => { let live = true; const load = async () => { try { const next = await bridge.readConfigDocuments(cwd); if (!live) return; setDocuments(next); setDrafts((current) => { const updated = { ...current }; for (const document of next) if (!dirty[document.id]) updated[document.id] = document.content; return updated; }); } catch (cause) { if (live) setStatus(cause instanceof Error ? cause.message : String(cause)); } }; void load(); const timer = window.setInterval(load, 1500); return () => { live = false; window.clearInterval(timer); }; }, [cwd, dirty]);
  const document = useMemo(() => documents.find((item) => item.id === active), [documents, active]);
  const save = async () => { if (!document) return; try { const saved = await bridge.writeConfigDocument({ ...document, content: drafts[document.id] ?? "" }); setDocuments((items) => items.map((item) => item.id === saved.id ? saved : item)); setDirty((current) => ({ ...current, [saved.id]: false })); setStatus(t("saved")); } catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); } };
  return <div className="flex min-h-[520px] flex-col"><Heading title={t("configuration")} description={zh ? "配置文件已并入账户模块。每 1.5 秒检查本地变动；config.toml、系统提示词和项目 AGENTS.md 均保持双向热同步。环境变量不再作为可编辑栏目暴露，API 接入统一由上方模型服务表单管理。" : "Configuration now lives with the account. config.toml, the system prompt, and project AGENTS.md stay in two-way hot sync. Raw environment variables are no longer exposed; API access is managed by the provider form above."} /><div className="flex gap-1 border-b border-line">{documents.map((item) => <button key={item.id} onClick={() => setActive(item.id)} className={`border-b px-3 py-2 font-mono text-[9.5px] ${active === item.id ? "border-acc text-acc" : "border-transparent text-dim"}`}>{item.label}{dirty[item.id] ? " •" : ""}</button>)}</div>{document ? <><div className="flex items-center gap-2 py-2"><span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-faint">{document.path}</span><span className="font-mono text-[9.5px] text-dim">{document.exists ? zh ? "已同步" : "SYNCED" : zh ? "新建" : "NEW"}</span><ActionButton tone="accent" onClick={() => void save()}>{t("save")}</ActionButton></div><textarea value={drafts[document.id] ?? ""} onChange={(event) => { setDrafts((current) => ({ ...current, [document.id]: event.target.value })); setDirty((current) => ({ ...current, [document.id]: true })); }} spellCheck={false} className="min-h-[360px] flex-1 resize-none rounded-[5px] border border-line2 bg-void p-3 font-mono text-[10.5px] leading-relaxed text-fg2 outline-none focus:border-acc-dim" /></> : <ExtensionState error={null} empty={t("loading")} />}{status && <p className="mt-2 font-mono text-[9.5px] text-dim">{status}</p>}</div>;
}
