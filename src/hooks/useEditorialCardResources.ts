'use client';

// Stage B+C card resource reader (Round 9, Order 17).
//
// Virtual-window cards call this hook to read — and lazily request — a drop's
// decrypted payload parts and its video thumbnail from the scoped page-visit
// store (editorialCardCache). Reads are synchronous useSyncExternalStore
// snapshots, so a revisited card renders its content on the FIRST commit —
// no lock flash. Legacy (non-virtual) cards pass enabled=false and get a
// stable empty snapshot; their own in-view decrypt effect stays authoritative.
//
// The store module is import-free by law (node --test drives it with fake
// runners), so the REAL runners are wired here, once per app run.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { decryptDrop } from '@/lib/drops';
import {
  EMPTY_CARD_RESOURCE,
  editorialCardCache,
  payloadRevision,
  type CardResourceSnapshot,
} from '@/lib/editorialCardCache';
import type { Drop } from '@/types';

let wired = false;
function ensureRunners(): void {
  if (wired) return;
  wired = true;
  editorialCardCache.setRunners({
    decrypt: (drop, userId, signal) => decryptDrop(drop as Drop, userId, signal),
    thumbnail: generateVideoThumbnail,
  });
}

// Stage C runner — the useVideoThumbnail recipe, store-owned: data URL →
// blob URL → video element → seek → canvas → JPEG DATA URL. The output is a
// DATA URL because the store RETAINS it for the whole visit (a blob URL would
// die with whoever revokes it); the generator's own temp blob URL is revoked
// in finally. The signal + bounded timeouts keep the single thumbnail permit
// from sticking on a hung video.
async function generateVideoThumbnail(fileData: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(fileData, { signal });
  const blob = await res.blob();
  if (signal.aborted) throw new Error('thumbnail aborted');
  const blobUrl = URL.createObjectURL(blob);
  try {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('video load timeout')), 8000);
      video.onloadeddata = () => { clearTimeout(timeout); resolve(); };
      video.onerror = () => { clearTimeout(timeout); reject(new Error('video load error')); };
      video.src = blobUrl;
    });
    if (signal.aborted) throw new Error('thumbnail aborted');

    video.currentTime = Math.min(1, video.duration * 0.1);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('video seek timeout')), 8000);
      video.onseeked = () => { clearTimeout(timeout); resolve(); };
      video.onerror = () => { clearTimeout(timeout); reject(new Error('video seek error')); };
    });
    if (signal.aborted) throw new Error('thumbnail aborted');

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 160;
    canvas.height = video.videoHeight || 90;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.6);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// Stable identities for useSyncExternalStore: a fresh arrow per render would
// re-subscribe the component every commit.
const noopSubscribe = () => () => {};
const getServerSnapshot = () => EMPTY_CARD_RESOURCE;

export function useEditorialCardResources(
  enabled: boolean,
  scope: string,
  drop: Drop,
  currentUserId?: string
): CardResourceSnapshot {
  const revision = payloadRevision(drop);

  const subscribe = useCallback(
    (cb: () => void) => (enabled ? editorialCardCache.subscribe(scope, drop.id, cb) : noopSubscribe()),
    [enabled, scope, drop.id]
  );
  const getSnapshot = useCallback(
    () => (enabled ? editorialCardCache.snapshot(scope, drop.id, revision) : EMPTY_CARD_RESOURCE),
    [enabled, scope, drop.id, revision]
  );

  const resources = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Runs on EVERY commit — deliberately, and cheap: the store dedupes every
  // request (in-flight membership, queue membership, decided-part checks),
  // and re-reading the snapshot here is how a finished decrypt chains into
  // its thumbnail request without a second effect.
  useEffect(() => {
    if (!enabled) return;
    ensureRunners();
    if (!drop.encrypted) return;
    // No viewer identity → stay pending (the legacy card's rule too).
    if (!currentUserId) return;
    editorialCardCache.requestDecrypt(scope, drop.id, drop, currentUserId);
    if (drop.mimeType?.startsWith('video/')) {
      const snap = editorialCardCache.snapshot(scope, drop.id, revision);
      if (snap.fileReady && snap.file) {
        editorialCardCache.requestThumbnail(scope, drop.id, revision, snap.file);
      }
    }
  });

  return resources;
}
