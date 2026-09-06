import type { PreviewFile } from "../bridge/types";

export type FilePreviewState = {
  previewOpen: boolean;
  planPreviewOpen: boolean;
  inspectorOpen: boolean;
  terminalOpen: boolean;
  previewLoading: boolean;
  previewFile: PreviewFile | null;
  previewError: string | null;
};

export function beginFilePreview(): FilePreviewState {
  return {
    previewOpen: true,
    planPreviewOpen: false,
    inspectorOpen: false,
    terminalOpen: false,
    previewLoading: true,
    previewFile: null,
    previewError: null,
  };
}

export function finishFilePreview(previewFile: PreviewFile): Pick<FilePreviewState, "previewFile" | "previewLoading"> {
  return { previewFile, previewLoading: false };
}

export function failFilePreview(message: string): Pick<FilePreviewState, "previewFile" | "previewLoading" | "previewError"> {
  return { previewFile: null, previewLoading: false, previewError: message };
}

export function closeFilePreview(): Pick<FilePreviewState, "previewOpen" | "previewLoading" | "previewFile" | "previewError"> {
  return { previewOpen: false, previewLoading: false, previewFile: null, previewError: null };
}
