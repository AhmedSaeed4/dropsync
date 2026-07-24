import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

// Per-user voice-transcription cap — mirrors the agent backend's usage_limit.py idea onto the
// voice route, frontend-side. /api/transcribe forwards caller audio to Groq under the SERVER's
// GROQ_API_KEY; without a per-user cap any logged-in user (or a script) could burn Groq quota =
// money. Regular users: 20 clips / rolling 24h. Trusted users (owner + tier "trusted"): unlimited.
const VOICE_DAILY_LIMIT = 20;
const VOICE_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const VOICE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB hard upload ceiling (anti-abuse/DoS)

// The added Firestore round-trip (the usage transaction below) needs headroom under Vercel's
// default 10s function timeout — mirror src/app/api/notify-mention/route.ts.
export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Trusted callers (owner + tier "trusted") bypass the cap entirely — unlimited AND untracked (no
// voiceUsage doc is created). Fresh read each request, FAIL-CLOSED (defaults to NOT trusted on any
// error): every read is wrapped so a transient Firestore blip can't accidentally grant unlimited
// access. Mirrors the agent backend's authz.is_trusted_caller (config/owner.uid OR users/{uid}.tier
// == 'trusted').
async function isTrustedVoiceCaller(uid: string): Promise<boolean> {
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

// Firestore error codes that mean a transient blip — on these we FAIL OPEN (admit) so a Firestore
// hiccup never blocks legitimate voice use (gRPC maps most network failures to 'unavailable').
// Anything else (e.g. contention exhaustion / logic bug) is a hard failure → FAIL CLOSED (503).
function isTransient(err: unknown): boolean {
  const code = (err as { code?: number | string } | null)?.code;
  if (code === undefined) return false;
  return new Set(['deadline-exceeded', 'unavailable', 'internal']).has(String(code));
}

// admitVoice — the per-user rolling-24h gate. Returns a NextResponse (429/503) to return, or null
// when admitted. A Firestore transaction makes two same-user requests serialize (admit-then-forward:
// the increment commits BEFORE the Groq fetch, so neither can double-spend). The Admin SDK bypasses
// firestore.rules → NO rules change. `now` is hoisted OUTSIDE the txn because firebase-admin re-runs
// the callback on contention retry; fixing it once keeps the 24h window math stable.
async function admitVoice(uid: string): Promise<NextResponse | null> {
  if (await isTrustedVoiceCaller(uid)) return null; // trusted = unlimited + untracked
  const now = Date.now();
  const db = getAdminDb();
  const ref = db.collection('voiceUsage').doc(uid);
  try {
    const decision = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const clips = snap.exists ? ((snap.data() || {}).clips as number[] | undefined) ?? [] : [];
      const pruned = clips.filter((t) => now - t < VOICE_DAY_WINDOW_MS);
      if (pruned.length >= VOICE_DAILY_LIMIT) {
        // Over the cap — write NOTHING. Reset = oldest in-window clip + 24h. pruned is guaranteed
        // non-empty here (length >= 20), so Math.min(...pruned) is safe.
        return { allowed: false as const, resetMs: Math.min(...pruned) + VOICE_DAY_WINDOW_MS };
      }
      pruned.push(now);
      txn.set(ref, { clips: pruned, updatedAt: new Date(now).toISOString() });
      return { allowed: true as const };
    });
    if (decision.allowed) return null;
    const retryAfterSec = Math.max(1, Math.ceil((decision.resetMs - now) / 1000));
    const resetUTC = formatResetUTC(decision.resetMs);
    return NextResponse.json(
      { error: `You've reached the daily voice limit (${VOICE_DAILY_LIMIT} clips/day). It resets at ${resetUTC}.` },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  } catch (err) {
    if (isTransient(err)) {
      console.error('voice limit transient; failing OPEN', err);
      return null;
    }
    console.error('voice limit hard failure; failing CLOSED (503)', err);
    return NextResponse.json({ error: "Couldn't verify the voice limit. Please retry." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    // ---- AUTH: require a valid Firebase ID token (mirrors /api/cleanup-fcm-tokens exactly).
    // This route forwards caller audio to Groq under the server's GROQ_API_KEY; without a login
    // check, anyone on the internet could burn that quota (denial-of-wallet). Auth gate only —
    // the Groq forwarding logic below is unchanged. No file-size/rate limit is added. ----
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

    // Byte-size pre-check #1 (before buffering the body). Content-Length can be spoofed, so we keep
    // BOTH layers — this header hint + the authoritative File.size check below. Mirrors upload/route.ts.
    const cl = parseInt(request.headers.get('content-length') || '0', 10);
    if (cl && cl > VOICE_MAX_BYTES) {
      return NextResponse.json({ error: 'Audio clip too large (max 2 MB).' }, { status: 413 });
    }

    const formData = await request.formData();
    const audioFile = formData.get('file') as File | null;

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    // Byte-size pre-check #2 (authoritative — Content-Length can be spoofed).
    if (audioFile.size > VOICE_MAX_BYTES) {
      return NextResponse.json({ error: 'Audio clip too large (max 2 MB).' }, { status: 413 });
    }

    // ---- Per-user usage gate (admit-then-forward). Runs AFTER auth + extraction + byte checks and
    // BEFORE the Groq forward, so the increment commits before any Groq spend. Two same-user requests
    // serialize via the Firestore transaction — neither can double-spend. Trusted = unlimited. ----
    const block = await admitVoice(uid);
    if (block) return block;

    // Forward to Groq Whisper API
    const groqForm = new FormData();
    groqForm.append('file', audioFile);
    groqForm.append('model', 'whisper-large-v3');
    groqForm.append('response_format', 'json');
    groqForm.append('language', 'en');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: groqForm,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Groq Whisper error:', error);
      return NextResponse.json({ error: 'Transcription failed' }, { status: 500 });
    }

    const result = await response.json();
    return NextResponse.json({ text: result.text });
  } catch (error) {
    console.error('Transcribe error:', error);
    return NextResponse.json({ error: 'Transcription failed' }, { status: 500 });
  }
}
