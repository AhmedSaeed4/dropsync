'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { contentToPlainText } from '@/lib/dropTagUtils';
import ShareStage from '@/components/share/ShareStage';
import ShareContentPane from '@/components/share/ShareContentPane';
import ShareStatusPane, { type ShareStatus } from '@/components/share/ShareStatusPane';
import { shareCssVars, SHARE_THEME_KEY, type ShareTheme, type ShareDesign } from '@/components/share/shareTheme';

export interface ShareData {
  type: 'text' | 'file';
  name: string;
  content: string | null;
  mimeType: string | null;
  fileSize: number | null;
  imageUrl: string | null;
  fileUrl: string | null;
  youtubeVideoId: string | null;
  fileFormat?: string | null;
  expiresAt: string | null;
  createdAt?: string | null;
}

// Strict Mode double-invokes effects in dev; guard so the design flip runs once per page
// load, not once per mount. Resets on full reload (module reloads). Lifted here from
// ShareStage so the content pane can be design-aware too.
let alternationResolvedThisLoad = false;

const SHARE_DESIGN_LS_KEY = 'ds-share-last-design';

export default function ShareClient({ initialTheme }: { initialTheme: ShareTheme }) {
  const params = useParams();
  const shareId = params.shareId as string;
  const [share, setShare] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // `loading` is intentionally not read — the content side derives its state from
  // `share`/`error` (share && !error ? success : status). setLoading stays so the fetch
  // effect (data-safety: untouched) keeps its existing shape.
  const [, setLoading] = useState(true);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  // Whether the share <video> has buffered enough to play (onCanPlay). False while buffering →
  // the content-pane spinner overlay covers the browser's native loading. Reset when the src
  // actually changes (binary streams fileUrl immediately; legacy sets a blob URL once loaded).
  const [videoReady, setVideoReady] = useState(false);
  // Theme is provided by the SERVER entry (page.tsx) from the `share-theme` cookie, so SSR
  // already paints the user's real theme — no light-first-paint flash for dark users. The
  // toggle below keeps both the cookie (next server render) and localStorage in sync.
  const [theme, setTheme] = useState<ShareTheme>(initialTheme);
  // null until the post-mount effect resolves the pick → ShareStage shows the neutral
  // placeholder (no canvas) during SSR + first paint. Lifted here (from ShareStage) so the
  // content pane can be design-aware too.
  const [design, setDesign] = useState<ShareDesign | null>(null);
  // Loading→content handoff state (see the handoff useEffect below).
  const [revealed, setRevealed] = useState(false);
  const hasContent = !!(share && !error);
  // Derived (not state): the loading pane fades the instant content arrives and stops fading
  // once revealed. Keeping it derived means the handoff effect below never calls setState for
  // it — only the reveal timeout does.
  const fadeLoading = hasContent && !revealed;

  // Design alternation — strict localStorage toggle, flipped exactly once per page load
  // (same key / flip rule / once-per-load guard / first-visit→wave as when it lived in
  // ShareStage). Resolves to 'wave' | 'flowfield' | null (null = not yet picked).
  useEffect(() => {
    if (alternationResolvedThisLoad) return;
    alternationResolvedThisLoad = true;
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(SHARE_DESIGN_LS_KEY);
    } catch {
      last = null;
    }
    const pick: ShareDesign = last === 'wave' ? 'flowfield' : 'wave'; // first visit (null) → wave
    try {
      window.localStorage.setItem(SHARE_DESIGN_LS_KEY, pick);
    } catch {
      /* ignore (private mode / disabled storage) */
    }
    setDesign(pick);
  }, []);

  // Loading→content handoff: when real content arrives, fade the loading pane out (~400ms),
  // THEN mount the content pane (which feeds in via its own staggered entrance). The ~420ms
  // is the fade duration only — no artificial extra delay. Loading→expired stays an in-place
  // status change (no fade), since hasContent never becomes true on the error path.
  useEffect(() => {
    if (!hasContent || revealed) return;
    const t = setTimeout(() => setRevealed(true), 420); // fade (derived) → mount content
    return () => clearTimeout(t);
  }, [hasContent, revealed]);

  useEffect(() => {
    async function fetchShare() {
      try {
        const res = await fetch(`/api/share?id=${shareId}`);
        if (!res.ok) {
          if (res.status === 410 || res.status === 404) {
            setError('expired');
          } else {
            setError('error');
          }
          return;
        }
        const data = await res.json();
        setShare(data);
      } catch {
        setError('error');
      } finally {
        setLoading(false);
      }
    }
    fetchShare();
  }, [shareId]);

  useEffect(() => {
    if (!share?.fileUrl || !share.mimeType?.startsWith('video/')) return;

    // Binary (unencrypted large) video: stream the R2 URL directly — no fetch/decode. The object
    // is served with its real Content-Type, so the browser range-requests + streams it.
    if (share.fileFormat === 'binary') {
      setVideoSrc(share.fileUrl);
      return;
    }

    let cancelled = false;
    let blobUrl: string | null = null;

    fetch(share.fileUrl)
      .then(res => res.text())
      .then(text => {
        if (cancelled) return;
        if (text.startsWith('data:')) {
          return fetch(text).then(r => r.blob());
        }
        return new Blob([text], { type: share.mimeType || 'video/mp4' });
      })
      .then(blob => {
        if (!cancelled && blob) {
          blobUrl = URL.createObjectURL(blob);
          setVideoSrc(blobUrl);
        }
      })
      .catch(() => { if (!cancelled) setVideoSrc(null); });

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [share?.fileUrl, share?.mimeType, share?.fileFormat]);

  // Reset the ready flag only when the source actually changes (not on every effect re-run), so
  // the overlay shows for a new video and hides once onCanPlay fires for it. onError also clears
  // it so a failed load never leaves the overlay permanently covering the video.
  useEffect(() => {
    setVideoReady(false);
  }, [videoSrc]);

  // Light/dark toggle. Persists to BOTH the `share-theme` cookie (so the SERVER renders the
  // right theme next load → no flash) and the app's `dropsync_theme` localStorage key.
  const toggleTheme = () => {
    setTheme((t) => {
      const next: ShareTheme = t === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(SHARE_THEME_KEY, next);
        document.cookie = `share-theme=${next}; path=/; max-age=31536000; SameSite=Lax`;
      } catch {
        /* ignore (private mode / disabled storage) */
      }
      return next;
    });
  };

  const handleCopy = async () => {
    if (share?.content) {
      // Copy the same clean text the viewer sees (mentions as plain names), not the raw tokens.
      await navigator.clipboard.writeText(contentToPlainText(share.content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Download via a same-origin server route (the server fetches the R2 asset — no client
  // CORS — and streams it with Content-Disposition: attachment, so the browser downloads and
  // stays on the page instead of opening the asset in a new tab).
  const handleDownload = () => {
    if (!shareId) return;
    const a = document.createElement('a');
    a.href = `/api/share/download?id=${encodeURIComponent(shareId)}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // The design shell (stage + split layout + toggle) always renders. The content side swaps:
  // success → ShareContentPane; otherwise → ShareStatusPane (loading / expired / error), so
  // the themed design stays visible in every state instead of early-returning a plain screen.
  return (
    // Outer wrapper carries the --ds-* CSS vars + Raleway so the fixed toggle button (a child)
    // can read them too. Split layout inside: animated stage (left, swaps design each load) +
    // content pane (right). Stacks on mobile (≤640). Palette is design-aware — wave+dark gets
    // the blue-tinted dark content side; everything else is neutral/cream.
    <div data-ds-share className="font-[family-name:var(--font-raleway)]" style={shareCssVars(theme, design)}>
      {/* Light/dark toggle — fixed top-right, SOLID bg (no backdrop-filter/blur), styled via
          --ds-* so it matches the content side and stays readable over the stage banner too. */}
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        className="fixed right-4 top-4 z-50 inline-flex items-center gap-[7px] rounded-full border border-[var(--ds-hair)] bg-[var(--ds-card)] px-[13px] py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--ds-ink)] transition-colors duration-[400ms] hover:border-[var(--ds-ink)]"
      >
        <span className="text-[13px] leading-none">{theme === 'dark' ? '☀' : '☾'}</span>
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>

      <div className="flex min-h-screen flex-col bg-[var(--ds-paper)] text-[var(--ds-ink)] sm:flex-row">
        <ShareStage design={design} theme={theme} />
        {revealed && share ? (
          <ShareContentPane
            share={share}
            copied={copied}
            videoSrc={videoSrc}
            videoReady={videoReady}
            onVideoReady={() => setVideoReady(true)}
            onCopy={handleCopy}
            onDownload={handleDownload}
            theme={theme}
            design={design}
          />
        ) : (
          <ShareStatusPane status={(error ?? 'loading') as ShareStatus} fading={fadeLoading} theme={theme} design={design} />
        )}
      </div>
    </div>
  );
}
