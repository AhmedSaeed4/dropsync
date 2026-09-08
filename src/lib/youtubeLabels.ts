'use client';

import {
  deleteField,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  type DocumentData,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import type { Drop } from '@/types';

export const MAX_YOUTUBE_LABEL_IDS_PER_DROP = 50;
export const MAX_YOUTUBE_RESOLVE_IDS_PER_REQUEST = 10;
// Must comfortably exceed the helper endpoint's worst-case legitimate answer time
// (cache reads plus paced fresh fetches inside its 12s budget plus one in-flight
// attempt). 15s was too tight: when YouTube hangs, the endpoint legitimately
// answers slowly, and aborting at 15s turned one slow video into a permanently
// stuck backfill (production incident, fixed 2026-08-21).
export const YOUTUBE_RESOLVE_TIMEOUT_MS = 35000;

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL || 'http://localhost:8000';
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const YOUTUBE_TOKEN_RE = /(?<![\w.\-/])(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be)\/[^\s,;<>"']+/gi;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubeVideoLabel {
  videoId: string;
  title: string;
  channel: string | null;
}

export interface YouTubeLabelSource {
  type: Drop['type'];
  name: string;
  content: string;
  categories: string[];
  workspaceId: string | null;
  isDrawing: boolean;
}

export interface YouTubeLabelGuard {
  type: Drop['type'];
  name: string;
  categories: string[];
  workspaceId: string | null;
  isDrawing: boolean;
  encrypted: boolean;
  content?: string;
  iv?: string;
  encryptedDEK?: string;
}

export interface YouTubeLabelingResult {
  status: 'labeled' | 'not-applicable' | 'incomplete' | 'skipped';
  labelsWritten: number;
  unresolved: number;
  helperRequested?: boolean;
  writeFailed?: boolean;
  // Server-provided throttle hint (seconds) from the request that made the
  // drop incomplete; the backfill uses it to pace the auto-retry wait.
  retryAfterSeconds?: number | null;
}

interface YouTubeResolveResponse {
  labels?: Array<Partial<YouTubeVideoLabel> & { source?: string }>;
  unresolved?: Array<{ videoId?: string; reason?: string }>;
  retryAfterSeconds?: number | null;
}

function stateKey(uid: string, suffix: string): string {
  return `dropsync_youtube_backfill_${suffix}_${uid}`;
}

// Legacy per-browser notes from the pre-account-state era. No longer decision
// inputs anywhere; swept best-effort when a run completes.
function legacyNoteKeys(uid: string): string[] {
  return [
    stateKey(uid, 'needed'),
    stateKey(uid, 'completed'),
    `dropsync_youtube_backfill_checkpoint_${uid}`,
  ];
}

// ── Account-wide decision state (users/{uid}) ──────────────────────────
// The button's ONLY memory is the account's Firestore doc:
//   - youtubeBackfillCompletedAt: set when a run genuinely completes.
//   - youtubeBackfillNeededAt: set when labeling fails or comes back
//     incomplete after a save; wins over completed.
//   - hasYoutubeDrops: sticky D7 signal (D8) — true once any YouTube-link
//     drop exists; EXPLICITLY false only for accounts created after this
//     feature shipped; ABSENT = legacy account = show-eligible (the sweep's
//     already-done skip makes its one no-op run cheap, and its completion
//     then hides the button for good).
export interface YoutubeBackfillDecisionState {
  hasYoutubeDrops?: boolean;
  needed: boolean;
  completed: boolean;
}

export function evaluateYoutubeBackfillVisibility(
  state: YoutubeBackfillDecisionState,
): boolean {
  if (state.hasYoutubeDrops === false) return false; // D7: known-empty account
  if (state.needed) return true; // recovery path wins over everything
  if (state.completed) return false;
  return true; // has drops and never swept (or legacy account)
}

// Live subscription — every tab and device converges; replaces the one-shot
// 5s-bounded read (its timeout/'unknown' machinery is gone). A stream error
// keeps the LAST-KNOWN state (hidden before the first snapshot arrives) and
// self-heals on reconnect — a completed or empty account must never flash the
// button because of a transient outage.
export function subscribeBackfillDecisionState(
  uid: string,
  onState: (state: YoutubeBackfillDecisionState) => void,
): () => void {
  return onSnapshot(
    doc(db, 'users', uid),
    (snapshot) => {
      const data = snapshot.data() ?? {};
      onState({
        hasYoutubeDrops:
          typeof data.hasYoutubeDrops === 'boolean' ? data.hasYoutubeDrops : undefined,
        needed: !!data.youtubeBackfillNeededAt,
        completed: !!data.youtubeBackfillCompletedAt,
      });
    },
    () => {
      // Stream error: keep the last-known state (hidden before the first
      // snapshot). The listener self-heals; never guess a state here — a
      // guess would flash the button on completed and empty accounts.
    },
  );
}

async function writeBackfillDecisionFields(
  uid: string,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await setDoc(doc(db, 'users', uid), fields, { merge: true });
  } catch {
    // Best-effort: a failed write never disturbs the primary flow. merge:true
    // (not updateDoc) so a missing users/{uid} doc is created, not an error.
  }
}

