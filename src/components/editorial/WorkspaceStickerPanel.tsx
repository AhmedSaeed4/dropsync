'use client';

/* eslint-disable @next/next/no-img-element -- Display original decrypted WebP/GIF assets without optimization. */
import { useCallback, useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceSticker, StickerAsset } from '@/types/stickers';
import type { WorkspaceStickers } from '@/hooks/useWorkspaceStickers';
import { useStickerAsset } from '@/hooks/useStickerAsset';
import { saveStickerFile } from '@/lib/stickers';
import { Toast } from '../Toast';
import { getEditorialThemeColors } from './editorialTheme';

export type StickerCloseReason = 'escape' | 'button' | 'outside' | 'sent' | 'context';
interface Props {
  id: string; open: boolean; isPhone: boolean; theme: 'light' | 'dark' | 'minimal';
  userId: string; ownerId?: string | null; catalog: WorkspaceStickers; sending: boolean;
  anchorRef: RefObject<HTMLDivElement | null>; triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: (reason: StickerCloseReason) => void; onSend: (sticker: WorkspaceSticker) => Promise<void>;
}
interface TileProps {
  sticker: WorkspaceSticker; catalog: WorkspaceStickers; sending: boolean; theme: Props['theme'];
  onSend: () => void; onActions: () => void;
  onPress: (event: ReactPointerEvent,sticker: WorkspaceSticker) => void;
}
function StickerTile({ sticker,catalog,sending,theme,onSend,onActions,onPress }: TileProps) {
  const tc = getEditorialThemeColors(theme);
  const { elementRef,asset,error:assetError,retry:retryAsset } = useStickerAsset(catalog.assets,sticker);
  const [failedUrl,setFailedUrl] = useState('');
  const failed = !!assetError || (!!asset && failedUrl === asset.url);
  return (
    <div ref={elementRef} className={'group relative h-20 min-w-0 '+tc.roundedClass}
      onPointerDown={event => { if (!(event.target as Element).closest('[data-sticker-action]')) onPress(event,sticker); }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onActions(); }}>
      <button type="button" aria-label={failed ? "Retry loading sticker" : "Send sticker"} disabled={sending}
        onClick={event => { event.stopPropagation(); if (failed) { setFailedUrl(''); retryAsset(); } else onSend(); }}
        className={'flex h-full w-full items-center justify-center p-2 disabled:opacity-40 '+tc.roundedClass+' hover:bg-[#1a1a1a]/5 transition-colors'}>
        {asset && !failed ? <img src={asset.url} alt="Sticker" draggable={false} onError={() => setFailedUrl(asset!.url)} className="h-full w-full object-contain select-none" />
          : failed ? <span className={'text-[10px] '+tc.muted}>Couldn&apos;t load sticker · Retry</span>
          : <span aria-label="Loading sticker" className={'h-4 w-4 animate-pulse rounded '+tc.activePillBg+' opacity-15'} />}
      </button>
      <button type="button" data-sticker-action aria-label="Sticker actions"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); onActions(); }}
        className={'absolute -right-1 -top-1 flex h-11 w-11 items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 '+tc.muted}>
        <span className={'flex h-6 w-6 items-center justify-center rounded border '+tc.cardBg+' '+tc.border}>
          <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </span>
      </button>
    </div>
  );
}

