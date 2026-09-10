// Instant-open preview caches (Win A + Win B).
//
// PRIMED DECRYPTS: every card decrypts its own payload when it scrolls into view, but the
// click-time preview (page.tsx handlePreview) used to repeat the whole download+decrypt.
// Cards prime their finished payload here; handlePreview consults it first (signature-
// guarded) and skips the duplicate work. Tiny LRU on purpose — decrypted payloads are
// megabytes.
//
// PREBUILT VIDEO URLS (desktop hover): resting on a supported video card pre-converts its
// decrypted data URL into a blob URL so the click finds the video already staged. Ownership
// TRANSFERS to the preview modal on consumption (the modal's cleanup revokes what it shows);
// entries never consumed are revoked on eviction or by clearPreviewPrimeCaches.

import type { Drop } from '@/types';

// Freshness fingerprint over the fields every payload-changing write rotates (the cards'
// guard uses iv|imageR2Key; r2Key is added belt-and-braces for re-uploaded files).
// Pin/rename/category/expiry/lock/reminder never touch these — and never change the
// payload either.
export function previewSig(drop: Drop): string {
  return `${drop.iv ?? ''}|${drop.imageR2Key ?? ''}|${drop.r2Key ?? ''}`;
}

// The shelf holds a whole screen/list of prepared payloads, bounded BOTH by count and by
// approximate total bytes (payload strings are megabytes for big files). Text notes are
// tiny, so a long list fits easily; large files evict oldest-first within the budget.
const PRIMED_LIMIT = 30;
const PRIMED_MAX_BYTES = 30_000_000;
const primedPreviews = new Map<string, { drop: Drop; sig: string }>();

function payloadBytes(drop: Drop): number {
  return (drop.content?.length ?? 0) + (drop.fileData?.length ?? 0) + (drop.imageData?.length ?? 0);
}

// Only a decrypt that demonstrably produced plaintext may be primed. decryptDrop's catch
// returns { ...drop, encrypted: false } — the raw ciphertext still sitting in content —
// so a mere non-empty-payload check would cache unreadable junk. Comparing against the
// RAW drop catches every failure shape (nothing changed = nothing decrypted).
export function primeDecryptedPreview(raw: Drop, decrypted: Drop): void {
  if (decrypted.encrypted !== false) return;
  const changed =
    decrypted.content !== raw.content ||
    decrypted.fileData !== raw.fileData ||
    !!decrypted.imageData;
  if (!changed) return;
  if (!decrypted.content && !decrypted.fileData && !decrypted.imageData) return;
  primedPreviews.delete(decrypted.id);
  primedPreviews.set(decrypted.id, { drop: decrypted, sig: previewSig(raw) });
  let totalBytes = 0;
  for (const entry of primedPreviews.values()) totalBytes += payloadBytes(entry.drop);
  while (primedPreviews.size > PRIMED_LIMIT || (totalBytes > PRIMED_MAX_BYTES && primedPreviews.size > 1)) {
    const oldest = primedPreviews.keys().next().value;
    if (oldest === undefined) break;
    const evicted = primedPreviews.get(oldest);
    if (evicted) totalBytes -= payloadBytes(evicted.drop);
    primedPreviews.delete(oldest);
  }
}

export function getPrimedPreview(id: string, sig: string): Drop | null {
  const entry = primedPreviews.get(id);
  if (!entry || entry.sig !== sig) return null;
  // LRU refresh on hit.
  primedPreviews.delete(id);
  primedPreviews.set(id, entry);
  return entry.drop;
}

const PREBUILT_LIMIT = 2;
const SUPPORTED_PREBUILT_MIMES = new Set(['video/mp4', 'video/webm', 'video/ogg']);
const prebuiltUrls = new Map<string, { url: string; sig: string }>();

function revokePrebuilt(id: string): void {
  const entry = prebuiltUrls.get(id);
  if (entry) {
    URL.revokeObjectURL(entry.url);
    prebuiltUrls.delete(id);
  }
}

// Desktop hover pre-stage: convert an already-decrypted data URL into a blob URL. No-op
// unless the payload is a supported video data URL. Re-hovering the same card with an
// unchanged payload is a no-op — a blind overwrite would orphan the previous blob URL.
export function prebuildVideoUrl(drop: Drop): void {
  if (!drop.mimeType || !SUPPORTED_PREBUILT_MIMES.has(drop.mimeType)) return;
  if (!drop.fileData || !drop.fileData.startsWith('data:')) return;
  const sig = previewSig(drop);
  const existing = prebuiltUrls.get(drop.id);
  if (existing) {
    if (existing.sig === sig) return;
    revokePrebuilt(drop.id);
  }
  void fetch(drop.fileData)
    .then(res => res.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      // A competing build for the same drop may have finished first; keep whichever the
      // map holds and discard ours so no URL is ever orphaned.
      const current = prebuiltUrls.get(drop.id);
      if (current && current.sig === sig) {
        URL.revokeObjectURL(url);
        return;
      }
      if (current) revokePrebuilt(drop.id);
      prebuiltUrls.set(drop.id, { url, sig });
      if (prebuiltUrls.size > PREBUILT_LIMIT) {
        const oldest = prebuiltUrls.keys().next().value;
        if (oldest !== undefined) revokePrebuilt(oldest);
      }
    })
    .catch(() => {});
}

// Consumed by handlePreview at click time: ownership of the URL transfers to the preview
// modal (its cleanup revokes it). A miss (never built, evicted, or payload changed) is
// silent — the modal then does its normal conversion.
export function consumePrebuiltVideoUrl(id: string, sig: string): string | null {
  const entry = prebuiltUrls.get(id);
  if (!entry || entry.sig !== sig) return null;
  prebuiltUrls.delete(id);
  return entry.url;
}

export function clearPreviewPrimeCaches(): void {
  primedPreviews.clear();
  for (const entry of prebuiltUrls.values()) URL.revokeObjectURL(entry.url);
  prebuiltUrls.clear();
}
