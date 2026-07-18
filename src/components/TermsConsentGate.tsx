'use client';

import { useState } from 'react';
import Link from 'next/link';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { CURRENT_TERMS_VERSION } from '@/lib/termsVersion';
import { getEditorialThemeColors } from './editorial/editorialTheme';

type Theme = 'light' | 'dark' | 'minimal';

interface TermsConsentGateProps {
  /** 'needed' = show the Accept/Decline card; 'error' = show the can't-reach-DB retry card. */
  status: 'needed' | 'error';
  /** Host layout so the gate matches its surroundings (mirrors ForeverLockedModal's variant prop). */
  variant: 'classic' | 'editorial';
  /** Host app theme. */
  theme: Theme;
  /** The authenticated user's uid — used as the accept-write target. */
  uid: string;
  /** Fired after the accept-write COMMITTED (safe to flip optimistically; the write succeeded). */
  onAccepted: () => void;
  /** Decline = non-destructive sign-out (handled by the host; touches no Firestore data). */
  onDecline: () => void;
  /** Retry a failed read (re-runs the onSnapshot subscription). Error card only. */
  onRetry?: () => void;
}

/**
 * Clickwrap Terms-of-Service consent gate.
 *
 * A full-screen themed card (NOT a fixed overlay sibling of #app-shell — it is an early return in
 * page.tsx, so the main app never renders behind it). Renders in BOTH design languages via the
 * `variant` prop: editorial (Raleway, editorial palette) and classic (mono/uppercase, isDark/
 * isMinimal inline), mirroring the email-verify screen + ForeverLockedModal.
 *
 * Accept performs an AWAITED `setDoc(..., { merge: true })` with a payload of EXACTLY
 * `{ tosAcceptedAt, tosAcceptedVersion }` — never `tier`, never a bare setDoc, never updateDoc.
 * On failure it stays mounted with an inline error banner and leaves Accept re-clickable.
 */
