'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { failedStickerId, importWorkspaceSticker, loadStickerAsset, stickerOperation } from '@/lib/stickers';
import { startStickerImport, updateStickerImportProgress, stickerImportSucceeded, stickerImportFailed,
  settleStickerImport, dismissStickerImport, startStickerCleanup, markStickerCleanupRunning,
  markStickerCleanupPending, markStickerCleanupFailed, markStickerCleanupSucceeded,
  dismissStickerCleanup, clearStickerOperations } from '@/lib/stickerOperations';
import { MAX_STICKER_BYTES, MAX_STICKER_CIPHERTEXT_BYTES, STICKER_MIME_TYPES,
  type StickerAsset, type StickerImportItem, type WorkspaceSticker } from '@/types/stickers';

type AssetEntry = {
  sticker: WorkspaceSticker; refs: number; updated: number; asset?: StickerAsset;
  pending?: Promise<StickerAsset>; controller?: AbortController;
};
type Listener = () => void;

type CleanupJob = {
  stickerId: string;
  operationId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  dismissed: boolean;
  completed: boolean;
  cardActive: boolean;
  attempt: (rethrow: boolean) => Promise<void>;
};

// Matches useIsPhone's breakpoint without making this data hook subscribe to viewport state.
function cleanupCardsAllowed(): boolean {
  return typeof window !== 'undefined' && !window.matchMedia('(max-width: 767px)').matches;
}

// One store per authenticated group/workspace scope; nothing is retained across revocation.
export class StickerAssetStore {
  private entries = new Map<string, AssetEntry>();
  private listeners = new Set<Listener>();
  private waiting: (() => void)[] = [];
  private active = 0;
  private alive = false;
  private catalog = new Map<string, WorkspaceSticker>();
  constructor(readonly workspaceId: string, readonly userId: string) {}
  activate() { this.alive = true; }
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { this.listeners.forEach(listener => listener()); }
  private key(sticker: WorkspaceSticker) { return sticker.id + ':' + sticker.iv; }
  private valid(sticker: WorkspaceSticker) {
    const current = this.catalog.get(sticker.id);
    return this.alive && current?.status === 'ready' && current.iv === sticker.iv;
  }
  setCatalog(stickers: WorkspaceSticker[]) {
    this.catalog = new Map(stickers.map(sticker => [sticker.id,sticker]));
    for (const [key,entry] of this.entries) {
      if (!this.valid(entry.sticker)) {
        entry.controller?.abort();
        if (entry.asset) URL.revokeObjectURL(entry.asset.url);
        this.entries.delete(key);
      }
    }
    this.notify();
  }
  retain(sticker: WorkspaceSticker): () => void {
    const key = this.key(sticker);
    let entry = this.entries.get(key);
    if (!entry) { entry = { sticker,refs:0,updated:Date.now() }; this.entries.set(key,entry); }
    entry.refs++;
    return () => {
      const current = this.entries.get(key);
      if (current !== entry) return;
      current.refs = Math.max(0,current.refs - 1);
      current.updated = Date.now();
      if (current.refs === 0 && current.pending && !current.asset) {
        current.controller?.abort();
        this.entries.delete(key); // StrictMode's next retain must start a fresh request.
      } else if (current.refs === 0 && !current.asset && !current.pending) this.entries.delete(key);
      this.trim();
    };
  }
  peek(sticker: WorkspaceSticker): StickerAsset | undefined {
    return this.valid(sticker) ? this.entries.get(this.key(sticker))?.asset : undefined;
  }
  invalidate(sticker: WorkspaceSticker) {
    const entry = this.entries.get(this.key(sticker));
    if (!entry) return;
    entry.controller?.abort();
    if (entry.asset) URL.revokeObjectURL(entry.asset.url);
    entry.asset = undefined; entry.pending = undefined; entry.controller = undefined;
    this.notify();
  }
  private async slot(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Cancelled','AbortError');
    if (this.active < 3) { this.active++; return; }
    await new Promise<void>((resolve,reject) => {
      const run = () => { this.active++; signal.removeEventListener('abort',abort); resolve(); };
      const abort = () => {
        this.waiting = this.waiting.filter(item => item !== run);
        reject(new DOMException('Cancelled','AbortError'));
      };
      signal.addEventListener('abort',abort,{ once:true });
      this.waiting.push(run);
    });
    if (signal.aborted) {
      this.active--; this.waiting.shift()?.();
      throw new DOMException('Cancelled','AbortError');
    }
  }
  request(sticker: WorkspaceSticker): Promise<StickerAsset> {
    if (!this.valid(sticker)) return Promise.reject(new Error('Sticker unavailable'));
    const key = this.key(sticker);
    let entry = this.entries.get(key);
    if (!entry) { entry = { sticker,refs:0,updated:Date.now() }; this.entries.set(key,entry); }
    if (entry.asset) return Promise.resolve(entry.asset);
    if (entry.pending) return entry.pending;
    const current = entry;
    const controller = new AbortController();
    current.controller = controller;
    const pending = (async () => {
      await this.slot(controller.signal);
      try {
        const asset = await loadStickerAsset(this.workspaceId,this.userId,sticker,controller.signal);
        if (!this.valid(sticker) || controller.signal.aborted || this.entries.get(key) !== current) {
          URL.revokeObjectURL(asset.url);
          throw new DOMException('Cancelled','AbortError');
        }
        current.asset = asset;
        current.updated = Date.now();
        this.trim();
        this.notify();
        return asset;
      } finally {
        this.active--;
        this.waiting.shift()?.();
      }
    })().finally(() => {
      if (current.pending === pending) { current.pending = undefined; current.controller = undefined; }
    });
    current.pending = pending;
    return pending;
  }
  private trim() {
    const idle = [...this.entries.entries()].filter(([,entry]) => entry.refs === 0 && !!entry.asset)
      .sort((a,b) => a[1].updated - b[1].updated);
    let idleCount = idle.length;
    let bytes = [...this.entries.values()].reduce((total,entry) => total + (entry.asset?.blob.size ?? 0),0);
    for (const [key,entry] of idle) {
      if (idleCount <= 12 && bytes <= 64 * 1024 * 1024) break;
      bytes -= entry.asset!.blob.size;
      idleCount--;
      URL.revokeObjectURL(entry.asset!.url);
      this.entries.delete(key);
    }
  }
  dispose() {
    this.alive = false;
    this.catalog.clear();
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      if (entry.asset) URL.revokeObjectURL(entry.asset.url);
    }
    this.entries.clear();
    this.notify();
  }
}

