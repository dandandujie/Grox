// Runs a command with the Go toolchain this project needs.
//
// MyGo requires Go 1.27.3+. This machine may keep a newer Go beside the
// system one (for example ~/sdk/go1.27.3) while the shell still exports an
// older GOROOT. The wrapper selects the newer toolchain and removes the
// stale GOROOT so the compiler and the go command agree.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { homedir, platform } from "node:os";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: node scripts/with-go.mjs <command> [...args]");
  process.exit(2);
}

const env = { ...process.env };
const executable = platform() === "win32" ? "go.exe" : "go";
const local = join(homedir(), "sdk", "go1.27.3", "bin");
if (existsSync(join(local, executable))) {
  env.PATH = local + delimiter + (env.PATH ?? "");
}
// The backend is chosen here, so do not let a stale GOROOT or a toolchain
// download decide which compiler runs.
delete env.GOROOT;
env.GOTOOLCHAIN = "local";

const probe = spawnSync("go", ["version"], { env, encoding: "utf8" });
if (probe.status !== 0) {
  console.error("Grox needs Go 1.27.3 or newer, but no go command was found.");
  console.error("Install Go from https://go.dev/dl/ or put a 1.27.3 toolchain on PATH.");
  process.exit(1);
}
const versionText = (probe.stdout + " " + probe.stderr).trim();
const match = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionText);
if (match) {
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  const ok = major > 1 || (major === 1 && (minor > 27 || (minor === 27 && patch >= 3)));
  if (!ok) {
    console.error("Grox needs Go 1.27.3 or newer; found " + versionText);
    console.error("This wrapper looks for ~/sdk/go1.27.3 first. Install that toolchain or update PATH.");
    process.exit(1);
  }
}

const result = spawnSync(argv[0], argv.slice(1), {
  stdio: "inherit",
  env,
  shell: platform() === "win32",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
