import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "./styles.css";
import "./styles-panels.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Grox: #root is missing");
createRoot(root).render(<App />);
