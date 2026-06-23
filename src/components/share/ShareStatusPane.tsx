'use client';

import { WAVE_DARK_GRADIENT, type ShareTheme, type ShareDesign } from './shareTheme';
import './share.css';

/**
 * ShareStatusPane — a themed content pane for the non-success states (loading / expired /
 * error). It MIRRORS ShareContentPane's root <section> shell exactly (same classes, same
 * wave-dark gradient, same masthead + seal, reads the same --ds-* vars) so the design stays
 * visible in every state instead of early-returning a plain un-themed screen.
 *
 * No action buttons and no expiry ring — there's no valid drop to act on. Copy is fixed per
 * status (see STATUS_COPY); do not invent new strings.
 */

export type ShareStatus = 'loading' | 'expired' | 'error';

const STATUS_COPY: Record<ShareStatus, { label: string; title: string; message: string }> = {
  loading: {
    label: 'Loading',
    title: 'Preparing your drop',
    message: 'Loading your shared file.',
  },
  expired: {
    label: 'Expired',
    title: 'No longer available',
    message: 'This file has expired or been removed by the owner.',
  },
  error: {
    label: 'Error',
    title: 'Something went wrong',
    message: "We couldn't load this shared file. Please try again later.",
  },
};

interface Props {
  status: ShareStatus;
  theme: ShareTheme;
  design: ShareDesign | null;
  /** When true, the pane fades its opacity out (loading→content handoff). */
  fading?: boolean;
}

export default function ShareStatusPane({ status, theme, design, fading }: Props) {
  const isWaveDark = design === 'wave' && theme === 'dark';
  const copy = STATUS_COPY[status];

  return (
    <section
      className={`flex flex-1 flex-col bg-[var(--ds-paper)] px-5 pb-10 pt-[30px] sm:min-h-screen sm:justify-center sm:px-[38px] sm:py-10 lg:px-[56px] lg:py-12 transition-opacity duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${fading ? 'opacity-0' : 'opacity-100'}`}
      style={isWaveDark ? { background: WAVE_DARK_GRADIENT } : undefined}
    >
      <div className="mx-auto w-full max-w-[440px] lg:max-w-[520px]">
        {/* Masthead (sm+) — mirrors the success pane. */}
        <div className="ds-fade mb-[30px] hidden items-center justify-between border-b border-[var(--ds-hair)] pb-[22px] sm:flex">
          <div className="flex items-center gap-[9px] text-[15px] font-medium tracking-[-0.02em] text-[var(--ds-ink)]">
            <span className="inline-block h-[9px] w-[9px] rotate-45 rounded-[1px] bg-current" />
            DropSync
          </div>
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--ds-faint)]">Shared file</span>
        </div>

        {/* Eyebrow: status label + dot. */}
        <div
          className="ds-fade-up mb-4 flex items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-[var(--ds-muted)]"
          style={{ animationDelay: '280ms' }}
        >
          <span>{copy.label}</span>
          <span className="h-[4px] w-[4px] rounded-full bg-current" />
        </div>

        {/* Themed icon above the title: spinner for loading, prohibition glyph for expired/error.
            The spinner is wrapped so the entrance fade-up and the continuous spin don't both set
            `animation` on the same element. */}
        {status === 'loading' ? (
          <div className="ds-fade-up mb-5" style={{ animationDelay: '320ms' }}>
            <div
              className="h-5 w-5 animate-spin rounded-full border border-[var(--ds-hair)] border-t-[var(--ds-ink)]"
              aria-hidden="true"
            />
          </div>
        ) : (
          <svg
            className="ds-fade-up mb-5 h-8 w-8 text-[var(--ds-muted)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            style={{ animationDelay: '320ms' }}
            aria-hidden="true"
          >
            <path d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        )}

        {/* Title (verbatim copy). */}
        <h1
          className="ds-fade-up text-[length:clamp(1.4rem,3vw,1.75rem)] font-normal leading-[1.15] tracking-[-0.025em] text-[var(--ds-ink)] lg:text-[length:clamp(1.5rem,3.2vw,2rem)]"
          style={{ animationDelay: '360ms' }}
        >
          {copy.title}
        </h1>
        <div className="ds-grow-rule mt-[18px] h-px w-12 bg-[var(--ds-hair)]" style={{ animationDelay: '500ms' }} />

        {/* Message (verbatim copy). */}
        <p
          className="ds-fade-up mt-5 max-w-sm text-[13px] leading-[1.6] text-[var(--ds-muted)]"
          style={{ animationDelay: '560ms' }}
        >
          {copy.message}
        </p>

        {/* Seal — mirrors the success pane. */}
        <div className="ds-fade mt-[26px] border-t border-[var(--ds-hair)] pt-[26px]" style={{ animationDelay: '950ms' }}>
          <a
            href="/"
            className="group inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--ds-muted)] transition-colors duration-[400ms] hover:text-[var(--ds-ink)]"
          >
            Shared via DropSync
            <span className="transition-[color,transform] duration-[400ms] group-hover:translate-x-[3px]">→</span>
          </a>
        </div>
      </div>
    </section>
  );
}
