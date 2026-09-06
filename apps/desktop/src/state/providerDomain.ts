import { MODELS } from "../bridge/types";
import type { ModelState, ProviderProfileSummary } from "../bridge/types";

export function providerProfilesState(result: { profiles: ProviderProfileSummary[]; activeId?: string }) {
  return { providerProfiles: result.profiles, activeProviderProfileId: result.activeId };
}

export function resolveModelState(state: ModelState) {
  const models = state.models.length > 0 ? state.models : MODELS;
  const saved = localStorage.getItem("grok.model");
  const model = (saved && models.some((item) => item.id === saved) ? saved : undefined)
    ?? (models.some((item) => item.id === state.currentId) ? state.currentId : models[0].id);
  localStorage.setItem("grok.model", model);
  return { models, model, modelsUpdatedAt: Date.now() };
}

export function providerModelState(state: ModelState, profile?: ProviderProfileSummary): ModelState {
  if (!profile || profile.residentModels.length === 0) return state;
  return {
    currentId: profile.residentModels.includes(state.currentId) ? state.currentId : profile.residentModels[0],
    models: profile.residentModels.map((id) => state.models.find((item) => item.id === id) ?? {
      id,
      label: id,
      tagline: profile.name,
    }),
  };
}

export const providerDefaultModel = (profile?: ProviderProfileSummary) =>
  profile?.residentModels[0] ?? profile?.availableModels[0];
