import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import type { PreviewFile } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { usePreviewCapability } from "../../state/previewCapabilityStore";
import { PreviewPane } from "./PreviewPane";

const initialState = useDesktop.getState();
const writeText = vi.fn(async () => undefined);

afterEach(() => {
  invoke.mockReset();
  writeText.mockClear();
  useDesktop.setState(initialState, true);
  usePreviewCapability.setState({ file: null, loading: false, error: null });
  document.body.replaceChildren();
});

describe("PreviewPane", () => {
  it("复制路径使用 Host 校验后的绝对路径", async () => {
    const file: PreviewFile = {
      path: "src/main.ts",
      name: "main.ts",
      kind: "text",
      mime: "text/plain",
      content: "export {};",
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    invoke.mockResolvedValue("/workspace/src/main.ts");
    useDesktop.setState({ workspace: "/workspace" });
    usePreviewCapability.setState({ file, loading: false, error: null });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPane />));
    const copyPath = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.title === "复制路径");
    await act(async () => copyPath?.click());

    expect(invoke).toHaveBeenCalledWith("workspace_file_path", { cwd: "/workspace", path: "src/main.ts" });
    expect(writeText).toHaveBeenCalledWith("/workspace/src/main.ts");
    await act(async () => root.unmount());
  });
});
