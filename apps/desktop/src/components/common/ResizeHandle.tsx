import { useEffect, useRef } from "react";

export function ResizeHandle({
  side,
  value,
  onChange,
}: {
  side: "left" | "right";
  value: number;
  onChange(value: number): void;
}) {
  const start = useRef({ x: 0, value });
  const frame = useRef<number | undefined>(undefined);
  const pendingValue = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    start.current = { x: event.clientX, value };
    const move = (next: PointerEvent) => {
      const delta = next.clientX - start.current.x;
      pendingValue.current = start.current.value + (side === "right" ? delta : -delta);
      if (frame.current !== undefined) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        if (pendingValue.current !== undefined) onChange(pendingValue.current);
      });
    };
    const up = () => {
      if (frame.current !== undefined) {
        cancelAnimationFrame(frame.current);
        frame.current = undefined;
      }
      if (pendingValue.current !== undefined) onChange(pendingValue.current);
      pendingValue.current = undefined;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="group relative z-20 w-0 shrink-0 touch-none cursor-col-resize select-none"
    >
      <span className="absolute inset-y-0 left-[-2px] w-[5px] bg-transparent transition-colors group-hover:bg-acc/25" />
    </div>
  );
}