// Sticky D7 signal: flipped true by any write path that introduces a
// YouTube-link drop (frontend saves + agent backend). Never unset.
export function noteYoutubeDropPresence(uid: string): void {
  void writeBackfillDecisionFields(uid, { hasYoutubeDrops: true });
}

// Account-wide "needed": labeling failed/incomplete after a successful save.
// Shows the button on EVERY device until a completed run clears it.
export function noteYoutubeBackfillNeeded(uid: string): void {
  void writeBackfillDecisionFields(uid, { youtubeBackfillNeededAt: serverTimestamp() });
}

// Genuine completion: set completed AND clear needed in one merged write
// (atomic per document — the pair can never settle completed-with-needed),
// then sweep the legacy per-browser notes nothing reads anymore.
export async function noteYoutubeBackfillComplete(uid: string): Promise<void> {
  await writeBackfillDecisionFields(uid, {
    youtubeBackfillCompletedAt: serverTimestamp(),
    youtubeBackfillNeededAt: deleteField(),
  });
  try {
    for (const key of legacyNoteKeys(uid)) window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable — visibility no longer depends on it.
  }
}

function normalizeCategories(value: unknown, legacyValue?: unknown): string[] {
  const values: unknown[] = Array.isArray(value) ? [...value] : [];
  if (typeof legacyValue === 'string') values.push(legacyValue);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const category = item.trim();
    const key = category.toLowerCase();
    if (!category || seen.has(key)) continue;
    seen.add(key);
    result.push(category);
  }
  return result;
}

export function isPasswordCategories(categories: string[]): boolean {
  return categories.some((category) => category.trim().toLowerCase() === 'password');
}

function isExpiredValue(value: unknown): boolean {
  if (!value) return false;
  const date = value instanceof Date
    ? value
    : typeof (value as { toDate?: unknown }).toDate === 'function'
      ? (value as { toDate: () => Date }).toDate()
      : null;
  return !!date && date.getTime() <= Date.now();
}

function normalizeLabel(value: unknown): YouTubeVideoLabel | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const videoId = typeof candidate.videoId === 'string' ? candidate.videoId.trim() : '';
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const channelValue = candidate.channel;
  const channel = typeof channelValue === 'string' && channelValue.trim()
    ? channelValue.trim().slice(0, 200)
    : null;
  if (!VIDEO_ID_RE.test(videoId) || !title) return null;
  return { videoId, title: title.slice(0, 500), channel };
}

export function normalizeYoutubeLabels(value: unknown): YouTubeVideoLabel[] {
  if (!Array.isArray(value)) return [];
  const result: YouTubeVideoLabel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const label = normalizeLabel(item);
    if (!label || seen.has(label.videoId)) continue;
    seen.add(label.videoId);
    result.push(label);
  }
  return result;
}

/**
 * Search-box matcher shared by BOTH list layouts (classic + editorial) so they
 * can never drift. Two modes:
 * - plain query  → case-insensitive substring match on the drop NAME
 *   (byte-for-byte today's behavior, including no trimming);
 * - '#'-prefixed → searches saved YouTube label TITLES and CHANNEL names
 *   instead (name ignored). Requires length > 1, so a bare '#' falls through
 *   to plain name matching for the literal '#' character.
 * Labels were normalized at load time (drops.ts), so no re-normalization
 * happens on this per-keystroke hot path.
 */
export function dropMatchesSearchQuery(
  drop: Pick<Drop, 'name' | 'youtubeVideoLabels'>,
  rawQuery: string,
): boolean {
  const query = rawQuery.toLowerCase();
  if (!query) return true;
  if (query.startsWith('#') && query.length > 1) {
    const term = query.slice(1);
    return (drop.youtubeVideoLabels ?? []).some(label =>
      label.title.toLowerCase().includes(term) ||
      (!!label.channel && label.channel.toLowerCase().includes(term))
    );
  }
  return drop.name.toLowerCase().includes(query);
}

export function getYouTubeVideoId(value: string): string | null {
  const text = (value || '').trim();
  if (VIDEO_ID_RE.test(text)) return text;
  if (!text) return null;

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    return match?.[1] || null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const queryId = parsed.searchParams.get('v');
  if (queryId && VIDEO_ID_RE.test(queryId)) return queryId;
  const pathMatch = parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
  return pathMatch?.[1] || null;
}

