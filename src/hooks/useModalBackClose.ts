'use client';

import { useEffect, useRef } from 'react';
import { registerModalBackClose, unregisterModalBackClose } from '@/lib/modalBackClose';

// open = true while the modal is open. Inside a conditionally-rendered modal component, pass
// `true`. For an always-mounted/inline modal, pass the real open flag. onClose = the same
// handler the X/backdrop use; for modals that block closing mid-action, guard it the same way.
export function useModalBackClose(open: boolean, onClose: () => void, enabled = true) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open || !enabled) return;
    const entry = registerModalBackClose(() => onCloseRef.current());
    return () => unregisterModalBackClose(entry);
  }, [open, enabled]);
}
