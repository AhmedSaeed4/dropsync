import type { Timestamp } from 'firebase/firestore';

export const STICKER_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type StickerMimeType = typeof STICKER_MIME_TYPES[number];
export const MAX_STICKER_BYTES = 10 * 1024 * 1024;
export const MAX_STICKER_CIPHERTEXT_BYTES = 20 * 1024 * 1024;
export const STICKER_UPLOAD_SECONDS = 300;
export const STICKER_RETIRE_MARGIN_MS = 60_000;

export interface StickerEnvelope {
  kind: 'sticker';
  stickerId: string;
  stickerWidth: number;
  stickerHeight: number;
}

export interface StickerRecord {
  uploaderId: string;
  createdAt: Timestamp;
  mimeType: StickerMimeType;
  byteSize: number;
  width: number;
  height: number;
  encrypted: true;
  iv: string;
  ciphertextBytes: number;
  r2Key: string;
  status: 'uploading' | 'ready' | 'deleting';
  uploadLeaseUntil: Timestamp;
  reservationEtag?: string;
  prepareToken?: string;
}

export interface WorkspaceSticker extends Omit<StickerRecord, 'createdAt' | 'uploadLeaseUntil'> {
  id: string;
  createdAt: Date | null;
  uploadLeaseUntil: Date | null;
}

export interface StickerOperationResult {
  ok: boolean;
  status?: string;
  error?: string;
  url?: string;
  headers?: Record<string, string>;
  retryAfterMs?: number;
}

export interface StickerImportItem {
  id: string;
  name: string;
  phase: 'preparing' | 'uploading' | 'finishing' | 'added' | 'error';
  ratio: number;
  error?: string;
}

export interface StickerAsset {
  blob: Blob;
  url: string;
}
