import type { Bootstrap, Model } from "@/lib/bridge";

export function preferredModel(providers: Bootstrap["providers"]): Model | undefined {
  const models = providers.flatMap((provider) => provider.models).filter((model) => model.available);
  return models.find((model) => model.provider !== "local" && model.default)
    ?? models.find((model) => model.provider !== "local")
    ?? models[0];
}

export function EngineModelSelect({ providers, value, onChange, demo = true, disabled }: {
  providers: Bootstrap["providers"];
  value: string;
  onChange: (value: string) => void;
  demo?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="panel-field">
      <span>Model</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {providers.map((provider) => {
          if (!demo && provider.id === "local") return null;
          const models = provider.models.filter((model) => model.available);
          if (models.length === 0) return null;
          return (
            <optgroup key={provider.id} label={provider.name}>
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}
