'use client';

import { useEffect, useRef, useState } from 'react';

// Keep an overlay mounted briefly after `active` flips false so a CSS fade-OUT can play before the
// real unmount (React otherwise removes the element instantly → no exit animation is possible).
// Returns { shouldRender, isExiting }: gate the element on shouldRender; apply the fade-OUT class
// while isExiting. Cancels a pending exit if active flips back true (instant re-show). Clears its
// timer on unmount so no setState fires after the panel is gone.
export function useDelayedUnmount(active: boolean, delayMs = 180) {
  const [shouldRender, setShouldRender] = useState(active);
  const [isExiting, setIsExiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (active) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setIsExiting(false);
      setShouldRender(true);
    } else if (shouldRender) {
      setIsExiting(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        setShouldRender(false);
        setIsExiting(false);
      }, delayMs);
    }
  }, [active, delayMs, shouldRender]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { shouldRender, isExiting };
}
