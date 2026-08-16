/**
 * Live AI-assistant activity + reply stream (shared by the Classic + Editorial chat panels).
 *
 * The backend runs the agent as a RESUMABLE job (agent-backend/src/main.py):
 *   1. POST /chat/runs starts (or idempotently resumes) a run and returns a ticket —
 *      the work happens detached from any connection, so it survives client
 *      network hiccups,
 *   2. GET /chat/runs/{run_id}/stream replays the run's whole event log from frame 0
 *      and then follows live; on a connection drop this module wipes its local stream
 *      state, shows "Reconnecting…", and re-attaches (with backoff, inside a ~90s
 *      budget) — replaying from 0 means the finished answer is never lost,
 *   3. POST /chat/runs/{run_id}/cancel genuinely stops a run (Stop button / panel
 *      close / unmount, driven by the AbortSignal — saves model quota). The cancel
 *      response may carry a `summary` of what the run had already done; on an abort
 *      it is surfaced as AgentStoppedError so the panel can save a stop-memory turn.
 * The per-send client_request_id makes START retries idempotent: the same message
 * can never start two runs (no double-create on flaky networks).
 *
 * This module still owns the SSE parsing (fetch + getReader — EventSource can't send
 * an Authorization header and is GET-only), the tool-name → activity-label map
 * (wording lives HERE on the frontend so label tweaks ship with an instant Vercel
 * deploy, shared by both layouts), the label swap throttle, and the legacy
 * fallbacks: /chat/runs 404 → the one-shot /chat/stream path → its own 404 → plain
 * /chat (deploy-order safety in both directions).
 */

export interface AgentChatResult {
  response: string;
  previewDropId?: string | null;
  previewWorkspaceId?: string | null;
}

/** Thrown when the backend answers 429 — panels show a transient notice and save NO error turn. */
export class AgentRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRateLimitError';
  }
}

/**
 * Thrown for TRANSIENT provider-side failures (Gemini free-tier rate limit / overload /
 * timeout) — same handling as AgentRateLimitError: transient notice, nothing saved into
 * the conversation (the string must not be replayed to the model as history later).
 */
export class AgentTransientError extends Error {
  readonly kind: 'rate_limited' | 'busy';
  constructor(kind: 'rate_limited' | 'busy', message: string) {
    super(message);
    this.name = 'AgentTransientError';
    this.kind = kind;
  }
}

/**
 * Thrown when the user stopped the assistant (Stop button / panel close / unmount)
 * AND the backend reported what the run had already accomplished. Its message is
 * the backend's stop-memory summary — panels save it as a NORMAL assistant turn so
 * the next request's history tells the model the previous run was stopped and what
 * had actually been done. Only the client whose cancel genuinely stopped the run
 * ever receives a summary, so only that client saves (single writer).
 */
export class AgentStoppedError extends Error {
  readonly summary: string;
  constructor(summary: string) {
    super(summary);
    this.name = 'AgentStoppedError';
    this.summary = summary;
  }
}

/** Internal marker (NOT exported): POST /chat/runs 404'd — the backend predates
 * resumable runs; fall back to the one-shot streaming path. */
class RunEndpointUnavailableError extends Error {
  constructor() {
    super('run endpoint not available');
    this.name = 'RunEndpointUnavailableError';
  }
}

export const DEFAULT_ACTIVITY_LABEL = 'Preparing your answer…';

/** Raw tool names from agent-backend/src/tools_server.py → human activity labels. */
const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  search_drops: 'Searching your drops…',
  list_drops: 'Looking through your drops…',
  get_drop: 'Reading drop details…',
  preview_drop: 'Opening that drop…',
  create_drop: 'Creating a new drop…',
  update_drop: 'Updating that drop…',
  delete_drop: 'Deleting that drop…',
  move_drop: 'Moving that drop…',
  copy_drop: 'Copying that drop…',
  list_workspaces: 'Checking your workspaces…',
  create_workspace: 'Creating a workspace…',
  join_workspace: 'Joining that workspace…',
  list_categories: 'Looking at your categories…',
  delete_category: 'Deleting that category…',
  get_storage_stats: 'Calculating storage stats…',
};

