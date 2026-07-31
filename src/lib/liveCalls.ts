// subscribeToActiveCall — optional sugar: "is there a live call in workspace W right now?".
// The drop LIST does NOT use this (a call drop is a regular drop with type 'call', surfaced by
// createDropListener + sortDrops' live tier). This focused listener is for a future header
// indicator / "a call is happening" affordance. One-call-per-workspace is enforced by the start
// route's deterministic doc id; this query returns at most one (the oldest if a transient race ever
// yielded two).

import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';

export function subscribeToActiveCall(
  workspaceId: string,
  cb: (callDropId: string | null) => void,
): () => void {
  let cancelled = false;
  const q = query(
    collection(db, 'drops'),
    where('type', '==', 'call'),
    where('workspaceId', '==', workspaceId),
    where('callState', '==', 'live'),
  );
  const unsub = onSnapshot(
    q,
    (snap) => {
      if (cancelled) return;
      // Deterministic pick if >1 ever lands (transient): oldest by createdAt. Primitive accumulators
      // (not an object) so TS control-flow analysis doesn't lose the type across the forEach closure.
      let firstId: string | null = null;
      let firstCreatedAt = Number.POSITIVE_INFINITY;
      snap.forEach((d) => {
        const data = d.data() as { createdAt?: { toMillis?: () => number } };
        const t = typeof data.createdAt?.toMillis === 'function' ? data.createdAt.toMillis() : 0;
        if (t < firstCreatedAt) {
          firstCreatedAt = t;
          firstId = d.id;
        }
      });
      cb(firstId);
    },
    () => {
      // Swallow — never throw.
    },
  );
  return () => {
    cancelled = true;
    unsub();
  };
}
