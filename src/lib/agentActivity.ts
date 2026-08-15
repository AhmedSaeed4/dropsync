/**
 * Live AI-assistant activity stream (shared by the Classic + Editorial chat panels).
 *
 * The backend's POST /chat/stream endpoint (agent-backend/src/main.py) runs the same agent
 * as /chat but emits Server-Sent Events while it works. This module owns:
 *   1. the SSE parsing (fetch + getReader — EventSource can't send an Authorization header
 *      and is GET-only; the same getReader pattern exists in archiveFormat.ts),
 *   2. the tool-name → activity-label map — wording lives HERE on the frontend so label
 *      tweaks ship with an instant Vercel deploy instead of an HF Space rebuild, and both
 *      layouts share one source (the layout-parity rule),
 *   3. a swap throttle so quick tool sequences don't flash labels,
 *   4. a legacy fallback: if /chat/stream 404s (frontend deployed before the backend got
 *      the endpoint), the same request is retried against plain /chat — no labels, same
 *      response shape, chat keeps working.
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
      // labels; identical response shape, so the panel code below doesn't care.
      const legacy = await fetch(`${url}/chat`, { method: 'POST', headers, body, signal });
      if (!legacy.ok) throw await httpError(legacy);
      return (await legacy.json()) as AgentChatResult;
    }
    throw await httpError(res);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('Streaming is not supported in this browser.');

  const decoder = new TextDecoder();
  let buffer = '';
  // Terminal state, filled in by the frame handler (a nested closure). Kept on a const
  // holder: plain `let`s assigned only inside a closure get flow-narrowed to `never` at
  // the read site, which eats the property types.
  const outcome: {
    final: AgentChatResult | null;
    error: { kind: string; message: string } | null;
  } = { final: null, error: null };

  // Label throttle: the first label applies immediately; later swaps are spaced at least
  // MIN_LABEL_MS apart (a pending swap is replaced by the newest label, so intermediate
  // states of a rapid sequence can be skipped entirely).
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
      if (label) applyLabel(label);
    } else if (eventName === 'delta') {
      if (typeof data.text === 'string' && data.text) onDelta?.(data.text);
    } else if (eventName === 'delta_reset') {
      onDeltaReset?.();
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

  const handleChunk = (chunk: string) => {
    buffer += chunk;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      handleFrame(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  };

  try {
    while (true) {
      const { done: readDone, value } = await reader.read();
      if (readDone) break;
      handleChunk(decoder.decode(value, { stream: true }));
      if (outcome.final || outcome.error) break;
    }
    if (!outcome.final && !outcome.error && buffer.trim()) {
      handleFrame(buffer); // trailing frame that arrived without the final blank line
    }
  } finally {
    finished = true;
    if (pendingTimer) clearTimeout(pendingTimer);
    try {
      // Fire-and-forget with a rejection handler: when the fetch was ABORTED (Stop button),
      // cancel()'s promise rejects ("BodyStreamBuffer was aborted" in Chromium) — without the
      // .catch that surfaces as an unhandled rejection the moment the user stops the agent.
      reader.cancel().catch(() => {});
    } catch {
      /* connection already closed */
    }
  }

  if (outcome.error) {
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
