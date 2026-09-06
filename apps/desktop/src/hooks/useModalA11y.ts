import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * 模态对话框的可访问性闭环：挂载时聚焦容器内第一个可聚焦元素并记住来源焦点，
 * Tab / Shift+Tab 在容器内圈定，Escape 触发 onClose（捕获阶段消费，避免同时
 * 触发页面级快捷键），关闭或卸载时把焦点归还来源元素。
 *
 * 仅在 `open` 为 true 的分支渲染容器（组件层面先做条件渲染），hook 生命周期
 * 即模态生命周期。jsdom 测试环境同样适用（不依赖布局几何）。
 */
export function useModalA11y(onEscape?: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = (): HTMLElement[] =>
      [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.getAttribute("aria-hidden") !== "true",
      );

    const initial = focusables()[0];
    (initial ?? container).focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 分层消费：容器内存在打开的下拉列表（ChipSelect 等）时，Esc 先归它
        // 处理（其自身会 stopPropagation），本轮不关闭整个模态。
        if (container.querySelector('[role="listbox"]')) return;
        event.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      // 完全接管 Tab 导航（而非依赖原生顺序）：jsdom 不实现原生 Tab，
      // 手动管理让真实浏览器与测试环境行为一致，且对动态 DOM 更稳。
      const elements = focusables();
      if (elements.length === 0) return;
      event.preventDefault();
      const active = document.activeElement;
      const inside = active instanceof Node && container.contains(active);
      const index = inside ? elements.indexOf(active as HTMLElement) : -1;
      if (index === -1) {
        (event.shiftKey ? elements[elements.length - 1] : elements[0]).focus();
        return;
      }
      const step = event.shiftKey ? -1 : 1;
      elements[(index + step + elements.length) % elements.length].focus();
    };
    // 捕获阶段：模态是当前最高交互层，Esc/Tab 语义优先于页面级快捷键。
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previousFocus?.focus();
    };
  }, []);

  return containerRef;
}