export function extractYouTubeVideoIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const token of (text || '').match(YOUTUBE_TOKEN_RE) || []) {
    const videoId = getYouTubeVideoId(token);
    if (videoId && !seen.has(videoId)) {
      seen.add(videoId);
      ids.push(videoId);
    }
  }
  return ids;
}

export function createYouTubeLabelGuard(input: {
  type: Drop['type'];
  name: string;
  categories: string[];
  workspaceId: string | null;
  isDrawing: boolean;
  encrypted: boolean;
  content?: string;
  iv?: string;
  encryptedDEK?: string;
}): YouTubeLabelGuard {
  return {
    type: input.type,
    name: input.name,
    categories: normalizeCategories(input.categories),
    workspaceId: input.workspaceId,
    isDrawing: input.isDrawing,
    encrypted: input.encrypted,
    content: input.encrypted ? undefined : input.content,
    iv: input.iv,
    encryptedDEK: input.encryptedDEK,
  };
}

function guardMatches(data: DocumentData, guard: YouTubeLabelGuard): boolean {
  if (data.type !== guard.type || data.name !== guard.name) return false;
  if ((data.workspaceId || null) !== guard.workspaceId) return false;
  if (!!data.isDrawing !== guard.isDrawing) return false;
  const currentCategories = normalizeCategories(data.categories, data.category);
  if (currentCategories.length !== guard.categories.length || currentCategories.some((value, index) => value !== guard.categories[index])) {
    return false;
  }
  if (isPasswordCategories(currentCategories) || isExpiredValue(data.expiresAt)) return false;

  if (guard.encrypted) {
    if (data.encrypted !== true || data.iv !== guard.iv) return false;
    if (guard.encryptedDEK !== undefined && data.encryptedDEK !== guard.encryptedDEK) return false;
    return true;
  }
  return data.encrypted !== true && data.content === guard.content;
}

