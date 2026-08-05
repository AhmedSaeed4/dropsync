// Coordinator for the "browser/mobile back button closes the topmost modal" feature.
//
// While any modal is open we keep ONE dummy history entry armed. A popstate (the user hitting
// back) then closes the TOP modal only; if another modal is still open we re-arm the dummy for
// it. Each modal registers on open and unregisters on close. This is FAIL-SAFE by design:
//  - popstate only acts when a modal is open, so normal in-app navigation is never intercepted.
//  - if history/pushState is unavailable, every call no-ops and modals still close via X/backdrop.
type Entry = { close: () => void };

const stack: Entry[] = [];
let listenerAttached = false;

function isArmed(): boolean {
  return typeof window !== 'undefined' && !!window.history.state && window.history.state.modalBack === true;
}

function pushDummy() {
  if (typeof window === 'undefined' || isArmed()) return;
  try { window.history.pushState({ modalBack: true }, ''); } catch { /* ignore */ }
}

function onPopState() {
  if (stack.length === 0) return;              // no modal open -> normal back nav, do nothing
  const top = stack[stack.length - 1];          // back targets the TOP modal only
  try { top.close(); } catch (e) { console.error('modal back-close error', e); }
  // Keep the ticket when the callback vetoes closing (for example, while Move/Copy is busy).
  // Normal close callbacks unmount their modal and unregister this entry during the update.
  if (stack.length > 0) pushDummy();
}

function ensureListener() {
  if (listenerAttached || typeof window === 'undefined') return;
  listenerAttached = true;
  window.addEventListener('popstate', onPopState);
}

export function registerModalBackClose(close: () => void): Entry {
  if (typeof window !== 'undefined') {
    if (stack.length === 0) pushDummy();        // first modal opens -> arm the dummy
    ensureListener();
  }
  const entry: Entry = { close };
  stack.push(entry);
  return entry;
}

export function unregisterModalBackClose(entry: Entry) {
  const idx = stack.indexOf(entry);
  if (idx === -1) return;                        // already popped by a back press
  stack.splice(idx, 1);
  if (stack.length === 0 && typeof window !== 'undefined') {
    // Last modal closed via button/backdrop. DEFER consuming the dummy so a React
    // strict-mode remount (re-registers synchronously) cancels it. If nothing re-registers,
    // consume it to keep the history stack clean.
    setTimeout(() => {
      if (stack.length === 0 && isArmed()) {
        try { window.history.back(); } catch { /* ignore */ }
      }
    }, 0);
  }
}
