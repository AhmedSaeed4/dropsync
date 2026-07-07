import { auth } from './firebase';

// The 8-field "content identity" two shares must agree on to be considered the same link.
// Compared with shallow equality. Note hasImage/hasFile are BOOLEANS (presence only) — that is
// the intended content identity, so swapping one image for a different image of the same presence
// is NOT detected and may reuse the old image link. This is an accepted limitation.
interface ShareIdentity {
  name: string;
  content: string;
  type: string;
  mimeType: string;
  fileSize: number;
  youtubeVideoId: string;
  hasImage: boolean;
  hasFile: boolean;
}

// An active (non-expired) share for a drop, as returned by GET /api/share/active. Same fields as
// ShareIdentity plus the shareId needed to rebuild the reuse URL.
export interface ActiveShare extends ShareIdentity {
  shareId: string;
}

// Build the current content identity from createShare()'s options (caller-side truth).
function buildShareIdentity(options: {
  name: string;
  content?: string;
  type: string;
  mimeType?: string;
  fileSize?: number;
  youtubeVideoId?: string;
  imageData?: string;
  fileData?: string;
  fileUrl?: string;
}): ShareIdentity {
  return {
    name: options.name,
    content: options.content ?? '',
    type: options.type,
    mimeType: options.mimeType ?? '',
    fileSize: options.fileSize ?? 0,
    youtubeVideoId: options.youtubeVideoId ?? '',
    hasImage: !!options.imageData,
    hasFile: !!(options.fileData || options.fileUrl),
  };
}

// Shallow equality on all 8 identity fields. content may be large; plain === is fine.
function identityMatches(a: ShareIdentity, b: ShareIdentity): boolean {
  return (
    a.name === b.name &&
    a.content === b.content &&
    a.type === b.type &&
    a.mimeType === b.mimeType &&
    a.fileSize === b.fileSize &&
    a.youtubeVideoId === b.youtubeVideoId &&
    a.hasImage === b.hasImage &&
    a.hasFile === b.hasFile
  );
}

// Cryptographically-secure, unbiased share-ID generator.
// A shareId is a BEARER SECRET — anyone holding it reads the fully-decrypted plaintext share via
// GET /api/share with no auth. So it must be unguessable, which Math.random() does NOT guarantee
// (it is not a CSPRNG and its output can correlate across calls / be observable). crypto.getRandom
// Values supplies a cryptographically-secure RNG.
// The 62-char alphabet is not a power of two, so naive `byte % 62` introduces modulo bias (a few
// chars ~2% likelier). Rejection sampling eliminates it: only accept a byte below the largest
// multiple of 62 that fits in a uint8 (248); bytes 248–255 are biased and re-rolled.
// Lengthened 12 → 20 chars (62^20 ≈ 7e35 keyspace) to harden against brute-force enumeration.
// Same alphabet, signature, and return type. Existing 12-char IDs are opaque strings — nothing
// validates length/format, so they keep working unchanged.
function generateShareId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // Largest multiple of the alphabet size that fits in a byte (62 → 248). Bytes ≥ this are
  // rejected and re-rolled so every char is exactly equiprobable (no modulo bias).
  const limit = Math.floor(256 / chars.length) * chars.length;
  const randomValues = new Uint8Array(20);
  crypto.getRandomValues(randomValues);

  let result = '';
  for (let i = 0; i < 20; i++) {
    let byte = randomValues[i];
    // Re-roll only the rejected bytes (248–255, ~3% each) until unbiased. Keeps the guarantee
    // without regenerating the whole buffer; ~0.6 extra bytes expected across all 20 chars.
    while (byte >= limit) {
      const next = new Uint8Array(1);
      crypto.getRandomValues(next);
      byte = next[0];
    }
    result += chars.charAt(byte % chars.length);
  }
  return result;
}

