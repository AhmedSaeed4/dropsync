'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

// One shared number with the panels' stream-follow guard (ChatPanel / EditorialChatPanel
// auto-scroll effect: scrollHeight - scrollTop - clientHeight <= 120): re-arm must mean
// "back inside the follow window", so if a panel's guard ever changes, this changes with it.
const NEAR_BOTTOM_PX = 120;

/**
 * USER-INTENT follow flag for the agent stream (Order 51). The panels' auto-scroll effects
 * fire on every ~40ms reveal tick and ask "is the reader within 120px of the bottom?" — on
 * touch, a finger moves only a few px per tick, so a reader could never cross 120px between
 * ticks and every tick re-snapped them to the bottom. This hook moves the snap decision to
 * intent: a wheel-up or a downward finger drag kills the follow within the first pixels
 * (before the 120px window is crossed), and returning to the bottom — the user's own scroll,
 * momentum landing, the jump-to-bottom button, the keyboard snap, or a fresh send via
 * resume() — re-arms it.
 *
 * While a touch is ACTIVE (touchstart until touchend or touchcancel) the scroll listener
 * will not re-arm: the finger owns the scroll, unconditionally. The native pan fires a
 * scroll event every few px, and the first 120px of every drag is still "near bottom", so a
 * mid-drag re-arm there would fight the touchmove kill — the panels' snap effect resets
 * scrollTop to the bottom and erases the drag as it is made (the owner-reported
 * stick-to-bottom during the thinking/tools phase). After the finger lifts, the scroll path
 * works exactly as before (Order 51-REPAIR-2).
 *
 * Same discipline as useNearBottom (src/hooks/useNearBottom.ts): OBSERVE + state only — this
 * hook NEVER sets scrollTop; the panels keep ownership of snapping. It also copies
 * useNearBottom's node-change re-attach pattern (see that hook's header): both panels attach
 * the SAME ref object to two DIFFERENT DOM nodes (ai list vs group list) and swap them on tab
 * switches WITHOUT remounting, so an effect keyed only on [ref] would leave its listeners on
 * the dead node; the 250ms identity poll re-attaches to the live node (established precedent).
 *
 * setFollowing with the same boolean is a React no-op bailout (same note as useNearBottom),
 * so the re-arm checks firing on every scroll/touch event only re-render on true↔false flips.
 */
export function useFollowStream(
  ref: RefObject<HTMLElement | null>
): { following: boolean; resume: () => void } {
  const [following, setFollowing] = useState(true);
  // Latest-value mirror so the (once-per-node) DOM listeners read the current flag without
  // re-attaching on every flip — the panels' latest-ref callback precedent.
  const followingRef = useRef(true);

  /** Explicit "follow the stream again" — wired to handleSend (a fresh question) and the
   *  jump-to-bottom button. Stable identity. */
  const resume = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
  }, []);

  useEffect(() => {
    let attachedTo: HTMLElement | null = null;
    let lastTouchY: number | null = null;
    let touchActive = false;

    const nearBottom = (el: HTMLElement) =>
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    const stopFollowing = () => {
      followingRef.current = false;
      setFollowing(false);
    };
    const startFollowing = () => {
      followingRef.current = true;
      setFollowing(true);
    };

    // Wheel UP abandons the follow; wheeling DOWN while pinned at the bottom must not
    // silently kill it (deltaY > 0 is a no-op here on purpose).
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stopFollowing();
    };
    const onTouchStart = (e: TouchEvent) => {
      touchActive = true;
      lastTouchY = e.touches.length > 0 ? e.touches[0].clientY : null;
    };
    // Finger moving DOWN the screen = list scrolling up = leaving the bottom. This fires
    // within the first few px of a drag — the flag dies long before the 120px near-bottom
    // window is crossed, so no reveal tick can snap the reader back down. Y updates every event.
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches.length > 0 ? e.touches[0].clientY : null;
      if (y === null || lastTouchY === null) return;
      if (y > lastTouchY) stopFollowing();
      lastTouchY = y;
    };
    // A tap / no-net-movement touch re-arms instantly when the list is still at the bottom.
    const onTouchEnd = () => {
      touchActive = false;
      const el = ref.current;
      if (el && nearBottom(el)) startFollowing();
    };
    // A system-interrupted gesture (browser/OS steals the touch) ends the drag like touchend:
    // the finger is gone, so a list resting at the bottom re-arms.
    const onTouchCancel = () => {
      touchActive = false;
      const el = ref.current;
      if (el && nearBottom(el)) startFollowing();
    };
    // Returning to the bottom by ANY means — the user's own scroll, momentum, the jump
    // button's smooth scroll landing, the keyboard snap — re-arms the follow. Except while
    // a finger is still down: the touch owns the scroll (the header explains why).
    const onScroll = () => {
      const el = ref.current;
      if (!touchActive && !followingRef.current && el && nearBottom(el)) startFollowing();
    };

    const attach = (el: HTMLElement) => {
      if (attachedTo === el) return;
      if (attachedTo) {
        attachedTo.removeEventListener('wheel', onWheel);
        attachedTo.removeEventListener('touchstart', onTouchStart);
        attachedTo.removeEventListener('touchmove', onTouchMove);
        attachedTo.removeEventListener('touchend', onTouchEnd);
        attachedTo.removeEventListener('touchcancel', onTouchCancel);
        attachedTo.removeEventListener('scroll', onScroll);
      }
      el.addEventListener('wheel', onWheel, { passive: true });
      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchmove', onTouchMove, { passive: true });
      el.addEventListener('touchend', onTouchEnd, { passive: true });
      el.addEventListener('touchcancel', onTouchCancel, { passive: true });
      el.addEventListener('scroll', onScroll, { passive: true });
      attachedTo = el;
    };

    const initial = ref.current;
    if (initial) attach(initial);

    // Re-attach when the ref is repointed to a different node (ai↔group tab switch) or when
    // the scroll container mounts after this hook ran (useNearBottom's precedent, verbatim).
    const poll = setInterval(() => {
      const el = ref.current;
      if (el && el !== attachedTo) attach(el);
    }, 250);

    // Full add/remove symmetry — this codebase runs React StrictMode and Round 19 paid for
    // an asymmetric cleanup once.
    return () => {
      clearInterval(poll);
      if (attachedTo) {
        attachedTo.removeEventListener('wheel', onWheel);
        attachedTo.removeEventListener('touchstart', onTouchStart);
        attachedTo.removeEventListener('touchmove', onTouchMove);
        attachedTo.removeEventListener('touchend', onTouchEnd);
        attachedTo.removeEventListener('touchcancel', onTouchCancel);
        attachedTo.removeEventListener('scroll', onScroll);
      }
    };
  }, [ref]);

  return { following, resume };
}
