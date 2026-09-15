'use client';

import { useEffect, useRef, useState } from 'react';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialStatusPanelProps {
  dropsCount: number;
  encryptionInitializing: boolean;
  theme: 'light' | 'dark' | 'minimal';
  showChat?: boolean;
  animEnabled: boolean;
  animStyle: string;
  animHold: number;
  // Defect D5: the mobile Drops view renders only the animated word — the count moves into the
  // view's own "N drops · X expiring soon" subline. Default true keeps every desktop call site
  // rendering exactly as today (#3/#27).
  showCount?: boolean;
  // Order 12: the animated mascot tile left of the word — desktop header only.
  // Default false keeps the mobile Drops view (MobileDropsView.tsx) rendering exactly
  // as today; same default-off pattern as showCount above.
  showMascot?: boolean;
}

const WORDS = [
  'Precipitating', 'Condensing', 'Percolating', 'Effervescing', 'Scintillating',
  'Undulating', 'Obfuscating', 'Enciphering', 'Encapsulating', 'Susurrating',
  'Vibing', 'Wandering', 'Spinning', 'Floating', 'Effecting',
  'Accomplishing', 'Working', 'Hustling', 'Creating', 'Philosophising',
];

const COMBO_STYLES = ['flip', 'smooth', 'ripple', 'cascade', 'glitch'];

// ── Order 12 + 12j: the mascot tile ───────────────────────────────────────────────
// Owner-made animation: the INTRO (206 frames, plays once per reload) and the
// LOOP (193 frames, forever) BOTH live on the canvas as WebP strip frames
// (28 frames each, 224px frames) drawn off ONE wall clock: ticks 0-205 draw the
// intro, tick 206 onward draws the loop — so a click during the intro recolors
// it instantly, same frame (the old GIF intro could not be recolored; 12j).
// Every tick copies one frame into the small canvas — 40 fresh paints per
// second, so the browser cannot leave a stale frame stuck on screen (the
// lost-repaint freeze of the sliding-strip display, MF-2; the 12d
// background-position era flickered instead — MF-1). A color swap (the owner's
// yellow toggle) or a theme swap repaints the SAME index in the new color —
// frame-exact by construction. Theme mapping: light -> black, dark -> white,
// minimal -> black; yellow rides over every theme until clicked again; reload
// resets everything; desktop only (showMascot stays default-off, so
// MobileDropsView never renders it).

const MASCOT_VARIANT: Record<EditorialStatusPanelProps['theme'], 'black' | 'white' | 'yellow'> = {
  light: 'black',
  dark: 'white',
  minimal: 'black',
};

const MASCOT_INTRO_FRAMES = 206;
const MASCOT_LOOP_FRAMES = 193;
const MASCOT_FRAME_MS = 50;
const MASCOT_STRIP_FRAMES = 28;
const MASCOT_STRIPS = 7;
const MASCOT_INTRO_STRIPS = 8;
const MASCOT_COLORS = ['black', 'white', 'yellow'] as const;
// every strip is a row of 224x224 frames; one drawImage copies one frame
const MASCOT_FRAME_PX = 224;

// Once per PAGE RELOAD: module scope survives every re-mount of the panel and
// resets on a real reload. The flip clock is also module state, so a re-mount
// resumes the SAME wall clock instead of restarting the animation.
let mascotYellowMode = false;
let mascotFlipStart = 0;
let mascotFlipRunning = false;
let mascotClockStarted = false;
let mascotFlipTimer: number | undefined;

function mascotStripUrl(color: string, strip: number, kind: 'intro' | 'loop') {
  const n = strip < 10 ? '0' + strip : String(strip);
  return `/mascot/strips/mascot-${color}/mascot-${color}-${kind}-${n}.webp`;
}

// Canvas-painter sources: each color's intro AND loop strips as Image objects,
// loaded once per page and reused for every draw. The intro's 206 frames = 7
// strips of 28 + a 10-frame tail; the loop's 193 = six 28-frame strips + a
// 25-frame tail. Source-rect drawing cannot stretch anything (the display-side
// stretch was MF-1) and i % 28 indexes each tail correctly because each
// boundary is a multiple of 28.
const mascotStripImgs = new Map<string, HTMLImageElement[]>();
function mascotGetStrips(color: string, kind: 'intro' | 'loop') {
  const key = `${color}-${kind}`;
  let imgs = mascotStripImgs.get(key);
  if (!imgs) {
    imgs = Array.from({ length: kind === 'intro' ? MASCOT_INTRO_STRIPS : MASCOT_STRIPS }, (_, s) => {
      const img = new Image();
      img.src = mascotStripUrl(color, s, kind);
      return img;
    });
    mascotStripImgs.set(key, imgs);
  }
  return imgs;
}

