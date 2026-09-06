import type { DiffHunk } from "../bridge/types";

function patchLines(path: string, patch: string, additions = 0, deletions = 0): DiffHunk {
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
    .filter((line) => !line.startsWith("diff --git") && !line.startsWith("index ") && !line.startsWith("@@") && !line.startsWith("--- ") && !line.startsWith("+++ "))
    .map((line) => ({
      kind: line.startsWith("+") ? "add" as const : line.startsWith("-") ? "del" as const : "ctx" as const,
      text: /^[ +\-]/.test(line) ? line.slice(1) : line,
    }));
  return { path, lines, added: additions || lines.filter((line) => line.kind === "add").length, removed: deletions || lines.filter((line) => line.kind === "del").length };
}

export function mapGitDiffs(value: unknown): DiffHunk[] {
  const envelope = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const resultValue = envelope.result ?? value;
  const result = resultValue && typeof resultValue === "object" ? resultValue as Record<string, unknown> : {};
  const files = Array.isArray(result.files) ? result.files : [];
  return files.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const file = entry as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "unknown";
    const patch = typeof file.patch === "string" ? file.patch : "";
    if (!patch && typeof file.oldText !== "string" && typeof file.newText !== "string") return [];
    if (patch) return [patchLines(path, patch, Number(file.additions) || 0, Number(file.deletions) || 0)];
    const oldText = typeof file.oldText === "string" ? file.oldText : "";
    const newText = typeof file.newText === "string" ? file.newText : "";
    const synthetic = `${oldText.split("\n").map((line) => `-${line}`).join("\n")}\n${newText.split("\n").map((line) => `+${line}`).join("\n")}`;
    return [patchLines(path, synthetic, Number(file.additions) || 0, Number(file.deletions) || 0)];
  });
}
