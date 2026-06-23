'use client';

import { useEffect, useState } from 'react';
import { contentToPlainText } from '@/lib/dropTagUtils';
import { WAVE_DARK_GRADIENT, type ShareTheme, type ShareDesign } from './shareTheme';
import './share.css';
import type { ShareData } from '@/app/s/[shareId]/ShareClient';

/**
 * ShareContentPane — the RIGHT panel. Purely presentational; all data comes from the real
 * `share` (fetched + decrypted upstream in page.tsx). Renders exactly the content type(s) the
 * drop actually has (no "Preview as" switcher). Expiry ring + countdown derive from the REAL
 * expiresAt (+ createdAt for the fraction). Copy uses contentToPlainText so mention tokens
 * read as plain names. Theme-adaptive via the --ds-* CSS vars set on the page wrapper.
 *
 * This is a READ-ONLY recipient view: no delete/update calls, no mutation of drop data.
 */

const RING_R = 14;
const RING_CIRC = 2 * Math.PI * RING_R;

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function typeLabel(share: ShareData, isVideo: boolean): string {
  if (share.youtubeVideoId) return 'YouTube';
  if (share.type === 'text' && share.content) return 'Text note';
  if (isVideo) return 'Video';
  if (share.imageUrl) return 'Image';
  return share.mimeType || 'File';
}

interface Props {
  share: ShareData;
  copied: boolean;
  videoSrc: string | null;
  onCopy: () => void;
  onDownload: () => void;
  theme: ShareTheme;
  design: ShareDesign | null;
}

