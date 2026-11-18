import { useT } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ExternalLink } from "lucide-react";
import type { Bot, Model, Provider } from "@/lib/bridge";
import { useApp } from "@/state/store";
import { ProviderMark } from "@/components/Icons";
import { cn } from "@/lib/cn";

export function currentModel(providers: Provider[], modelId: string): Model | undefined {
  for (const provider of providers) {
    const found = provider.models.find((model) => model.id === modelId);
    if (found) return found;
  }
  return undefined;
}

export function ModelPicker({ bot }: { bot: Bot }) {
  const t = useT();
  const { providers, engines, state, updateBot, setUI, ui } = useApp();
  const model = currentModel(providers, bot.modelId);
  const [activeId, setActiveId] = useState(model?.provider ?? providers[0]?.id ?? "grok");
  const open = ui.modelPickerOpen;
  const active = useMemo(() => providers.find((provider) => provider.id === activeId) ?? providers[0], [providers, activeId]);

  useEffect(() => {
    if (open) setActiveId(model?.provider ?? providers[0]?.id ?? "grok");
  }, [open, model?.provider, providers]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".model-picker-anchor")) return;
      setUI({ modelPickerOpen: false });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUI({ modelPickerOpen: false });
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, setUI]);

  const engine = engines.find((item) => item.providerId === active?.id);

  const choose = async (choice: Model) => {
    if (!choice.available) return;
    if (!await updateBot(bot.id, { modelId: choice.id })) return;
    setUI({ modelPickerOpen: false });
  };

  const overrideLabel = ({
    demo: t("Grox Demo"), grok: "Grok CLI", claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI",
    api: state.settings.apiModel || t("Custom API"),
  } as Record<string, string>)[state.settings.engineMode];

  return (
    <div className="model-picker-anchor no-drag">
      <button
        type="button"
        className={cn("model-pill", open && "is-open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => overrideLabel ? setUI({ modelPickerOpen: false, settingsOpen: true, settingsSection: "engines" }) : setUI({ modelPickerOpen: !open })}
        title={overrideLabel ? t("All bots use ") + overrideLabel : t(model?.name || bot.modelId)}
      >
        {!overrideLabel && <ProviderMark provider={model?.provider ?? "local"} size={15} />}
        <span className="model-pill-name">{overrideLabel || t(model?.name || bot.modelId)}</span>
        <ChevronDown size={14} className="model-pill-chevron" />
      </button>

      {open && !overrideLabel && (
        <div className="model-picker" role="dialog" aria-label={t("Choose a model")}>
          <div className="model-rail">
            {providers.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className={cn("rail-button", provider.id === activeId && "is-active", provider.status !== "ready" && "is-dim")}
                title={provider.name + (provider.status === "ready" ? "" : t(" · not connected"))}
                aria-label={provider.name}
                onClick={() => setActiveId(provider.id)}
              >
                <ProviderMark provider={provider.id} size={17} />
                <span className={cn("rail-dot", provider.status === "ready" && "is-on")} />
              </button>
            ))}
          </div>
          <div className="model-panel">
            <div className="model-panel-head">
              <div>
                <div className="model-provider-name">{active?.name}</div>
                <div className="model-provider-detail">
                  {engine?.status === "ready"
                    ? (engine.version ? engine.version : t("CLI installed"))
                    : active?.id === "local"
                      ? t("Built into Grox · no account needed")
                      : active?.models.some((item) => item.available)
                        ? t("API key configured")
                        : t("Not connected")}
                </div>
              </div>
              <button
                type="button"
                className="model-manage"
                onClick={() => setUI({ modelPickerOpen: false, settingsOpen: true, settingsSection: "engines" })}
              >
                {t("Manage")} <ExternalLink size={12} />
              </button>
            </div>
            <div className="model-list">
              {active?.models.map((choice) => {
                const selected = choice.id === bot.modelId;
                return (
                  <button
                    type="button"
                    key={choice.id}
                    className={cn("model-row", selected && "is-selected", !choice.available && "is-disabled")}
                    disabled={!choice.available}
                    onClick={() => void choose(choice)}
                    title={!choice.available ? t("Connect this engine in Settings") : t(choice.description)}
                  >
                    <span className="model-row-copy">
                      <span className="model-row-name">
                        {t(choice.name)}
                        {choice.default && <span className="default-badge">default</span>}
                      </span>
                      <span className="model-row-desc">{t(choice.description)}</span>
                    </span>
                    {selected && <Check size={16} className="model-check" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
