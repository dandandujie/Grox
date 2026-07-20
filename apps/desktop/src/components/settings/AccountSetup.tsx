import { useState } from "react";
import type { ProviderApiBackend, ProviderKind } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";

export function AccountSetup() {
  const { t, language } = useI18n();
  const open = useDesktop((state) => state.accountSetupOpen);
  const configure = useDesktop((state) => state.configureProvider);
  const saveProviderProfile = useDesktop((state) => state.saveProviderProfile);
  const activateProviderProfile = useDesktop((state) => state.activateProviderProfile);
  const setOpen = useDesktop((state) => state.setAccountSetupOpen);
  const runtime = useDesktop((state) => state.runtime);
  const runtimeBusy = useDesktop((state) => state.runtimeBusy);
  const installOfficialRuntime = useDesktop((state) => state.installOfficialRuntime);
  const [kind, setKind] = useState<ProviderKind>("oauth");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyHidden, setApiKeyHidden] = useState(false);
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiBackend, setApiBackend] = useState<ProviderApiBackend>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  if (runtime?.selectionRequired) {
    const installRuntime = async () => {
      setError(null);
      try {
        await installOfficialRuntime();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-void/80 p-5 backdrop-blur-[4px]">
        <div className="w-full max-w-[620px] rounded-[9px] border border-line3 bg-panel p-6 shadow-2xl animate-fade-up">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line3 bg-raise"><BlackHole size={22} /></div>
            <div className="min-w-0 flex-1">
              <h1 className="text-[17px] font-medium text-fg">{language === "zh-CN" ? "安装官方 Grok Build CLI" : "Install the official Grok Build CLI"}</h1>
              <p className="mt-1 text-[11px] leading-relaxed text-dim">{language === "zh-CN" ? "Grox 完全使用官方 CLI 的 Agent harness、工具与 ACP，不再内置或维护替代运行时。" : "Grox uses the official CLI's Agent harness, tools, and ACP exclusively, with no bundled replacement runtime."}</p>
            </div>
            <button onClick={() => setOpen(false)} className="text-dim hover:text-fg" title="Close"><Icon name="x" size={14} /></button>
          </div>
          <div className="mt-6">
            <RuntimeOption
              icon="globe"
              title={language === "zh-CN" ? "安装官方 CLI" : "Install official CLI"}
              badge={language === "zh-CN" ? "推荐" : "RECOMMENDED"}
              description={language === "zh-CN" ? "调用 x.ai 官方安装脚本，自动安装到系统标准位置；之后终端和 Grox 共用同一个 CLI、配置和历史。" : "Run x.ai's official installer. Grox and your terminal will share the same CLI, configuration, and history."}
              disabled={runtimeBusy}
              onClick={() => void installRuntime()}
            />
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-[5px] border border-line bg-raise px-3 py-2.5 font-mono text-[9.5px] text-dim">
            <span className={`h-1.5 w-1.5 rounded-full ${runtimeBusy ? "animate-pulse-dot bg-gold" : "bg-acc"}`} />
            {runtimeBusy ? (language === "zh-CN" ? "正在执行官方安装并重新检测…" : "Running the official installer and detecting the CLI…") : (language === "zh-CN" ? "未检测到官方 grok 命令" : "Official grok command not detected")}
          </div>
          {error && <p className="mt-3 rounded-[4px] border border-red/30 bg-red/5 px-3 py-2 text-[10px] text-red">{error}</p>}
        </div>
      </div>
    );
  }

  const submit = async () => {
    const wasComplete = localStorage.getItem("grox.accountSetupComplete") === "1";
    setBusy(true);
    setError(null);
    try {
      if (kind === "compatible") {
        const profile = await saveProviderProfile({
          name: providerName,
          apiKey,
          baseUrl,
          apiBackend,
          residentModels: [],
        });
        localStorage.setItem("grox.accountSetupComplete", "1");
        await activateProviderProfile(profile.id);
        // Mirror configureProvider: a successful first-run setup must close
        // the modal, otherwise the user stays stuck on it (issue: 卡在初次设置).
        setBusy(false);
        setOpen(false);
      } else {
        await configure({ kind, apiKey, baseUrl });
      }
    } catch (cause) {
      if (!wasComplete) localStorage.removeItem("grox.accountSetupComplete");
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-void/80 p-5 backdrop-blur-[4px]">
      <div className="w-full max-w-[560px] rounded-[9px] border border-line3 bg-panel p-6 shadow-2xl animate-fade-up">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line3 bg-raise">
            <BlackHole size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[17px] font-medium text-fg">{t("firstRunTitle")}</h1>
            <p className="mt-1 text-[11px] leading-relaxed text-dim">{t("firstRunBody")}</p>
          </div>
          <button onClick={() => setOpen(false)} className="text-dim hover:text-fg" title="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2">
          {(["oauth", "official", "compatible"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setKind(option)}
              className={`rounded-[5px] border px-2 py-3 text-left ${kind === option ? "border-acc-dim bg-acc-wash" : "border-line2 bg-raise hover:border-line3"}`}
            >
              <Icon name={option === "oauth" ? "user" : option === "official" ? "bolt" : "globe"} size={13} className={kind === option ? "text-acc" : "text-dim"} />
              <p className="mt-2 font-mono text-[10px] text-fg2">
                {option === "oauth" ? t("oauth") : option === "official" ? t("officialApi") : t("compatibleApi")}
              </p>
            </button>
          ))}
        </div>

        {kind !== "oauth" && (
          <div className="mt-4 space-y-3">
            <KeyField label={t("apiKey")} value={apiKey} onChange={setApiKey} hidden={apiKeyHidden} onToggle={() => setApiKeyHidden((value) => !value)} language={language} />
            {kind === "compatible" && (
              <>
                <Field label={language === "zh-CN" ? "供应商名称" : "Provider name"} value={providerName} onChange={setProviderName} placeholder={language === "zh-CN" ? "例如：公司中转 / OpenRouter" : "e.g. Company gateway / OpenRouter"} />
                <Field label={t("baseUrl")} value={baseUrl} onChange={setBaseUrl} placeholder="https://example.com/v1" />
                <label className="block">
                  <span className="mb-1 block text-[9px] text-dim">{language === "zh-CN" ? "接口协议" : "API protocol"}</span>
                  <select value={apiBackend} onChange={(event) => setApiBackend(event.target.value as ProviderApiBackend)} className="h-9 w-full rounded-[4px] border border-line2 bg-void px-3 font-mono text-[10px] text-fg2 outline-none focus:border-acc-dim">
                    <option value="responses">Responses · {language === "zh-CN" ? "完整搜索/思考事件" : "full search/reasoning events"}</option>
                    <option value="chat_completions">Chat Completions · {language === "zh-CN" ? "兼容回退" : "compatibility fallback"}</option>
                    <option value="auto">AUTO · grok2api / CLIProxyAPI / NewAPI</option>
                  </select>
                </label>
                <p className="rounded-[5px] border border-line bg-raise px-3 py-2 text-[10px] leading-relaxed text-dim">{language === "zh-CN" ? "保存后会自动从 Base URL /models 获取可用模型；之后可在账户设置中选择常驻模型或添加自定义模型。" : "Grox will fetch Base URL /models automatically. Resident and custom models can be managed later in Account settings."}</p>
              </>
            )}
          </div>
        )}

        {kind === "oauth" && (
          <div className="mt-4 rounded-[5px] border border-line bg-raise px-3 py-2.5 text-[10.5px] leading-relaxed text-dim">
            {t("oauth")} 会打开 Grok 官方登录页。登录后可读取订阅等级与上游实际提供的周额度；当前 Grok Build 接口没有独立五小时额度字段。
          </div>
        )}

        {error && <p className="mt-3 rounded-[4px] border border-red/30 bg-red/5 px-3 py-2 text-[10px] text-red">{error}</p>}

        <button
          disabled={busy}
          onClick={() => void submit()}
          className="mt-5 flex h-9 w-full items-center justify-center gap-2 rounded-[5px] border border-acc-dim bg-acc-wash font-mono text-[10px] tracking-[0.08em] text-acc hover:bg-high disabled:opacity-50"
        >
          {busy && <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-acc" />}
          {t("continue")}
        </button>
      </div>
    </div>
  );
}

function RuntimeOption({ icon, title, badge, description, disabled, onClick }: { icon: "globe" | "bolt"; title: string; badge: string; description: string; disabled: boolean; onClick(): void }) {
  return <button disabled={disabled} onClick={onClick} className="group min-h-[154px] rounded-[7px] border border-line2 bg-raise p-4 text-left transition-colors hover:border-acc-dim hover:bg-high disabled:cursor-wait disabled:opacity-50"><div className="flex items-start justify-between"><span className="flex h-8 w-8 items-center justify-center rounded-[5px] border border-line2 bg-void text-acc"><Icon name={icon} size={14} /></span><span className="rounded-[3px] border border-line2 px-1.5 py-0.5 font-mono text-[8.5px] tracking-[0.08em] text-faint group-hover:text-acc">{badge}</span></div><p className="mt-4 text-[12px] font-medium text-fg">{title}</p><p className="mt-1.5 text-[10px] leading-relaxed text-dim">{description}</p></button>;
}
function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange(value: string): void; placeholder?: string; type?: string }) {
  return (
    <label className="block">
      <span className="lbl !text-[9.5px]">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="mt-1.5 h-9 w-full rounded-[4px] border border-line2 bg-void px-3 font-mono text-[10.5px] text-fg outline-none placeholder:text-faint focus:border-acc-dim"
      />
    </label>
  );
}

function KeyField({ label, value, onChange, hidden, onToggle, language }: { label: string; value: string; onChange(value: string): void; hidden: boolean; onToggle(): void; language: string }) {
  return <label className="block"><span className="lbl !text-[9.5px]">{label}</span><div className="relative mt-1.5"><input type={hidden ? "password" : "text"} value={value} onChange={(event) => onChange(event.target.value)} placeholder="xai-…" autoComplete="off" spellCheck={false} className="h-9 w-full rounded-[4px] border border-line2 bg-void py-0 pl-3 pr-16 font-mono text-[10.5px] text-fg outline-none placeholder:text-faint focus:border-acc-dim" /><button type="button" onClick={onToggle} className="absolute inset-y-0 right-0 w-14 border-l border-line font-mono text-[8.5px] text-dim hover:text-fg">{hidden ? (language === "zh-CN" ? "显示" : "SHOW") : (language === "zh-CN" ? "隐藏" : "HIDE")}</button></div></label>;
}
