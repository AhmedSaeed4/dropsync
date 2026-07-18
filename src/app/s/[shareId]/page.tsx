import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { cache } from 'react';
import ShareClient from './ShareClient';
import { getAdminDb } from '@/lib/firebase-admin';

// Neutral default Metadata, returned byte-identical for EVERY non-revealing case: missing doc,
// expired doc (expiresAt <= now), or ANY exception in the read. A crawler/prober cannot
// distinguish "no such share" from "expired" from "errored" — no existence oracle. Note: it is
// shareId-free, so two different nonexistent IDs render identical OG output.
// robots noindex/nofollow is ALWAYS present here AND on the rich card — share URLs must never be
// indexed (otherwise the OG title = filename lingers in search results after the share expires).
const NEUTRAL_METADATA: Metadata = {
  title: 'DropSync',
  description: 'Shared securely via DropSync',
  robots: { index: false, follow: false },
  openGraph: {
    title: 'DropSync',
    description: 'Shared securely via DropSync',
    siteName: 'DropSync',
    type: 'website',
    // No og:url: a module constant can't read headers(), and any fixed URL would re-introduce a
    // hardcoded origin. Omitting it keeps this neutral default shareId-free and byte-identical
    // across all nonexistent IDs (crawlers fall back to the page URL they fetched).
  },
  twitter: {
    card: 'summary',
    title: 'DropSync',
    description: 'Shared securely via DropSync',
  },
};

// The subset of a share doc surfaced into rendered metadata. This is a STRICT allowlist — nothing
// else from the doc may reach the Metadata object. In particular content (the decrypted text body),
// ownerId, dropId, imageR2Key, fileR2Key, fileUrl, fileSize, and createdAt are NEVER read for OG.
type OgShare = {
  name: string;
  type: string | null;
  mimeType: string | null;
  imageUrl: string | null;
  youtubeVideoId: string | null;
  expired: boolean;
};

// Read a share doc for OG purposes only, deduped within a single request via React cache() so
// generateMetadata's read shares one Firestore hit with any future server read in the same pass.
// (ShareClient keeps its own client-side /api/share fetch — intentionally untouched this PR.)
// Looks up by the `id` FIELD (== shareId), exactly like GET /api/share, NOT the Firestore doc id.
// Returns null for a missing doc; sets `expired` for an expired one. Never throws — any failure
// (incl. a malformed expiresAt) propagates to the caller's try/catch which returns the neutral
// default, preserving the no-oracle guarantee.
const readShareForOg = cache(async (shareId: string): Promise<OgShare | null> => {
  const snapshot = await getAdminDb()
    .collection('shares')
    .where('id', '==', shareId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;

  const data = snapshot.docs[0].data();

  let expired = false;
  if (data.expiresAt) {
    // Firestore Timestamp → Date. A malformed value throws here → caught by generateMetadata →
    // neutral default (never an oracle, never a crash).
    const expiresAt = data.expiresAt.toDate();
    expired = expiresAt <= new Date();
  }

  // Allowlist pull ONLY — never spread `data`.
  return {
    name: typeof data.name === 'string' ? data.name : '',
    type: typeof data.type === 'string' ? data.type : null,
    mimeType: typeof data.mimeType === 'string' ? data.mimeType : null,
    imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : null,
    youtubeVideoId: typeof data.youtubeVideoId === 'string' ? data.youtubeVideoId : null,
    expired,
  };
});

// Rich Open Graph preview for /s/{shareId} links (WhatsApp/Facebook/etc. cards), plus a
// cryptographically-hardened share ID (see src/lib/shares.ts). Builds a STRICT-allowlist Metadata:
// only name/type/mimeType/imageUrl/youtubeVideoId are surfaced (expiresAt consulted then dropped).
// Never throws; the whole body is try/catch → neutral default. robots noindex/nofollow on every
// returned object. Missing/expired/errored → the IDENTICAL neutral default (no existence oracle).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  try {
    const { shareId } = await params; // Next 16: params is a Promise

    // Derive the real request origin dynamically so og:url + the icon.svg fallback are correct on
    // prod, on Vercel preview deploys, and on any future custom domain — never a hardcoded guess.
    // Prod (Vercel) sets x-forwarded-host/x-forwarded-proto; dev exposes `host`. The literal is only
    // the impossible no-host fallback (the real production origin). headers() opts this into dynamic
    // rendering (intended — origin is per-request); SharePage (PREPAINT + ShareClient) is cookie-free.
    const h = await headers();
    const host = h.get('x-forwarded-host') || h.get('host');
    const proto = h.get('x-forwarded-proto')?.split(',')[0] || 'https';
    const origin = host ? `${proto}://${host}` : 'https://drag-drop-app.vercel.app';

    if (!shareId) return NEUTRAL_METADATA;

    const og = await readShareForOg(shareId);
    // Missing doc, expired, or no usable name → identical neutral default (no existence oracle).
    if (!og || og.expired || !og.name) return NEUTRAL_METADATA;

    // ---- og:image resolution (strict precedence) ----
    let ogImage: string | null = null;
    let ogImageWidth: number | undefined;
    let ogImageHeight: number | undefined;
    if (og.youtubeVideoId) {
      // hqdefault always exists (maxresdefault 404s for many videos). Known dimensions 480x360.
      ogImage = `https://img.youtube.com/vi/${og.youtubeVideoId}/hqdefault.jpg`;
      ogImageWidth = 480;
      ogImageHeight = 360;
    } else if (og.imageUrl) {
      // Already an absolute public-HTTPS R2 URL. Dimensions unknown server-side → omitted.
      ogImage = og.imageUrl;
    }
    // No youtube + no imageUrl → fall back to the existing public brand asset (icon.svg is the only
    // DropSync mark in public/ — the app favicon). The spec forbids creating a new design asset.
    // (SVG OG images aren't rendered by every social platform; those just show no image and the
    // twitter card stays summary — acceptable, and the file already exists for the favicon.)
    if (!ogImage) {
      ogImage = `${origin}/icon.svg`;
    }

    // ---- description (generic + branded; NEVER the content body) ----
    let description = 'Shared securely via DropSync';
    const typeLabel = og.type === 'file' ? 'File' : og.type === 'text' ? 'Text' : null;
    if (typeLabel) description = `${typeLabel} shared securely via DropSync`;

    return {
      title: og.name,
      description,
      robots: { index: false, follow: false },
      openGraph: {
        title: og.name,
        description,
        siteName: 'DropSync',
        type: 'website',
        url: `${origin}/s/${shareId}`,
        images: ogImageWidth
          ? [{ url: ogImage, width: ogImageWidth, height: ogImageHeight }]
          : [{ url: ogImage }],
      },
      twitter: {
        card: 'summary_large_image',
        title: og.name,
        description,
        images: [ogImage],
      },
    };
  } catch {
    // NEVER throw from generateMetadata. Any failure → identical neutral default (no oracle).
    return NEUTRAL_METADATA;
  }
}

