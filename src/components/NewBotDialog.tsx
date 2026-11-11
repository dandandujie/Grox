import { useEffect, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { useApp } from "@/state/store";
import { Mascot } from "@/components/Mascot";
import { Modal } from "@/components/ui";
import type { Preset } from "@/lib/bridge";

export function NewBotDialog() {
  const { ui, setUI, createBot, providers, state } = useApp();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("General");
  const [description, setDescription] = useState("");
  const [soul, setSoul] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const options = providers.flatMap((provider) => provider.models.filter((model) => model.available).map((model) => ({ provider, model })));
  const fallbackModel = options.find((item) => item.model.default) ?? options[0];

  useEffect(() => {
    if (!ui.newBotOpen) return;
    setName("");
    setTitle("");
    setDepartment("General");
    setDescription("");
    setSoul("");
    setModelId(fallbackModel?.model.id ?? "grox-demo");
    setBusy(false);
    setError("");
  }, [ui.newBotOpen]);

  const presets: Preset[] = state.presets ?? [];
  const applyPreset = (preset: Preset) => {
    setTitle(preset.title);
    setDescription(preset.description);
    setSoul(preset.soul);
    if (!name) setName(preset.name);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the bot a name.");
      return;
    }
    setBusy(true);
    const bot = await createBot({ name: name.trim(), title: title.trim(), department: department.trim() || "General", description: description.trim(), soul: soul.trim(), color: "green", modelId });
    setBusy(false);
    if (bot) setUI({ newBotOpen: false });
  };

  return (
    <Modal open={ui.newBotOpen} onClose={() => setUI({ newBotOpen: false })} title="New bot" width={600} className="new-bot-modal">
      <form className="new-bot" onSubmit={submit}>
        <div className="new-bot-hero">
          <Mascot seed={name || "New bot"} size={78} />
          <p className="new-bot-avatar-note">The portrait is generated from the name. Rename the bot later to change its seed.</p>
        </div>

        <div className="preset-row">
          <span className="preset-label"><Sparkles size={13} /> Start from</span>
          {presets.map((preset) => (
            <button type="button" key={preset.id} className="preset-chip" onClick={() => applyPreset(preset)} title={preset.description}>
              {preset.name}
            </button>
          ))}
          {presets.length === 0 && <span className="preset-empty">Save a bot as a preset from its profile.</span>}
        </div>

        <label className="panel-field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="Onyx" />
        </label>
        <div className="form-two">
          <label className="panel-field">
            <span>Role</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Personal assistant" />
          </label>
          <label className="panel-field">
            <span>Department</span>
            <input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="General" />
          </label>
        </div>
        <div className="form-two">
          <label className="panel-field">
            <span>Model</span>
            <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
              {providers.map((provider) => {
                const available = provider.models.filter((model) => model.available);
                if (!available.length) return null;
                return (
                  <optgroup key={provider.id} label={provider.name}>
                    {available.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </label>
        </div>
        <label className="panel-field">
          <span>What it does</span>
          <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="A short description for the sidebar" />
        </label>
        <label className="panel-field">
          <span>Instructions <span className="field-optional">optional</span></span>
          <textarea rows={4} value={soul} onChange={(event) => setSoul(event.target.value)} placeholder="How should this bot think and speak? It can learn the rest." />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setUI({ newBotOpen: false })}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : <><Plus size={15} /> Create bot</>}
          </button>
        </div>
      </form>
    </Modal>
  );
}
