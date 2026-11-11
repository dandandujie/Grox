import { memo } from "react";
import { PixelAvatar } from "@/components/PixelAvatar";
import { cn } from "@/lib/cn";

export interface MascotProps {
  color?: string;
  shape?: string;
  expression?: string;
  size?: number;
  avatarUrl?: string;
  faceColor?: string | null;
  className?: string;
  animated?: boolean;
  title?: string;
  /** Stable identity string for the generated portrait. Falls back to title. */
  seed?: string;
}

/**
 * The old mascot API is kept so the app's call sites stay small, but every bot
 * now renders the same deterministic 1-bit portrait system. Colour, shape and
 * expression are intentionally ignored.
 */
export const Mascot = memo(function Mascot({ size = 44, title, seed, className }: MascotProps) {
  return (
    <PixelAvatar
      seed={seed || title || "Grox"}
      title={title}
      size={size}
      className={cn("mascot", className)}
    />
  );
});
