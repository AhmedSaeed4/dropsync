import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { cache } from 'react';
import ShareClient from './ShareClient';
import { getAdminDb } from '@/lib/firebase-admin';

// Production origin for absolute OG URLs (og:url / og:image). Confirmed from the repo's only
// domain reference (admin-route comments) and CLAUDE.md's CORS example — next.config and vercel.json
// configure no custom domain, so this is the canonical prod origin. No new env var is introduced;
// metadataBase is set once on the root layout.
const SITE_ORIGIN = 'https://dropsync.vercel.app';

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
    url: SITE_ORIGIN,
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
      ogImage = `${SITE_ORIGIN}/icon.svg`;
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
        url: `${SITE_ORIGIN}/s/${shareId}`,
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

// Runs during HTML parse, BEFORE hydration: copies the app's `dropsync_theme` localStorage
// value into the `share-theme` cookie so the SERVER renders the right theme on the NEXT load
// (no flash from the second visit on, for users who set dark on the main app). It only sets a
// cookie for the next load — it never touches the current render, so there's no hydration
// mismatch. Only light/dark are synced; minimal (app-only) falls back to light.
const SYNC_THEME = `(function(){try{var t=localStorage.getItem('dropsync_theme');if(t==='dark'||t==='light'){document.cookie='share-theme='+t+';path=/;max-age=31536000;SameSite=Lax';}}catch(e){}})();`;

export default async function SharePage() {
  // The cookie is set by the toggle (live) and by the SYNC_THEME script (from the app's
  // localStorage). Reading it here lets the SERVER paint the user's real theme at first
  // paint — no light-first-paint flash for dark users. No cookie yet → safe 'light' default.
  const c = await cookies();
  const t = c.get('share-theme')?.value;
  const initialTheme: 'light' | 'dark' = t === 'light' ? 'light' : 'dark';

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SYNC_THEME }} />
      <ShareClient initialTheme={initialTheme} />
    </>
  );
}