function projectSticker(id: string, data: Record<string, unknown>): WorkspaceSticker | null {
  const date = (value: unknown) => value && typeof (value as { toDate?: unknown }).toDate === 'function'
    ? (value as { toDate: () => Date }).toDate() : null;
  if (typeof data.uploaderId !== 'string' || data.encrypted !== true || typeof data.iv !== 'string'
    || !STICKER_MIME_TYPES.includes(data.mimeType as WorkspaceSticker['mimeType'])
    || !Number.isSafeInteger(data.byteSize) || (data.byteSize as number) < 1 || (data.byteSize as number) > MAX_STICKER_BYTES
    || !Number.isSafeInteger(data.ciphertextBytes) || (data.ciphertextBytes as number) < 1 || (data.ciphertextBytes as number) > MAX_STICKER_CIPHERTEXT_BYTES
    || !Number.isSafeInteger(data.width) || (data.width as number) < 1
    || !Number.isSafeInteger(data.height) || (data.height as number) < 1
    || !['uploading','ready','deleting'].includes(data.status as string)) return null;
  return {
    ...data,id,createdAt:date(data.createdAt),uploadLeaseUntil:date(data.uploadLeaseUntil),
  } as WorkspaceSticker;
}

const EMPTY_STICKERS: WorkspaceSticker[] = [];

