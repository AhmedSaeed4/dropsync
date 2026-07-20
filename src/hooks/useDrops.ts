import { useState, useEffect, useCallback } from 'react';
import { createDropListener, cleanupExpiredDrops, sortDrops } from '@/lib/drops';
import { Drop } from '@/types';
import { useAuth } from './useAuth';

export function useDrops(workspaceId: string | null = null) {
  const { user } = useAuth();
  const [drops, setDrops] = useState<Drop[]>([]);
  const [loading, setLoading] = useState(true);

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
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user, workspaceId]);

  // ONE periodic re-sort tick (the single subscription owner — do NOT add ticks to the list
  // components). A reminder whose time is in the FUTURE when the snapshot arrives would otherwise
  // never auto-flip to the fired tier; every 30s we re-sort so a due reminder jumps to the top.
  // sortDrops returns a NEW array ref → re-render → list components re-evaluate the glow predicate
  // with a fresh `now`. (30s matches the existing presence/typing tick cadence.)
  useEffect(() => {
    const id = setInterval(() => setDrops((prev) => sortDrops(prev, new Date())), 30000);
    return () => clearInterval(id);
  }, []);

  const refreshDrops = useCallback(() => {
    if (user) {
      cleanupExpiredDrops({ userId: user.uid, workspaceId });
    }
  }, [user, workspaceId]);

  return { drops, loading, refreshDrops };
}