async function writeLabelsIfCurrent(
  dropId: string,
  labels: YouTubeVideoLabel[],
  guard: YouTubeLabelGuard,
): Promise<boolean> {
  const dropRef = doc(db, 'drops', dropId);
  let accepted = false;
  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(dropRef);
      if (!snapshot.exists() || !guardMatches(snapshot.data(), guard)) return;
      const current = normalizeYoutubeLabels(snapshot.data().youtubeVideoLabels);
      const next = normalizeYoutubeLabels(labels);
      accepted = true;
      if (JSON.stringify(current) === JSON.stringify(next)) return;
      transaction.update(dropRef, next.length > 0
        ? { youtubeVideoLabels: next }
        : { youtubeVideoLabels: deleteField() });
    });
  } catch {
    return false;
  }
  return accepted;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveYouTubeVideoIdsDataApi(
  videoIds: string[],
  signal?: AbortSignal,
): Promise<YouTubeResolveResponse | null> {
  const apiKey = process.env.NEXT_PUBLIC_YOUTUBE_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), YOUTUBE_RESOLVE_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoIds.join(',')}&key=${apiKey}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as {
      items?: Array<{ id?: unknown; snippet?: { title?: unknown; channelTitle?: unknown } }>;
    } | null;
    if (!payload || !Array.isArray(payload.items)) return null;
    const labels: Array<Partial<YouTubeVideoLabel> & { source?: string }> = [];
    for (const item of payload.items) {
      const videoId = typeof item?.id === 'string' ? item.id : '';
      const title = typeof item?.snippet?.title === 'string' ? item.snippet.title.trim().slice(0, 500) : '';
      const channelValue = item?.snippet?.channelTitle;
      const channel = typeof channelValue === 'string' && channelValue.trim()
        ? channelValue.trim().slice(0, 200)
        : null;
      if (!videoId || !title) continue;
      labels.push({ videoId, title, channel });
    }
    const foundIds = new Set(labels.map((label) => label.videoId));
    return {
      labels,
      unresolved: videoIds
        .filter((videoId) => !foundIds.has(videoId))
        .map((videoId) => ({ videoId, reason: 'unavailable' })),
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function resolveYouTubeVideoIds(
  userId: string,
  videoIds: string[],
  signal?: AbortSignal,
): Promise<YouTubeResolveResponse> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== userId) throw new Error('The signed-in user changed.');
  if (signal?.aborted) throw new Error('The title lookup was cancelled.');
  if (videoIds.length > MAX_YOUTUBE_RESOLVE_IDS_PER_REQUEST) {
    throw new Error('Too many video IDs in one lookup.');
  }
  const token = await currentUser.getIdToken();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), YOUTUBE_RESOLVE_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const direct = await resolveYouTubeVideoIdsDataApi(videoIds, signal);
    if (direct) return direct;
    const response = await fetch(`${AGENT_URL}/youtube/resolve-labels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ videoIds }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as YouTubeResolveResponse;
    if (response.status === 429) {
      const retryAfterHeader = Number.parseInt(response.headers.get('Retry-After') || '', 10);
      return {
        labels: [],
        unresolved: videoIds.map((videoId) => ({ videoId, reason: 'throttled' })),
        retryAfterSeconds: Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader
          : payload.retryAfterSeconds ?? 60,
      };
    }
    if (!response.ok) {
      throw new Error('The title helper was unavailable.');
    }
    return payload;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function labelDropBestEffort(input: {
  userId: string;
  dropId: string;
  source: YouTubeLabelSource;
  guard: YouTubeLabelGuard;
  existingLabels?: unknown;
  signal?: AbortSignal;
}): Promise<YouTubeLabelingResult> {
  const { source } = input;
  if (
    source.type !== 'text' ||
    source.isDrawing ||
    isPasswordCategories(source.categories)
  ) {
    return { status: 'skipped', labelsWritten: 0, unresolved: 0 };
  }

  const allIds = extractYouTubeVideoIds(`${source.name}\n${source.content}`);
  if (allIds.length > 0) {
    noteYoutubeDropPresence(input.userId);
  }
  if (allIds.length === 0) {
    const existingLabels = normalizeYoutubeLabels(input.existingLabels);
    if (existingLabels.length === 0) {
      return { status: 'not-applicable', labelsWritten: 0, unresolved: 0 };
    }
    const accepted = await writeLabelsIfCurrent(input.dropId, [], input.guard);
    if (!accepted) {
      noteYoutubeBackfillNeeded(input.userId);
      return { status: 'incomplete', labelsWritten: 0, unresolved: 1, writeFailed: true };
    }
    return { status: 'labeled', labelsWritten: 0, unresolved: 0, writeFailed: false };
  }

  let incomplete = allIds.length > MAX_YOUTUBE_LABEL_IDS_PER_DROP;
  const ids = allIds.slice(0, MAX_YOUTUBE_LABEL_IDS_PER_DROP);
  const labelsById = new Map<string, YouTubeVideoLabel>();
  for (const label of normalizeYoutubeLabels(input.existingLabels)) {
    if (ids.includes(label.videoId)) labelsById.set(label.videoId, label);
  }

  let unresolvedCount = 0;
  let unavailableCount = 0;
  let helperRequested = false;
  let retryAfterSeconds: number | null = null;
  const groups = chunks(ids, MAX_YOUTUBE_RESOLVE_IDS_PER_REQUEST);
  for (const [groupIndex, group] of groups.entries()) {
    if (input.signal?.aborted) {
      incomplete = true;
      break;
    }
    helperRequested = true;
    try {
      const response = await resolveYouTubeVideoIds(input.userId, group, input.signal);
      if (typeof response.retryAfterSeconds === 'number' && response.retryAfterSeconds > 0) {
        retryAfterSeconds = response.retryAfterSeconds;
      }
      for (const rawLabel of response.labels || []) {
        const label = normalizeLabel(rawLabel);
        if (label && group.includes(label.videoId)) labelsById.set(label.videoId, label);
      }
      const unresolvedEntries = Array.isArray(response.unresolved) ? response.unresolved : [];
      const retryableEntries = unresolvedEntries.filter((entry) => entry.reason !== 'unavailable');
      unavailableCount += unresolvedEntries.length - retryableEntries.length;
      unresolvedCount += retryableEntries.length;
      if (retryableEntries.length > 0) {
        incomplete = true;
        // Do not immediately retry throttled/pending/temporary IDs. The next
        // explicit backfill action is the recovery path. A 4xx unavailable
        // video is final and does not block the remaining groups.
        break;
      }
    } catch {
      incomplete = true;
      break;
    }
    if (groupIndex < groups.length - 1) {
      await sleep(750);
    }
  }

  const orderedLabels = ids
    .map((videoId) => labelsById.get(videoId))
    .filter((label): label is YouTubeVideoLabel => !!label);
  const accepted = await writeLabelsIfCurrent(input.dropId, orderedLabels, input.guard);
  const writeFailed = !accepted;
  if (writeFailed) incomplete = true;

  if (incomplete) {
    noteYoutubeBackfillNeeded(input.userId);
  }
  return {
    status: incomplete ? 'incomplete' : 'labeled',
    labelsWritten: orderedLabels.length,
    unresolved: unresolvedCount + unavailableCount + (writeFailed ? 1 : 0),
    helperRequested,
    writeFailed,
    retryAfterSeconds: incomplete ? retryAfterSeconds : null,
  };
}

export function sourceFromDrop(drop: Drop, content: string): YouTubeLabelSource {
  return {
    type: drop.type,
    name: drop.name,
    content,
    categories: normalizeCategories(drop.categories, drop.category),
    workspaceId: drop.workspaceId,
    isDrawing: !!drop.isDrawing,
  };
}
