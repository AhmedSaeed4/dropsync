'use client';

// PAGE-LEVEL presence hook. Called ONCE in src/app/page.tsx, ABOVE all early returns — the chat
// panel unmounts on close (ClassicLayout/EditorialLayout gate it on showChat), so presence cannot
// live in the panel. The returned map is threaded DOWN to both chat panels as a prop.
//
// Online = `online` flag (written true on focus/first-beat) AND lastSeen fresher than
// PRESENCE_GRACE_MS. The `online:false` write on hide/pagehide is a FAST-OFF signal; lastSeen
// freshness is the source of truth — never trust the `online` flag alone. Self is excluded from the
// map (you never see your own online dot to yourself). Firestore has no onDisconnect, so offline is
// detected via the heartbeat + TTL (a missed heartbeat ages lastSeen past the grace window).

import { useEffect, useMemo, useState } from 'react';
import {
  PRESENCE_GRACE_MS,
  setPresenceOffline,
  subscribeToPresence,
  updatePresence,
  type PresenceEntry,
} from '@/lib/presence';

export type PresenceMap = Record<string, { lastSeen: number; online: boolean }>;

export function usePresence(userId: string | null, workspaceId: string | null): PresenceMap {
  // Raw entries from the listener (self already excluded), keyed by uid.
  const [entries, setEntries] = useState<Record<string, { lastSeenMs: number; online: boolean }>>({});
  // 5s re-filter tick: a doc going stale (no new snapshot) must drop offline without a fresh write.
  const [tick, setTick] = useState(0);

  // Reader — subscribe to presence docs for this workspace. Self-guard: no-op when null.
  useEffect(() => {
    if (!userId || !workspaceId) {
      setEntries({});
      return;
    }
    // Reset on workspace switch — the derived onlineMap must not reflect the previous workspace
    // during the subscription gap before this workspace's first onSnapshot lands.
    setEntries({});
    let cancelled = false;
    const unsub = subscribeToPresence(workspaceId, (list: PresenceEntry[]) => {
      if (cancelled) return;
      const map: Record<string, { lastSeenMs: number; online: boolean }> = {};
      for (const e of list) {
        if (e.uid === userId) continue; // never show yourself as online to yourself
        map[e.uid] = { lastSeenMs: e.lastSeenMs, online: e.online };
      }
      setEntries(map);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [userId, workspaceId]);

  // Heartbeat (writer) — 10s while the tab is visible. Switching workspace stops the old heartbeat
  // via this effect's cleanup; the old workspace's lastSeen simply ages out (no explicit offline
  // write on switch — the grace window handles it).
  useEffect(() => {
    if (!userId || !workspaceId) return;
    // Immediate first beat on entering the workspace (writes online:true + lastSeen).
    void updatePresence(workspaceId, userId, true).catch(() => {});
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void updatePresence(workspaceId, userId, false).catch(() => {});
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [userId, workspaceId]);

  // Visibility + pagehide — fast-off signals. This is our OWN listener (we do not piggyback on the
  // page.tsx waitForPendingWrites flush). Visible → online:true; hidden/pagehide → online:false.
  useEffect(() => {
    if (!userId || !workspaceId) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void updatePresence(workspaceId, userId, true).catch(() => {});
      } else {
        void setPresenceOffline(workspaceId, userId).catch(() => {});
      }
    };
    const onHide = () => {
      void setPresenceOffline(workspaceId, userId).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
    };
  }, [userId, workspaceId]);

  // 5s re-filter tick arm.
  useEffect(() => {
    if (!userId || !workspaceId) return;
    const i = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(i);
  }, [userId, workspaceId]);

  // Derive the online map. Memoized on [entries, tick] so the reference is stable when nothing
  // changed — avoids re-rendering both panels every 5s.
  const onlineMap = useMemo<PresenceMap>(() => {
    const now = Date.now();
    const out: PresenceMap = {};
    for (const [uid, e] of Object.entries(entries)) {
      const age = now - e.lastSeenMs;
      const online = e.online === true && age >= 0 && age < PRESENCE_GRACE_MS;
      out[uid] = { lastSeen: e.lastSeenMs, online };
    }
    return out;
  }, [entries, tick]);

  return onlineMap;
}
