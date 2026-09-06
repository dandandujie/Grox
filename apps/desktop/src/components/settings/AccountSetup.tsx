import { useState } from "react";
import type { ProviderKind } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { formatGroxError, toGroxError } from "../../lib/errorModel";
import { Icon } from "../fx/Icon";
import { useModalA11y } from "../../hooks/useModalA11y";
import { BlackHole } from "../fx/BlackHole";

const providerErrorText = (cause: unknown) => formatGroxError(toGroxError(cause, {
  domain: "operation",
  code: "PROVIDER_SETUP_FAILED",
}));

export function AccountSetup() {
  const { t, language } = useI18n();
  const open = useDesktop((state) => state.accountSetupOpen);
  const configure = useDesktop((state) => state.configureProvider);
  const saveProviderProfile = useDesktop((state) => state.saveProviderProfile);
  const activateProviderProfile = useDesktop((state) => state.activateProviderProfile);
  const setOpen = useDesktop((state) => state.setAccountSetupOpen);
  const runtime = useDesktop((state) => state.runtime);
  const runtimeBusy = useDesktop((state) => state.runtimeBusy);
  const auth = useDesktop((state) => state.auth);
  const cancelAuthentication = useDesktop((state) => state.cancelAuthentication);
  const installOfficialRuntime = useDesktop((state) => state.installOfficialRuntime);
  const [kind, setKind] = useState<ProviderKind>("oauth");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyHidden, setApiKeyHidden] = useState(true);
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
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
      <RuntimeInstallDialog
        runtimeBusy={runtimeBusy}
        installRuntime={() => void installRuntime()}
        error={error}
        heading={language === "zh-CN" ? "安装官方 Grok Build CLI" : "Install the official Grok Build CLI"}
        body={language === "zh-CN"
          ? "Grox 完全使用官方 CLI 的 Agent harness、工具与 ACP，不再内置或维护替代运行时。"
          : "Grox uses the official CLI's Agent harness, tools, and ACP exclusively, with no bundled replacement runtime."}
        optionTitle={language === "zh-CN" ? "安装官方 CLI" : "Install official CLI"}
        optionBadge={language === "zh-CN" ? "推荐" : "RECOMMENDED"}
        optionDescription={language === "zh-CN"
          ? "调用 x.ai 官方安装脚本，自动安装到系统标准位置；之后终端和 Grox 共用同一个 CLI、配置和历史。"
          : "Run x.ai's official installer. Grox and your terminal will share the same CLI, configuration, and history."}
        statusLine={runtimeBusy
          ? (language === "zh-CN" ? "正在执行官方安装并重新检测…" : "Running the official installer and detecting the CLI…")
          : (language === "zh-CN" ? "未检测到官方 grok 命令" : "Official grok command not detected")}
      />
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
          // Grok Build's documented custom-model endpoint is OpenAI
          // Chat Completions. Responses-only routing belongs in a user-owned
          // custom model declaration, not an app-generated config override.
          apiBackend: "chat_completions",
          allowInsecureHttp: false,
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
      setError(providerErrorText(cause));
      setBusy(false);
    }
  };

  const deferSetup = () => {
    // 只跳过首次引导，不伪造登录状态；真正发送时仍由 auth.required 拦截。
    localStorage.setItem("grox.accountSetupComplete", "1");
    setError(null);
    setOpen(false);
  };

  const cancelSignIn = async () => {
    setError(null);
    try {
      await cancelAuthentication();
    } catch (cause) {
      setError(providerErrorText(cause));
    }
  };

  const dialogRef = useModalA11y(() => setOpen(false));
  return (
    <div className="settings-shell fixed inset-0 z-[70] flex items-center justify-center bg-void/80 p-5 backdrop-blur-[4px]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("firstRunTitle")}
        className="w-full max-w-[560px] rounded-[9px] border border-line3 bg-panel p-6 shadow-2xl animate-fade-up"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line3 bg-raise">
            <BlackHole size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[18px] font-medium text-fg">{t("firstRunTitle")}</h1>
            <p className="mt-1 text-[12px] leading-relaxed text-dim">{t("firstRunBody")}</p>
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
              <p className="mt-2 text-[12px] text-fg2">
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
                <p className="rounded-[5px] border border-line bg-raise px-3 py-2 text-[10px] leading-relaxed text-dim">{language === "zh-CN" ? "仅接入标准 OpenAI Chat Completions 服务：保存后会从 Base URL /models 获取模型，并为当前模型写入 Grok 官方的 env_key、base_url 与 api_backend=chat_completions；切回 OAuth 时自动恢复。真实 Key 始终只保存在当前 ACP 子进程环境。" : "Only standard OpenAI Chat Completions endpoints are connected here. Grox fetches Base URL /models and writes the documented env_key, base_url, and api_backend=chat_completions for the active model, restoring them on OAuth. The literal key stays only in the current ACP child environment."}</p>
              </>
            )}
          </div>
        )}

        {kind === "oauth" && (
          <div className="mt-4 rounded-[7px] border border-line bg-raise px-3 py-2.5 text-[11.5px] leading-relaxed text-dim">
            {t("oauth")} 会打开 Grok 官方登录页。登录后可读取订阅等级与上游实际提供的周额度；当前 Grok Build 接口没有独立五小时额度字段。
            {auth.error && <p className="mt-2 text-red">{auth.error}</p>}
          </div>
        )}

        {error && <p className="mt-3 rounded-[4px] border border-red/30 bg-red/5 px-3 py-2 text-[10px] text-red">{error}</p>}

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
          <button onClick={() => auth.inProgress ? void cancelSignIn() : deferSetup()} disabled={busy && !auth.inProgress} className="h-9 rounded-full px-3 text-[12px] text-dim hover:bg-high hover:text-fg2 disabled:opacity-50">
            {auth.inProgress
              ? (language === "zh-CN" ? "取消登录" : "Cancel sign-in")
              : (language === "zh-CN" ? "稍后设置，先进入应用" : "Set up later")}
          </button>
          <button
            disabled={busy || auth.inProgress}
            onClick={() => void submit()}
            className="flex h-9 min-w-[132px] items-center justify-center gap-2 rounded-full bg-acc px-5 text-[12px] font-medium text-base hover:bg-acc-deep disabled:opacity-50"
          >
            {busy && <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-base" />}
            {t("continue")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RuntimeOption({ icon, title, badge, description, disabled, onClick }: { icon: "globe" | "bolt"; title: string; badge: string; description: string; disabled: boolean; onClick(): void }) {
  return <button disabled={disabled} onClick={onClick} className="group min-h-[154px] rounded-[9px] border border-line2 bg-raise p-4 text-left transition-colors hover:border-acc-dim hover:bg-high disabled:cursor-wait disabled:opacity-50"><div className="flex items-start justify-between"><span className="flex h-8 w-8 items-center justify-center rounded-[5px] border border-line2 bg-void text-acc"><Icon name={icon} size={14} /></span><span className="rounded-full border border-line2 px-2 py-0.5 text-[10px] text-faint group-hover:text-acc">{badge}</span></div><p className="mt-4 text-[13px] font-medium text-fg">{title}</p><p className="mt-1.5 text-[11.5px] leading-relaxed text-dim">{description}</p></button>;
}
function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange(value: string): void; placeholder?: string; type?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] text-dim">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="mt-1.5 h-10 w-full rounded-[6px] border border-line2 bg-void px-3 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-acc-dim"
      />
    </label>
  );
}

