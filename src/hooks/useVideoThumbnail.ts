'use client';

import { useState, useEffect } from 'react';

export function useVideoThumbnail(fileData: string | null, mimeType?: string): { thumbnailUrl: string | null; isGenerating: boolean } {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (!fileData || !mimeType?.startsWith('video/')) {
      setThumbnailUrl(null);
      setIsGenerating(false);
      return;
    }

    let cancelled = false;
    let blobUrl: string | null = null;

    setIsGenerating(true);

    const generate = async () => {
      try {
        // Convert data URL to blob URL for the video element
        const res = await fetch(fileData);
        const blob = await res.blob();
        if (cancelled) return;

        blobUrl = URL.createObjectURL(blob);

        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;

        const loaded = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timeout')), 8000);
          video.onloadeddata = () => { clearTimeout(timeout); resolve(); };
          video.onerror = () => { clearTimeout(timeout); reject(new Error('video load error')); };
        });

        video.src = blobUrl;
        await loaded;
        if (cancelled) return;

        // Seek to 1 second (or 0 for very short videos)
        video.currentTime = Math.min(1, video.duration * 0.1);

        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
        });
        if (cancelled) return;

        // Draw frame to canvas
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 160;
        canvas.height = video.videoHeight || 90;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const thumbnail = canvas.toDataURL('image/jpeg', 0.6);

        if (!cancelled) {
          setThumbnailUrl(thumbnail);
          setIsGenerating(false);
        }
      } catch {
        if (!cancelled) {
          setThumbnailUrl(null);
          setIsGenerating(false);
        }
      } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    };

    generate();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [fileData, mimeType]);

  return { thumbnailUrl, isGenerating };
}
