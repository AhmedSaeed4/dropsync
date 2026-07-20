import { useEffect, useState } from 'react';

// A ticking "now" for live relative-time displays (the reminder fire previews in the Edit picker +
// the View-modal header). Re-renders only at the tick cadence — NOT for sort/glow logic, which uses
// the listener's own clock. Defaults to 30s so minute-granularity countdowns stay fresh without churn.
export function useNow(intervalMs = 30000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
