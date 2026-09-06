import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// i18n 棘轮：冻结「内联双语三元」的存量，禁止新增。
//
// 仓库的双语机制是 lib/i18n.ts 的 t()，但存量代码大量使用
// `language === "zh-CN" ? … : …` / `zh ? … : …` 内联写法（约 800 处）。
// 推倒重来不值得；本测试按文件冻结存量计数，只拦新增：
// - 新增内联双语 → 计数超过基线 → 测试红，请改走 t()；
// - 清理存量 → 欢迎把基线数字同步下调；
// - 确属一次性文案且 Review 通过 → 有意上调基线并在 PR 说明。

const INLINE_BILINGUAL = /language === "zh-CN"|\bzh \? /g;

/** 基线 = 2026-09 全量清点结果；只允许下调，不允许悄悄上调。 */
const BASELINE: Record<string, number> = {
  "src/components/chrome/EnvironmentSummary.tsx": 80,
  "src/components/chrome/Sidebar.tsx": 66,
  "src/components/chrome/StatusBar.tsx": 4,
  "src/components/chrome/TitleBar.tsx": 14,
  "src/components/chrome/WorkbenchPanel.tsx": 11,
  // 12 -> 13：菜单容器补 role="dialog" 的 aria-label（2026-09，a11y 改造新增）。
  "src/components/common/PromptControls.tsx": 13,
  "src/components/home/AutomationsStudio.tsx": 52,
  "src/components/home/Home.tsx": 36,
  "src/components/home/MediaStudio.tsx": 47,
  "src/components/inspector/Inspector.tsx": 52,
  "src/components/palette/CommandPalette.tsx": 10,
  "src/components/preview/PlanPreviewPane.tsx": 17,
  "src/components/preview/PreviewPane.tsx": 1,
  // 61 -> 70：FeedbackDialog 从内联 JSX 提取为组件，文案原样搬移+zh 布尔命名，
  // 未新增用户可见文案（2026-09）。
  "src/components/session/Composer.tsx": 70,
  "src/components/session/PermissionCard.tsx": 8,
  "src/components/session/PlanCard.tsx": 3,
  "src/components/session/QuestionCard.tsx": 13,
  "src/components/session/RewindMenu.tsx": 34,
  "src/components/session/ThinkingBlock.tsx": 2,
  "src/components/session/Timeline.tsx": 35,
  "src/components/session/ToolCallCard.tsx": 18,
  "src/components/session/TurnChangeCard.tsx": 7,
  "src/components/session/blocks.tsx": 10,
  "src/components/settings/AccountSetup.tsx": 14,
  "src/components/settings/SettingsModal.tsx": 170,
  "src/components/terminal/TerminalPanel.tsx": 3,
  "src/components/update/UpdateNotice.tsx": 21,
};

describe("i18n 棘轮", () => {
  it("组件不得新增内联双语三元（新文案走 lib/i18n.ts 的 t()）", () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const [file, baseline] of Object.entries(BASELINE)) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const count = source.match(INLINE_BILINGUAL)?.length ?? 0;
      seen.add(file);
      if (count > baseline) {
        violations.push(`${file}: ${count} > 基线 ${baseline}（新增 ${count - baseline} 处）。新文案请走 t()；有意新增请更新本测试基线并在 PR 说明。`);
      }
    }
    expect(violations).toEqual([]);

    // 新文件也要纳入：任何含内联双语的组件文件都必须登记进基线。
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path) : /\.tsx$/.test(entry.name) && !entry.name.includes(".test.") ? [relative(process.cwd(), path)] : [];
      });
    for (const path of walk(join(process.cwd(), "src/components"))) {
      const count = (readFileSync(path, "utf8").match(INLINE_BILINGUAL)?.length ?? 0);
      if (count > 0 && !seen.has(path)) {
        violations.push(`${path}: 新组件出现 ${count} 处内联双语，请登记进基线或改走 t()`);
      }
    }
    expect(violations).toEqual([]);
  });
});
