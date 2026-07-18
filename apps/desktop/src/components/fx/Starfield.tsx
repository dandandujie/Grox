/* ─────────────────────────────────────────────────────────────────────────
   Starfield — a sparse, slow drift of pin stars behind the home screen.
   Restraint is the point: ~110 one-pixel stars, barely moving, one in
   twelve twinkling. Space, implied.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  r: number;
  base: number;
  twinkle: number;
  phase: number;
  drift: number;
}

export function Starfield({ density = 110, className = "" }: { density?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let stars: Star[] = [];
    let raf = 0;
    let w = 0;
    let h = 0;

    const seed = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = rect.width;
      h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: density }, (_, i) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() < 0.85 ? 0.6 : 1,
        base: 0.12 + Math.random() * 0.3,
        twinkle: i % 12 === 0 ? 0.5 + Math.random() * 0.5 : 0,
        phase: Math.random() * Math.PI * 2,
        drift: 0.008 + Math.random() * 0.02,
      }));
    };

    const frame = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.y -= s.drift;
        if (s.y < -2) {
          s.y = h + 2;
          s.x = Math.random() * w;
        }
        const tw = s.twinkle ? Math.sin(t / 1400 + s.phase) * s.twinkle : 0;
        const alpha = Math.max(0.03, s.base + tw * 0.4);
        ctx.fillStyle = `rgba(232,232,232,${alpha.toFixed(3)})`;
        ctx.fillRect(s.x, s.y, s.r, s.r);
      }
      raf = requestAnimationFrame(frame);
    };

    seed();
    raf = requestAnimationFrame(frame);
    const ro = new ResizeObserver(seed);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [density]);

  return <canvas ref={ref} className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}
