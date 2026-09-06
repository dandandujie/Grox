import { describe, expect, it } from "vitest";
import { beginFilePreview, closeFilePreview, failFilePreview, finishFilePreview } from "./previewDomain";

describe("previewDomain", () => {
  it("只表达文件预览状态转换，不携带 IPC 或竞态状态", () => {
    expect(beginFilePreview()).toMatchObject({ previewOpen: true, previewLoading: true, previewFile: null });
    const file = { kind: "text", path: "README.md", name: "README.md", mime: "text/markdown", content: "ok" } as const;
    expect(finishFilePreview(file)).toEqual({ previewFile: file, previewLoading: false });
    expect(failFilePreview("读取失败")).toEqual({ previewFile: null, previewLoading: false, previewError: "读取失败" });
    expect(closeFilePreview()).toEqual({ previewOpen: false, previewLoading: false, previewFile: null, previewError: null });
  });
});
