'use client';

// useCallPreview — thin camera+mic preview hook for the CREATE-DROP modal's Call mode (NOT the mesh).
// Acquires the local stream on mount so the host sees themselves before pressing Start. On Start,
// handoffStream() detaches ownership (releaseOwnership) so the modal's unmount cleanup does NOT stop
// the tracks — useCallMesh.adoptStream takes them over and the call keeps the same camera/mic live
// (no blink). Never relies on React mount/unmount timing for media ownership (§9).

import { useEffect, useState } from 'react';
import { useCallMedia } from './useCallMedia';

export function useCallPreview(enabled = true) {
  const media = useCallMedia();
  const [acquiring, setAcquiring] = useState(false);

  // Acquire once on mount. The 3 guards (startingRef / unmount-cleanup / AbortController) live in
  // useCallMedia; here we just trigger + track the "acquiring" spinner state.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setAcquiring(true);
    media
      .acquire()
      .finally(() => {
        if (!cancelled) setAcquiring(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  /**
   * Hand the preview stream to the mesh. Returns the stream object AND detaches ownership here so
   * this hook's unmount cleanup (which fires when the modal closes) won't stop the tracks. The
   * caller passes the returned stream straight to useCallMesh.adoptStream.
   */
  const handoffStream = (): MediaStream | null => {
    const s = media.stream;
    if (s) media.releaseOwnership();
    return s;
  };

  return {
    stream: media.stream,
    error: media.error,
    acquiring,
    cameraAvailable: media.cameraAvailable,
    handoffStream,
  };
}
