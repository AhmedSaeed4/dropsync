'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getArchiveTaskManager } from '@/lib/archiveTaskManager';
import { ArchiveProgressChip } from './ArchiveProgressChip';

export function ArchiveChipStack({ editorial, callPill, onOpen }: {
  editorial: boolean; callPill: boolean; onOpen: (jobId: string, showAll?: boolean) => void;
}) {
  const manager = getArchiveTaskManager();
  const store = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const container = useRef<HTMLDivElement | null>(null);
  const [phone, setPhone] = useState(false);
  const [short, setShort] = useState(false);
  const [contrasts, setContrasts] = useState<boolean[]>([]);
  const settled = useMemo(() => store.settled.filter((item) => !item.dismissed).sort((a, b) => a.settledAt - b.settledAt), [store.settled]);
  const maxRows = short ? 1 : phone ? 2 : 3;
  const visibleSettled = settled.slice(-Math.max(0, maxRows - (store.active ? 1 : 0)));
  const rows = [...visibleSettled, ...(store.active ? [store.active] : [])];
  const overflowCount = Math.max(0, settled.length - visibleSettled.length);

  useEffect(() => {
    const updateViewport = () => {
      const isPhone = window.matchMedia('(max-width: 639px)').matches;
      setPhone(isPhone);
      setShort(window.visualViewport?.height ? window.visualViewport.height < (isPhone ? 360 : 330) : window.innerHeight < (isPhone ? 360 : 330));
    };
    updateViewport();
    window.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
    return () => { window.removeEventListener('resize', updateViewport); window.visualViewport?.removeEventListener('resize', updateViewport); };
  }, []);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = container.current;
        if (!element || rows.length === 0) {
          document.body.style.removeProperty('--archive-stack-clearance');
          setContrasts([]);
          return;
        }
        const rect = element.getBoundingClientRect();
        document.body.style.setProperty('--archive-stack-clearance', `${Math.ceil(window.innerHeight - rect.top + 12)}px`);
        const footer = document.getElementById('footer-shell')?.getBoundingClientRect();
        setContrasts(Array.from(element.querySelectorAll('.archive-chip-row')).map((row) => {
          const box = row.getBoundingClientRect();
          return !!footer && box.left < footer.right && box.right > footer.left && box.top < footer.bottom && box.bottom > footer.top;
        }));
      });
    };
    measure();
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    if (container.current) observer.observe(container.current);
    const footer = document.getElementById('footer-shell');
    if (footer) observer.observe(footer);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer.disconnect();
      document.body.style.removeProperty('--archive-stack-clearance');
    };
  }, [rows.length, phone, editorial, callPill]);

  if (rows.length === 0) return null;
  const bottom = phone
    ? editorial ? 'calc(100px + env(safe-area-inset-bottom))' : 'calc(20px + env(safe-area-inset-bottom))'
    : callPill ? '78px' : '24px';
  return (
    <div ref={container} className="fixed right-6 max-[639px]:right-[14px] z-[60] flex flex-col gap-2" style={{ bottom }}>
      {rows.map((item, index) => <ArchiveProgressChip key={item.jobId} item={item}
        contrast={contrasts[index] || false}
        overflowCount={index === 0 ? overflowCount : 0}
        onOpen={() => onOpen(item.jobId)}
        onOverflow={() => onOpen(item.jobId, true)}
        onCancel={() => manager.requestCancel(item.jobId)}
        onDismiss={() => manager.dismissVerifiedError(item.jobId)} />)}
    </div>
  );
}
