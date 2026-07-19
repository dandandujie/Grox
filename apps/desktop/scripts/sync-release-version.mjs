import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawTag = process.argv[2]?.trim() || process.env.GITHUB_REF_NAME?.trim();
const version = rawTag?.replace(/^[vV]/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`无效的 Release tag：${rawTag || "<empty>"}`);
}

for (const relativePath of ["package.json", "src-tauri/tauri.conf.json"]) {
  const path = resolve(desktopRoot, relativePath);
  const contents = readFileSync(path, "utf8");
  if (!/"version"\s*:\s*"[^"]+"/.test(contents)) {
    throw new Error(`未在 ${relativePath} 中找到 version`);
  }
  writeFileSync(
    path,
    contents.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`),
  );
}

const cargoPath = resolve(desktopRoot, "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
if (!/(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m.test(cargo)) {
  throw new Error("未在 Tauri Cargo.toml 中找到 package.version");
}
const updatedCargo = cargo.replace(
  /(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
  `$1"${version}"`,
);
writeFileSync(cargoPath, updatedCargo);

const cargoLockPath = resolve(desktopRoot, "src-tauri", "Cargo.lock");
const cargoLock = readFileSync(cargoLockPath, "utf8");
const desktopPackage = /(\[\[package\]\]\s+name\s*=\s*"grox-desktop"\s+version\s*=\s*)"[^"]+"/;
if (!desktopPackage.test(cargoLock)) {
  throw new Error("未在 Tauri Cargo.lock 中找到 grox-desktop package.version");
}
writeFileSync(
  cargoLockPath,
  cargoLock.replace(desktopPackage, `$1"${version}"`),
);

console.log(`Release version synchronized: ${version}`);
