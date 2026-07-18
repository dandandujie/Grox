import { useRef } from "react";

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

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    start.current = { x: event.clientX, value };
    const move = (next: PointerEvent) => {
      const delta = next.clientX - start.current.x;
      onChange(start.current.value + (side === "right" ? delta : -delta));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="group relative z-20 w-0 shrink-0 cursor-col-resize"
    >
      <span className="absolute inset-y-0 left-[-2px] w-[5px] bg-transparent transition-colors group-hover:bg-acc/25" />
    </div>
  );
}
