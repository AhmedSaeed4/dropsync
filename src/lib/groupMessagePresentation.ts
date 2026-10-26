import type { GroupChatMessage } from '@/types';
import type { StickerEnvelope } from '@/types/stickers';

export function isStickerMessage(message: { kind?: unknown }): boolean {
  return message.kind === 'sticker';
}

// The kind, never the encrypted/inert body, decides every presentation surface.
export function groupMessagePreview(message: Pick<GroupChatMessage, 'kind' | 'content'>): string {
  return isStickerMessage(message) ? 'Sticker' : message.content;
}

export function hasStickerFields(data: Record<string, unknown>): boolean {
  return isStickerMessage(data)
    || ['stickerId', 'stickerWidth', 'stickerHeight'].some((field) => field in data);
}

export function readStickerEnvelope(data: Record<string, unknown>): Partial<StickerEnvelope> {
  if (!isStickerMessage(data)) return {};
  return {
    kind: 'sticker',
    ...(typeof data.stickerId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.stickerId)
      ? { stickerId: data.stickerId } : {}),
    ...(typeof data.stickerWidth === 'number' && Number.isSafeInteger(data.stickerWidth) && data.stickerWidth > 0
      ? { stickerWidth: data.stickerWidth } : {}),
    ...(typeof data.stickerHeight === 'number' && Number.isSafeInteger(data.stickerHeight) && data.stickerHeight > 0
      ? { stickerHeight: data.stickerHeight } : {}),
  };
}