export function WorkspaceStickerPanel({ id,open,isPhone,theme,userId,ownerId,catalog,sending,anchorRef,triggerRef,onClose,onSend }: Props) {
  const tc = getEditorialThemeColors(theme);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [count,setCount] = useState(60);
  const [actionId,setActionId] = useState<string | null>(null);
  const [confirm,setConfirm] = useState(false);
  const [deleteNotice,setDeleteNotice] = useState<string | null>(null);
  const [download,setDownload] = useState<{ id: string; loading: boolean; asset?: StickerAsset; error?: string } | null>(null);
  const [layout,setLayout] = useState({ maxHeight:320,bottom:0 });
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; pointerId: number; x: number; y: number } | null>(null);
  const suppressClick = useRef<string | null>(null);
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadEpoch = useRef(0);
  const releaseDownload = useRef<(() => void) | null>(null);
  const cancelDownload = useCallback(() => {
    downloadEpoch.current++;
    releaseDownload.current?.(); releaseDownload.current = null;
  },[]);
  const selected = actionId ? catalog.byId.get(actionId) : undefined;
  const cancelPress = useCallback(() => { if (press.current) clearTimeout(press.current.timer); press.current = null; },[]);
  const closeActions = useCallback(() => {
    downloadEpoch.current++;
    releaseDownload.current?.(); releaseDownload.current = null;
    setDownload(null); setConfirm(false); setActionId(null);
  },[]);
  const openActions = (sticker: WorkspaceSticker) => {
    cancelPress(); downloadEpoch.current++;
    releaseDownload.current?.(); releaseDownload.current = null;
    setDownload(null); setConfirm(false); setActionId(sticker.id);
  };
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const bottom = Math.max(0,window.innerHeight - ((viewport?.offsetTop ?? 0) + height));
      const anchor = anchorRef.current;
      const headerBottom = anchor?.parentElement?.firstElementChild?.getBoundingClientRect().bottom ?? 72;
      const room = Math.max(0,(anchor?.getBoundingClientRect().top ?? height) - headerBottom - 8);
      setLayout({ maxHeight:isPhone ? Math.max(0,Math.min(440,height - 72)) : Math.min(320,room),bottom });
    };
    const raf = requestAnimationFrame(() => {
      measure(); closeRef.current?.focus({ preventScroll:true });
      if (!cancelled) { setCount(60); setActionId(null); setConfirm(false); setDeleteNotice(null); setDownload(null); }
    });
    const resize = new ResizeObserver(measure);
    if (anchorRef.current) resize.observe(anchorRef.current);
    window.addEventListener('resize',measure);
    window.visualViewport?.addEventListener('resize',measure);
    window.visualViewport?.addEventListener('scroll',measure);
    return () => {
      cancelled = true; cancelAnimationFrame(raf); resize.disconnect();
      window.removeEventListener('resize',measure);
      window.visualViewport?.removeEventListener('resize',measure);
      window.visualViewport?.removeEventListener('scroll',measure);
      cancelDownload();
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
      if (suppressTimer.current) clearTimeout(suppressTimer.current);
      suppressClick.current = null;
    };
  },[open,isPhone,anchorRef,catalog.assets,cancelDownload]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (press.current && press.current.pointerId !== event.pointerId) cancelPress();
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) onClose('outside');
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (confirm) setConfirm(false);
        else if (actionId) closeActions();
        else onClose('escape');
      }
      if (isPhone && event.key === 'Tab') {
        const region = panelRef.current?.querySelector<HTMLElement>('[data-sticker-submenu]') ?? panelRef.current;
        const controls = region?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex="0"]');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length-1];
        if (!Array.from(controls).includes(document.activeElement as HTMLElement)) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const scroll = () => cancelPress();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',keys,true);
    document.addEventListener('scroll',scroll,true);
    return () => {
      document.removeEventListener('pointerdown',outside,true);
      document.removeEventListener('keydown',keys,true);
      document.removeEventListener('scroll',scroll,true);
    };
  },[open,isPhone,confirm,actionId,onClose,triggerRef,cancelPress,closeActions]);

  const adoptCleanups = catalog.adoptCleanups;
  useEffect(() => {
    adoptCleanups(ownerId);
  },[catalog.records,adoptCleanups,ownerId]);

  const beginPress = (event: ReactPointerEvent,sticker: WorkspaceSticker) => {
    cancelPress();
    if (!isPhone || !event.isPrimary || event.button !== 0) return;
    const pointerId = event.pointerId, x = event.clientX, y = event.clientY;
    const timer = setTimeout(() => {
      suppressClick.current = sticker.id;
      openActions(sticker);
    },500);
    press.current = { timer,pointerId,x,y };
  };
  const downloadSelected = async (sticker: WorkspaceSticker) => {
    const epoch = ++downloadEpoch.current;
    releaseDownload.current?.();
    releaseDownload.current = catalog.assets.retain(sticker);
    const cached = catalog.assets.peek(sticker);
    if (cached) { saveStickerFile(sticker,cached); setDownload({ id:sticker.id,loading:false,asset:cached }); return; }
    setDownload({ id:sticker.id,loading:true });
    try {
      const asset = await catalog.assets.request(sticker);
      if (downloadEpoch.current === epoch) setDownload({ id:sticker.id,loading:false,asset });
    } catch {
      if (downloadEpoch.current === epoch) setDownload({ id:sticker.id,loading:false,error:"Couldn't load sticker" });
    }
  };
  const deleteSelected = async (sticker: WorkspaceSticker) => {
    try {
      await catalog.remove(sticker,{ showCard:!isPhone });
    } catch {
      setDeleteNotice("Couldn't delete sticker. Try again.");
    }
  };
  if (!open || typeof document === 'undefined') return null;
  const compact = 'inline-flex shrink-0 items-center justify-center whitespace-nowrap text-xs '+tc.fontClass+' '+tc.roundedClass;
  const compactSize = isPhone ? ' min-h-11 px-3 py-2' : ' px-3 py-1.5';
  const quiet = compact+' border '+tc.border+' '+tc.text+' hover:bg-[#1a1a1a]/5 transition-colors'+compactSize;
  const quietDanger = compact+' border '+tc.border+' text-red-500 hover:bg-[#1a1a1a]/5 transition-colors'+compactSize;
  const primary = compact+' border border-transparent font-medium '+tc.activePillBg+' '+tc.activePillText+' hover:opacity-90 disabled:opacity-40 transition-opacity'+compactSize;
  const iconButton = 'inline-flex shrink-0 items-center justify-center border '+tc.border+' '+tc.text+' hover:bg-[#1a1a1a]/5 transition-colors '+tc.roundedClass+' '+(isPhone ? 'h-11 w-11' : 'h-7 w-7');
  const menuRow = 'flex w-full items-center gap-2 px-3 py-2 text-left text-xs '+tc.fontClass+' '+tc.text+' hover:bg-[#1a1a1a]/5 transition-colors'+(isPhone ? ' min-h-11' : '');
  const menuDanger = 'flex w-full items-center gap-2 px-3 py-2 text-left text-xs '+tc.fontClass+' text-red-500 hover:bg-[#1a1a1a]/5 transition-colors'+(isPhone ? ' min-h-11' : '');
  const importTotal = catalog.items.length;
  const importFailed = catalog.items.filter(item => item.phase === 'error');
  const importSettled = catalog.items.filter(item => item.phase === 'added' || item.phase === 'error').length;
  const importActiveRatio = catalog.items.find(item => item.phase === 'uploading')?.ratio
    ?? (catalog.items.some(item => item.phase === 'finishing') ? 1 : 0);
  const importPercent = importTotal > 0
    ? Math.min(100,Math.max(0,Math.round(((importSettled + importActiveRatio) / importTotal) * 100)))
    : 0;
  const body = (
    <section id={id} ref={panelRef} role="dialog" aria-modal={isPhone || undefined} aria-labelledby={id+'-title'}
      data-lenis-prevent
      className={(isPhone ? 'fixed left-0 right-0 z-[211] rounded-t-2xl' : 'absolute bottom-full left-4 z-[60] mb-2 w-[360px] '+tc.roundedClass)
        +' flex flex-col overflow-hidden border '+tc.border+' '+tc.cardBg+' '+tc.text+' '+tc.fontClass}
      style={{ maxHeight:layout.maxHeight,maxWidth:isPhone ? undefined : 'calc(100% - 32px)',bottom:isPhone ? layout.bottom : undefined,touchAction:'pan-y',
        paddingTop:isPhone ? 'env(safe-area-inset-top)' : undefined,paddingBottom:isPhone ? 'max(8px,env(safe-area-inset-bottom))' : 8 }}
      onClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onPointerMove={event => { if (press.current && Math.hypot(event.clientX-press.current.x,event.clientY-press.current.y)>8) cancelPress(); }}
      onPointerCancel={cancelPress}
      onPointerUp={() => {
        cancelPress();
        if (suppressClick.current) {
          if (suppressTimer.current) clearTimeout(suppressTimer.current);
          suppressTimer.current = setTimeout(() => { suppressClick.current = null; },250);
        }
      }}>
      <div className={'flex shrink-0 items-center gap-1.5 border-b px-2 py-1 '+tc.border}>
        <h4 id={id+'-title'} className="min-w-0 flex-1 px-2 text-sm font-semibold">Stickers</h4>
        <button type="button" className={primary} disabled={catalog.busy || !!catalog.error}
          onClick={() => inputRef.current?.click()}>Add stickers</button>
        <button ref={closeRef} type="button" aria-label="Close stickers" className={iconButton} onClick={() => onClose('button')}>
          <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <input ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
        onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; if (files.length) void catalog.addFiles(files,{ showCard:!isPhone }); }} />
      <div className="min-h-0 overflow-y-auto overscroll-contain p-3" style={{ touchAction:'pan-y' }}>
        {catalog.loading ? <>
          <p className={'mb-2 text-xs '+tc.muted}>Loading stickers…</p>
          <div className="grid grid-cols-4 gap-2" aria-hidden="true">
            {Array.from({ length:8 },(_,index) => <div key={index} className={'h-20 animate-pulse rounded '+tc.activePillBg+' opacity-10'} />)}
          </div>
        </> : catalog.error ? <div className="py-5 text-center text-sm">
          <p>Couldn&apos;t load stickers</p><button type="button" className={quiet+' mt-2'} onClick={catalog.retry}>Retry</button>
        </div> : <>
          {!catalog.ready.length && <p className={'py-4 text-center text-sm '+tc.muted}>No stickers yet — add the first one</p>}
          <div className="grid gap-2" style={{
            gridTemplateColumns:catalog.ready.length ? 'repeat(auto-fill,minmax(64px,1fr))' : '80px',
            justifyContent:catalog.ready.length ? undefined : 'center',
          }}>
            <button type="button" className={'flex h-20 flex-col items-center justify-center border border-dashed text-xs '+tc.border+' '+tc.roundedClass+' hover:bg-[#1a1a1a]/5 transition-colors'}
              disabled={catalog.busy} onClick={() => inputRef.current?.click()} aria-label="Add stickers">
              <span className="text-2xl">+</span><span>Add</span>
            </button>
            {catalog.ready.slice(0,count).map(sticker => <StickerTile key={sticker.id} sticker={sticker} catalog={catalog}
              sending={sending} theme={theme} onPress={beginPress} onActions={() => openActions(sticker)}
              onSend={() => {
                if (suppressClick.current === sticker.id) { suppressClick.current = null; return; }
                void onSend(sticker);
              }} />)}
          </div>
          {catalog.ready.length > count && <button type="button" className={quiet+' mt-2 w-full'} onClick={() => setCount(value => value+60)}>Show more</button>}
        </>}
        {isPhone && catalog.busy && importTotal > 0 && (
          <p role="status" className={'mt-2 text-xs '+tc.muted}>
            Importing {importTotal} {importTotal === 1 ? 'sticker' : 'stickers'} — {importPercent}%
          </p>
        )}
        {isPhone && importFailed.length > 0 && (
          <p role="status" className="mt-2 break-words text-xs text-red-500">
            {importFailed.map(item => item.error).filter((error): error is string => !!error).join(' · ')}
          </p>
        )}
      </div>
      {selected && <div className={(confirm ? 'z-[213] ' : 'z-[212] ')+'absolute inset-0 flex flex-col justify-end '+tc.cardBg} role="group" aria-label="Sticker actions" data-sticker-submenu>
        <div className="min-h-0 overflow-y-auto">
          {confirm ? <div className="p-3">
            <p className="text-sm font-semibold">Delete this sticker from the workspace?</p>
            <p className={'mt-2 text-xs '+tc.muted}>Everyone will lose it from this collection. Old messages will show ‘Sticker unavailable’.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className={quiet} onClick={() => setConfirm(false)}>Cancel</button>
              <button type="button" className={quietDanger} onClick={() => { closeActions(); void deleteSelected(selected); }}>Delete</button>
            </div>
          </div> : <>
            <p className={'px-3 pb-2 pt-3 text-sm font-semibold '+tc.text}>Sticker actions</p>
            <div className="py-1">
              {download?.id === selected.id && download.loading ? <p role="status" className={'px-3 py-2 text-xs '+tc.muted}>Preparing download…</p>
                : download?.id === selected.id && download.asset ? <button type="button" className={menuRow} onClick={() => saveStickerFile(selected,download.asset!)}>
                    <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14" />
                    </svg>
                    Save file
                  </button>
                : <button type="button" className={menuRow} onClick={() => void downloadSelected(selected)}>
                    <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14" />
                    </svg>
                    Download
                  </button>}
              {download?.error && <p className={'px-3 pb-2 text-xs '+tc.muted} role="status">{download.error}</p>}
            </div>
            {(selected.uploaderId === userId || ownerId === userId)
              && <div className={'border-t '+tc.border+' pt-1'}>
                <button type="button" className={menuDanger} onClick={() => setConfirm(true)}>
                  <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                  Delete
                </button>
              </div>}
            <div className={'border-t '+tc.border+' pt-1'}>
              <button type="button" className={menuRow} onClick={closeActions}>
                <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Cancel
              </button>
            </div>
          </>}
        </div>
      </div>}
    </section>
  );
  const notice = deleteNotice ? <Toast message={deleteNotice} duration={4} theme={theme} editorial mobileFloat={isPhone}
    onDone={() => setDeleteNotice(null)} /> : null;
  return isPhone ? createPortal(<>
    <div className="fixed inset-0 z-[210] bg-black/30" onPointerDown={event => { event.stopPropagation(); onClose('outside'); }} />
    {body}
    {notice}
  </>,document.body) : <>
    {body}
    {notice}
  </>;
}
