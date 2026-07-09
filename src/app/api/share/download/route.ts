import { NextRequest, NextResponse } from 'next/server';
import { isAllowedR2Url } from '@/lib/r2Url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Initialize Firebase Admin (only once). Safe to duplicate alongside ../route.ts — the
// getApps() guard prevents double-init. This route is READ-ONLY: it reads Firestore and
// streams a public R2 asset. It NEVER writes to Firestore or R2 and NEVER deletes anything
// (expiry-cleanup stays in ../route.ts).
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const adminDb = getFirestore();

/**
 * Build a Content-Disposition: attachment header for a download.
 * - ASCII form `filename="..."`: strip control chars + double-quotes, cap length.
 * - Non-ASCII names: also emit the RFC 5987 `filename*=UTF-8''<pct-encoded>` form so the
 *   real name survives.
 * - Empty/missing name → "download".
 */
function contentDispositionHeader(rawName: string | undefined | null): string {
  const fallback = 'download';
  const name = (rawName || '').trim() || fallback;
  const ascii = name.replace(/["\x00-\x1f]/g, '').slice(0, 200) || fallback;
  const hasNonAscii = /[^\x20-\x7e]/.test(name);
  if (hasNonAscii) {
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  return `attachment; filename="${ascii}"`;
}

/**
 * Derive a file extension from a content-type. The asset's REAL content-type (set by R2) is
 * the most reliable signal. Returns '' for unknown/unmappable types so no misleading
 * extension is ever appended.
 */
function extForType(type: string | null): string {
  if (!type) return '';
  const m = type.toLowerCase().split(';')[0].trim();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/avif') return 'avif';
  if (m === 'image/svg+xml') return 'svg';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/webm') return 'webm';
  if (m === 'application/pdf') return 'pdf';
  const sub = m.split('/')[1];
  return sub && /^[a-z0-9.+]+$/.test(sub) ? sub.replace('+xml', '') : '';
}

// GET /api/share/download?id=<shareId> — stream the share's image/file as a DOWNLOAD
// (Content-Disposition: attachment). Fetched server-side so there's no client CORS issue
// (the old client fetch → window.open fallback opened the asset in a new tab). No auth: the
// share is a public link, same model as GET /api/share. READ-ONLY.
export async function GET(request: NextRequest) {
  try {
    const shareId = request.nextUrl.searchParams.get('id');
    if (!shareId) {
      return NextResponse.json({ error: 'No share ID provided' }, { status: 400 });
    }

    const snapshot = await adminDb.collection('shares').where('id', '==', shareId).limit(1).get();

    if (snapshot.empty) {
      return NextResponse.json({ error: 'Share not found' }, { status: 404 });
    }

    const data = snapshot.docs[0].data();

    // Expiry check — READ-ONLY. Do NOT delete here; ../route.ts owns expiry-cleanup. Forever
    // drops (expiresAt null) skip this and remain downloadable.
    if (data.expiresAt) {
      const expiresAt = data.expiresAt.toDate();
      if (expiresAt <= new Date()) {
        return NextResponse.json({ error: 'Share expired' }, { status: 410 });
      }
    }

    const assetUrl: string | undefined = data.imageUrl || data.fileUrl;
    if (!assetUrl) {
      return NextResponse.json({ error: 'No downloadable asset' }, { status: 404 });
    }

    // SSRF guard (defense-in-depth for shares created before the intake validation): never fetch a
    // non-R2 URL server-side, even if a legacy share stored one. https + R2 origin only.
    if (!isAllowedR2Url(assetUrl)) {
      return NextResponse.json({ error: 'Blocked asset URL' }, { status: 403 });
    }

    // Fetch the asset server-side (no CORS server-to-server).
    let assetRes: Response;
    try {
      assetRes = await fetch(assetUrl);
    } catch (error) {
      console.error('Share download: asset fetch failed:', error);
      return NextResponse.json({ error: 'Failed to fetch asset' }, { status: 502 });
    }
    if (!assetRes.ok) {
      return NextResponse.json({ error: 'Failed to fetch asset' }, { status: 502 });
    }
    const body = assetRes.body;
    if (!body) {
      return NextResponse.json({ error: 'Failed to fetch asset' }, { status: 502 });
    }

    // Derive the extension via a fallback chain: the asset's REAL content-type, then the
    // stored mimeType, then the extension already in the drop name. The generic
    // "application/octet-stream" (which R2 reports for some video uploads) is ignored so it
    // doesn't mask a real type stored on the doc — that was leaving videos with no extension.
    const assetType = (assetRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const docType = ((data.mimeType as string) || '').split(';')[0].trim().toLowerCase();
    const isSpecific = (t: string) => !!t && t !== 'application/octet-stream';
    // Some drops are stored in R2 as a base64 DATA URI (the literal text "data:<mime>;base64,…")
    // instead of real binary, so streaming them raw would save an unplayable text file. Peek
    // the first bytes — a data URI starts with ASCII "data:" (0x64 0x61 0x74 0x61 0x3a); real
    // binary has different magic bytes, so this is a safe distinguisher.
    const reader = body.getReader();
    const first = await reader.read();
    const firstChunk: Uint8Array = first.done || !first.value ? new Uint8Array(0) : first.value;
    const isDataUri =
      firstChunk.length >= 5 &&
      firstChunk[0] === 0x64 && // 'd'
      firstChunk[1] === 0x61 && // 'a'
      firstChunk[2] === 0x74 && // 't'
      firstChunk[3] === 0x61 && // 'a'
      firstChunk[4] === 0x3a; // ':'

    let responseBody: BodyInit;
    let resolvedType: string;

    if (isDataUri) {
      // Data URI → gather the text and base64-decode it to real binary. This necessarily
      // buffers (must read the base64 to decode); fine for share-sized files. <mime> from the
      // data URI is the authoritative content-type.
      const chunks: Uint8Array[] = [firstChunk];
      let total = firstChunk.length;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value) {
          chunks.push(r.value);
          total += r.value.length;
        }
      }
      await reader.cancel().catch(() => {});
      const all = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) {
        all.set(c, pos);
        pos += c.length;
      }
      // "data:<mime>[;base64],<payload>" — find the header terminator ',', decode only the
      // short header for the mime, and base64-decode the payload bytes after it.
      let comma = 0;
      while (comma < all.length && all[comma] !== 0x2c /* , */) comma++;
      if (comma >= all.length) {
        return NextResponse.json({ error: 'Failed to decode asset' }, { status: 502 });
      }
      const header = new TextDecoder('utf8').decode(all.subarray(0, comma));
      const hm = header.match(/^data:([^;,]+)/);
      resolvedType = hm ? hm[1].toLowerCase() : 'application/octet-stream';
      const payloadStr = Buffer.from(all.subarray(comma + 1)).toString('latin1');
      responseBody = Buffer.from(payloadStr, 'base64');
    } else {
      // Real binary → pass through STREAMED. Reconstruct a stream that yields the peeked
      // chunk first, then pulls the rest on demand — never buffers the whole asset.
      resolvedType = isSpecific(assetType) ? assetType : isSpecific(docType) ? docType : '';
      let sentPeek = false;
      responseBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sentPeek) {
            sentPeek = true;
            controller.enqueue(firstChunk);
            return;
          }
          return reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                controller.close();
                return;
              }
              if (value) controller.enqueue(value);
            })
            .catch((e) => controller.error(e));
        },
        cancel(reason) {
          reader.cancel(reason).catch(() => {});
        },
      });
    }

    // Derive the extension (resolved type → stored mimeType → name) and the Content-Type
    // header from the resolved type (the data-URI mime for data URIs; else asset/doc type).
    const typeForExt = isSpecific(resolvedType) ? resolvedType : isSpecific(docType) ? docType : '';
    let ext = extForType(typeForExt);
    if (!ext && data.name) {
      const m = String(data.name).toLowerCase().match(/\.([a-z0-9]+)$/);
      if (m) ext = m[1];
    }
    const contentTypeHeader = isSpecific(resolvedType)
      ? resolvedType
      : isSpecific(docType)
        ? docType
        : 'application/octet-stream';

    // Append the extension so the OS recognises the file — but only if the name doesn't
    // already end with it. Content-Disposition: attachment makes the browser download.
    const baseName = ((data.name as string) || '').trim() || 'download';
    const filename =
      ext && !new RegExp('.' + ext + '$', 'i').test(baseName) ? `${baseName}.${ext}` : baseName;

    return new NextResponse(responseBody, {
      status: 200,
      headers: {
        'Content-Type': contentTypeHeader,
        'Content-Disposition': contentDispositionHeader(filename),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('Share download error:', error);
    return NextResponse.json({ error: 'Failed to download share' }, { status: 500 });
  }
}
