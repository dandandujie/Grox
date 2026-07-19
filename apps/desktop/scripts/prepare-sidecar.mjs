import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cargoManifest = resolve(repoRoot, "Cargo.toml");
const debug = process.argv.includes("--debug");
const targetIndex = process.argv.indexOf("--target");
const requestedTarget = targetIndex >= 0 ? process.argv[targetIndex + 1]?.trim() : undefined;
if (targetIndex >= 0 && !requestedTarget) {
  throw new Error("--target 后必须提供 Rust target triple");
}

const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (rustc.status !== 0) {
  throw new Error(`无法读取 Rust 主机信息：${rustc.stderr || rustc.error}`);
}
const host = rustc.stdout.match(/^host:\s+(.+)$/m)?.[1]?.trim();
if (!host) throw new Error("rustc -vV 未返回 host triple");
const target = requestedTarget || host;

// MSVC cannot emit a PDB for the full debug Grok binary (LNK1318 / PDB LIMIT).
// `cargo rustc` applies debuginfo=0 only to the final Windows executable, so
// dependency artifacts remain reusable and Tauri development stays fast.
const windowsDebug = debug && target.includes("windows");
const cargoArgs = [
  windowsDebug ? "rustc" : "build",
  "--locked",
  "--manifest-path",
  cargoManifest,
  "-p",
  "xai-grok-pager-bin",
];
if (!debug) {
  cargoArgs.push("--profile", "release-dist", "--features", "release-dist");
}
if (requestedTarget) cargoArgs.push("--target", requestedTarget);
if (windowsDebug) {
  cargoArgs.push(
    "--bin",
    "xai-grok-pager",
    "--",
    "-C",
    "debuginfo=0",
    "-C",
    "link-arg=/DEBUG:NONE",
  );
}
const build = spawnSync(
  "cargo",
  cargoArgs,
  { cwd: repoRoot, stdio: "inherit" },
);
if (build.status !== 0) {
  throw new Error(`Grok Build sidecar 编译失败（退出码 ${build.status ?? "unknown"}）`);
}

const extension = target.includes("windows") ? ".exe" : "";
const targetRoot = process.env.CARGO_TARGET_DIR
  ? resolve(repoRoot, process.env.CARGO_TARGET_DIR)
  : resolve(repoRoot, "target");
const source = resolve(
  targetRoot,
  ...(requestedTarget ? [requestedTarget] : []),
  debug ? "debug" : "release-dist",
  `xai-grok-pager${extension}`,
);
const destinationDir = resolve(desktopRoot, "src-tauri", "binaries");
const destination = resolve(destinationDir, `grok-${target}${extension}`);
mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);
console.log(`Sidecar ready: ${destination}`);
