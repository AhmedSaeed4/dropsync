'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCallAccessRoute } from '@/lib/callRoutes';

export function useCallAccess(userId: string | null): {
  canStart: boolean;
  trusted: boolean;
  loading: boolean;
  resetAt: number | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [canStart, setCanStart] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [resetAt, setResetAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setCanStart(false);
      setTrusted(false);
      setResetAt(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getCallAccessRoute();
      setCanStart(result.canStart);
      setTrusted(result.trusted);
      setResetAt(result.resetAt);
    } catch {
      // Fail closed in the UI; the server remains the final authority.
      setCanStart(false);
      setTrusted(false);
      setResetAt(null);
      setError("Couldn't check call access. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { canStart, trusted, loading, resetAt, error, refresh };
}
