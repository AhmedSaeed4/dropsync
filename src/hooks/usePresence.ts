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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  PRESENCE_GRACE_MS,
  setPresenceOffline,
  subscribeToPresence,
  updatePresence,
  type PresenceEntry,
} from '@/lib/presence';

export type PresenceMap = Record<string, { lastSeen: number; online: boolean }>;

export function usePresence(userId: string | null, workspaceId: string | null): PresenceMap {
  // Raw entries from the listener (self already excluded), keyed by uid. Kept in a ref
  // on purpose — PERF(PF-1): heartbeat snapshots refresh lastSeenMs every few seconds,
  // and that churn must never re-render the page; only a REAL change of the derived
  // online map may.
  const entriesRef = useRef<Record<string, { lastSeenMs: number; online: boolean }>>({});
  const [onlineMap, setOnlineMap] = useState<PresenceMap>({});

  // Re-derive the online map from the latest raw entries and publish it ONLY when its
  // visible content changed: the key set, any online flag, or the lastSeen of an OFFLINE
  // member (the only lastSeen a label renders — formatLastSeen shows it under offline
  // members only). An online member's heartbeat lastSeen refresh is display-invisible
  // and deliberately skipped.
  const recomputeOnlineMap = useCallback(() => {
    const now = Date.now();
    const out: PresenceMap = {};
    for (const [uid, e] of Object.entries(entriesRef.current)) {
      const age = now - e.lastSeenMs;
      const online = e.online === true && age >= -CLOCK_SKEW_TOLERANCE_MS && age < PRESENCE_GRACE_MS;
      out[uid] = { lastSeen: e.lastSeenMs, online };
    }
    setOnlineMap((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(out);
      if (prevKeys.length !== nextKeys.length) return out;
      for (const uid of nextKeys) {
        const p = prev[uid];
        const n = out[uid];
        if (!p || p.online !== n.online || (n.online === false && p.lastSeen !== n.lastSeen)) {
          return out;
        }
      }
      return prev;
    });
  }, []);

  // Reader — subscribe to presence docs for this workspace. Self-guard: no-op when null.
  useEffect(() => {
    if (!userId || !workspaceId) {
      entriesRef.current = {};
      recomputeOnlineMap();
      return;
    }
    // Reset on workspace switch — the derived onlineMap must not reflect the previous workspace
    // during the subscription gap before this workspace's first onSnapshot lands.
    entriesRef.current = {};
    recomputeOnlineMap();
    let cancelled = false;
    const unsub = subscribeToPresence(workspaceId, (list: PresenceEntry[]) => {
      if (cancelled) return;
      const map: Record<string, { lastSeenMs: number; online: boolean }> = {};
      for (const e of list) {
        if (e.uid === userId) continue; // never show yourself as online to yourself
        map[e.uid] = { lastSeenMs: e.lastSeenMs, online: e.online };
      }
      entriesRef.current = map;
      recomputeOnlineMap();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [userId, workspaceId, recomputeOnlineMap]);

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

  // 5s re-filter tick arm: re-derive so a doc going stale (no new snapshot) drops
  // offline without a fresh write — PERF(PF-1): unchanged derivations publish nothing.
  useEffect(() => {
    if (!userId || !workspaceId) return;
    const i = setInterval(() => recomputeOnlineMap(), 5000);
    return () => clearInterval(i);
  }, [userId, workspaceId, recomputeOnlineMap]);

  return onlineMap;
}