/**
 * Backend activity phase → label. `tool_done` returns null on purpose: a just-finished tool
 * is followed immediately by the next event (another tool or generating), and keeping the
 * current label through that gap avoids churn between rapid steps.
 */
export function activityLabelFor(phase: string, tool?: string): string | null {
  if (phase === 'tool') return (tool && TOOL_ACTIVITY_LABELS[tool]) || 'Working on it…';
  if (phase === 'generating') return DEFAULT_ACTIVITY_LABEL;
  return null;
}

export interface StreamAgentChatOptions {
  url: string;
  token: string;
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  /** AbortSignal — the panels wire this to the Stop button, panel close, and unmount. */
  signal?: AbortSignal;
  /** Called with the translated label as the agent's activity changes (throttled). */
  onActivity: (label: string) => void;
  /** Called for each text delta of the answer as the model writes it (token-level stream). */
  onDelta?: (text: string) => void;
  /** Called when streamed-so-far text is invalidated (the model moved on to a tool after talking). */
  onDeltaReset?: () => void;
}

/** Min time a label stays visible before the next swap (anti-flash for quick tool runs). */
const MIN_LABEL_MS = 400;

/** How long an abort waits for the cancel response's stop-memory summary before
 * falling back to today's silent stop — bounded so a slow network can never hang it. */
const CANCEL_SUMMARY_MAX_WAIT_MS = 2500;

/** Sleep that ABORTS: the abort event rejects the promise (a mere early resolve
 * would let the caller continue into another attach attempt). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** fetch/read network failures surface as TypeError ("network error" in Chrome,
 * "Failed to fetch", reader rejections) — the reconnect trigger. */
function isNetworkFailure(e: unknown): boolean {
  return e instanceof TypeError;
}

