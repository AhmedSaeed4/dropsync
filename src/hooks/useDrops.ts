import { useState, useEffect, useCallback } from 'react';
import { createDropListener, cleanupExpiredDrops } from '@/lib/drops';
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

    // Clean up expired drops on load (only for personal drops)
    if (!workspaceId) {
      cleanupExpiredDrops(user.uid);
    }

    // Subscribe to real-time updates
    const unsubscribe = createDropListener(user.uid, workspaceId, (newDrops) => {
      setDrops(newDrops);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user, workspaceId]);

  const refreshDrops = useCallback(() => {
    if (user && !workspaceId) {
      cleanupExpiredDrops(user.uid);
    }
  }, [user, workspaceId]);

  return { drops, loading, refreshDrops };
}