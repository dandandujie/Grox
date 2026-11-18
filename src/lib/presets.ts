import type { Translate } from "@/i18n";
import type { Preset } from "@/lib/bridge";

const DEFAULT_IDS = new Set(["preset-research", "preset-inbox-chief", "preset-code-review", "preset-operations"]);

export function localizePreset(preset: Preset, t: Translate): Preset {
  if (!DEFAULT_IDS.has(preset.id)) return preset;
  return {
    ...preset,
    name: t(preset.name),
    title: t(preset.title),
    description: t(preset.description),
    soul: t(preset.soul),
  };
}
