/* Bridge factory. The shell talks to whatever this returns. */

import type { GrokBridge } from "./GrokBridge";
import { MockBridge } from "./MockBridge";
import { AcpBridge } from "./AcpBridge";

/** Tauri ships with ACP enabled; the browser remains an offline showcase. */
export function createBridge(): GrokBridge {
  const params = new URLSearchParams(window.location.search);
  const stored = window.localStorage.getItem("grok.bridge");
  const inTauri = "__TAURI_INTERNALS__" in window;
  const wantsMock = params.has("mock") || stored === "mock";
  if (inTauri && !wantsMock) return new AcpBridge();
  return new MockBridge();
}

export const bridge = createBridge();
