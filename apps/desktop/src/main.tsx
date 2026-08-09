import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// First-paint: only the weights the shell actually uses at rest. Extra
// weights used to block startup for hundreds of ms on cold open.
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/600.css";

import "./styles/tokens.css";
import App from "./App";

document.documentElement.dataset.reduceMotion =
  localStorage.getItem("grok.pref.reduceMotion") === "1" ? "1" : "0";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
