import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

// AI image naming for PASTED images (Order 37). Mirrors /api/transcribe (the voice route) end
// to end: Firebase-ID-token auth, a per-user rolling-24h cap so no user can burn the Groq
// quota, and a single forward to Groq vision chat completions. The route NEVER trusts a
// body-provided uid; the drop itself is still created client-side — this route only looks at
// the image and answers with a name.
const IMAGE_DAILY_LIMIT = 20;
const IMAGE_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — pasted screenshots are far smaller; base64 inflates ~33%
// Groq's current vision-capable model (docs: console.groq.com/docs/vision, verified 2026-09-25).
const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Trusted callers (owner + tier "trusted") bypass the cap entirely — unlimited AND untracked.
// Fresh read each request, FAIL-CLOSED on any error. Mirrors /api/transcribe.
async function isTrustedImageCaller(uid: string): Promise<boolean> {
  const db = getAdminDb();
  try {
    const ownerSnap = await db.collection('config').doc('owner').get();
    if (ownerSnap.exists && (ownerSnap.data() || {}).uid === uid) return true;
  } catch {
    /* fall through, fail-closed */
  }
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists && (userSnap.data() || {}).tier === 'trusted') return true;
  } catch {
    /* fail-closed */
  }
  return false;
}

// Formats a reset instant as "HH:MM UTC on YYYY-MM-DD" for the 429 message (UTC).
function formatResetUTC(resetMs: number): string {
  const d = new Date(resetMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${hh}:${mm} UTC on ${yyyy}-${mo}-${dd}`;
}

// Firestore blips that mean transient — FAIL OPEN so a hiccup never blocks naming. Mirrors
// /api/transcribe isTransient exactly.
function isTransient(err: unknown): boolean {
  const code = (err as { code?: number | string } | null)?.code;
  if (code === undefined) return false;
  return new Set(['deadline-exceeded', 'unavailable', 'internal']).has(String(code));
}

// admitImage — the per-user rolling-24h gate on the imageNamingUsage doc. Admit-then-forward:
// the increment commits BEFORE the Groq spend, and the transaction serializes same-user races.
async function admitImage(uid: string): Promise<NextResponse | null> {
  if (await isTrustedImageCaller(uid)) return null; // trusted = unlimited + untracked
  const now = Date.now();
  const db = getAdminDb();
  const ref = db.collection('imageNamingUsage').doc(uid);
  try {
    const decision = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const images = snap.exists ? ((snap.data() || {}).images as number[] | undefined) ?? [] : [];
      const pruned = images.filter((t) => now - t < IMAGE_DAY_WINDOW_MS);
      if (pruned.length >= IMAGE_DAILY_LIMIT) {
        // Over the cap — write NOTHING. pruned is non-empty here, so Math.min is safe.
        return { allowed: false as const, resetMs: Math.min(...pruned) + IMAGE_DAY_WINDOW_MS };
      }
      pruned.push(now);
      txn.set(ref, { images: pruned, updatedAt: new Date(now).toISOString() });
      return { allowed: true as const };
    });
    if (decision.allowed) return null;
    const retryAfterSec = Math.max(1, Math.ceil((decision.resetMs - now) / 1000));
    const resetUTC = formatResetUTC(decision.resetMs);
    return NextResponse.json(
      { error: `You've reached the daily AI naming limit (${IMAGE_DAILY_LIMIT} images/day). It resets at ${resetUTC}.` },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  } catch (err) {
    if (isTransient(err)) {
      console.error('image naming limit transient; failing OPEN', err);
      return null;
    }
    console.error('image naming limit hard failure; failing CLOSED (503)', err);
    return NextResponse.json({ error: "Couldn't verify the naming limit. Please retry." }, { status: 503 });
  }
}

// Cleans a raw model answer into a drop-safe name: collapse whitespace, strip surrounding
// quotes and Windows-hostile filename characters, drop trailing dots, cap at 60 chars.
// A provider refusal (however worded) must never become a drop name — fall back instead.
function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.+$/, '')
    .slice(0, 60)
    .trim();
  const refusal =
    /^(i'm sorry|sorry|i cannot|i can't|i won't|i am unable|unable)/i.test(cleaned) ||
    /(cannot|can't|won't) (assist|help|analyze|describe|provide)/i.test(cleaned);
  return cleaned.length > 0 && !refusal ? cleaned : 'Pasted image';
}

export async function POST(request: NextRequest) {
  try {
    // ---- AUTH: require a valid Firebase ID token (mirrors /api/transcribe). The login + cap
    // below are the denial-of-wallet guards for forwarding caller images to Groq. ----
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const idToken = authHeader.substring(7);
    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Groq API key not configured' }, { status: 500 });
    }

    // Byte-size pre-check #1 (header hint; Content-Length can be spoofed — the File.size check
    // below is authoritative). Mirrors /api/transcribe.
    const cl = parseInt(request.headers.get('content-length') || '0', 10);
    if (cl && cl > IMAGE_MAX_BYTES) {
      return NextResponse.json({ error: 'Image too large (max 5 MB).' }, { status: 413 });
    }

    const formData = await request.formData();
    const imageFile = formData.get('file') as File | null;

    if (!imageFile) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }
    if (!imageFile.type.startsWith('image/')) {
      return NextResponse.json({ error: 'Only images can be named.' }, { status: 415 });
    }
    if (imageFile.size > IMAGE_MAX_BYTES) {
      return NextResponse.json({ error: 'Image too large (max 5 MB).' }, { status: 413 });
    }

    // ---- Per-user usage gate (admit-then-forward), BEFORE the Groq spend. ----
    const block = await admitImage(uid);
    if (block) return block;

    // Forward to Groq vision chat completions with the image as a base64 data URL
    // (docs: console.groq.com/docs/vision — max 3 images/request; we always send exactly 1).
    const buffer = Buffer.from(await imageFile.arrayBuffer());
    const dataUrl = `data:${imageFile.type};base64,${buffer.toString('base64')}`;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You name images for a file-sharing app. Reply with ONLY a short descriptive name (2-6 words). If the image shows an action or activity, name what is HAPPENING — the main action or event (for example "Man doing push-ups" or "Chef plating a dish"); mention a person, clothing, or the background only when there is no action. If the image is a document, screenshot, or interface, name its specific content: read the actual names, titles, and values visible and include them, and add the document type when it fits (for example "Model A vs Model B comparison" or "Acme invoice #4172") — never a generic summary alone. Whatever the content, always answer with a brief factual, clinical description — never refuse, never warn, never moralize. No quotes, no trailing punctuation, no explanation.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Name this image.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 32,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Groq image naming error:', error);
      return NextResponse.json({ error: 'Image naming failed' }, { status: 500 });
    }

    const result = await response.json();
    const raw = String(result.choices?.[0]?.message?.content ?? '');
    return NextResponse.json({ name: sanitizeName(raw) });
  } catch (error) {
    console.error('Image-name error:', error);
    return NextResponse.json({ error: 'Image naming failed' }, { status: 500 });
  }
}