export function useWorkspaceStickers(workspaceId: string | null | undefined, userId: string | undefined, enabled: boolean) {
  const scopeKey = enabled && workspaceId && userId ? userId + ':' + workspaceId : '';
  const assets = useMemo(() => new StickerAssetStore(enabled ? workspaceId || '' : '',enabled ? userId || '' : ''),[enabled,workspaceId,userId]);
  const [snapshot,setSnapshot] = useState<{ scope: string; records: WorkspaceSticker[]; loading: boolean; error: string | null; revoked: boolean }>({
    scope:'',records:[],loading:true,error:null,revoked:false,
  });
  const [items,setItems] = useState<StickerImportItem[]>([]);
  const [busy,setBusy] = useState(false);
  const [retry,setRetry] = useState(0);
  const session = useRef<{ controller: AbortController; key: string; batch: { cancelled: boolean } | null } | null>(null);
  const addFilesRef = useRef<(files: File[], options?: { showCard?: boolean }) => boolean>(() => false);
  const cleanupJobs = useRef(new Map<string,CleanupJob>());
  const catalogLive = useRef(false);
  const recordsRef = useRef<WorkspaceSticker[]>([]);

  useEffect(() => {
    if (!scopeKey || !workspaceId || !userId) return () => assets.dispose();
    // Arm every setup, including StrictMode replay of the same store instance.
    assets.activate();
    const controller = new AbortController();
    const current = { controller,key:scopeKey,batch:null as { cancelled: boolean } | null };
    const jobs = cleanupJobs.current;
    session.current = current;
    catalogLive.current = false;
    let delivered = false;
    queueMicrotask(() => {
      if (controller.signal.aborted || session.current !== current) return;
      setSnapshot({ scope:scopeKey,records:[],loading:true,error:null,revoked:false });
      setItems([]); setBusy(false);
    });
    const unsubscribe = onSnapshot(query(collection(db,'workspaces',workspaceId,'stickers'),orderBy('createdAt','desc')),snap => {
      if (controller.signal.aborted || session.current !== current) return;
      if (!snap.metadata.fromCache) delivered = true;
      const records = snap.docs.map(item => projectSticker(item.id,item.data())).filter((item): item is WorkspaceSticker => item !== null)
        .sort((a,b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
      catalogLive.current = true;
      assets.setCatalog(records);
      setSnapshot({ scope:scopeKey,records,loading:false,error:null,revoked:false });
    },error => {
      if (controller.signal.aborted || session.current !== current) return;
      catalogLive.current = false;
      assets.setCatalog([]);
      const revoked = delivered && error.code === 'permission-denied';
      if (revoked) {
        clearStickerOperations();
        jobs.forEach(job => { if (job.timer) clearTimeout(job.timer); job.dismissed = true; job.timer = null; });
        jobs.clear();
        controller.abort(); assets.dispose(); current.batch = null; setBusy(false);
      }
      setSnapshot({ scope:scopeKey,records:[],loading:false,error:"Couldn't load stickers",revoked });
    });
    return () => {
      clearStickerOperations();
      jobs.forEach(job => { if (job.timer) clearTimeout(job.timer); job.dismissed = true; job.timer = null; });
      jobs.clear();
      catalogLive.current = false;
      controller.abort(); unsubscribe(); assets.dispose();
      if (session.current === current) session.current = null;
    };
  },[scopeKey,workspaceId,userId,assets,retry]);

  const current = snapshot.scope === scopeKey;
  const records = current ? snapshot.records : EMPTY_STICKERS;
  recordsRef.current = records;
  const byId = useMemo(() => new Map(records.map(record => [record.id,record])),[records]);
  const ready = useMemo(() => records.filter(record => record.status === 'ready'),[records]);

  const ensureCleanup = useCallback((stickerId: string, showCard: boolean, reopen = false): { job: CleanupJob; created: boolean } | null => {
    const active = session.current;
    if (!active || active.key !== scopeKey || active.controller.signal.aborted || !workspaceId) return null;

    const openCard = (job: CleanupJob) => {
      if (job.cardActive || job.completed || job.dismissed) return;
      job.operationId = startStickerCleanup({
        stickerId: job.stickerId,
        onRetry: () => {
          const live = session.current;
          if (!live || live.key !== scopeKey || live.controller.signal.aborted || job.dismissed) return false;
          void job.attempt(false);
          return true;
        },
        onDismiss: () => {
          job.dismissed = true;
          job.cardActive = false;
          if (job.timer) { clearTimeout(job.timer); job.timer = null; }
        },
      });
      job.cardActive = true;
    };

    const existing = cleanupJobs.current.get(stickerId);
    if (existing) {
      if (reopen && existing.dismissed) existing.dismissed = false;
      if (showCard) openCard(existing);
      return { job: existing, created: false };
    }

    const job: CleanupJob = {
      stickerId, operationId: null, timer: null, running: false, dismissed: false,
      completed: false, cardActive: false, attempt: async () => {},
    };
    const attempt = async (rethrow: boolean): Promise<void> => {
      const live = session.current;
      if (job.dismissed || job.completed || job.running
        || !live || live.key !== scopeKey || live.controller.signal.aborted) return;
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
      if (job.operationId) markStickerCleanupRunning(job.operationId);
      job.running = true;
      try {
        const result = await stickerOperation({ op:'delete',workspaceId,stickerId },live.controller.signal);
        if (job.dismissed || session.current !== live || live.controller.signal.aborted) return;
        if (result.ok) {
          if (job.timer) { clearTimeout(job.timer); job.timer = null; }
          job.completed = true;
          if (job.operationId) markStickerCleanupSucceeded(job.operationId);
          return;
        }
        if (job.operationId) markStickerCleanupPending(job.operationId);
        if (job.timer) clearTimeout(job.timer);
        job.timer = setTimeout(() => {
          job.timer = null;
          void attempt(false);
        },Math.max(1000,result.retryAfterMs ?? 30_000));
      } catch (error) {
        if (job.dismissed || session.current !== live || live.controller.signal.aborted) return;
        if (job.timer) { clearTimeout(job.timer); job.timer = null; }
        const message = error instanceof Error ? error.message : "Couldn't delete sticker. Try again.";
        if (!rethrow && job.operationId) markStickerCleanupFailed(job.operationId,message);
        if (rethrow) throw error;
      } finally {
        job.running = false;
      }
    };
    job.attempt = attempt;
    cleanupJobs.current.set(stickerId,job);
    if (showCard) openCard(job);
    return { job, created: true };
  },[scopeKey,workspaceId]);

  const adoptCleanups = useCallback((ownerId?: string | null) => {
    if (!catalogLive.current) return;
    const showCard = cleanupCardsAllowed();
    for (const sticker of recordsRef.current) {
      if (sticker.status !== 'deleting') continue;
      if (sticker.uploaderId !== userId && ownerId !== userId) continue;
      const entry = ensureCleanup(sticker.id,showCard,false);
      if (entry?.created) void entry.job.attempt(false);
    }
  },[ensureCleanup,userId]);

  useEffect(() => {
    if (!current || !catalogLive.current) return;
    adoptCleanups();
  },[current,records,adoptCleanups]);

  const addFiles = useCallback((files: File[], options?: { showCard?: boolean }): boolean => {
    const active = session.current;
    if (!active || active.key !== scopeKey || active.controller.signal.aborted || active.batch || !workspaceId || !userId) return false;
    // The session controller also guards the live listener and every sticker operation;
    // aborting it would tear down the session and abort the in-flight upload. This per-batch
    // gate stops only files that have not started, letting the current file settle normally.
    const batch = { cancelled: false };
    active.batch = batch;
    setBusy(true);
    const rows: StickerImportItem[] = files.map(file => ({ id:crypto.randomUUID(),name:file.name,phase:'preparing',ratio:0 }));
    setItems(rows);
    const alive = () => session.current === active && !active.controller.signal.aborted;
    const operationId = options?.showCard ? startStickerImport({
      total:files.length,
      onCancel:() => { batch.cancelled = true; },
      onRetry:failed => addFilesRef.current(failed,{ showCard:true }),
    }) : null;
    const run = async () => {
      try {
        for (let i=0;i<files.length;i++) {
          if (!alive() || batch.cancelled) break;
          const update = (phase: StickerImportItem['phase'],ratio: number,error?: string) => {
            if (!alive()) return;
            setItems(before => before.map(row => row.id === rows[i].id ? { ...row,phase,ratio,error } : row));
            if (operationId) updateStickerImportProgress(operationId,ratio);
          };
          try {
            await importWorkspaceSticker(workspaceId,userId,files[i],active.controller.signal,(phase,ratio) => update(phase,ratio));
            if (!alive()) break;
            if (operationId) stickerImportSucceeded(operationId);
          } catch (error) {
            // A failed import can leave a server reservation behind. Attach its id to the
            // cleanup card/loop; the old fire-and-forget call cannot retry its own 202.
            const reservedId = failedStickerId(error);
            if (reservedId) {
              const entry = ensureCleanup(reservedId,options?.showCard ?? cleanupCardsAllowed(),true);
              if (entry?.created) void entry.job.attempt(false);
            }
            if (!alive()) break;
            const raw = error instanceof Error ? error.message : 'Upload failed. Try this file again.';
            const prefix = files[i].name + ':';
            const reason = raw.startsWith(prefix) ? (raw.slice(prefix.length).trim() || raw) : raw;
            const display = raw.startsWith(prefix) ? raw : files[i].name + ': ' + raw;
            update('error',0,display);
            if (operationId) stickerImportFailed(operationId,files[i],files[i].name,reason);
          }
        }
      } finally {
        active.batch = null;
        if (alive()) setBusy(false);
        if (operationId) {
          if (alive()) settleStickerImport(operationId);
          else dismissStickerImport(operationId);
        }
      }
    };
    void run();
    return true;
  },[scopeKey,workspaceId,userId,ensureCleanup]);
  addFilesRef.current = addFiles;

  const remove = useCallback(async function removeSticker(
    sticker: WorkspaceSticker,
    options?: { showCard?: boolean },
  ): Promise<void> {
    const showCard = options?.showCard ?? cleanupCardsAllowed();
    const entry = ensureCleanup(sticker.id,showCard,true);
    if (!entry || entry.job.completed) return;
    try {
      await entry.job.attempt(true);
    } catch (error) {
      // An immediate delete failure is a transient action error, not a pending cleanup.
      // Surface it through the floating notice and let the still-ready tile be retried.
      if (showCard && entry.job.operationId) dismissStickerCleanup(entry.job.operationId);
      throw error;
    }
  },[ensureCleanup]);

  return {
    records,ready,byId,assets,items:current ? items : [],busy:current && busy,addFiles,remove,adoptCleanups,
    loading:!current || snapshot.loading,error:current ? snapshot.error : null,revoked:current && snapshot.revoked,
    retry:() => setRetry(value => value+1),
  };
}
export type WorkspaceStickers = ReturnType<typeof useWorkspaceStickers>;
