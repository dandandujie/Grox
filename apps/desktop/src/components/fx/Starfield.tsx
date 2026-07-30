/* ─────────────────────────────────────────────────────────────────────────
   Starfield — deep-field canvas behind mission control.

   Three parallax layers, soft nebula washes, occasional meteors, and a
   light pointer warp so the void feels alive without turning into noise.
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
  depth: number;
  hue: number;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  width: number;
}

interface Nebula {
  x: number;
  y: number;
  r: number;
  a: number;
  hue: number;
  driftX: number;
  driftY: number;
  phase: number;
}

export function Starfield({
  density = 160,
  interactive = true,
  className = "",
}: {
  density?: number;
  interactive?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let stars: Star[] = [];
    let nebulas: Nebula[] = [];
    let meteors: Meteor[] = [];
    let raf = 0;
    let resizeRaf = 0;
    let w = 0;
    let h = 0;
    let lastFrame = 0;
    let pointerX = 0.5;
    let pointerY = 0.5;
    let targetX = 0.5;
    let targetY = 0.5;
    let nextMeteor = 1800 + Math.random() * 2400;

    const reducedMotion = () =>
      document.documentElement.dataset.reduceMotion === "1" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const isLight = () => document.documentElement.dataset.theme === "light";

    const seed = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      stars = Array.from({ length: density }, (_, i) => {
        const depth = i % 5 === 0 ? 1.35 : i % 3 === 0 ? 1 : 0.55;
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          r: depth > 1.2 ? 1.35 + Math.random() * 0.8 : depth > 0.9 ? 0.85 : 0.55,
          base: 0.1 + Math.random() * (0.18 + depth * 0.18),
          twinkle: i % 7 === 0 ? 0.45 + Math.random() * 0.55 : i % 11 === 0 ? 0.25 : 0,
          phase: Math.random() * Math.PI * 2,
          drift: (0.012 + Math.random() * 0.03) * depth,
          depth,
          hue: Math.random() < 0.12 ? 200 + Math.random() * 40 : Math.random() < 0.08 ? 28 + Math.random() * 18 : 0,
        };
      });

      nebulas = Array.from({ length: 4 }, (_, i) => ({
        x: w * (0.18 + i * 0.2 + Math.random() * 0.08),
        y: h * (0.25 + ((i * 37) % 50) / 100),
        r: Math.min(w, h) * (0.22 + Math.random() * 0.18),
        a: 0.035 + Math.random() * 0.04,
        hue: i % 2 === 0 ? 205 : 30,
        driftX: (Math.random() - 0.5) * 0.012,
        driftY: (Math.random() - 0.5) * 0.008,
        phase: Math.random() * Math.PI * 2,
      }));
      meteors = [];
      nextMeteor = 1200 + Math.random() * 1800;
    };

    const spawnMeteor = () => {
      const fromLeft = Math.random() > 0.35;
      meteors.push({
        x: fromLeft ? -20 : Math.random() * w * 0.7,
        y: Math.random() * h * 0.45,
        vx: 4.2 + Math.random() * 3.4,
        vy: 1.6 + Math.random() * 1.8,
        life: 0,
        max: 42 + Math.random() * 28,
        width: 1.1 + Math.random() * 1.2,
      });
    };

    const draw = (t: number, advance: boolean, dt: number) => {
      ctx.clearRect(0, 0, w, h);
      const light = isLight();
      const px = (pointerX - 0.5) * 28;
      const py = (pointerY - 0.5) * 18;

      for (const n of nebulas) {
        if (advance) {
          n.x += n.driftX * dt * 0.06;
          n.y += n.driftY * dt * 0.06;
          if (n.x < -n.r) n.x = w + n.r;
          if (n.x > w + n.r) n.x = -n.r;
          if (n.y < -n.r) n.y = h + n.r;
          if (n.y > h + n.r) n.y = -n.r;
        }
        const breath = 0.85 + 0.15 * Math.sin(t / 4200 + n.phase);
        const gx = n.x + px * 0.15;
        const gy = n.y + py * 0.12;
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, n.r);
        if (light) {
          g.addColorStop(0, `hsla(${n.hue}, 35%, 55%, ${(n.a * breath * 0.55).toFixed(3)})`);
          g.addColorStop(1, `hsla(${n.hue}, 30%, 60%, 0)`);
        } else {
          g.addColorStop(0, `hsla(${n.hue}, 70%, 62%, ${(n.a * breath).toFixed(3)})`);
          g.addColorStop(0.55, `hsla(${n.hue}, 55%, 45%, ${(n.a * breath * 0.35).toFixed(3)})`);
          g.addColorStop(1, `hsla(${n.hue}, 50%, 40%, 0)`);
        }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(gx, gy, n.r, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const s of stars) {
        if (advance) {
          s.y -= s.drift * (dt / 16);
          if (s.y < -4) {
            s.y = h + 4;
            s.x = Math.random() * w;
          }
        }
        const tw = s.twinkle ? Math.sin(t / 1100 + s.phase) * s.twinkle : 0;
        const alpha = Math.max(0.04, Math.min(0.95, s.base + tw * 0.45));
        const ox = px * s.depth * 0.35;
        const oy = py * s.depth * 0.28;
        const x = s.x + ox;
        const y = s.y + oy;
        if (s.r > 1.1 && !light) {
          const glow = ctx.createRadialGradient(x, y, 0, x, y, s.r * 4.5);
          if (s.hue) {
            glow.addColorStop(0, `hsla(${s.hue}, 80%, 70%, ${(alpha * 0.45).toFixed(3)})`);
            glow.addColorStop(1, `hsla(${s.hue}, 70%, 55%, 0)`);
          } else {
            glow.addColorStop(0, `rgba(255,255,255,${(alpha * 0.35).toFixed(3)})`);
            glow.addColorStop(1, "rgba(255,255,255,0)");
          }
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, s.r * 4.5, 0, Math.PI * 2);
          ctx.fill();
        }
        if (s.hue && !light) {
          ctx.fillStyle = `hsla(${s.hue}, 75%, 78%, ${alpha.toFixed(3)})`;
        } else {
          ctx.fillStyle = light
            ? `rgba(40,40,36,${(alpha * 0.55).toFixed(3)})`
            : `rgba(236,236,236,${alpha.toFixed(3)})`;
        }
        ctx.fillRect(x, y, s.r, s.r);
      }

      if (advance) {
        nextMeteor -= dt;
        if (nextMeteor <= 0 && meteors.length < 2) {
          spawnMeteor();
          nextMeteor = 2200 + Math.random() * 4200;
        }
      }

      meteors = meteors.filter((m) => {
        if (advance) {
          m.x += m.vx * (dt / 16);
          m.y += m.vy * (dt / 16);
          m.life += dt / 16;
        }
        const progress = m.life / m.max;
        if (progress >= 1) return false;
        const alpha = (1 - progress) * (light ? 0.35 : 0.85);
        const tailX = m.x - m.vx * 3.2;
        const tailY = m.y - m.vy * 3.2;
        const grad = ctx.createLinearGradient(tailX, tailY, m.x, m.y);
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(0.55, `rgba(180,210,255,${(alpha * 0.35).toFixed(3)})`);
        grad.addColorStop(1, `rgba(255,255,255,${alpha.toFixed(3)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = m.width;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(m.x, m.y);
        ctx.stroke();
        return true;
      });
    };

    const frame = (t: number) => {
      const dt = lastFrame ? Math.min(48, t - lastFrame) : 16;
      if (interactive) {
        pointerX += (targetX - pointerX) * 0.06;
        pointerY += (targetY - pointerY) * 0.06;
      }
      if (t - lastFrame >= 16) {
        draw(t, true, dt);
        lastFrame = t;
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (document.hidden || reducedMotion()) {
        pointerX = 0.5;
        pointerY = 0.5;
        draw(0, false, 16);
        return;
      }
      lastFrame = 0;
      raf = requestAnimationFrame(frame);
    };

    const onPointer = (event: PointerEvent) => {
      if (!interactive || reducedMotion()) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      targetX = (event.clientX - rect.left) / rect.width;
      targetY = (event.clientY - rect.top) / rect.height;
    };

    const onLeave = () => {
      targetX = 0.5;
      targetY = 0.5;
    };

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
    document.addEventListener("visibilitychange", start);
    window.addEventListener("grox-motion-change", start);
    if (interactive) {
      window.addEventListener("pointermove", onPointer, { passive: true });
      canvas.addEventListener("pointerleave", onLeave);
    }
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", start);
      window.removeEventListener("grox-motion-change", start);
      window.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [density, interactive]);

  return <canvas ref={ref} className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}
