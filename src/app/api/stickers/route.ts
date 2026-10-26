import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth } from '@/lib/firebase-admin';
import { parseStickerRequest, runStickerOperation, StickerRequestError } from '@/lib/stickers.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  let uid: string;
  try { uid = (await getAdminAuth().verifyIdToken(authorization.slice(7))).uid; }
  catch { return NextResponse.json({ ok: false, error: 'Invalid token' }, { status: 401 }); }
  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { throw new StickerRequestError(400, 'Invalid sticker request.'); }
    const result = await runStickerOperation(uid, parseStickerRequest(body));
    return NextResponse.json(result.body, { status: result.statusCode, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof StickerRequestError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.statusCode });
    }
    // Never log signed URLs, ciphertext, bearer tokens or storage credentials.
    console.error('Sticker operation failed:', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ ok: false, error: "Couldn't finish sticker request. Try again." }, { status: 503 });
  }
}