export async function createShare(options: {
  dropId: string;
  type: 'text' | 'file';
  name: string;
  content?: string;
  mimeType?: string;
  fileSize?: number;
  imageData?: string;
  fileData?: string;
  fileUrl?: string;
  fileFormat?: 'binary';
  youtubeVideoId?: string;
  expiresAt: Date | null;
}): Promise<{ shareId: string; url: string } | null> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return null;

    const idToken = await currentUser.getIdToken();

    // REUSE: if an active (non-expired) share for this drop already exists AND the drop's
    // content is unchanged since that share was made, hand back the SAME existing URL and SKIP
    // the R2 upload + Firestore write entirely. Only create a new link when there is no active
    // share OR the content identity differs. getActiveShareForDrop is best-effort (never throws):
    // on any failure it returns null and we fall through to the normal create path, so sharing
    // can never break because of this check.
    const currentIdentity = buildShareIdentity(options);
    const active = await getActiveShareForDrop(options.dropId);
    if (active && identityMatches(active, currentIdentity)) {
      return { shareId: active.shareId, url: `${window.location.origin}/s/${active.shareId}` };
    }

    const shareId = generateShareId();

    // If there's image data, upload it to R2 via API
    let imageUrl: string | undefined;
    let imageR2Key: string | undefined;
    if (options.imageData) {
      try {
        const uploadRes = await fetch('/api/share', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({ imageData: options.imageData }),
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          imageUrl = uploadData.imageUrl;
          imageR2Key = uploadData.imageR2Key;
        } else {
          const err = await uploadRes.json();
          console.error('Share image upload failed:', err);
        }
      } catch (error) {
        console.error('Share image upload failed:', error);
      }
    }

    // If there's file data (video, PDF, etc.), upload it to R2 via API
    let fileUrl: string | undefined;
    let fileR2Key: string | undefined;
    if (options.fileData) {
      try {
        const uploadRes = await fetch('/api/share', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({ fileData: options.fileData, mimeType: options.mimeType }),
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          fileUrl = uploadData.fileUrl;
          fileR2Key = uploadData.fileR2Key;
        } else {
          const err = await uploadRes.json();
          console.error('Share file upload failed:', err);
        }
      } catch (error) {
        console.error('Share file upload failed:', error);
      }
    } else if (options.fileUrl) {
      // Large unencrypted files: use the original R2 URL directly
      fileUrl = options.fileUrl;
    }

    const res = await fetch('/api/share', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        shareId,
        dropId: options.dropId,
        type: options.type,
        name: options.name,
        content: options.content,
        mimeType: options.mimeType,
        fileSize: options.fileSize,
        imageUrl,
        imageR2Key,
        fileUrl,
        fileR2Key,
        fileFormat: options.fileFormat,
        youtubeVideoId: options.youtubeVideoId,
        expiresAt: options.expiresAt?.toISOString() || null,
      }),
    });

    if (!res.ok) {
      const error = await res.json();
      console.error('Share creation failed:', error);
      return null;
    }

    const url = `${window.location.origin}/s/${shareId}`;
    return { shareId, url };
  } catch (error) {
    console.error('Error creating share:', error);
    return null;
  }
}

export async function deleteSharesForDrop(dropId: string): Promise<void> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    const idToken = await currentUser.getIdToken();

    await fetch(`/api/share?dropId=${dropId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${idToken}`,
      },
    });
  } catch (error) {
    console.error('Error deleting shares for drop:', error);
  }
}

// Fetch the latest active (non-expired) share for a drop, or null. Mirrors deleteSharesForDrop
// exactly in structure (auth.currentUser guard; getIdToken; Bearer fetch; parse; catch + log;
// never throws). Used by createShare() to decide whether to REUSE an existing link or create a
// new one. Best-effort: any failure resolves to null (caller falls through to create).
export async function getActiveShareForDrop(dropId: string): Promise<ActiveShare | null> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return null;

    const idToken = await currentUser.getIdToken();

    const res = await fetch(`/api/share/active?dropId=${encodeURIComponent(dropId)}`, {
      headers: {
        'Authorization': `Bearer ${idToken}`,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data ?? null;
  } catch (error) {
    console.error('Error fetching active share for drop:', error);
    return null;
  }
}

// Re-sync EVERY share link for a drop to the drop's latest expiry ("always match"). Called
// best-effort from updateDropMetadata/updateTextDrop after a drop's expiry edit succeeds, so
// existing share links never show a stale expiry. Mirrors deleteSharesForDrop exactly:
// fire-and-forget, never throws to the caller, never affects the edit's return value.
export async function syncSharesExpiryForDrop(
  dropId: string,
  expiresAt: Date | null
): Promise<void> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    const idToken = await currentUser.getIdToken();

    await fetch('/api/share/sync-expiry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        dropId,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      }),
    });
  } catch (error) {
    console.error('Error syncing shares expiry for drop:', error);
  }
}
