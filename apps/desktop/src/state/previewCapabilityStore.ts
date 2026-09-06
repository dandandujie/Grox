import { create } from "zustand";
import type { PreviewFile } from "../bridge/types";

interface PreviewCapabilityState {
  file: PreviewFile | null;
  loading: boolean;
  error: string | null;
  setFile(file: PreviewFile | null): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
}

export const usePreviewCapability = create<PreviewCapabilityState>((set) => ({
  file: null,
  loading: false,
  error: null,
  setFile: (file) => set({ file }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
