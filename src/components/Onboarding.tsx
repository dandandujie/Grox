import { useRef, useState } from "react";
import { ArrowRight, Plug } from "lucide-react";
import { useApp } from "@/state/store";
import { Modal } from "@/components/ui";
import { Mascot } from "@/components/Mascot";
import { EngineModelSelect, preferredModel } from "@/components/EngineModelSelect";

export function Onboarding() {
  const { state, providers, engines, ui, setUI, selectBot, updateBot, patchSettings } = useApp();
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const bot = state.bots.find((item) => item.id === state.activeBotId && !item.hidden && !item.archived)
    ?? state.bots.find((item) => !item.hidden && !item.archived);
  const open = !state.settings.onboarded && !ui.newBotOpen && !ui.settingsOpen && !ui.newChannelOpen;
  const models = providers.flatMap((provider) => provider.models).filter((model) => model.available && model.provider !== "local");
  const selected = models.find((model) => model.id === selectedId)
    ?? models.find((model) => model.id === bot?.modelId)
    ?? preferredModel(providers);
  const configuredAPI = state.settings.engineMode === "api" && Boolean(state.settings.apiBaseUrl && state.settings.apiModel);
  const canSelectModel = models.length > 0;
  const selectedCLI = engines.some((engine) => engine.providerId === selected?.provider && engine.status === "ready");

  const finish = async (mode: "real" | "demo" | "close") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      if (mode !== "close" && bot && (mode === "demo" || !configuredAPI)) {
        const modelId = mode === "demo" ? "grox-demo" : selected?.id;
        if (!modelId || (bot.modelId !== modelId && !await updateBot(bot.id, { modelId }))) return;
      }
      const settings = mode === "demo" || (mode === "real" && !configuredAPI)
        ? { onboarded: true, engineMode: "auto" }
        : { onboarded: true };
      if (!await patchSettings(settings)) return;
      if (mode !== "close" && bot) selectBot(bot.id);
      if (mode !== "close" && !bot) setUI({ newBotOpen: true });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={() => void finish("close")} title="Set up Grox" width={480}>
      <div className="onboarding">
        <div className="onboarding-hero">
          <Mascot seed={bot?.name || "Grox"} size={60} />
          <div>
            <h2>{bot ? `Start with ${bot.name}` : "Set up your first agent"}</h2>
            <p>Choose the engine for your first conversation.</p>
          </div>
        </div>
        {configuredAPI ? (
          <div className="setup-engine"><Plug size={16} /> {state.settings.apiModel} <span>API configured</span></div>
        ) : canSelectModel && selected ? (
          <div className="setup-choice">
            <EngineModelSelect providers={providers} value={selected.id} onChange={setSelectedId} demo={false} disabled={saving} />
            <p>{selectedCLI ? "CLI installed. Sign in to it if your first message asks for authentication." : "API key configured. The first message checks whether it works."}</p>
          </div>
        ) : (
          <div className="setup-engine"><Plug size={16} /> No engine configured</div>
        )}
        <div className="setup-actions">
          <button type="button" className="btn btn-ghost" disabled={saving} title="Explore with scripted replies" onClick={() => void finish("demo")}>Try demo</button>
          <button type="button" className={configuredAPI || canSelectModel ? "btn btn-secondary" : "btn btn-primary"} disabled={saving} onClick={() => setUI({ settingsOpen: true, settingsSection: "engines" })}>
            {configuredAPI || canSelectModel ? "Engine settings" : "Connect an engine"}
          </button>
          {(configuredAPI || canSelectModel) && (
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void finish("real")}>
              {saving ? "Saving…" : "Start chatting"} <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