export function TermsConsentGate({ status, variant, theme, uid, onAccepted, onDecline, onRetry }: TermsConsentGateProps) {
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Accept = awaited merge-write of EXACTLY { tosAcceptedAt, tosAcceptedVersion }. No tier, no
  // spread, no fire-and-forget. On failure: stay mounted, show the error, keep Accept enabled.
  const handleAccept = async () => {
    setWriteError(null);
    setWriting(true);
    try {
      await setDoc(
        doc(db, 'users', uid),
        { tosAcceptedAt: serverTimestamp(), tosAcceptedVersion: CURRENT_TERMS_VERSION },
        { merge: true }
      );
      onAccepted(); // the write COMMITTED — safe to dismiss optimistically
    } catch (e) {
      console.error('TermsConsentGate: accept write failed', e);
      setWriteError('Could not save your acceptance. Check your connection and try again.');
      setWriting(false); // re-enable Accept so the user can retry
    }
  };

  // ---- Editorial branch -------------------------------------------------------
  if (variant === 'editorial') {
    const tc = getEditorialThemeColors(theme);
    return (
      <div className={`min-h-screen flex items-center justify-center ${tc.bg} transition-colors duration-500 p-4`}>
        <div className={`max-w-md w-full ${tc.bg} border ${tc.border} rounded-xl shadow-xl`}>
          <div className={`border-b ${tc.border} px-5 py-4`}>
            <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>
              {status === 'error' ? 'Terms verification' : 'Terms of Service'}
            </h2>
          </div>
          <div className="p-6">
            {status === 'error' ? (
              <>
                <p className={`text-sm ${tc.fontClass} ${tc.text} mb-6 leading-relaxed`}>
                  Can&apos;t reach DropSync to verify the Terms. Check your connection and try again.
                </p>
                {writeError && (
                  <p className={`text-xs ${tc.fontClass} ${tc.muted} mb-4 leading-relaxed`}>{writeError}</p>
                )}
                <button
                  onClick={() => onRetry?.()}
                  className={`w-full ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 transition-opacity ${tc.fontClass}`}
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <p className={`text-sm ${tc.fontClass} ${tc.text} mb-4 leading-relaxed`}>
                  To continue using DropSync, please review and accept our Terms of Service and Privacy Policy.
                </p>
                <div className="flex flex-col gap-2 mb-4">
                  <Link
                    href="/terms"
                    target="_blank"
                    rel="noopener"
                    className={`text-sm ${tc.text} underline hover:opacity-70 transition-opacity ${tc.fontClass}`}
                  >
                    Terms of Service ↗
                  </Link>
                  <Link
                    href="/privacy"
                    target="_blank"
                    rel="noopener"
                    className={`text-sm ${tc.text} underline hover:opacity-70 transition-opacity ${tc.fontClass}`}
                  >
                    Privacy Policy ↗
                  </Link>
                </div>
                {writeError && (
                  <p className={`text-xs ${tc.fontClass} ${tc.muted} mb-4 leading-relaxed`}>{writeError}</p>
                )}
                <div className="space-y-3">
                  <button
                    onClick={handleAccept}
                    disabled={writing}
                    className={`w-full ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${tc.fontClass}`}
                  >
                    {writing && (
                      <span className="w-4 h-4 border border-current/40 border-t-current animate-spin rounded-full inline-block" />
                    )}
                    {writing ? 'Saving…' : 'I Accept'}
                  </button>
                  <button
                    onClick={onDecline}
                    disabled={writing}
                    className={`w-full border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:opacity-70 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed ${tc.fontClass}`}
                  >
                    Decline
                  </button>
                </div>
                <p className={`mt-4 text-xs ${tc.muted} ${tc.fontClass} leading-relaxed text-center`}>
                  You&apos;ll be signed out. Your drops and workspaces are kept — sign back in anytime to accept and continue.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- Classic branch (inline isDark/isMinimal — mirrors ForeverLockedModal) ---
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const pageBg = isMinimal ? 'bg-[#C5C9B8]' : isDark ? 'bg-[#0D0D0D]' : 'bg-[#FFFEF5]';
  const cardBg = isMinimal ? 'bg-[#D4D8C8]' : isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]';
  const border = isMinimal ? 'border-[#1A1A1A]/20' : isDark ? 'border-white/10' : 'border-[#1A1A1A]';
  const text = isMinimal || !isDark ? 'text-[#1A1A1A]' : 'text-white';
  const muted = isMinimal ? 'text-[#4a4a4a]' : isDark ? 'text-white/50' : 'text-[#666]';
  const rounded = isMinimal ? 'rounded-full' : '';
  const linkFont = isMinimal ? 'font-sans text-xs' : 'font-mono uppercase tracking-wider text-[10px]';

  return (
    <div className={`min-h-screen flex items-center justify-center ${pageBg} transition-colors duration-500 p-4`}>
      <div className={`max-w-md w-full ${cardBg} border ${border} ${isMinimal ? 'rounded-lg' : ''} shadow-xl`}>
        <div className={`border-b ${border} px-6 py-4 bg-[#FF5A47]`}>
          <h2 className="text-sm font-bold uppercase tracking-wider text-white">
            {status === 'error' ? 'CANNOT_VERIFY_TERMS' : 'TERMS_OF_SERVICE'}
          </h2>
        </div>
        <div className="p-6">
          {status === 'error' ? (
            <>
              <p className={`text-sm ${text} mb-6 leading-relaxed`}>
                Can&apos;t reach DropSync to verify the Terms. Check your connection and try again.
              </p>
              {writeError && <p className={`text-xs ${muted} mb-4 leading-relaxed`}>{writeError}</p>}
              <button
                onClick={() => onRetry?.()}
                className={`w-full bg-[#1A1A1A] hover:bg-[#333] text-white py-3 text-xs tracking-wider transition-colors ${rounded}`}
              >
                RETRY
              </button>
            </>
          ) : (
            <>
              <p className={`text-sm ${text} mb-4 leading-relaxed`}>
                To keep using DropSync, review and accept our Terms of Service and Privacy Policy.
              </p>
              <div className="flex flex-col gap-1.5 mb-4">
                <Link href="/terms" target="_blank" rel="noopener" className={`${linkFont} ${text} underline hover:opacity-70 transition-opacity`}>
                  Terms of Service ↗
                </Link>
                <Link href="/privacy" target="_blank" rel="noopener" className={`${linkFont} ${text} underline hover:opacity-70 transition-opacity`}>
                  Privacy Policy ↗
                </Link>
              </div>
              {writeError && <p className={`text-xs ${muted} mb-4 leading-relaxed`}>{writeError}</p>}
              <div className="space-y-3">
                <button
                  onClick={handleAccept}
                  disabled={writing}
                  className={`w-full bg-[#1A1A1A] hover:bg-[#333] text-white py-3 text-xs tracking-wider transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${rounded}`}
                >
                  {writing && <span className="w-3.5 h-3.5 border border-white/40 border-t-white animate-spin rounded-full inline-block" />}
                  {writing ? 'SAVING…' : 'I_ACCEPT'}
                </button>
                <button
                  onClick={onDecline}
                  disabled={writing}
                  className={`w-full bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 ${text} py-3 text-xs tracking-wider transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${rounded}`}
                >
                  DECLINE
                </button>
              </div>
              <p className={`mt-4 text-xs ${muted} leading-relaxed text-center`}>
                You&apos;ll be signed out. Your drops and workspaces are kept — sign back in anytime to accept and continue.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
