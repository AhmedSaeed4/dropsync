import { useState, useEffect, useCallback } from 'react';
import { createDropListener, cleanupExpiredDrops } from '@/lib/drops';
import { Drop } from '@/types';
import { useAuth } from './useAuth';

export function useDrops() {
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

    // Clean up expired drops on load
    cleanupExpiredDrops(user.uid);

    // Subscribe to real-time updates
    const unsubscribe = createDropListener(user.uid, (newDrops) => {
      setDrops(newDrops);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  const refreshDrops = useCallback(() => {
    if (user) {
      cleanupExpiredDrops(user.uid);
    }
  }, [user]);

  return { drops, loading, refreshDrops };
}