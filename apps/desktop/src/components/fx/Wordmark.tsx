/* ─────────────────────────────────────────────────────────────────────────
   The wordmark. GROK — set in the house grotesque, tracked wide, paired
   with the black hole. Nothing else needs to be said.
   ───────────────────────────────────────────────────────────────────────── */

import type { ReactNode } from "react";
import { BlackHole } from "./BlackHole";

export function Wordmark({
  size = 15,
  withMark = true,
  markSpin = false,
  className = "",
}: {
  size?: number;
  withMark?: boolean;
  markSpin?: boolean | "slow";
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      {withMark && <BlackHole size={size * 1.35} spin={markSpin} />}
      <span
        className="font-sans font-semibold text-fg"
        style={{ fontSize: size, letterSpacing: "0.34em", marginRight: "-0.34em" }}
      >
        GROK
      </span>
    </span>
  );
}

/** Mono caption paired under the wordmark, e.g. "DESKTOP · BUILD 0.1.0". */
export function WordmarkCaption({ children }: { children: ReactNode }) {
  return (
    <div className="lbl" style={{ letterSpacing: "0.3em" }}>
      {children}
    </div>
  );
}
