'use client';

import { useEffect, useRef } from 'react';

/**
 * FlowField — Design A (monochrome "flow-field").
 *
 * Faithful React port of the standalone mockup's generative flow-field. A Canvas 2D
 * particle system driven by a sine-based vector field, leaving fading paper-colored
 * trails. Particle count scales to stage area; dpr is capped at 2.
 *
 * `ink` / `paper` are hex strings supplied by ShareStage from the resolved theme, so the
 * field re-tints when the theme changes (and reads correctly in both light and dark).
 * Reduced-motion users get a single static render (no RAF loop).
 *
 * NEVER put backdrop-filter/blur over this canvas — it caused the lag we already fixed.
 */

function hexToRgb(h: string): [number, number, number] {
  let s = (h || '').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  if (isNaN(n)) return [26, 26, 26];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface Part {
  x: number;
  y: number;
  life: number;
  age: number;
  w: number;
  a: number;
}

export default function FlowField({ ink, paper }: { ink: string; paper: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Latest colors, read each frame. Initialized from first props; updated by the re-tint effect.
  const colorsRef = useRef<{ ink: [number, number, number]; paper: [number, number, number] }>({
    ink: hexToRgb(ink),
    paper: hexToRgb(paper),
  });

  // Re-tint when the theme changes: refresh the colors ref and re-fill the base so the
  // fading trails converge to the new paper instead of flashing mixed colors.
  useEffect(() => {
    colorsRef.current = { ink: hexToRgb(ink), paper: hexToRgb(paper) };
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      const [r, g, b] = colorsRef.current.paper;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [ink, paper]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let SW = 0;
    let SH = 0;
    let dpr = 1;
    let t = 0;
    let parts: Part[] = [];
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    function fillPaper() {
      const [r, g, b] = colorsRef.current.paper;
      ctx!.fillStyle = `rgb(${r},${g},${b})`;
      ctx!.fillRect(0, 0, SW, SH);
    }

    function spawn(): Part {
      return {
        x: Math.random() * SW,
        y: Math.random() * (SH || 1),
        life: Math.random() * 140 + 50,
        age: 0,
        w: (Math.random() * 1.1 + 0.4) * dpr,
        a: Math.random() * 0.35 + 0.12,
      };
    }

    function seed() {
      const area = (SW / dpr) * (SH / dpr);
      const n = Math.round(Math.min(260, Math.max(90, area / 5200)));
      parts = [];
      for (let i = 0; i < n; i++) parts.push(spawn());
    }

    function field(x: number, y: number) {
      const nx = x / SW;
      const ny = y / SH;
      const a =
        Math.sin(nx * 6.0 + t * 0.7) +
        Math.cos(ny * 5.0 - t * 0.5) +
        Math.sin((nx + ny) * 4.0 + t * 0.35) * 0.8;
      return a * 1.15;
    }

    function step() {
      // fade existing trails toward the paper color
      const [pr, pg, pb] = colorsRef.current.paper;
      ctx!.fillStyle = `rgba(${pr},${pg},${pb},0.055)`;
      ctx!.fillRect(0, 0, SW, SH);
      t += 0.0042;
      const [ir, ig, ib] = colorsRef.current.ink;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const ang = field(p.x, p.y);
        const sp = 0.65 * dpr;
        const nx = p.x + Math.cos(ang) * sp;
        const ny = p.y + Math.sin(ang) * sp;
        ctx!.strokeStyle = `rgba(${ir},${ig},${ib},${p.a.toFixed(3)})`;
        ctx!.lineWidth = p.w;
        ctx!.lineCap = 'round';
        ctx!.beginPath();
        ctx!.moveTo(p.x, p.y);
        ctx!.lineTo(nx, ny);
        ctx!.stroke();
        p.x = nx;
        p.y = ny;
        p.age++;
        if (p.age > p.life || nx < -4 || nx > SW + 4 || ny < -4 || ny > SH + 4) parts[i] = spawn();
      }
      raf = requestAnimationFrame(step);
    }

    function drawStatic() {
      const [ir, ig, ib] = colorsRef.current.ink;
      for (let k = 0; k < 60; k++) {
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          const ang = field(p.x, p.y);
          const nx = p.x + Math.cos(ang) * 0.65 * dpr;
          const ny = p.y + Math.sin(ang) * 0.65 * dpr;
          ctx!.strokeStyle = `rgba(${ir},${ig},${ib},${(p.a * 0.7).toFixed(3)})`;
          ctx!.lineWidth = p.w;
          ctx!.lineCap = 'round';
          ctx!.beginPath();
          ctx!.moveTo(p.x, p.y);
          ctx!.lineTo(nx, ny);
          ctx!.stroke();
          p.x = nx;
          p.y = ny;
        }
      }
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas!.getBoundingClientRect();
      SW = canvas!.width = Math.max(1, Math.floor(r.width * dpr));
      SH = canvas!.height = Math.max(1, Math.floor(r.height * dpr));
      fillPaper();
      seed();
    }

    resize();
    if (prefersReduced) drawStatic();
    else raf = requestAnimationFrame(step);

    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      clearTimeout(resizeTimer);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full block" aria-hidden="true" />;
}