function MascotTile({ theme, small }: { theme: 'light' | 'dark' | 'minimal'; small: boolean }) {
  const tc = getEditorialThemeColors(theme);
  const [yellowMode, setYellowMode] = useState(mascotYellowMode);
  const flipRef = useRef<HTMLCanvasElement>(null);
  const themeRef = useRef(theme);
  const smallRef = useRef(small);
  // The painter and the toggle live INSIDE the effect below (so no in-component
  // function needs to appear in its dependency array) and are exposed through this
  // ref for the click handler and the size watcher.
  const apiRef = useRef<{ repaint: () => void; toggleYellow: () => void } | null>(null);

  useEffect(() => {
    themeRef.current = theme;

    const applyFlip = () => {
      const canvas = flipRef.current;
      if (!canvas) return;
      const total = Math.floor((performance.now() - mascotFlipStart) / MASCOT_FRAME_MS);
      const inIntro = total < MASCOT_INTRO_FRAMES;
      const i = inIntro ? total : (total - MASCOT_INTRO_FRAMES) % MASCOT_LOOP_FRAMES;
      const color = mascotYellowMode ? 'yellow' : MASCOT_VARIANT[themeRef.current];
      const img = mascotGetStrips(color, inIntro ? 'intro' : 'loop')[Math.floor(i / MASCOT_STRIP_FRAMES)];
      if (!img.complete || !img.naturalWidth) return; // strip still loading — next tick redraws
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // every tick copies one frame straight into the canvas — fresh pixels 40
      // times per second, so the browser cannot leave a stale frame stuck on
      // screen the way it did with the sliding-strip imgs (the MF-2 freeze)
      ctx.drawImage(img, (i % MASCOT_STRIP_FRAMES) * MASCOT_FRAME_PX, 0, MASCOT_FRAME_PX, MASCOT_FRAME_PX, 0, 0, canvas.width, canvas.height);
    };

    // Starts the shared wall clock once per page; every later color/theme swap
    // or re-mount is just a repaint of the same timeline position.
    const startFlipClock = () => {
      if (mascotClockStarted) {
        if (!mascotFlipRunning) {
          mascotFlipRunning = true;
          mascotFlipTimer = window.setInterval(applyFlip, 25);
        }
        return;
      }
      mascotClockStarted = true;
      mascotFlipRunning = true;
      mascotFlipStart = performance.now();
      applyFlip(); // paint the first frame BEFORE the layer is revealed — no blank
      mascotFlipTimer = window.setInterval(applyFlip, 25);
      if (flipRef.current) flipRef.current.style.display = 'block';
    };

    apiRef.current = {
      repaint: applyFlip,
      toggleYellow: () => {
        mascotYellowMode = !mascotYellowMode;
        setYellowMode(mascotYellowMode);
        applyFlip();
      },
    };

    // every color's intro AND loop strips start loading NOW — the intro plays
    // for ~10s, so the loop is decoded long before tick 206 needs it
    for (const c of MASCOT_COLORS) {
      mascotGetStrips(c, 'intro');
      mascotGetStrips(c, 'loop');
    }
    startFlipClock();
    return () => {
      if (mascotFlipTimer !== undefined) window.clearInterval(mascotFlipTimer);
      mascotFlipRunning = false;
    };
  }, [theme]);

  useEffect(() => {
    smallRef.current = small;
    if (mascotFlipRunning) apiRef.current?.repaint();
  }, [small]);

  const toggleYellow = () => apiRef.current?.toggleYellow();

  return (
    <span
      role="button"
      tabIndex={0}
      title="click me"
      aria-label="Mascot: click to toggle yellow"
      aria-pressed={yellowMode}
      onClick={toggleYellow}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleYellow();
        }
      }}
      className={`relative block shrink-0 border ${tc.border} ${tc.hoverBorder} overflow-hidden cursor-pointer transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${small ? 'h-4 w-4' : 'h-5 w-5'}`}
    >
      <canvas
        ref={flipRef}
        aria-hidden="true"
        width={MASCOT_FRAME_PX}
        height={MASCOT_FRAME_PX}
        className="absolute inset-0 h-full w-full"
        style={{ display: 'none' }}
      />
    </span>
  );
}

