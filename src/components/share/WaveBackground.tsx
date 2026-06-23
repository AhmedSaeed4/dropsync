'use client';

import { useEffect, useRef } from 'react';

/**
 * WaveBackground — Design B ("blue wave").
 *
 * Faithful React port of the standalone mockup's ribbon waves. Canvas 2D vertical-gradient
 * bands driven by the mockup's GEOM table. The stage is ALWAYS dark + blue, even in light
 * mode — this is intentional (Option A), so the palette is hardcoded here and does NOT adapt
 * to the theme. Do not "fix" it to follow light mode.
 *
 * dpr is capped at 2, and the loop is THROTTLED to ~30fps (draws every other frame) to stay
 * smooth. Reduced-motion users get a single static frame (no loop). The static SVG grain
 * overlay (feTurbulence, opacity 0.12, mix-blend overlay) ships with the wave.
 *
 * NEVER put backdrop-filter/blur over this canvas — it caused the lag we already fixed.
 */

// Ribbon geometry: normalized y position, amplitude, frequency, phase, drift speed, thickness.
const GEOM = [
  { y: 0.3, amp: 0.045, freq: 1.1, phase: 0.0, speed: 0.0002, thick: 0.11 },
  { y: 0.46, amp: 0.065, freq: 0.8, phase: 1.4, speed: -0.00016, thick: 0.15 },
  { y: 0.56, amp: 0.038, freq: 1.7, phase: 2.2, speed: 0.00026, thick: 0.09 },
  { y: 0.68, amp: 0.055, freq: 1.0, phase: 0.7, speed: -0.00018, thick: 0.13 },
  { y: 0.4, amp: 0.08, freq: 0.6, phase: 3.1, speed: 0.00013, thick: 0.17 },
  { y: 0.6, amp: 0.05, freq: 1.3, phase: 4.0, speed: 0.00022, thick: 0.12 },
];

// Locked dark + blue palette (design-specific constants — match the mockup exactly).
const DARK = {
  bg: '#06070E',
  cols: ['#1E3A8A', '#312E81', '#4F46E5', '#3B82F6', '#2563EB', '#6366F1'],
  alphas: [0.14, 0.13, 0.16, 0.13, 0.11, 0.15],
};

const STEPS = 30;

function hexRgb(h: string): [number, number, number] {
  const s = (h || '').replace('#', '');
  const n = parseInt(s, 16);
  if (isNaN(n)) return [26, 26, 26];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(rgb: [number, number, number], a: number) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

export default function WaveBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 0;
    let H = 0;
    let dpr = 1;
    let waveSkip = 0;
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    function drawWaves(t: number) {
      ctx!.fillStyle = DARK.bg;
      ctx!.fillRect(0, 0, W, H);
      for (let ri = 0; ri < GEOM.length; ri++) {
        const r = GEOM[ri];
        const phA = r.phase + t * r.speed;
        const phB = phA + 0.7;
        const half = (r.thick * H) / 2;
        const rgb = hexRgb(DARK.cols[ri]);
        const a = DARK.alphas[ri];
        const topPts: [number, number][] = [];
        const botPts: [number, number][] = [];
        for (let i = 0; i <= STEPS; i++) {
          const xf = i / STEPS;
          const x = xf * W;
          const yMid = (r.y + r.amp * Math.sin(xf * r.freq * Math.PI * 2 + phA)) * H;
          topPts.push([x, yMid - half + r.amp * 0.4 * Math.sin(xf * r.freq * Math.PI * 2 + phB) * H]);
          botPts.push([x, yMid + half + r.amp * 0.4 * Math.sin(xf * r.freq * Math.PI * 2 + phB) * H]);
        }
        let minY = H;
        let maxY = 0;
        for (let k = 0; k < topPts.length; k++) {
          if (topPts[k][1] < minY) minY = topPts[k][1];
          if (botPts[k][1] > maxY) maxY = botPts[k][1];
        }
        const g = ctx!.createLinearGradient(0, minY, 0, maxY);
        g.addColorStop(0, rgba(rgb, 0));
        g.addColorStop(0.5, rgba(rgb, a));
        g.addColorStop(1, rgba(rgb, 0));
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.moveTo(topPts[0][0], topPts[0][1]);
        for (let x = 1; x < topPts.length; x++) ctx!.lineTo(topPts[x][0], topPts[x][1]);
        for (let b = botPts.length - 1; b >= 0; b--) ctx!.lineTo(botPts[b][0], botPts[b][1]);
        ctx!.closePath();
        ctx!.fill();
      }
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas!.getBoundingClientRect();
      W = canvas!.width = Math.max(1, Math.floor(rect.width * dpr));
      H = canvas!.height = Math.max(1, Math.floor(rect.height * dpr));
      drawWaves(0);
    }

    // Throttle to ~30fps: draw every other frame (matches the mockup's waveLoop).
    function waveLoop() {
      waveSkip++;
      if (waveSkip % 2 === 0) drawWaves(performance.now());
      raf = requestAnimationFrame(waveLoop);
    }

    resize();
    if (prefersReduced) {
      // single static frame, no loop
    } else {
      raf = requestAnimationFrame(waveLoop);
    }

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

  return (
    <>
      <canvas
        ref={canvasRef}
        className="ds-fade absolute inset-0 block h-full w-full"
        style={{ animationDuration: '1400ms', animationDelay: '100ms' }}
        aria-hidden="true"
      />
      {/* static film grain — feTurbulence, opacity 0.12, overlay blend */}
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ opacity: 0.12, mixBlendMode: 'overlay' }}
        aria-hidden="true"
        preserveAspectRatio="none"
      >
        <filter id="ds-grain-filter">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#ds-grain-filter)" />
      </svg>
    </>
  );
}
