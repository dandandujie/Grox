import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalA11y } from "./useModalA11y";

afterEach(() => {
  document.body.replaceChildren();
});

function Host({ onEscape }: { onEscape?: () => void }) {
  const ref = useModalA11y(onEscape);
  return (
    <div>
      <button id="outside">outside</button>
      <div id="modal" ref={ref} role="dialog" aria-modal="true">
        <button id="first">first</button>
        <button id="last">last</button>
      </div>
    </div>
  );
}

async function renderHost(onEscape?: () => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Host onEscape={onEscape} />));
  return { container, unmount: () => act(() => root.unmount()) };
}

const press = (key: string, shift = false) =>
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true }),
    );
  });

describe("useModalA11y", () => {
  it("挂载时聚焦容器内第一个可聚焦元素，卸载时归还焦点", async () => {
    const outside = document.createElement("button");
    outside.id = "origin";
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const { unmount } = await renderHost();
    expect(document.activeElement?.id).toBe("first");

    unmount();
    expect(document.activeElement).toBe(outside);
  });

  it("Tab 在容器内圈定，Shift+Tab 从首元素回绕到最后一个", async () => {
    await renderHost();
    const first = document.getElementById("first")!;
    const last = document.getElementById("last")!;
    first.focus();

    press("Tab");
    expect(document.activeElement).toBe(last);

    press("Tab", true);
    expect(document.activeElement).toBe(first);
  });

  it("Escape 只消费给模态并通知 onClose", async () => {
    const onEscape = vi.fn();
    await renderHost(onEscape);
    press("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.id).toBe("first");
  });

  it("焦点逃逸到容器外时，下一次 Tab 拉回容器", async () => {
    await renderHost();
    const outside = document.getElementById("outside")!;
    outside.focus();
    press("Tab");
    expect(document.activeElement?.id).toBe("first");
  });
});
