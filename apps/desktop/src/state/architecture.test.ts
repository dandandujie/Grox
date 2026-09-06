import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("组件运行时边界", () => {
  it("不直接调用 Tauri IPC 或 ACP bridge", () => {
    const violations = sourceFiles(join(process.cwd(), "src/components")).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return /\b(?:invoke\s*(?:<[^>]+>)?\s*\(|bridge\.)/.test(source)
        || /from\s+["'][^"']*\/bridge["']/.test(source)
        ? [path]
        : [];
    });
    expect(violations).toEqual([]);
  });

  it("不直接引用 @tauri-apps/api（事件/窗口走 lib/hostActions；仅纯资源 URL 助手登记白名单）", () => {
    // convertFileSrc 是纯资源 URL 助手（无 IPC、无副作用），允许在消费组件内直接使用。
    const allowlisted = new Set([
      join(process.cwd(), "src/components/home/MediaStudio.tsx"),
      join(process.cwd(), "src/components/session/ToolCallCard.tsx"),
    ]);
    const violations = sourceFiles(join(process.cwd(), "src/components")).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      if (!source.includes("@tauri-apps/api")) return [];
      if (allowlisted.has(path)) {
        // 白名单文件也只允许 core 的 convertFileSrc，不允许 event/window。
        return /@tauri-apps\/api\/(event|window)/.test(source) ? [`${path}（只允许 convertFileSrc）`] : [];
      }
      return [path];
    });
    expect(violations).toEqual([]);
  });
});

describe("IPC 所有权边界", () => {
  it("直接 invoke 只能出现在已登记的 runtime/持久化适配器", () => {
    const allowed = new Set([
      join(process.cwd(), "src/bridge/AcpBridge.ts"),
      join(process.cwd(), "src/lib/automations.ts"),
      join(process.cwd(), "src/lib/defaultOpen.ts"),
      join(process.cwd(), "src/lib/draftPersistence.ts"),
        join(process.cwd(), "src/lib/markdown.tsx"),
      join(process.cwd(), "src/lib/notify.ts"),
      join(process.cwd(), "src/lib/promptQueuePersistence.ts"),
      join(process.cwd(), "src/lib/sessionCache.ts"),
      join(process.cwd(), "src/lib/hostActions.ts"),
      join(process.cwd(), "src/lib/offlineSessionHydrate.ts"),
      join(process.cwd(), "src/lib/pathAttachments.ts"),
      join(process.cwd(), "src/state/store.ts"),
    ]);
    const violations = sourceFiles(join(process.cwd(), "src")).filter((path) => {
      const source = readFileSync(path, "utf8");
      return /\binvoke\s*(?:<[^>]+>)?\s*\(/.test(source) && !allowed.has(path);
    });
    expect(violations).toEqual([]);
  });
});
