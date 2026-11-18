import { AVATAR_SIZE, CIRCLE_PATH, generateAvatar } from "@/lib/pixel-avatar";
import { cn } from "@/lib/cn";

export function PixelAvatar({ seed, size = 44, title, className }: {
  seed: string;
  size?: number;
  title?: string;
  className?: string;
}) {
  const { path } = generateAvatar(seed);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}`}
      shapeRendering="crispEdges"
      className={cn("pixel-avatar", className)}
      role="img"
      aria-label={title || seed}
    >
      <path d={CIRCLE_PATH} fill="#FFFFFF" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