function KeyField({ label, value, onChange, hidden, onToggle, language }: { label: string; value: string; onChange(value: string): void; hidden: boolean; onToggle(): void; language: string }) {
  return <label className="block"><span className="text-[11px] text-dim">{label}</span><div className="relative mt-1.5"><input type={hidden ? "password" : "text"} value={value} onChange={(event) => onChange(event.target.value)} placeholder="xai-…" autoComplete="off" spellCheck={false} className="h-10 w-full rounded-[6px] border border-line2 bg-void py-0 pl-3 pr-16 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-acc-dim" /><button type="button" onClick={onToggle} className="absolute inset-y-0 right-0 w-14 border-l border-line text-[11px] text-dim hover:text-fg">{hidden ? (language === "zh-CN" ? "显示" : "Show") : (language === "zh-CN" ? "隐藏" : "Hide")}</button></div></label>;
}

function RuntimeInstallDialog({ runtimeBusy, installRuntime, error, heading, body, optionTitle, optionBadge, optionDescription, statusLine }: {
  runtimeBusy: boolean;
  installRuntime(): void;
  error: string | null;
  heading: string;
  body: string;
  optionTitle: string;
  optionBadge: string;
  optionDescription: string;
  statusLine: string;
}) {
  const dialogRef = useModalA11y();
  return (
    <div className="settings-shell fixed inset-0 z-[70] flex items-center justify-center bg-void/80 p-5 backdrop-blur-[4px]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="w-full max-w-[620px] rounded-[9px] border border-line3 bg-panel p-6 shadow-2xl animate-fade-up"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line3 bg-raise"><BlackHole size={22} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[17px] font-medium text-fg">{heading}</h1>
            <p className="mt-1 text-[11px] leading-relaxed text-dim">{body}</p>
          </div>
        </div>
        <div className="mt-6">
          <RuntimeOption icon="globe" title={optionTitle} badge={optionBadge} description={optionDescription} disabled={runtimeBusy} onClick={installRuntime} />
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-[5px] border border-line bg-raise px-3 py-2.5 font-mono text-[9.5px] text-dim">
          <span className={`h-1.5 w-1.5 rounded-full ${runtimeBusy ? "animate-pulse-dot bg-gold" : "bg-acc"}`} />
          {statusLine}
        </div>
        {error && <p className="mt-3 rounded-[4px] border border-red/30 bg-red/5 px-3 py-2 text-[10px] text-red">{error}</p>}
      </div>
    </div>
  );
}
