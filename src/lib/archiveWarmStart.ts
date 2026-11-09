// One bounded, cancellable warm-start lease. No data or DOM inspection.
export const ARCHIVE_STARTUP_GRACE_MS = 8000;
export const ARCHIVE_QUIET_MS = 250;
export const ARCHIVE_MAX_FRAME_GAP_MS = 50;
export const ARCHIVE_MIN_FRAMES = 3;
export type ArchiveWarmTrigger = 'warm' | 'bound' | 'foreground' | 'retry';
export interface ArchiveWarmRuntime {
  now: () => number;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (handle: unknown) => void;
  requestFrame?: (callback: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
}
export const archiveWarmNow = () => typeof performance === 'undefined' ? Date.now() : performance.now();
const runtime: ArchiveWarmRuntime = {
  now: archiveWarmNow,
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  requestFrame: typeof requestAnimationFrame === 'undefined' ? undefined : (callback) => requestAnimationFrame(callback),
  cancelFrame: typeof cancelAnimationFrame === 'undefined' ? undefined : (handle) => cancelAnimationFrame(handle as number),
};

export function deferArchiveCheck(origin: number, activate: (trigger: 'warm' | 'bound') => void, clock = runtime) {
  const deadline = origin + ARCHIVE_STARTUP_GRACE_MS;
  let stopped = false;
  let ready = false;
  let scope: number | undefined;
  let timer: unknown;
  let frame: unknown;
  let firstFrame: number | undefined;
  let lastFrame: number | undefined;
  let frames = 0;
  const clearFrame = () => {
    if (frame !== undefined) clock.cancelFrame?.(frame);
    frame = undefined;
  };
  const resetQuiet = () => { firstFrame = lastFrame = undefined; frames = 0; };
  const cancel = () => {
    stopped = true;
    if (timer !== undefined) clock.clearTimer(timer);
    timer = undefined;
    clearFrame();
  };
  const start = (trigger: 'warm' | 'bound') => {
    if (stopped) return;
    cancel();
    activate(trigger);
  };
  const expired = () => {
    if (clock.now() < deadline) return false;
    start('bound');
    return true;
  };
  const sample = () => {
    frame = undefined;
    if (stopped || expired() || !ready) return;
    const now = clock.now();
    if (lastFrame === undefined || now - lastFrame > ARCHIVE_MAX_FRAME_GAP_MS) {
      firstFrame = now;
      frames = 0;
    }
    lastFrame = now;
    frames++;
    if (frames >= ARCHIVE_MIN_FRAMES && now - firstFrame! >= ARCHIVE_QUIET_MS) start('warm');
    else frame = clock.requestFrame?.(sample);
  };
  const fallback = () => {
    timer = undefined;
    if (stopped) return;
    if (!expired()) timer = clock.setTimer(fallback, Math.max(0, deadline - clock.now()));
  };
  if (!expired()) timer = clock.setTimer(fallback, Math.max(0, deadline - clock.now()));
  return {
    cancel,
    setReady(value: boolean, epoch: number) {
      if (stopped || expired()) return;
      if (!value || scope !== epoch || ready !== value) {
        clearFrame();
        resetQuiet();
      }
      ready = value;
      scope = epoch;
      if (ready && frame === undefined) frame = clock.requestFrame?.(sample);
    },
  };
}
