'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// Full-screen image viewer. A near-black overlay at the app's top layer (z-[999]) with the
// image centered at its largest clean size. Portaled to <body> so it layers above any
// modal (the preview modals sit at z-50) regardless of transformed ancestors
// (framer-motion cards). Exits: the ✕ button, the Escape key, or a backdrop click — the
// same three ways every other modal in the app closes. Pure display: it only ever receives
// the already-decrypted src string the visible <img> was showing.
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const image = imageRef.current;
    if (!overlay || !image) return;

    type Point = { x: number; y: number };
    type Finger = Point & { id: number };
    const view = { scale: 1, x: 0, y: 0 };
    let fitWidth = 0, fitHeight = 0, width = 0, height = 0, centerX = 0, centerY = 0;
    let mouse: { id: number; start: Point; last: Point; moved: boolean } | null = null;
    let touch: { start: Point; time: number; target: EventTarget | null; moved: boolean; multi: boolean } | null = null;
    let fingers: Finger[] = [];
    let lastTap: (Point & { time: number }) | null = null;
    let suppressClick = false;
    let lastMouseDrag = false;
    let touchUntil = 0;
    const threshold = 6;
    const isButton = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest("button");

    // The model is synchronous: fast native events never read a stale React render.
    const paint = () => {
      const canPan = view.scale > 1 && (fitWidth * view.scale > width || fitHeight * view.scale > height);
      const dragging = mouse?.moved || touch?.moved || touch?.multi;
      image.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
      overlay.style.cursor = canPan ? (dragging ? "grabbing" : "grab") : "";
    };
    const apply = (scale: number, x: number, y: number) => {
      if (![scale, x, y].every(Number.isFinite)) return;
      view.scale = Math.min(5, Math.max(1, scale));
      const boundX = Math.max(0, (fitWidth * view.scale - width) / 2);
      const boundY = Math.max(0, (fitHeight * view.scale - height) / 2);
      view.x = view.scale === 1 ? 0 : Math.max(-boundX, Math.min(boundX, x));
      view.y = view.scale === 1 ? 0 : Math.max(-boundY, Math.min(boundY, y));
      paint();
    };
    const measure = () => {
      const viewport = overlay.getBoundingClientRect();
      const rect = image.getBoundingClientRect();
      width = viewport.width;
      height = viewport.height;
      centerX = viewport.left + width / 2;
      centerY = viewport.top + height / 2;
      fitWidth = rect.width / view.scale;
      fitHeight = rect.height / view.scale;
      apply(view.scale, view.x, view.y);
    };
    // Image point q = (oldAnchor - center - translation) / oldScale.
    const zoom = (scale: number, oldAnchor: Point, newAnchor = oldAnchor) => {
      if (fitWidth <= 0 || fitHeight <= 0 || !Number.isFinite(scale)) return;
      const nextScale = Math.min(5, Math.max(1, scale));
      const ratio = nextScale / view.scale;
      apply(nextScale,
        newAnchor.x - centerX - (oldAnchor.x - centerX - view.x) * ratio,
        newAnchor.y - centerY - (oldAnchor.y - centerY - view.y) * ratio);
    };
    const toggle = (point: Point) => {
      if (view.scale > 1) apply(1, 0, 0);
      else zoom(2.5, point);
    };
    const pointOf = (event: { clientX: number; clientY: number }): Point =>
      ({ x: event.clientX, y: event.clientY });
    const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    const readFingers = (event: TouchEvent): Finger[] =>
      Array.from(event.touches, finger => ({ id: finger.identifier, ...pointOf(finger) }))
        .sort((a, b) => a.id - b.id);
    const midpoint = (pair: Finger[]): Point =>
      ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
      const delta = event.deltaY * unit;
      if (!Number.isFinite(delta)) return;
      // Includes ctrlKey trackpad pinch; cancel browser page zoom over the viewer.
      zoom(view.scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), pointOf(event));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0 || isButton(event.target)) return;
      suppressClick = false;
      lastMouseDrag = false;
      touchUntil = 0;
      lastTap = null;
      const point = pointOf(event);
      mouse = { id: event.pointerId, start: point, last: point, moved: false };
    };
    const moveMouse = (event: PointerEvent) => {
      if (!mouse || mouse.id !== event.pointerId) return;
      const point = pointOf(event);
      if (distance(point, mouse.start) > threshold) mouse.moved = true;
      if (mouse.moved) {
        if (view.scale > 1) apply(view.scale, view.x + point.x - mouse.last.x, view.y + point.y - mouse.last.y);
        mouse.last = point;
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!mouse || mouse.id !== event.pointerId) return;
      if (!(event.buttons & 1)) {
        suppressClick = mouse.moved;
        lastMouseDrag = mouse.moved;
        mouse = null;
        paint();
        return;
      }
      moveMouse(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!mouse || mouse.id !== event.pointerId) return;
      moveMouse(event);
      suppressClick = mouse.moved;
      lastMouseDrag = mouse.moved;
      mouse = null;
      paint();
    };
    const cancel = () => {
      mouse = null;
      touch = null;
      fingers = [];
      lastTap = null;
      suppressClick = true;
      lastMouseDrag = true;
      paint();
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (event.target !== image || mouse || lastMouseDrag || Date.now() < touchUntil) return;
      event.preventDefault();
      toggle(pointOf(event));
    };
    const onClickCapture = (event: MouseEvent) => {
      if (isButton(event.target)) return;
      if (suppressClick || (event.detail > 0 && Date.now() < touchUntil)) {
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      if (!touch && isButton(event.target)) return;
      event.preventDefault();
      touchUntil = Date.now() + 700;
      mouse = null;
      const next = readFingers(event);
      if (!next.length) return;
      if (!touch) {
        touch = { start: next[0], time: Date.now(), target: event.target, moved: false, multi: next.length > 1 };
      } else {
        touch.multi = true;
      }
      if (next.length > 1) {
        touch.multi = true;
        lastTap = null;
      }
      fingers = next;
      paint();
    };
    const onTouchMove = (event: TouchEvent) => {
      event.preventDefault();
      if (!touch) return;
      touchUntil = Date.now() + 700;
      const next = readFingers(event);
      if (next.length > 1) {
        touch.multi = true;
        lastTap = null;
        if (fingers.length > 1 && next[0].id === fingers[0].id && next[1].id === fingers[1].id) {
          const before = distance(fingers[0], fingers[1]);
          const after = distance(next[0], next[1]);
          if (before > 0 && after > 0) zoom(view.scale * after / before, midpoint(fingers), midpoint(next));
        }
      } else if (next.length === 1 && fingers.length === 1 && next[0].id === fingers[0].id) {
        if (distance(next[0], touch.start) > threshold) {
          touch.moved = true;
          lastTap = null;
        }
        if ((touch.moved || touch.multi) && view.scale > 1) {
          apply(view.scale, view.x + next[0].x - fingers[0].x, view.y + next[0].y - fingers[0].y);
        }
        // Keep the first position until the drag threshold is crossed.
        if (!touch.moved && !touch.multi) return;
      }
      fingers = next;
      paint();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!touch) return; // Close-button taps retain their existing native click.
      event.preventDefault();
      const now = Date.now();
      touchUntil = now + 700;
      const next = readFingers(event);
      if (next.length) {
        touch.multi = true; // Rebase pinch -> single-finger pan; never classify as a tap.
        fingers = next;
        paint();
        return;
      }
      const session = touch;
      const endpoint = Array.from(event.changedTouches).find(finger => finger.identifier === fingers[0]?.id);
      const point = endpoint ? pointOf(endpoint) : fingers[0] ?? session.start;
      if (distance(point, session.start) > threshold) session.moved = true;
      touch = null;
      fingers = [];
      paint();
      if (session.multi || session.moved) {
        lastTap = null;
        return;
      }
      if (session.target === overlay) {
        lastTap = null;
        suppressClick = false;
        overlay.click(); // Reuse the byte-identical backdrop target guard after preventing touch defaults.
      } else if (session.target === image && now - session.time <= 250) {
        if (lastTap && now - lastTap.time <= 300 && distance(point, lastTap) <= 24) {
          lastTap = null;
          toggle(point);
        } else {
          lastTap = { ...point, time: now };
        }
      } else {
        lastTap = null;
      }
    };
    const onTouchCancel = (event: TouchEvent) => {
      event.preventDefault();
      touchUntil = Date.now() + 700;
      cancel();
    };
    const onDragStart = (event: DragEvent) => event.preventDefault();

    // Identity first: remeasure the existing CSS fit before the first paint or a src replacement.
    paint();
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(overlay);
    observer?.observe(image);
    const viewport = window.visualViewport;
    overlay.addEventListener("wheel", onWheel, { passive: false });
    overlay.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", cancel);
    overlay.addEventListener("dblclick", onDoubleClick);
    overlay.addEventListener("click", onClickCapture, { capture: true });
    overlay.addEventListener("touchstart", onTouchStart, { passive: false });
    overlay.addEventListener("touchmove", onTouchMove, { passive: false });
    overlay.addEventListener("touchend", onTouchEnd, { passive: false });
    overlay.addEventListener("touchcancel", onTouchCancel, { passive: false });
    overlay.addEventListener("dragstart", onDragStart);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("blur", cancel);
    viewport?.addEventListener("resize", measure);
    image.addEventListener("load", measure);
    return () => {
      overlay.removeEventListener("wheel", onWheel);
      overlay.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", cancel);
      overlay.removeEventListener("dblclick", onDoubleClick);
      overlay.removeEventListener("click", onClickCapture, { capture: true });
      overlay.removeEventListener("touchstart", onTouchStart);
      overlay.removeEventListener("touchmove", onTouchMove);
      overlay.removeEventListener("touchend", onTouchEnd);
      overlay.removeEventListener("touchcancel", onTouchCancel);
      overlay.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("blur", cancel);
      viewport?.removeEventListener("resize", measure);
      image.removeEventListener("load", measure);
      observer?.disconnect();
      mouse = null;
      touch = null;
    };
  }, [src]);

  return createPortal(
    <div
      ref={overlayRef}
      data-lenis-prevent
      className="fixed inset-0 z-[999] bg-black/90 flex items-center justify-center p-4 overflow-hidden select-none"
      style={{ touchAction: "none", overscrollBehavior: "none" }}
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
      {/* eslint-disable-next-line @next/next/no-img-element -- Display the existing decrypted in-memory src without an optimization request. */}
      <img ref={imageRef} src={src} alt={alt} draggable={false} className="max-w-full max-h-full object-contain" style={{ transformOrigin: "center" }} />
    </div>,
    document.body
  );
}
