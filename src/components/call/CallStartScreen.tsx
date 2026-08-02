'use client';

// CallStartScreen — the CREATE-DROP modal's Call mode. A 16:9 live camera preview (the host sees
// themselves before pressing Start) + the scoped-E2EE line + ONE full-width "Start call" button.
// The Start button is type="button" and fires onStart (NOT the form submit) — in call mode the
// TextModal hides its form footer entirely and this screen owns Start. Start is desktop-gated
// (disabled when !hoverable with a "Calls are desktop-only" helper). On Start, handoffStream()
// detaches preview ownership so the mesh can adopt the SAME camera/mic with no blink (§9).

import { useEffect, useRef, useState } from 'react';
import { useCallPreview } from '@/hooks/useCallPreview';
import { getCallTheme, type CallTheme, type CallVariant } from './callTheme';

// Exact copy (§11) — NEVER "zero-knowledge". Scoped E2EE honesty (the mesh media IS e2e between
// peers; metadata is handled like all other DropSync data).
const E2EE_LINE = 'Call media is end-to-end encrypted; call metadata is handled like your other data.';

interface CallStartScreenProps {
  theme: CallTheme;
  variant: CallVariant;
  hoverable: boolean;
  /** Server decision for whether this user may start a call today. */
  canStart?: boolean;
  accessLoading?: boolean;
  /** Fired with the preview stream (ownership handed off) when the host presses Start. */
  onStart: (stream: MediaStream | null) => void;
}

export function CallStartScreen({
  theme,
  variant,
  hoverable,
  canStart = true,
  accessLoading = false,
  onStart,
}: CallStartScreenProps) {
  const { stream, error, acquiring, handoffStream } = useCallPreview(hoverable && canStart && !accessLoading);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tc = getCallTheme(variant, theme);
  // Flips the button to "Connecting…" the instant the host presses Start, and holds until the call
  // modal opens — the create-modal (and this screen) unmount once the start route resolves, so this
  // never needs resetting. Prevents a double-click during the create-call network round-trip.
  const [starting, setStarting] = useState(false);
  // A stream with no video track (audio-only fallback on a no-camera PC) renders the avatar path —
  // identical to a camera-off tile, at the SAME reserved 16:9 height (no shrink, no blank <video>).
  const hasVideo = !!(stream?.getVideoTracks().length);

  useEffect(() => {
    // Bind the live stream to the preview <video> directly (srcObject, not a URL — no revoke needed).
    if (videoRef.current) {
      videoRef.current.srcObject = hasVideo ? stream : null;
    }
  }, [stream, hasVideo]);

  return (
    <div className="flex flex-col gap-4">
      {/* 16:9 bordered live preview */}
      <div className={`relative aspect-video w-full overflow-hidden border ${tc.border} ${tc.inactivePillBg} ${tc.rounded} bg-black flex items-center justify-center`}>
        {stream && hasVideo ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover -scale-x-100" /* mirror self-view */
          />
        ) : (
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            {acquiring ? (
              <div className={`w-6 h-6 border border-current/30 border-t-current animate-spin rounded-full ${tc.text}`} />
            ) : (
              <svg className={`w-10 h-10 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
              </svg>
            )}
            <p className={`${tc.fontClass} ${tc.muted} text-xs`}>
              {error ? error : acquiring ? 'Requesting camera…' : stream ? 'Audio only — no camera detected' : 'Camera unavailable'}
            </p>
          </div>
        )}
      </div>

      {/* Scoped E2EE line with a lock icon */}
      <div className={`flex items-start gap-2 ${tc.muted}`}>
        <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6a2.25 2.25 0 002.25 2.25z" />
        </svg>
        <p className={`${tc.fontClass} leading-relaxed text-xs`}>{E2EE_LINE}</p>
      </div>

      {/* ONE full-width primary Start button — NOT a form submit. Desktop-gated. */}
      <button
        type="button"
        disabled={!hoverable || starting || accessLoading || !canStart}
        onClick={() => {
          if (accessLoading || !canStart) return;
          setStarting(true);
          onStart(handoffStream());
        }}
        className={`w-full ${hoverable ? tc.activePillBg : tc.inactivePillBg} ${hoverable ? tc.activePillText : tc.muted} py-3 text-sm ${tc.rounded} ${tc.fontClass} transition-opacity flex items-center justify-center gap-2 enabled:hover:opacity-90 enabled:active:scale-[0.98] disabled:cursor-not-allowed`}
      >
        {starting || accessLoading ? (
          <span className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        )}
        {starting ? 'Connecting…' : accessLoading ? 'Checking access…' : canStart ? 'Start call' : 'Call limit reached'}
      </button>
      {!hoverable && (
        <p className={`${tc.fontClass} ${tc.muted} text-xs text-center`}>Calls are desktop-only.</p>
      )}
      {hoverable && !accessLoading && !canStart && (
        <p className={`${tc.fontClass} ${tc.muted} text-xs text-center`}>
          Your 30-minute call limit has been reached. You can still join a call with a trusted user.
        </p>
      )}
    </div>
  );
}
