import { useState } from "react";
import type { ProviderKind } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";

export function AccountSetup() {
  const { t } = useI18n();
  const open = useDesktop((state) => state.accountSetupOpen);
  const configure = useDesktop((state) => state.configureProvider);
  const setOpen = useDesktop((state) => state.setAccountSetupOpen);
  const [kind, setKind] = useState<ProviderKind>("oauth");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelsUrl, setModelsUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await configure({ kind, apiKey, baseUrl, modelsUrl });
    } catch (cause) {
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
            <Field label={t("apiKey")} value={apiKey} onChange={setApiKey} type="password" placeholder="xai-…" />
            {kind === "compatible" && (
              <>
                <Field label={t("baseUrl")} value={baseUrl} onChange={setBaseUrl} placeholder="https://example.com/v1" />
                <Field label={t("modelsUrl")} value={modelsUrl} onChange={setModelsUrl} placeholder="https://example.com/v1/models" />
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
