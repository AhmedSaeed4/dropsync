'use client';

/* eslint-disable @next/next/no-img-element -- Native img preserves original decrypted animation bytes. */
import { useState } from 'react';
import type { GroupChatMessage } from '@/types';
import type { WorkspaceSticker } from '@/types/stickers';
import type { StickerAssetStore } from '@/hooks/useWorkspaceStickers';
import { useStickerAsset } from '@/hooks/useStickerAsset';
import { getEditorialThemeColors } from './editorialTheme';

interface StickerMessageProps {
  message: GroupChatMessage;
  sticker?: WorkspaceSticker;
  assets: StickerAssetStore;
  isPhone: boolean;
  theme: 'light' | 'dark' | 'minimal';
  loading?: boolean;
}
export function StickerMessage({ message,sticker,assets,isPhone,theme,loading }: StickerMessageProps) {
  const tc = getEditorialThemeColors(theme);
  const { elementRef,asset,error:assetError,retry:retryAsset } = useStickerAsset(assets,sticker?.status === 'ready' ? sticker : undefined);
  const [failedUrl,setFailedUrl] = useState('');
  const valid = Number.isSafeInteger(message.stickerWidth) && (message.stickerWidth ?? 0) > 0
    && Number.isSafeInteger(message.stickerHeight) && (message.stickerHeight ?? 0) > 0;
  const width = valid ? message.stickerWidth! : 160;
  const height = valid ? message.stickerHeight! : 160;
  const bound = isPhone ? 176 : 200;
  const scale = Math.min(1,bound/width,bound/height);
  const unavailable = !loading && (!sticker || sticker.status !== 'ready');
  const error = assetError || (!!asset && failedUrl === asset.url);
  return (
    <div ref={elementRef} className="relative max-w-full" style={{ width:width*scale,aspectRatio:width+'/'+height }}>
      {asset && !unavailable && !error ? (
        <img src={asset.url} alt="Sticker" draggable={false}
          onError={() => setFailedUrl(asset!.url)}
          className="absolute inset-0 h-full w-full object-contain select-none" />
      ) : (
        <div className={'absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-xs '+tc.fontClass+' '+tc.muted}>
          {unavailable ? <span>Sticker unavailable</span> : error ? <>
            <span>Couldn&apos;t load sticker</span>
            <button type="button" className={'min-h-11 px-3 underline '+tc.text}
              onClick={event => { event.stopPropagation(); setFailedUrl(''); retryAsset(); }}>Retry</button>
          </> : <>
            <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border border-current border-t-transparent" />
            <span>Loading sticker…</span>
          </>}
        </div>
      )}
    </div>
  );
}
