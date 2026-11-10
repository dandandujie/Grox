import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "Grox",
  slug: "grox",
  identifier: "app.grox.desktop",
  version: "0.1.0",
  copyright: "© 2026 Grox contributors",
  license: "Apache-2.0",
  devUrl: "http://localhost:5174",
  devCommand: "npm run dev:web",
  buildCommand: "npm run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  macos: {
    minimumSystemVersion: "14.0",
    signingIdentity: "-",
  },
  linux: {
    categories: ["Utility", "Office"],
    comment: "A local-first chat app for a team of AI agents",
  },
});
