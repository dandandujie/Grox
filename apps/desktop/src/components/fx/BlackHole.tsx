/* ─────────────────────────────────────────────────────────────────────────
   BlackHole — the Grok mark, rendered honestly.

   Not a spinner with pretensions: an accretion disk with relativistic
   beaming (the near side burns brighter), a photon ring hugging the
   horizon, the lensed halo arcing over the top — and at the center,
   nothing. Spacecraft instruments orbit it while Grok thinks.

   Scales from 12px status glyph to the 160px hero on the home screen.
   ───────────────────────────────────────────────────────────────────────── */

import { useId, useMemo } from "react";

export interface BlackHoleProps {
  size?: number;
  /** spin the accretion flow; pass "slow" for ambient rotation */
  spin?: boolean | "slow";
  className?: string;
}

/* parametric ellipse point, tilted */
function diskPoint(
  cx: number, cy: number, rx: number, ry: number, tiltDeg: number, tDeg: number,
): [number, number] {
  const t = (tDeg * Math.PI) / 180;
  const tilt = (tiltDeg * Math.PI) / 180;
  const ex = rx * Math.cos(t);
  const ey = ry * Math.sin(t);
  return [
    cx + ex * Math.cos(tilt) - ey * Math.sin(tilt),
    cy + ex * Math.sin(tilt) + ey * Math.cos(tilt),
  ];
}

/** Build an arc as a chain of segments whose opacity follows `glow(t)`. */
function beamedArc(
  cx: number, cy: number, rx: number, ry: number, tilt: number,
  from: number, to: number, glow: (t: number) => number,
): { d: string; opacity: number }[] {
  const step = 4;
  const segs: { d: string; opacity: number }[] = [];
  for (let t = from; t < to; t += step) {
    const [x1, y1] = diskPoint(cx, cy, rx, ry, tilt, t);
    const [x2, y2] = diskPoint(cx, cy, rx, ry, tilt, t + step);
    segs.push({
      d: `M ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      opacity: glow(t + step / 2),
    });
  }
  return segs;
}

export function BlackHole({ size = 16, spin = false, className }: BlackHoleProps) {
  const rawId = useId();
  const glowId = `bh-glow-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const detailed = size >= 30;

  /* Accretion disk — front half beams brightest at lower-left (t≈135°),
     back half whisper-dim behind the horizon. */
  const arcs = useMemo(() => {
    if (!detailed) return [];
    const front = beamedArc(50, 50, 44, 13.5, -16, 0, 180, (t) => {
      const beam = (1 + Math.cos(((t - 135) * Math.PI) / 180)) / 2;
      return 0.2 + 0.72 * beam;
    });
    const back = beamedArc(50, 50, 44, 13.5, -16, 180, 360, (t) => {
      const beam = (1 + Math.cos(((t - 225) * Math.PI) / 180)) / 2;
      return 0.07 + 0.26 * beam;
    });
    return [...back, ...front];
  }, [detailed]);

  const spinClass =
    spin === "slow" ? "animate-orbit-slow" : spin ? "animate-orbit" : "";
  const revClass =
    spin === "slow" ? "animate-orbit-rev" : spin ? "animate-orbit-slow" : "";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-hidden
    >
      <defs>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--black-hole-light)" stopOpacity="0.20" />
          <stop offset="45%" stopColor="var(--black-hole-light)" stopOpacity="0.05" />
          <stop offset="100%" stopColor="var(--black-hole-light)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ambient halo */}
      <circle cx="50" cy="50" r="49" fill={`url(#${glowId})`} />

      {detailed ? (
        <>
          {/* swirling matter streaks */}
          <g className={spinClass} style={{ transformOrigin: "50px 50px" }} opacity={spin ? 1 : 0.55}>
            <circle cx="50" cy="50" r="34.5" stroke="var(--black-hole-light)" strokeWidth="0.7" strokeDasharray="1.4 7.2" opacity="0.30" />
          </g>
          <g className={revClass} style={{ transformOrigin: "50px 50px" }} opacity={spin ? 1 : 0.5}>
            <circle cx="50" cy="50" r="40" stroke="var(--black-hole-light)" strokeWidth="0.6" strokeDasharray="2.4 10.5" opacity="0.18" />
          </g>

          {/* accretion disk, relativistic beaming */}
          {arcs.map((a, i) => (
            <path key={i} d={a.d} stroke="var(--black-hole-light)" strokeWidth="5.6" strokeLinecap="round" opacity={a.opacity} />
          ))}

          {/* lensed halo over the horizon */}
          <path
            d="M 26.5 42.5 Q 50 24 73.5 42.5"
            stroke="var(--black-hole-light)"
            strokeWidth="2.2"
            strokeLinecap="round"
            opacity="0.5"
          />
        </>
      ) : (
        /* compact glyph: ring + beamed edge, nothing more */
        <>
          <circle cx="50" cy="50" r="34" stroke="var(--black-hole-light)" strokeWidth="7" opacity="0.22" />
          <path
            d="M 20.4 61 A 34 34 0 0 1 33.7 21.6"
            stroke="var(--black-hole-light)"
            strokeWidth="7"
            strokeLinecap="round"
            opacity="0.85"
          />
        </>
      )}

      {/* photon ring — the last orbit of light */}
      <circle cx="50" cy="50" r="24.5" stroke="var(--black-hole-light)" strokeWidth="4.5" opacity="0.13" />
      <circle cx="50" cy="50" r="24.5" stroke="var(--black-hole-light)" strokeWidth="1.5" opacity="0.95" />

      {/* event horizon — the nothing at the center */}
      <circle cx="50" cy="50" r="21" fill="#000000" />
    </svg>
  );
}