export async function streamAgentChat({
  url,
  token,
  message,
  history,
  signal,
  onActivity,
  onDelta,
  onDeltaReset,
}: StreamAgentChatOptions): Promise<AgentChatResult> {
  // One label throttle for the WHOLE call, shared across reconnects: rapid
  // replayed activity frames collapse to ≥400ms spacing instead of flashing,
  // and 'Reconnecting…' flows through the same pipe as real labels.
  let lastLabelAt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  const applyLabel = (label: string) => {
    if (finished) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    const wait = lastLabelAt === 0 ? 0 : Math.max(0, lastLabelAt + MIN_LABEL_MS - performance.now());
    if (wait === 0) {
      lastLabelAt = performance.now();
      onActivity(label);
    } else {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastLabelAt = performance.now();
        if (!finished) onActivity(label);
      }, wait);
    }
  };

  // Best-effort GENUINE cancel on Stop / panel close / unmount: kill the backend
  // run so no model quota burns after the user walked away. keepalive lets the
  // fetch outlive the panel; NO signal is passed — the signal is already
  // aborted, which would cancel this fetch before it leaves. The promise is
  // RETAINED so an abort-path AbortError can be upgraded to AgentStoppedError
  // with the backend's stop-memory summary before the panels see it.
  let currentRunId: string | null = null;
  let cancelFetch: Promise<{ status?: string; summary?: string | null } | null> | null = null;
  const fireCancel = () => {
    if (!currentRunId || cancelFetch) return;
    cancelFetch = fetch(`${url}/chat/runs/${currentRunId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    })
      .then(async (res) => {
        if (!res.ok) return null; // run evicted / backend restarted / auth hiccup
        try {
          return (await res.json()) as { status?: string; summary?: string | null };
        } catch {
          return null;
        }
      })
      .catch(() => null);
  };
  signal?.addEventListener('abort', fireCancel, { once: true });

  // Stop-memory: after an abort we wait briefly for the cancel response; a
  // missing/failed/summary-less response degrades to exactly today's silent
  // AbortError. Bounded so a slow network can never hang the stop.
  const stopSummaryIfAny = async (): Promise<string | null> => {
    if (!cancelFetch) return null;
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), CANCEL_SUMMARY_MAX_WAIT_MS),
    );
    const res = await Promise.race([cancelFetch, timeout]);
    if (!res || typeof res.summary !== 'string' || !res.summary.trim()) return null;
    return res.summary;
  };

  try {
    try {
      // Per-SEND idempotency key: a START lost to a network hiccup retries with
      // the same key and re-attaches to the same run — never a second run.
      const clientRequestId = crypto.randomUUID();
      const runId = await startRun(url, token, message, history, clientRequestId, signal);
      currentRunId = runId;
      // Instant-Stop closure: if the user aborted BEFORE the START response
      // arrived (the {once} listener fired into a null currentRunId and so
      // cancelled nothing — while the backend created the run anyway, because a
      // fully-sent POST can't be unsent), or even before this call registered
      // the listener at all, this is the first moment the run id is knowable.
      // Fire the cancel NOW; the attach below then rejects instantly (aborted
      // signal) and the wrapper turns the cancel response into a stop-memory
      // turn — so an instant Stop cancels for real instead of orphaning a
      // server-side run that keeps mutating the user's drops.
      if (signal?.aborted) fireCancel();
      try {
        return await attachWithReconnect(url, token, runId, signal, applyLabel, onDelta, onDeltaReset);
      } catch (e) {
        // OUR abort (Stop button / panel close / unmount): the attach loop surfaces
        // it as AbortError. Before going silent, ask the cancel we just fired what
        // the run had done — a summary becomes AgentStoppedError (panels save a
        // normal turn); anything else rethrows today's silent AbortError. The
        // `signal?.aborted` gate is load-bearing: a cancelled terminal frame that
        // arrived WITHOUT our abort (cross-tab) keeps its silent AbortError.
        if (signal?.aborted && e instanceof Error && e.name === 'AbortError') {
          const summary = await stopSummaryIfAny();
          if (summary) throw new AgentStoppedError(summary);
        }
        throw e;
      }
    } catch (e) {
      if (e instanceof RunEndpointUnavailableError) {
        // Backend without /chat/runs (deploy-order gap) — the pre-reconnect
        // one-shot path: same streaming UX, no resume.
        return await streamOneShot({
          url,
          token,
          message,
          history,
          signal,
          onActivity: applyLabel,
          onDelta,
          onDeltaReset,
        });
      }
      throw e;
    }
  } finally {
    finished = true;
    if (pendingTimer) clearTimeout(pendingTimer);
    signal?.removeEventListener('abort', fireCancel);
  }
}

/**
 * Per-CONNECTION SSE state (frame buffer + terminal outcome). A fresh session is
 * created for every attach so a reconnect replays cleanly from frame 0; reset()
 * gives back a blank slate for the next attempt.
 *
 * `outcome` rides a const holder on purpose: plain `let`s assigned only inside a
 * closure get flow-narrowed to `never` at the read site, which eats the property
 * types.
 */
interface StreamSession {
  outcome: {
    final: AgentChatResult | null;
    error: { kind: string; message: string } | null;
  };
  reset: () => void;
  feed: (chunk: string) => void;
  flush: () => void;
}

function createStreamSession(callbacks: {
  onActivity: (label: string) => void;
  onDelta?: (text: string) => void;
  onDeltaReset?: () => void;
}): StreamSession {
  let buffer = '';
  const outcome: StreamSession['outcome'] = { final: null, error: null };

  const handleFrame = (frame: string) => {
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return; // keepalive comment frames / blanks
    let data: {
      phase?: string;
      tool?: string;
      response?: string;
      text?: string;
      kind?: string;
      previewDropId?: string | null;
      previewWorkspaceId?: string | null;
      message?: string;
    };
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (eventName === 'activity') {
      const label = activityLabelFor(data.phase ?? '', data.tool);
      if (label) callbacks.onActivity(label);
    } else if (eventName === 'delta') {
      if (typeof data.text === 'string' && data.text) callbacks.onDelta?.(data.text);
    } else if (eventName === 'delta_reset') {
      callbacks.onDeltaReset?.();
    } else if (eventName === 'final') {
      outcome.final = {
        response: data.response ?? '',
        previewDropId: data.previewDropId ?? null,
        previewWorkspaceId: data.previewWorkspaceId ?? null,
      };
    } else if (eventName === 'error') {
      outcome.error = {
        kind: typeof data.kind === 'string' ? data.kind : 'unknown',
        message: data.message || 'Something went wrong.',
      };
    }
  };

  return {
    outcome,
    reset: () => {
      buffer = '';
      outcome.final = null;
      outcome.error = null;
    },
    feed: (chunk: string) => {
      buffer += chunk;
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        handleFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    },
    flush: () => {
      if (buffer.trim()) handleFrame(buffer); // trailing frame without the final blank line
      buffer = '';
    },
  };
}

/**
 * Read one SSE response into the session. Returns when the terminal frame
 * arrived (outcome set); a network failure propagates as the raw TypeError —
 * that is the reconnect trigger. The finally keeps the shipped abort fix:
 * cancel()'s promise rejects when the fetch was aborted, and without the
 * .catch that surfaces as an unhandled rejection.
 */
async function readSseInto(res: Response, session: StreamSession): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Streaming is not supported in this browser.');
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done: readDone, value } = await reader.read();
      if (readDone) break;
      session.feed(decoder.decode(value, { stream: true }));
      if (session.outcome.final || session.outcome.error) break;
    }
    if (!session.outcome.final && !session.outcome.error) session.flush();
  } finally {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* connection already closed */
    }
  }
}

/** Translate a terminal outcome into the thrown-error contract the panels
 * already handle: transient kinds → AgentTransientError (notice, nothing
 * saved), "cancelled" → a silent AbortError (a stop this client didn't trigger,
 * e.g. another tab), everything else → a plain Error (saved error turn). */
function mapOutcome(outcome: StreamSession['outcome'], signal?: AbortSignal): AgentChatResult {
  if (outcome.error) {
    if (outcome.error.kind === 'cancelled') {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (outcome.error.kind === 'rate_limited' || outcome.error.kind === 'busy') {
      throw new AgentTransientError(outcome.error.kind, outcome.error.message);
    }
    throw new Error(outcome.error.message);
  }
  if (!outcome.final) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error('The assistant stopped responding. Please try again.');
  }
  return outcome.final;
}

/** One-shot path (deploy-order fallback when /chat/runs 404s): a single
 * POST /chat/stream with no resume — the original implementation, kept so an
 * old backend still gets the full streaming UX. Its own 404 falls back to the
 * legacy JSON /chat endpoint. */
async function streamOneShot({
  url,
  token,
  message,
  history,
  signal,
  onActivity,
  onDelta,
  onDeltaReset,
}: StreamAgentChatOptions): Promise<AgentChatResult> {
  const body = JSON.stringify({ message, history });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  let res: Response;
  try {
    res = await fetch(`${url}/chat/stream`, { method: 'POST', headers, body, signal });
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw e;
  }

  if (!res.ok) {
    if (res.status === 404) {
      // Backend without /chat/stream (deploy-order gap) — retry the legacy endpoint. No
      // labels; identical response shape, so the caller doesn't care.
      const legacy = await fetch(`${url}/chat`, { method: 'POST', headers, body, signal });
      if (!legacy.ok) throw await httpError(legacy);
      return (await legacy.json()) as AgentChatResult;
    }
    throw await httpError(res);
  }

  const session = createStreamSession({ onActivity, onDelta, onDeltaReset });
  await readSseInto(res, session);
  return mapOutcome(session.outcome, signal);
}

/** Start (or idempotently resume) a run. Only NETWORK failures retry — and
 * they're safe to retry because the idempotency key returns the same run; HTTP
 * verdicts (429 quota, 503 busy, 404 old backend) are final.
 *
 * The START POST is deliberately NOT tied to the AbortSignal: the run exists
 * server-side the instant the POST lands, so an instant-Stop client MUST still
 * receive the run id (the caller then fires the cancel it owes). Aborting the
 * POST instead would orphan a live server-side run that keeps working. The
 * retry sleeps between attempts stay abortable, so a dead-network retry loop
 * still stops immediately. */
async function startRun(
  url: string,
  token: string,
  message: string,
  history: StreamAgentChatOptions['history'],
  clientRequestId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const body = JSON.stringify({ message, history, client_request_id: clientRequestId });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  // 4 attempts, ~0/0.5/1/2s apart.
  for (const delay of [0, 500, 1000, 2000]) {
    if (delay) await abortableSleep(delay, signal);
    try {
      // No signal here on purpose — see the docstring above.
      const res = await fetch(`${url}/chat/runs`, { method: 'POST', headers, body });
      if (res.status === 404) throw new RunEndpointUnavailableError();
      if (!res.ok) throw await httpError(res);
      const data = (await res.json()) as { run_id: string };
      return data.run_id;
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // fetch rejects with TypeError on a network failure; a response body cut
      // mid-transfer makes res.json() throw SyntaxError. Both are retryable.
      if (e instanceof TypeError || e instanceof SyntaxError) continue;
      throw e;
    }
  }
  throw new AgentTransientError(
    'busy',
    'Could not reach the assistant. Check your connection and try again.',
  );
}

/** Total time we keep re-attaching after a connection drop. The run itself
 * keeps working server-side regardless — this only bounds how long the user
 * waits on a dead network before a friendly message instead. */
const RECONNECT_MAX_MS = 90_000;

async function attachWithReconnect(
  url: string,
  token: string,
  runId: string,
  signal: AbortSignal | undefined,
  applyLabel: (label: string) => void,
  onDelta?: (text: string) => void,
  onDeltaReset?: () => void,
): Promise<AgentChatResult> {
  const giveUp = () =>
    new AgentTransientError(
      'busy',
      "The connection to the assistant was lost and couldn't be restored. Nothing from this reply was saved — if you asked the assistant to change or delete something, please double-check the result before asking again.",
    );
  const deadline = Date.now() + RECONNECT_MAX_MS;
  let attempt = 0;
  while (true) {
    const session = createStreamSession({ onActivity: applyLabel, onDelta, onDeltaReset });
    try {
      const res = await fetch(`${url}/chat/runs/${runId}/stream`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (res.status === 404) throw giveUp(); // run evicted (~10 min) / backend restarted
      if (!res.ok) throw await httpError(res);
      await readSseInto(res, session);
      if (!session.outcome.final && !session.outcome.error) {
        // The stream ended without a terminal (server closed early) — treat it
        // like a drop and re-attach: the replay either resumes or lands it.
        throw new TypeError('stream ended without a terminal');
      }
      return mapOutcome(session.outcome, signal);
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!isNetworkFailure(e)) throw e; // give-up / HTTP verdicts are final
      if (Date.now() >= deadline) throw giveUp();
      // Reconnect: the server replays from frame 0, so the smooth buffer must be
      // wiped FIRST or the replayed text would double up; the label tells the
      // user through the normal activity pipe (zero panel changes).
      session.reset();
      onDeltaReset?.();
      applyLabel('Reconnecting…');
      await abortableSleep(Math.min(500 * 2 ** attempt, 3000), signal);
      attempt += 1;
      // If the run finished while we were away, the next attach returns
      // replay + terminal instantly.
    }
  }
}

async function httpError(res: Response): Promise<Error> {
  const err = await res.json().catch(() => ({ detail: 'Request failed' }));
  if (res.status === 429) {
    return new AgentRateLimitError(
      err.detail || "You've reached the agent message limit. Please try again shortly.",
    );
  }
  if (res.status === 503) {
    // Legacy-path provider "busy" (deploy-order window) — transient, same no-save handling.
    return new AgentTransientError(
      'busy',
      err.detail || 'The AI service is busy right now. Please try again shortly.',
    );
  }
  return new Error(err.detail || `Error ${res.status}`);
}
