'use client';

import FlowField from './FlowField';
import WaveBackground from './WaveBackground';
import { getSharePalette, type ShareTheme, type ShareDesign } from './shareTheme';
import './share.css';

/**
 * ShareStage — the LEFT panel of the share page. Receives the resolved `design` from the
 * parent (page.tsx owns the alternation + its Strict-Mode once-per-load guard).
 *
 * null → neutral placeholder (no canvas, no RAF). 'wave' → <WaveBackground/>; 'flowfield' →
 * <FlowField/>. Exactly ONE canvas/RAF loop runs at a time. Mounting the chosen canvas only
 * after the pick resolves (SSR + first paint show the placeholder) is what avoids the
 * hydration error and the flash of the wrong design.
 *
 * Overlay colors: flow-field (Design A) follows the resolved theme (light/dark) via CSS vars;
 * wave (Design B) is ALWAYS a dark stage, so its overlay colors are locked light regardless
 * of theme.
 */

export default function ShareStage({ design, theme }: { design: ShareDesign | null; theme: ShareTheme }) {
  const palette = getSharePalette(theme, design);
  const isWave = design === 'wave';
  const isFlow = design === 'flowfield';

  // Overlay text colors: wave stage is always dark (locked light text); flow-field follows theme.
  const brandColor = isWave ? 'text-white' : 'text-[var(--ds-ink)]';
  const mutedColor = isWave ? 'text-[#9aa7c7]' : 'text-[var(--ds-muted)]';
  const faintColor = isWave ? 'text-[#68739a]' : 'text-[var(--ds-faint)]';

  const stageBg = isWave
    ? 'bg-[linear-gradient(180deg,#05060C_0%,#090B16_100%)]'
    : 'bg-[linear-gradient(160deg,var(--ds-paper)_0%,var(--ds-paper-2)_100%)]';

  return (
    <section
      aria-hidden="true"
      className={[
        'relative w-full shrink-0 overflow-hidden',
        // Mobile (base): full-width 260px banner with bottom border.
        'h-[260px] border-b',
        // ≥640 (tablet + desktop): side panel, full height, right border.
        'sm:h-auto sm:min-h-screen sm:border-b-0 sm:border-r sm:basis-[41%] lg:basis-[46%]',
        isWave ? 'border-[rgba(255,255,255,0.12)]' : 'border-[var(--ds-hair)]',
        stageBg,
      ].join(' ')}
    >
      {/* Mount exactly ONE canvas after the pick resolves. Before that, the neutral gradient
          above is the placeholder (no canvas, no RAF loop). */}
      {isFlow && <FlowField ink={palette.ink} paper={palette.paper} />}
      {isWave && <WaveBackground />}

      {/* Stage overlay: live chip top, brand/tag/edition bottom. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between px-5 py-[18px] sm:px-[30px] sm:py-[28px] lg:px-[38px] lg:py-[34px]">
        <div
          className={`ds-fade inline-flex items-center gap-[9px] self-start text-[9px] uppercase tracking-[0.28em] ${mutedColor}`}
          style={{ animationDelay: '500ms' }}
        >
          <span className="ds-live-dot" />
          Private link
        </div>

        <div className="flex flex-col gap-[10px]">
          <div
            className={`ds-fade-up flex items-center gap-[11px] text-[20px] font-medium tracking-[-0.02em] ${brandColor}`}
            style={{ animationDelay: '600ms' }}
          >
            <span className="inline-block h-[12px] w-[12px] rotate-45 rounded-[1px] bg-current" />
            DropSync
          </div>
          <div
            className={`ds-fade-up hidden max-w-[30ch] text-[13px] leading-[1.6] sm:block ${mutedColor}`}
            style={{ animationDelay: '720ms' }}
          >
            Drop on one device.
            <br />
            Pick up on another — secure, encrypted, temporary.
          </div>
          <div
            className={`ds-fade mt-[4px] text-[9px] uppercase tracking-[0.26em] ${faintColor}`}
            style={{ animationDelay: '900ms' }}
          >
            Edition 2.0 · AES-256
          </div>
        </div>
      </div>
    </section>
  );
}
