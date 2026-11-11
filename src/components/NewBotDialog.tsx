import { useEffect, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { useApp } from "@/state/store";
import { Mascot } from "@/components/Mascot";
import { Modal } from "@/components/ui";

const PRESETS = [
  { title: "Research", description: "Market maps, diligence, and clean sources.", soul: "You are a research analyst. Lead with the finding, keep sources close, and say when the data is weak." },
  { title: "Inbox chief", description: "Drafts in your voice. Never sends without you.", soul: "You are an inbox chief. Triage by what needs a human decision, draft replies that sound like the person you work for, and never send or delete without approval." },
  { title: "Code review", description: "Reads the diff before it types.", soul: "You are a senior engineer who reviews code. Be direct, rank findings by risk, and separate correctness from style." },
  { title: "Operations", description: "Turns plans into owners and dates.", soul: "You are an operations lead. When asked to prioritize, force a tradeoff, name an owner, and end with a single next action." },
];

export function NewBotDialog() {
  const { ui, setUI, createBot, providers } = useApp();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
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
    setDescription("");
    setSoul("");
    setModelId(fallbackModel?.model.id ?? "grox-demo");
    setBusy(false);
    setError("");
  }, [ui.newBotOpen]);

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setTitle(preset.title);
    setDescription(preset.description);
    setSoul(preset.soul);
    if (!name) setName(preset.title.split(" ")[0] ?? "");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the bot a name.");
      return;
    }
    setBusy(true);
    const bot = await createBot({ name: name.trim(), title: title.trim(), description: description.trim(), soul: soul.trim(), color: "green", modelId });
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
          {PRESETS.map((preset) => (
            <button type="button" key={preset.title} className="preset-chip" onClick={() => applyPreset(preset)}>
              {preset.title}
            </button>
          ))}
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
