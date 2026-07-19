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
    let resizeRaf = 0;
    let w = 0;
    let h = 0;
    let lastFrame = 0;

    const reducedMotion = () =>
      document.documentElement.dataset.reduceMotion === "1" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const seed = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

    const draw = (t: number, advance: boolean) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        if (advance) s.y -= s.drift;
        if (s.y < -2) {
          s.y = h + 2;
          s.x = Math.random() * w;
        }
        const tw = s.twinkle ? Math.sin(t / 1400 + s.phase) * s.twinkle : 0;
        const alpha = Math.max(0.03, s.base + tw * 0.4);
        ctx.fillStyle = `rgba(232,232,232,${alpha.toFixed(3)})`;
        ctx.fillRect(s.x, s.y, s.r, s.r);
      }
    };

    const frame = (t: number) => {
      if (t - lastFrame >= 32) {
        draw(t, true);
        lastFrame = t;
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (document.hidden || reducedMotion()) {
        draw(0, false);
        return;
      }
      lastFrame = 0;
      raf = requestAnimationFrame(frame);
    };

    const sync = () => start();

    seed();
    start();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        seed();
        start();
      });
    });
    ro.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("grox-motion-change", sync);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("grox-motion-change", sync);
    };
  }, [density]);

  return <canvas ref={ref} className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}
