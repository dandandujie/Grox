import { useCallback, useRef } from "react";

type KeyLike = {
  key: string;
  nativeEvent: { isComposing?: boolean };
  keyCode: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * 屏蔽输入法候选确认使用的 Enter，包括部分 WebView 在 compositionend 后
 * 额外派发、且 isComposing 已变为 false 的那一次 Enter。
 */
export function useImeGuard() {
  const composing = useRef(false);
  const justEnded = useRef(false);
  const clearTimer = useRef<number | null>(null);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
    justEnded.current = false;
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    clearTimer.current = null;
  }, []);

  const onCompositionEnd = useCallback(() => {
    composing.current = false;
    justEnded.current = true;
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => {
      justEnded.current = false;
      clearTimer.current = null;
    }, 100);
  }, []);

  const isImeBlocking = useCallback((event: KeyLike) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return true;
    if (
      justEnded.current &&
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      justEnded.current = false;
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
      clearTimer.current = null;
      return true;
    }
    return false;
  }, []);

  return { onCompositionStart, onCompositionEnd, isImeBlocking };
}
