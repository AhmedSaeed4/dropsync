'use client';

import { useEffect, useState, type RefObject } from 'react';

// True when `ref`'s scroll container is within `threshold` px of its bottom. Drives the typing-pill
// vs scroll-to-bottom-button swap in the group chat. Additive — it only OBSERVES scroll position; it
// never sets scrollTop and does not replace or interfere with either panel's existing auto-scroll
// (the scrollTop = scrollHeight on new-message effects). atBottom defaults to true (matches the
// panels' open-at-bottom behavior) so the pill — not the button — shows first.
//
// Why the node-change re-check: both panels attach the SAME ref object to two DIFFERENT DOM nodes
// (the AI scroll area vs the group scroll area) and swap them on an ai↔group tab switch WITHOUT the
// panel remounting. The ref OBJECT's identity stays stable, so an effect keyed only on [ref] would
// keep its scroll listener on the now-unmounted node and `atBottom` would go stale after a tab flip.
// The interval re-attaches to the live node whenever ref.current changes identity (and re-runs the
// initial attach when the scroll container mounts after this hook). The 250ms cadence bounds the
// worst-case post-flip staleness to ~250ms (any overlay flicker is imperceptible) for a cost of one
// cheap identity check — far less work than handling a scroll event.
export function useNearBottom(ref: RefObject<HTMLElement | null>, threshold = 120): boolean {
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    let attachedTo: HTMLElement | null = null;

    const compute = () => {
      const el = ref.current;
      if (!el) return;
      // setAtBottom with the same boolean is a no-op for React (it bails out without re-rendering
      // children), so firing this on every scroll tick only actually re-renders on true↔false flips.
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= threshold);
    };

    const attach = (el: HTMLElement) => {
      if (attachedTo === el) return;
      if (attachedTo) attachedTo.removeEventListener('scroll', compute);
      el.addEventListener('scroll', compute, { passive: true });
      attachedTo = el;
      compute();
    };

    const initial = ref.current;
    if (initial) attach(initial);

    // Re-attach when the ref is repointed to a different node (ai↔group tab switch) or when the
    // scroll container mounts after this hook ran. 250ms keeps any post-flip overlay flicker
    // imperceptible (atBottom self-corrects within one tick).
    const poll = setInterval(() => {
      const el = ref.current;
      if (el && el !== attachedTo) attach(el);
    }, 250);

    const onResize = () => compute();
    window.addEventListener('resize', onResize);

    return () => {
      clearInterval(poll);
      window.removeEventListener('resize', onResize);
      if (attachedTo) attachedTo.removeEventListener('scroll', compute);
    };
  }, [ref, threshold]);

  return atBottom;
}
