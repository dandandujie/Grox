import { create } from "zustand";
import type { Automation } from "../lib/automations";
import type { AutomationRunRecord } from "../lib/automationRunHistory";

interface AutomationCapabilityState {
  automations: Automation[];
  runningId: string | null;
  runHistory: AutomationRunRecord[];
  lastTickAt: number | null;
  setAutomations(automations: Automation[]): void;
  setRunningId(runningId: string | null): void;
  setRunHistory(runHistory: AutomationRunRecord[]): void;
  setLastTickAt(lastTickAt: number | null): void;
}

export const useAutomationCapability = create<AutomationCapabilityState>((set) => ({
  automations: [],
  runningId: null,
  runHistory: [],
  lastTickAt: null,
  setAutomations: (automations) => set({ automations }),
  setRunningId: (runningId) => set({ runningId }),
  setRunHistory: (runHistory) => set({ runHistory }),
  setLastTickAt: (lastTickAt) => set({ lastTickAt }),
}));
