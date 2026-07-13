import { useSyncExternalStore } from 'react';
import type { Drop } from '@/types';
import { deleteDrop } from '@/lib/drops';

/**
 * Module-level singleton store for single-drop delete-with-undo state, shared by both drop lists
 * (DropList + EditorialDropList) via `usePendingDeletions()`.
 *
 * WHY this exists (PR #168, follow-up to #167): in #167 the pending map (`useState`) and the
 * tombstone (`useRef`) lived PER COMPONENT INSTANCE. When a drop list unmounted + remounted during
 * the 30s undo window — a classic<->editorial layout toggle (`page.tsx` swaps the layout component
 * in a ternary) or navigating to another route and back — the new instance started with an EMPTY
 * pending map + EMPTY tombstone while the drop doc was still in `drops`, so the drop REAPPEARED
 * and stayed until the orphaned 30s `setTimeout` finally fired the real delete. Hoisting the state
 * to this process-global module makes it survive layout switch + client-side navigation (the timer
 * is owned here, so it is never orphaned). Full browser reload destroys the JS context (store +
 * timer) and is intentionally out of scope — it behaves exactly as before, no regression.
 *
 * No `'use client'` directive: this module has no JSX. It becomes client bundle automatically via
 * its importers (the two `'use client'` drop lists). Do not import it from any server component /
 * route handler / server action (it captures a 30s timer + mutable module state).
 */

/** A drop awaiting its 30s undo window, plus the timer that fires the real delete on elapse. */
/** Length of the undo window, in ms. Single source of truth — used by BOTH the delete timer and the
 * display deadline (expiresAt), so the visible countdown can never drift from the real trigger. */
const DELETE_DELAY_MS = 30000;

interface PendingDeletion {
  drop: Drop;
  // `ReturnType<typeof setTimeout>` (not `NodeJS.Timeout`) so the type is correct in both the
  // browser (number) and Node (Timeout) without depending on @types/node in the client bundle.
  timeoutId: ReturnType<typeof setTimeout>;
  // Absolute epoch-ms deadline of the undo window (set alongside the timer in requestDelete). The
  // display countdown (UndoToast) derives from this so it stays synced to the real timer across
  // remounts; the store timer remains the authoritative delete trigger.
  expiresAt: number;
}

/** The cached snapshot shape handed to React via useSyncExternalStore. */
interface PendingDeletionsSnapshot {
  pending: Map<string, PendingDeletion>;
  tombstone: Set<string>;
}

// `onDelete` is the parent's `refreshDrops` (useCallback-memoized in useDrops, stable for a given
// user + workspace). It is captured by the 30s timer closure at request time — safe because it
// does not change identity during the window.
type OnDelete = () => void;

// ---- Module-level singleton state (process-global). ----
// `pending` is the request-time hide + the 30s timer. `tombstone` is the fired-set (ids whose
// delete has already fired). INVARIANT (Hard rule #2): request-time ids go in `pending`, NEVER in
// the tombstone. The tombstone is written ONLY by `performDelete`. It serves double duty — the
// #167 visibility filter (hide the drop until onSnapshot confirms removal) AND the double-fire
// guard (the two 30s timers — requestDelete's setTimeout AND the toast dismiss — must not both
// fire deleteDrop). Do NOT split these into two sets.
const pending = new Map<string, PendingDeletion>();
const tombstone = new Set<string>();
const listeners = new Set<() => void>();

// CRITICAL — Hard rule #1 (useSyncExternalStore snapshot stability): `getSnapshot()` MUST return
// the SAME object reference between `notify()` calls. If it built a fresh object each call, React
// would infinite-loop ("The result of getSnapshot should be cached"). So we cache ONE snapshot
// object and rebuild it ONLY inside `notify()`. `getSnapshot` just returns the cached reference.
let snapshot: PendingDeletionsSnapshot = {
  pending: new Map(),
  tombstone: new Set(),
};

/** Rebuild the cached snapshot from the live state with NEW Map/Set references (never mutate the
 * cached snapshot in place) and notify every subscriber. This is the ONLY place the snapshot is
 * rebuilt — every mutation funnels through here. */
function notify() {
  snapshot = {
    pending: new Map(pending),
    tombstone: new Set(tombstone),
  };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Returns the cached snapshot reference unchanged between notifies (Hard rule #1). Also reused as
// the server snapshot for SSR: the store starts empty and is only mutated from client event
// handlers, so server + initial client renders both see an empty snapshot (no hydration mismatch).
function getSnapshot() {
  return snapshot;
}

function removePending(dropId: string) {
  pending.delete(dropId);
  notify();
}

/**
 * The real delete. Tombstone is set SYNCHRONOUSLY before any `await` so the drop is hidden the
 * instant the delete fires — this preserves #167's ordering-independence between the two 30s timers.
 */
async function performDelete(drop: Drop, onDelete: OnDelete) {
  if (tombstone.has(drop.id)) return; // already fired — ignore the second 30s timer (double-fire guard)
  tombstone.add(drop.id); // SYNCHRONOUSLY, before the await below
  notify();
  try {
    const ok = await deleteDrop(drop);
    if (!ok) {
      // delete FAILED — the drop still exists (onSnapshot will re-show it). Clear the tombstone so
      // the user's retry (click delete again) is NOT blocked, AND notify() so the cached snapshot is
      // rebuilt. The drop lists read the tombstone through the cached snapshot (not the live Set),
      // so without this notify the stale tombstone would keep the drop hidden permanently. Safe vs
      // the double-fire: the second 30s timer already returned early above, so clearing + notifying
      // here does not reopen it.
      tombstone.delete(drop.id);
      notify();
    }
  } finally {
    onDelete();
  }
}

/** Begin a single-drop delete with a 30s undo window. Adds the drop to `pending` (the request-time
 * hide) and arms the 30s timer. Undo within the window cancels via `undo()`. */
export function requestDelete(drop: Drop, onDelete: OnDelete) {
  const expiresAt = Date.now() + DELETE_DELAY_MS;
  const timeoutId = setTimeout(() => {
    // Fire-and-forget: performDelete has already set the tombstone + notified synchronously before
    // its first await, so it is safe to drop the entry from pending immediately after.
    performDelete(drop, onDelete);
    removePending(drop.id);
  }, DELETE_DELAY_MS);

  pending.set(drop.id, { drop, timeoutId, expiresAt });
  notify();
}

/** Undo within the 30s window: cancel the timer + drop from pending. NEVER touches the tombstone
 * (undo never fired a delete), preserving the #167 "undo re-shows the drop" invariant. */
export function undo(dropId: string) {
  const entry = pending.get(dropId);
  if (entry) {
    clearTimeout(entry.timeoutId);
  }
  pending.delete(dropId);
  notify();
}

/** Toast dismiss (user lets the delete proceed immediately): cancel the timer, fire the real delete
 * now, drop from pending. */
export function dismiss(dropId: string, onDelete: OnDelete) {
  const entry = pending.get(dropId);
  if (entry) {
    clearTimeout(entry.timeoutId);
    performDelete(entry.drop, onDelete);
  }
  pending.delete(dropId);
  notify();
}

/** React binding. Returns the cached `{ pending, tombstone }` snapshot — a stable reference between
 * notifies (Hard rule #1). */
export function usePendingDeletions(): PendingDeletionsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
