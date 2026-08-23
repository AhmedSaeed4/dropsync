'use client';

import { useEffect, useRef } from 'react';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialStatusPanelProps {
  dropsCount: number;
  encryptionInitializing: boolean;
  theme: 'light' | 'dark' | 'minimal';
  showChat?: boolean;
  animEnabled: boolean;
  animStyle: string;
  animHold: number;
}

const WORDS = [
  'Precipitating', 'Condensing', 'Percolating', 'Effervescing', 'Scintillating',
  'Undulating', 'Obfuscating', 'Enciphering', 'Encapsulating', 'Susurrating',
  'Vibing', 'Wandering', 'Spinning', 'Floating', 'Effecting',
  'Accomplishing', 'Working', 'Hustling', 'Creating', 'Philosophising',
];

const COMBO_STYLES = ['flip', 'smooth', 'ripple', 'cascade', 'glitch'];

export function EditorialStatusPanel({ dropsCount, encryptionInitializing, theme, showChat = false, animEnabled, animStyle, animHold }: EditorialStatusPanelProps) {
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
      <span ref={wordRef} className={tc.text}>
        {encryptionInitializing ? 'Setting up…' : 'Precipitating'}
      </span>
      <span className={tc.muted}>&middot;</span>
      <span>
        {dropsCount} drops
      </span>
    </div>
  );
}
