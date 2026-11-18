import { localizePreset } from "@/lib/presets";
import { useT } from "@/i18n";
import { useEffect, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { useApp } from "@/state/store";
import { Mascot } from "@/components/Mascot";
import { Modal } from "@/components/ui";
import type { Preset } from "@/lib/bridge";
import { EngineModelSelect, preferredModel } from "@/components/EngineModelSelect";

export function NewBotDialog() {
  const t = useT();
  const { ui, setUI, createBot, providers, state } = useApp();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("General");
  const [description, setDescription] = useState("");
  const [soul, setSoul] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fallbackModel = preferredModel(providers);

  useEffect(() => {
    if (!ui.newBotOpen) return;
    setName("");
    setTitle("");
    setDepartment("General");
    setDescription("");
    setSoul("");
    setModelId(fallbackModel?.id ?? "grox-demo");
    setBusy(false);
    setError("");
  }, [ui.newBotOpen]);

  const presets = (state.presets ?? []).map((preset) => localizePreset(preset, t));
  const applyPreset = (preset: Preset) => {
    setTitle(preset.title);
    setDescription(preset.description);
    setSoul(preset.soul);
    if (!name) setName(preset.name);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t("Give the bot a name."));
      return;
    }
    setBusy(true);
    const bot = await createBot({ name: name.trim(), title: title.trim(), department: department.trim() || "General", description: description.trim(), soul: soul.trim(), color: "green", modelId });
    setBusy(false);
    if (bot) setUI({ newBotOpen: false });
  };

  return (
    <Modal open={ui.newBotOpen} onClose={() => setUI({ newBotOpen: false })} title={t("New bot")} width={600} className="new-bot-modal">
      <form className="new-bot" onSubmit={submit}>
        <div className="new-bot-hero">
          <Mascot seed={name || t("New bot")} size={78} />
        </div>

        <div className="preset-row">
          <span className="preset-label"><Sparkles size={13} /> {t("Start from")}</span>
          {presets.map((preset) => (
            <button type="button" key={preset.id} className="preset-chip" onClick={() => applyPreset(preset)} title={preset.description}>
              {preset.name}
            </button>
          ))}
          {presets.length === 0 && <span className="preset-empty">{t("Save a bot as a preset from its profile.")}</span>}
        </div>

        <label className="panel-field">
          <span>{t("Name")}</span>
          <input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="Onyx" />
        </label>
        <div className="form-two">
          <label className="panel-field">
            <span>{t("Role")}</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("Personal assistant")} />
          </label>
          <label className="panel-field">
            <span>{t("Department")}</span>
            <input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="General" />
          </label>
        </div>
        <EngineModelSelect providers={providers} value={modelId} onChange={setModelId} />
        <label className="panel-field">
          <span>{t("What it does")}</span>
          <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("A short description for the sidebar")} />
        </label>
        <label className="panel-field">
          <span>{t("Instructions")} <span className="field-optional">{t("Optional")}</span></span>
          <textarea rows={4} value={soul} onChange={(event) => setSoul(event.target.value)} placeholder={t("How should this bot think and speak? It can learn the rest.")} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setUI({ newBotOpen: false })}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? t("Creating…") : <><Plus size={15} /> {t("Create bot")}</>}
          </button>
        </div>
      </form>
    </Modal>
  );
}