export function EditorialStatusPanel({ dropsCount, encryptionInitializing, theme, showChat = false, showCount = true, showMascot = false, animEnabled, animStyle, animHold }: EditorialStatusPanelProps) {
  const tc = getEditorialThemeColors(theme);
  const wordRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = wordRef.current;
    if (!el) return;

    const timers: number[] = [];
    const rafIds: number[] = [];
    let intervalId: number | undefined;
    let cycleIndex = 0;
    let comboStep = 0;

    const later = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(fn, ms));
    };

    const raf2 = (fn: () => void) => {
      rafIds.push(window.requestAnimationFrame(() => {
        rafIds.push(window.requestAnimationFrame(fn));
      }));
    };

    const FX_BASE = 'opacity .38s ease, transform .38s ease, filter .38s ease';
    const FX_FLIP = 'transform .26s ease-in, opacity .26s ease-in';

    const clearFx = () => {
      el.style.opacity = '';
      el.style.transform = '';
      el.style.filter = '';
    };

    const setPlain = (w: string) => {
      el.textContent = w;
    };

    const setLetters = (w: string) => {
      el.textContent = '';
      for (let i = 0; i < w.length; i++) {
        const s = document.createElement('span');
        s.style.display = 'inline-block';
        s.style.transition = 'opacity .3s ease, transform .3s ease';
        s.textContent = w[i] === ' ' ? '\u00A0' : w[i];
        el.appendChild(s);
      }
    };

    const resetToPlain = (w: string) => {
      el.style.animation = '';
      clearFx();
      el.style.whiteSpace = 'nowrap';
      el.style.transition = 'none';
      el.textContent = w;
      el.style.width = 'auto';
      el.style.width = el.offsetWidth + 'px';
    };

    const prepareGlide = (fromPx: number): number => {
      el.style.transition = 'none';
      el.style.width = 'auto';
      const target = el.offsetWidth;
      el.style.width = fromPx + 'px';
      void el.offsetWidth;
      return target;
    };

    const finishGlide = () => {
      later(() => {
        el.style.transition = '';
      }, 520);
    };
    const swapSmooth = (w: string) => {
      const w0 = el.offsetWidth;
      el.style.transition = FX_BASE;
      el.style.opacity = '0';
      el.style.transform = 'translateY(-5px)';
      el.style.filter = 'blur(2.5px)';
      later(() => {
        setPlain(w);
        const target = prepareGlide(w0);
        el.style.transition = `${FX_BASE}, width .5s ease`;
        el.style.opacity = '0';
        el.style.transform = 'translateY(5px)';
        el.style.filter = 'blur(2.5px)';
        raf2(clearFx);
        el.style.width = target + 'px';
        finishGlide();
      }, 390);
    };

    const swapSlide = (w: string) => {
      const w0 = el.offsetWidth;
      el.style.transition = FX_BASE;
      el.style.opacity = '0';
      el.style.transform = 'translateX(-12px)';
      later(() => {
        setPlain(w);
        const target = prepareGlide(w0);
        el.style.transition = `${FX_BASE}, width .5s ease`;
        el.style.opacity = '0';
        el.style.transform = 'translateX(12px)';
        raf2(clearFx);
        el.style.width = target + 'px';
        finishGlide();
      }, 330);
    };

    const swapMelt = (w: string) => {
      const w0 = el.offsetWidth;
      el.style.transition = FX_BASE;
      el.style.opacity = '0';
      el.style.filter = 'blur(5px)';
      later(() => {
        setPlain(w);
        const target = prepareGlide(w0);
        el.style.transition = `${FX_BASE}, width .5s ease`;
        el.style.opacity = '0';
        el.style.filter = 'blur(5px)';
        raf2(clearFx);
        el.style.width = target + 'px';
        finishGlide();
      }, 490);
    };

    const swapFlip = (w: string) => {
      const w0 = el.offsetWidth;
      el.style.transition = FX_FLIP;
      el.style.opacity = '.2';
      el.style.transform = 'perspective(260px) rotateX(90deg)';
      later(() => {
        setPlain(w);
        const target = prepareGlide(w0);
        el.style.transition = `${FX_FLIP}, width .5s ease`;
        el.style.opacity = '.2';
        el.style.transform = 'perspective(260px) rotateX(-90deg)';
        raf2(clearFx);
        el.style.width = target + 'px';
        finishGlide();
      }, 270);
    };
    const swapCascade = (w: string) => {
      const w0 = el.offsetWidth;
      el.style.transition = 'opacity .25s ease';
      el.style.opacity = '0';
      later(() => {
        el.style.transition = '';
        el.style.opacity = '';
        setLetters(w);
        const ls = Array.from(el.children) as HTMLElement[];
        ls.forEach(s => {
          s.style.opacity = '0';
          s.style.transform = 'translateY(4px)';
        });
        const target = prepareGlide(w0);
        el.style.transition = 'width .5s ease';
        el.style.width = target + 'px';
        finishGlide();
        ls.forEach((s, i) => {
          later(() => {
            s.style.opacity = '';
            s.style.transform = '';
          }, 550 + i * 45);
        });
      }, 260);
    };

    const swapRipple = (w: string) => {
      const w0 = el.offsetWidth;
      const prev = Array.from(el.children) as HTMLElement[];
      if (!prev.length) {
        el.style.transition = 'opacity .25s ease';
        el.style.opacity = '0';
      }
      prev.forEach((s, i) => {
        s.style.transitionDelay = `${i * 30}ms`;
        s.style.opacity = '0';
        s.style.transform = 'translateY(-4px)';
      });
      const outTime = 320 + prev.length * 30;
      later(() => {
        el.style.transition = '';
        el.style.opacity = '';
        setLetters(w);
        const ls = Array.from(el.children) as HTMLElement[];
        ls.forEach(s => {
          s.style.opacity = '0';
          s.style.transform = 'translateY(4px)';
        });
        const target = prepareGlide(w0);
        el.style.transition = 'width .5s ease';
        el.style.width = target + 'px';
        finishGlide();
        ls.forEach((s, j) => {
          later(() => {
            s.style.opacity = '';
            s.style.transform = '';
          }, 550 + j * 35);
        });
        later(() => {
          ls.forEach(s => {
            s.style.transitionDelay = '';
          });
        }, 550 + ls.length * 35 + 350);
      }, prev.length ? outTime : 260);
    };

    const swapGlitch = (w: string) => {
      const w0 = el.offsetWidth;
      setPlain(w);
      const target = prepareGlide(w0);
      el.style.transition = 'width .5s ease';
      el.style.width = target + 'px';
      finishGlide();
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = 'ds-jit .32s steps(2,end)';
      later(() => {
        el.style.animation = '';
      }, 340);
    };

    const performSwap = (styleName: string, w: string) => {
      if (styleName === 'smooth') swapSmooth(w);
      else if (styleName === 'slide') swapSlide(w);
      else if (styleName === 'melt') swapMelt(w);
      else if (styleName === 'flip') swapFlip(w);
      else if (styleName === 'ripple') swapRipple(w);
      else if (styleName === 'cascade') swapCascade(w);
      else if (styleName === 'glitch') swapGlitch(w);
    };
    if (encryptionInitializing) {
      resetToPlain('Setting up…');
    } else if (!animEnabled) {
      resetToPlain('Precipitating');
    } else {
      resetToPlain(WORDS[0]);
      intervalId = window.setInterval(() => {
        cycleIndex = (cycleIndex + 1) % WORDS.length;
        const styleName = animStyle === 'combo'
          ? COMBO_STYLES[comboStep++ % COMBO_STYLES.length]
          : animStyle;
        performSwap(styleName, WORDS[cycleIndex]);
      }, animHold);
    }

    return () => {
      if (intervalId !== undefined) window.clearInterval(intervalId);
      timers.forEach(t => {
        window.clearTimeout(t);
      });
      rafIds.forEach(r => {
        window.cancelAnimationFrame(r);
      });
      timers.length = 0;
      rafIds.length = 0;
    };
  }, [animEnabled, animStyle, animHold, encryptionInitializing]);

  return (
    <div className={`flex items-center gap-2 ${tc.fontClass} ${tc.muted} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'text-xs' : 'text-sm'}`}>
      <style>{`@keyframes ds-jit{0%,100%{transform:none;text-shadow:none}15%{transform:translateX(-2px);text-shadow:1.5px 0 rgba(255,59,48,.6),-1.5px 0 rgba(41,211,232,.6)}30%{transform:translateX(2px)}45%{transform:translateX(-1px);text-shadow:-1.5px 0 rgba(255,59,48,.55),1.5px 0 rgba(41,211,232,.55)}60%{transform:translateX(1.5px)}80%{transform:translateX(-.5px);text-shadow:1px 0 rgba(255,59,48,.4),-1px 0 rgba(41,211,232,.4)}}`}</style>
      {showMascot && <MascotTile theme={theme} small={showChat} />}
      <span ref={wordRef} className={tc.text}>
        {encryptionInitializing ? 'Setting up…' : 'Precipitating'}
      </span>
      {showCount && (
        <>
          <span className={tc.muted}>&middot;</span>
          <span>
            {dropsCount} drops
          </span>
        </>
      )}
    </div>
  );
}
