import { create } from "zustand";
import type { ProviderProfileSummary, ProviderStatus } from "../bridge/types";

interface ProviderCapabilityState {
  provider: ProviderStatus;
  profiles: ProviderProfileSummary[];
  activeProfileId?: string;
  switching: boolean;
  setProvider(provider: ProviderStatus): void;
  setProfiles(profiles: ProviderProfileSummary[], activeProfileId?: string): void;
  setSwitching(switching: boolean): void;
}

export const useProviderCapability = create<ProviderCapabilityState>((set) => ({
  provider: { kind: "oauth", hasApiKey: false, secretBackend: "missing" },
  profiles: [],
  activeProfileId: undefined,
  switching: false,
  setProvider: (provider) => set({ provider }),
  setProfiles: (profiles, activeProfileId) => set({ profiles, activeProfileId }),
  setSwitching: (switching) => set({ switching }),
}));
