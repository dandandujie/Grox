#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(desktopRoot, "src-tauri", "icons", "app-icon.svg");
const output = resolve(desktopRoot, "src-tauri", "icons");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpm,
  ["tauri", "icon", source, "--output", output],
  { cwd: desktopRoot, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.status !== 0) {
  throw new Error(`图标生成失败（退出码 ${result.status ?? "unknown"}）`);
}
