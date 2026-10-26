'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSticker, StickerAsset } from '@/types/stickers';
import type { StickerAssetStore } from './useWorkspaceStickers';

export function useStickerAsset(store: StickerAssetStore, sticker: WorkspaceSticker | undefined) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [visible,setVisible] = useState(false);
  const [attempt,setAttempt] = useState(0);
  const [state,setState] = useState<{ key: string; asset?: StickerAsset; error?: string }>({ key:'' });
  const key = sticker ? store.userId + ':' + store.workspaceId + ':' + sticker.id + ':' + sticker.iv : '';
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      let cancelled = false;
      queueMicrotask(() => { if (!cancelled) setVisible(true); });
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver(entries => {
      const showing = entries.some(entry => entry.isIntersecting);
      setVisible(showing);
      if (!showing) setState({ key });
    },{ rootMargin:'80px' });
    observer.observe(element);
    return () => observer.disconnect();
  },[key]);
  useEffect(() => {
    if (!visible || !sticker || sticker.status !== 'ready') return;
    let cancelled = false;
    const release = store.retain(sticker);
    const changed = () => {
      if (!cancelled) setState(before => ({ ...before,key,asset:store.peek(sticker) }));
    };
    const unsubscribe = store.subscribe(changed);
    const cached = store.peek(sticker);
    void (cached ? Promise.resolve(cached) : store.request(sticker)).then(asset => {
        if (!cancelled) setState({ key,asset });
      }).catch(error => {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) setState({ key,error:"Couldn't load sticker" });
      });
    return () => { cancelled = true; unsubscribe(); release(); };
  },[visible,sticker,store,key,attempt]);
  return {
    elementRef,asset:visible && state.key === key && sticker?.status === 'ready' ? state.asset : undefined,
    error:state.key === key ? state.error : undefined,retry:() => { if (sticker) store.invalidate(sticker); setState({ key }); setAttempt(value => value+1); },
  };
}
