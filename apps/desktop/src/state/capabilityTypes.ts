import type {
  BillingInfo, DiffHunk, PreviewFile, ProjectPreview, ProviderProfileSummary, ProviderStatus,
  AccountInfo, WorkspaceEntry,
} from "../bridge/types";
import type { Automation } from "../lib/automations";
import type { AutomationRunRecord } from "../lib/automationRunHistory";

/** 非会话能力的公开快照；session store 只消费这些稳定字段。 */
export interface CapabilityState {
  account: AccountInfo | null;
  billing: BillingInfo | null;
  provider: ProviderStatus;
  providerProfiles: ProviderProfileSummary[];
  activeProviderProfileId?: string;
  providerSwitching: boolean;
  accountLoading: boolean;
  automations: Automation[];
  automationRunningId: string | null;
  automationRunHistory: AutomationRunRecord[];
  automationLastTickAt: number | null;
  workspaceFiles: WorkspaceEntry[];
  workspaceDiffs: DiffHunk[];
  workspaceDiffReady: boolean;
  projectPreview: ProjectPreview;
  previewOpen: boolean;
  previewFile: PreviewFile | null;
  previewLoading: boolean;
  previewError: string | null;
}

export const emptyCapabilityState: CapabilityState = {
  account: null,
  billing: null,
  provider: { kind: "oauth", hasApiKey: false, secretBackend: "missing" },
  providerProfiles: [],
  activeProviderProfileId: undefined,
  providerSwitching: false,
  accountLoading: false,
  automations: [],
  automationRunningId: null,
  automationRunHistory: [],
  automationLastTickAt: null,
  workspaceFiles: [],
  workspaceDiffs: [],
  workspaceDiffReady: false,
  projectPreview: { status: "idle" },
  previewOpen: false,
  previewFile: null,
  previewLoading: false,
  previewError: null,
};
