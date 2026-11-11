import { useId, useMemo } from "react";
import { CIRCLE_PATH, blackPixels, generateAvatar } from "@/lib/pixel-avatar";
import { cn } from "@/lib/cn";

export function PixelAvatar({ seed, size = 44, title, className }: {
  seed: string;
  size?: number;
  title?: string;
  className?: string;
}) {
  const avatar = useMemo(() => generateAvatar(seed), [seed]);
  const pixels = useMemo(() => blackPixels(avatar), [avatar]);
  const reactId = useId();
  const clipId = "pixel-avatar-" + reactId.replace(/[^a-zA-Z0-9_-]/g, "");
  const label = title || avatar.seed;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      className={cn("pixel-avatar", className)}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <defs>
        <clipPath id={clipId}>
          <path d={CIRCLE_PATH} />
        </clipPath>
      </defs>
      <path d={CIRCLE_PATH} fill="#FFFFFF" />
      <g clipPath={"url(#" + clipId + ")"}>
        {pixels.map(([x, y]) => (
          <rect key={x + "-" + y} x={x} y={y} width={1} height={1} fill="#000000" />
        ))}
      </g>
    </svg>
  );
}