// COOKIE-FREE theme pre-paint. Reads the app's `dropsync_theme` localStorage value during HTML
// parse (BEFORE first paint) and paints the share page's --ds-* palette vars on
// document.body.style, so the stage + content follow the user's theme with NO cookie and NO
// flash. Same collapse rule the cookie read used: light → light, everything else
// (dark/minimal/missing) → dark (the share page's default). Palette tokens are byte-identical to
// SHARE_PALETTES.light/.dark in src/components/share/shareTheme.ts (array order: paper, paper2,
// card, ink, muted, faint, hair, hair2). ShareClient.tsx takes over these vars on mount,
// incl. the wave-dark navy palette once the design resolves.
const PREPAINT = `(function(){try{var t=localStorage.getItem('dropsync_theme');var p;if(t==='light'){p=['#FFFEF5','#FBF9EE','#FDFCF9','#1a1a1a','#666','#999','#e0e0e0','#ececec'];}else{p=['#0D0D0D','#141414','#1a1a1a','#ffffff','#9a9a9a','#666','#2a2a2a','#222222'];}var r=document.body.style;r.setProperty('--ds-paper',p[0]);r.setProperty('--ds-paper-2',p[1]);r.setProperty('--ds-card',p[2]);r.setProperty('--ds-ink',p[3]);r.setProperty('--ds-muted',p[4]);r.setProperty('--ds-faint',p[5]);r.setProperty('--ds-hair',p[6]);r.setProperty('--ds-hair-2',p[7]);}catch(e){}})();`;

export default function SharePage() {
  // Cookie-free: PREPAINT (above) paints the share palette (--ds-*) from localStorage before
  // first paint, and ShareClient reads `dropsync_theme` on mount and owns the vars from then on.
  // `initialTheme` is now just the SSR/first-paint default (dark, this page's default); the
  // remembered theme is applied client-side. The stage/content read --ds-* from document.body, so
  // first paint is already correct — no flash, no cookie.
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
      <ShareClient initialTheme="dark" />
    </>
  );
}