export default function ShareContentPane({ share, copied, videoSrc, onCopy, onDownload, theme, design }: Props) {
  const isVideo = !!share.mimeType?.startsWith('video/');
  const label = typeLabel(share, isVideo);
  // Wave + dark gets the blue-tinted dark content side + navy→black fade (matches the wave).
  // Flow-field dark stays neutral; all light modes stay cream. Colors themselves need no
  // manual change — they read --ds-* vars, which already swap via shareCssVars(theme, design).
  const isWaveDark = design === 'wave' && theme === 'dark';

  // Real countdown from expiresAt. Forever drops (expiresAt null) show "No expiry".
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    if (!share.expiresAt) return; // forever — no interval
    const end = new Date(share.expiresAt).getTime();
    const tick = () => setRemainingMs(Math.max(0, end - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [share.expiresAt]);

  const totalMs =
    share.expiresAt && share.createdAt
      ? new Date(share.expiresAt).getTime() - new Date(share.createdAt).getTime()
      : null;
  const forever = !share.expiresAt;
  const frac =
    forever || !totalMs || totalMs <= 0 || remainingMs === null
      ? 1
      : Math.max(0, Math.min(1, remainingMs / totalMs));
  const countdownText = forever ? 'No expiry' : remainingMs !== null ? formatCountdown(remainingMs) : '—';

  const hasCopy = share.type === 'text' && !!share.content;
  const hasDownload = !!(share.imageUrl || share.fileUrl);
  const darkShadow = theme === 'dark' ? 'shadow-[0_14px_38px_rgba(0,0,0,0.5)]' : '';

  return (
    <section
      className="flex flex-1 flex-col bg-[var(--ds-paper)] px-5 pb-10 pt-[30px] sm:min-h-screen sm:justify-center sm:px-[38px] sm:py-10 lg:px-[56px] lg:py-12"
      style={isWaveDark ? { background: WAVE_DARK_GRADIENT } : undefined}
    >
      <div className="mx-auto w-full max-w-[440px] lg:max-w-[520px]">
        {/* Masthead — hidden on mobile (matches mockup). */}
        <div className="ds-fade mb-[30px] hidden items-center justify-between border-b border-[var(--ds-hair)] pb-[22px] sm:flex">
          <div className="flex items-center gap-[9px] text-[15px] font-medium tracking-[-0.02em] text-[var(--ds-ink)]">
            <span className="inline-block h-[9px] w-[9px] rotate-45 rounded-[1px] bg-current" />
            DropSync
          </div>
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--ds-faint)]">Shared file</span>
        </div>

        {/* Eyebrow (real type label — no fake "File 042"). */}
        <div
          className="ds-fade-up mb-4 flex items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-[var(--ds-muted)]"
          style={{ animationDelay: '280ms' }}
        >
          <span>{label}</span>
          <span className="h-[4px] w-[4px] rounded-full bg-current" />
        </div>

        {/* Title — real drop name. */}
        <h1
          className="ds-fade-up text-[length:clamp(1.4rem,3vw,1.75rem)] font-normal leading-[1.15] tracking-[-0.025em] text-[var(--ds-ink)] lg:text-[length:clamp(1.5rem,3.2vw,2rem)]"
          style={{ animationDelay: '360ms' }}
        >
          {share.name}
        </h1>
        <div className="ds-grow-rule mt-[18px] h-px w-12 bg-[var(--ds-hair)]" style={{ animationDelay: '500ms' }} />

        {/* Content — render exactly the real type(s); no manual switcher. */}
        <div className="mt-[26px]">
          {/* Text content (may coexist with an attached image). */}
          {share.type === 'text' && share.content && (
            <div
              className={`ds-fade-up relative mb-5 overflow-hidden rounded-[14px] border border-[var(--ds-hair)] bg-[var(--ds-card)] p-5 sm:px-[30px] sm:py-7 ${darkShadow}`}
              style={{ animationDelay: '560ms' }}
            >
              <div className="ds-scan-beam" />
              <pre className="whitespace-pre-wrap break-words font-[family-name:var(--font-raleway)] text-[14px] leading-[1.75] text-[var(--ds-ink)]">
                {contentToPlainText(share.content)}
              </pre>
            </div>
          )}

          {/* Attached image. */}
          {share.imageUrl && (
            <div
              className="ds-fade-up relative mb-5 flex items-center justify-center overflow-hidden rounded-[14px] border border-[var(--ds-hair)]"
              style={{ animationDelay: '560ms' }}
            >
              <div className="ds-scan-beam" />
              <img
                src={share.imageUrl}
                alt={share.name}
                className="max-h-[50vh] w-full object-contain"
              />
            </div>
          )}

          {/* YouTube. */}
          {share.youtubeVideoId && (
            <div
              className="ds-fade-up relative mb-5 overflow-hidden rounded-[14px] border border-[var(--ds-hair)]"
              style={{ animationDelay: '560ms' }}
            >
              <div className="ds-scan-beam" />
              <a
                href={`https://www.youtube.com/watch?v=${share.youtubeVideoId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="group block"
              >
                <div className="relative">
                  <img
                    src={`https://img.youtube.com/vi/${share.youtubeVideoId}/mqdefault.jpg`}
                    alt="YouTube thumbnail"
                    className="w-full"
                  />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-[60px] w-[60px] items-center justify-center rounded-full bg-white/90 transition-transform group-hover:scale-105">
                      <svg viewBox="0 0 24 24" className="ml-[3px] h-5 w-5 fill-[#111]">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  </span>
                </div>
              </a>
            </div>
          )}

          {/* Video file player. */}
          {isVideo && share.fileUrl && (
            <div
              className="ds-fade-up relative mb-5 flex aspect-video items-center justify-center overflow-hidden rounded-[14px] border border-[var(--ds-hair)] bg-[#111]"
              style={{ animationDelay: '560ms' }}
            >
              <div className="ds-scan-beam" />
              {videoSrc ? (
                <video src={videoSrc} controls className="max-h-[60vh] w-full">
                  Your browser does not support video playback.
                </video>
              ) : (
                <div className="flex h-8 w-8 animate-pulse text-[var(--ds-faint)]">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                    />
                  </svg>
                </div>
              )}
            </div>
          )}

          {/* Generic file drop. */}
          {share.fileUrl && !isVideo && !share.imageUrl && (
            <div
              className={`ds-fade-up relative mb-5 flex flex-col items-center gap-[14px] overflow-hidden rounded-[14px] border border-[var(--ds-hair)] bg-[var(--ds-card)] px-5 py-8 sm:px-7 ${darkShadow}`}
              style={{ animationDelay: '560ms' }}
            >
              <div className="ds-scan-beam" />
              <div className="flex h-[54px] w-[54px] items-center justify-center rounded-[14px] bg-[#1a1a1a]">
                <svg className="h-[26px] w-[26px]" fill="none" stroke="#FFFEF5" viewBox="0 0 24 24" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-[14px] font-medium text-[var(--ds-ink)]">{share.name}</div>
                <div className="mt-1 text-[11px] tracking-[0.06em] text-[var(--ds-faint)]">
                  {share.mimeType || 'File'}
                  {share.fileSize ? ` · ${(share.fileSize / (1024 * 1024)).toFixed(1)} MB` : ''}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Meta row: real expiry ring + countdown, E2E badge. (No creator — see notes.) */}
        <div
          className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5"
          style={{ animationDelay: '700ms' }}
        >
          <div className="flex items-center gap-[11px]">
            <svg width="34" height="34" viewBox="0 0 34 34" className="-rotate-90">
              <circle cx="17" cy="17" r={RING_R} fill="none" stroke="var(--ds-hair)" strokeWidth="2.5" />
              <circle
                cx="17"
                cy="17"
                r={RING_R}
                fill="none"
                stroke="var(--ds-ink)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={RING_CIRC}
                strokeDashoffset={RING_CIRC * (1 - frac)}
                className="transition-[stroke-dashoffset] duration-1000 ease-linear"
              />
            </svg>
            <div className="leading-[1.3]">
              <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--ds-faint)]">Expires in</div>
              <div className="text-[13px] font-medium tabular-nums text-[var(--ds-ink)]">{countdownText}</div>
            </div>
          </div>

          <span className="inline-flex items-center gap-2 text-[11px] text-[var(--ds-muted)]" title="Encrypted in transit and at rest">
            <svg className="h-[13px] w-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 018 0v3" />
            </svg>
            End-to-end encrypted
          </span>
        </div>

        {/* Actions — Copy (clean text), Download, Watch on YouTube. */}
        <div
          className="mt-7 flex flex-col gap-3 sm:flex-row"
          style={{ animationDelay: '800ms' }}
        >
          {hasCopy && (
            <button
              onClick={onCopy}
              className={`inline-flex w-full items-center justify-center gap-[9px] rounded-[10px] border border-[var(--ds-ink)] bg-[var(--ds-ink)] px-[22px] py-3 text-[12px] font-medium tracking-[0.04em] text-[var(--ds-paper)] transition-[color,background-color,border-color,transform,box-shadow] duration-[400ms] hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(0,0,0,0.16)] sm:w-auto ${copied ? 'ds-copied' : ''}`}
            >
              {copied ? (
                <>
                  <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path className="ds-tick" pathLength={1} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 012-2h10" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          )}

          {hasDownload && (
            <button
              onClick={onDownload}
              className="inline-flex w-full items-center justify-center gap-[9px] rounded-[10px] border border-[var(--ds-ink)] px-[22px] py-3 text-[12px] font-medium tracking-[0.04em] text-[var(--ds-ink)] transition-colors duration-[400ms] hover:bg-[var(--ds-ink)] hover:text-[var(--ds-paper)] sm:w-auto"
            >
              <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
              </svg>
              Download
            </button>
          )}

          {share.youtubeVideoId && (
            <a
              href={`https://www.youtube.com/watch?v=${share.youtubeVideoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center gap-[9px] rounded-[10px] border border-[#FF0000] px-[22px] py-3 text-[12px] font-medium tracking-[0.04em] text-[#FF0000] transition-colors hover:bg-[#FF0000] hover:text-white sm:w-auto"
            >
              <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
              Watch on YouTube
            </a>
          )}
        </div>

        {/* Seal. */}
        <div className="mt-[26px] border-t border-[var(--ds-hair)] pt-[26px]">
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
