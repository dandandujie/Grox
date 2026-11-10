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
  const { providers, engines, updateBot, setUI, ui, toast } = useApp();
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
    await updateBot(bot.id, { modelId: choice.id });
    setUI({ modelPickerOpen: false });
    toast({ kind: "success", title: "Model switched", body: choice.name + " · " + choice.providerName });
  };

  return (
    <div className="model-picker-anchor no-drag">
      <button
        type="button"
        className={cn("model-pill", open && "is-open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setUI({ modelPickerOpen: !open })}
        title={model ? model.name : bot.modelId}
      >
        <ProviderMark provider={model?.provider ?? "local"} size={15} />
        <span className="model-pill-name">{model?.name ?? bot.modelId}</span>
        <ChevronDown size={14} className="model-pill-chevron" />
      </button>

      {open && (
        <div className="model-picker" role="dialog" aria-label="Choose a model">
          <div className="model-rail">
            {providers.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className={cn("rail-button", provider.id === activeId && "is-active", provider.status !== "ready" && "is-dim")}
                title={provider.name + (provider.status === "ready" ? "" : " · not connected")}
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
                    ? (engine.version ? engine.version : "CLI installed")
                    : active?.id === "local"
                      ? "Built into Grox · no account needed"
                      : active?.models.some((item) => item.available)
                        ? "API key configured"
                        : "Not connected"}
                </div>
              </div>
              <button
                type="button"
                className="model-manage"
                onClick={() => setUI({ modelPickerOpen: false, settingsOpen: true, settingsSection: "engines" })}
              >
                Manage <ExternalLink size={12} />
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
                    title={!choice.available ? "Connect this engine in Settings" : choice.description}
                  >
                    <span className="model-row-copy">
                      <span className="model-row-name">
                        {choice.name}
                        {choice.default && <span className="default-badge">default</span>}
                      </span>
                      <span className="model-row-desc">{choice.description}</span>
                    </span>
                    {selected && <Check size={16} className="model-check" />}
                  </button>
                );
              })}
            </div>
            <div className="model-panel-foot">
              <span>{active?.status === "ready" ? "Uses your local login" : "Connect an engine to unlock"}</span>
              <span className="model-foot-note">Switch mid-conversation</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
