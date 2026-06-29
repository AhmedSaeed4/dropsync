'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/useAuth';

export type UserTier = 'trusted' | 'standard';

/**
 * Reactive subscription to the current user's `tier` field on their `users/{uid}` doc.
 *
 * `tier` is 'trusted' only when the doc exists and its `tier` field === 'trusted'; otherwise
 * 'standard'. `loading` is true until the first snapshot lands — callers should NOT gate on
 * tier while loading (the Firestore rules from the trusted-tier feature are the real
 * enforcement, so a brief ungated window during load is safe and avoids a spurious lock for
 * trusted users). A read error (e.g. permission-denied) falls back to 'standard'.
 */
export function useUserTier(): { tier: UserTier; loading: boolean } {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [tier, setTier] = useState<UserTier>('standard');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setTier('standard');
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubscribe = onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        setTier(snap.exists() && snap.get('tier') === 'trusted' ? 'trusted' : 'standard');
        setLoading(false);
      },
      (error) => {
        // A failed read must never block the UI — fall back to standard. Firestore rules are
        // the real enforcement, so this only affects whether the forever button self-gates.
        console.error('useUserTier: subscription error', error);
        setTier('standard');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [uid]);

  return { tier, loading };
}
