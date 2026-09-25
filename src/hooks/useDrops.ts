import { useState, useEffect, useCallback, useRef } from 'react';
import { createDropListener, cleanupExpiredDrops, sortDrops, isReminderFiredShared } from '@/lib/drops';
import { Drop } from '@/types';
import { useAuth } from './useAuth';

// PERF(PF-1, Order 10f): the 30s tick's skip signature — the ordered ids PLUS each drop's shared
// fired-reminder flag. A reminder flipping to fired changes the signature even when its POSITION
// does not (closes the Order 10e narrow stale window: the fired section + glow must appear with
// zero user interaction).
function dropsTickSignature(drops: Drop[], now: Date): string {
  return drops.map((d) => `${d.id}:${isReminderFiredShared(d, now) ? 1 : 0}:${d.isStaged ? 1 : 0}`).join("|");
}

export function useDrops(
  workspaceId: string | null = null,
  options?: { onAccessDenied?: (workspaceId: string | null) => void }
) {
  const { user } = useAuth();
  const [drops, setDrops] = useState<Drop[]>([]);
  const [loading, setLoading] = useState(true);
  const lastTickSigRef = useRef("");
  // Stage B: the access-denied callback lives in a ref written by an EFFECT
  // (never during render) so a changing options object never resubscribes
  // the drops listener.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!user) {
      setDrops([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    // Clean up expired drops on load (personal + workspace scopes)
    cleanupExpiredDrops({ userId: user.uid, workspaceId });

    // Subscribe to real-time updates
    const unsubscribe = createDropListener(user.uid, workspaceId, (newDrops) => {
      setDrops(newDrops);
      lastTickSigRef.current = dropsTickSignature(newDrops, new Date());
      setLoading(false);
    }, (deniedWorkspaceId) => optionsRef.current?.onAccessDenied?.(deniedWorkspaceId));

    return () => unsubscribe();
  }, [user, workspaceId]);

  // ONE periodic re-sort tick (the single subscription owner — do NOT add ticks to the list
  // components). A reminder whose time is in the FUTURE when the snapshot arrives would otherwise
  // never auto-flip to the fired tier; every 30s we re-sort so a due reminder jumps to the top.
  // (30s matches the existing presence/typing tick cadence.)
  useEffect(() => {
    const id = setInterval(() => setDrops((prev) => {
      const now = new Date();
      const next = sortDrops(prev, now);
      // PERF(PF-1): sortDrops always returns a new array. Skip the publish — keep the previous
      // reference so the re-render stops at this hook — ONLY while the tick signature is
      // unchanged (same ids in the same order, no reminder tier flipped). A fired-flag flip
      // publishes even without a position change (Order 10f: closes the Order 10e stale window —
      // the fired section + glow must appear with zero user interaction).
      const sig = dropsTickSignature(next, now);
      if (sig === lastTickSigRef.current) {
        return prev;
      }
      lastTickSigRef.current = sig;
      return next;
    }), 30000);
    return () => clearInterval(id);
  }, []);

  const refreshDrops = useCallback(() => {
    if (user) {
      cleanupExpiredDrops({ userId: user.uid, workspaceId });
    }
  }, [user, workspaceId]);

  return { drops, loading, refreshDrops };
}
