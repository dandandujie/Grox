import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "@fontsource/geist-mono/700.css";

import "./styles/tokens.css";
import App from "./App";

document.documentElement.dataset.reduceMotion =
  localStorage.getItem("grok.pref.reduceMotion") === "1" ? "1" : "0";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
