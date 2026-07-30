/* ─────────────────────────────────────────────────────────────────────────
   StageTransition — keyed enter for home ↔ session (and tab swaps).
   ───────────────────────────────────────────────────────────────────────── */

import type { ReactNode } from "react";

export function StageTransition({
  stageKey,
  variant = "deck",
  className = "",
  children,
}: {
  stageKey: string;
  variant?: "deck" | "home" | "panel";
  className?: string;
  children: ReactNode;
}) {
  const enterClass =
    variant === "home"
      ? "animate-stage-home"
      : variant === "panel"
        ? "animate-stage-panel"
        : "animate-stage-deck";

  return (
    <div key={stageKey} className={`flex min-h-0 min-w-0 flex-1 flex-col ${enterClass} ${className}`}>
      {children}
    </div>
  );
}
