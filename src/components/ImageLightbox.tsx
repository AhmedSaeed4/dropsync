'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// Full-screen image viewer. A near-black overlay at the app's top layer (z-[999]) with the
// image centered at its largest clean size. Portaled to <body> so it layers above any
// modal (the preview modals sit at z-50) regardless of transformed ancestors
// (framer-motion cards). Exits: the ✕ button, the Escape key, or a backdrop click — the
// same three ways every other modal in the app closes. Pure display: it only ever receives
// the already-decrypted src string the visible <img> was showing.
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[999] bg-black/90 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Exit full screen"
        title="Exit full screen (Esc)"
        className="absolute top-4 right-4 z-10 w-10 h-10 flex items-center justify-center text-white/70 hover:text-white transition-colors"
      >
        <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <img src={src} alt={alt} className="max-w-full max-h-full object-contain" />
    </div>,
    document.body
  );
}
