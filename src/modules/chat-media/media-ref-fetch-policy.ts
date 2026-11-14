import type { MediaFetchOutcome } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * The decisions of the background media fetcher, kept free of I/O and of the clock so they can be tested
 * on their own. The service in `media-ref-fetcher.service.ts` only carries them out.
 */

export type RefStatus = 'pending' | 'done' | 'expired' | 'failed';

export interface RefUpdate {
  status: RefStatus;
  attempts: number;
  lastError: string | null;
  /** Seconds since the epoch. */
  lastAttemptAt: number;
}

/** What happened to one reference this time. `no-row`: the message row is not in the database (yet). */
export type RefResult =
  | { kind: 'fetched' }
  | { kind: 'already-archived' }
  | { kind: 'no-row' }
  | { kind: 'archive-refused'; detail: string }
  | { kind: 'archive-failed' }
  | { kind: 'fetch-failed'; outcome: Extract<MediaFetchOutcome, { ok: false }> };

/**
 * How a result changes the reference's record. Null leaves the record as it is: nothing was attempted
 * (the engine has no connection), so a later pass owes it a first try, not a second.
 */
export function updateFor(result: RefResult, attempts: number, maxAttempts: number, nowSec: number): RefUpdate | null {
  const next = attempts + 1;
  const base = { attempts: next, lastAttemptAt: nowSec };
  const retry = (detail: string): RefUpdate => ({
    ...base,
    status: next >= maxAttempts ? 'failed' : 'pending',
    lastError: next >= maxAttempts ? `${detail} (gave up after ${next} attempts)` : detail,
  });
  switch (result.kind) {
    case 'fetched':
    case 'already-archived':
      return { ...base, status: 'done', lastError: null };
    case 'no-row':
      return retry('message row not found');
    case 'archive-failed':
      return retry('could not store the file');
    case 'archive-refused':
      return { ...base, status: 'failed', lastError: result.detail };
    case 'fetch-failed': {
      const { reason, detail } = result.outcome;
      switch (reason) {
        case 'not-ready':
          return null;
        case 'expired':
          return { ...base, status: 'expired', lastError: detail };
        case 'too-large':
        case 'refused-host':
          return { ...base, status: 'failed', lastError: `${reason}: ${detail}` };
        case 'phone-unavailable':
        case 'error':
          return retry(`${reason}: ${detail}`);
      }
    }
  }
}

/** Wait before the next try after `attempts` tries: base, then twice that, and so on up to the cap. */
export function retryDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
}

export function isDue(
  attempts: number,
  lastAttemptAtSec: number | null,
  nowMs: number,
  baseMs: number,
  maxMs: number,
): boolean {
  if (attempts === 0 || lastAttemptAtSec === null) return true;
  return nowMs >= lastAttemptAtSec * 1000 + retryDelayMs(attempts, baseMs, maxMs);
}

/**
 * Chat ids as the operator writes them: `85294970208@c.us`, or just the digits, or with a `+`. Anything
 * with an `@` is taken as written (a group, a lid). Returns the neutral id the references are filed under.
 */
export function parseChatList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(/[,;\n]+/)
        .map(s => s.trim().replace(/\s+/g, ''))
        .filter(Boolean)
        .map(s => (s.includes('@') ? s : `${s.replace(/\D/g, '')}@c.us`))
        .filter(s => !s.startsWith('@')),
    ),
  ];
}

// ─── Asking the phone for older history, one chat at a time ───────────────────────────────────────

export interface HistoryChatState {
  /** Requests answered with older messages so far. */
  pages: number;
  /** Requests that brought nothing new (the phone is off, or there is nothing older). */
  misses: number;
  /** When the open request was sent (ms), and the oldest message id at that moment. Null when none is open. */
  waitingSince: number | null;
  anchorId: string | null;
  done: boolean;
  doneReason: string | null;
}

export const newHistoryState = (): HistoryChatState => ({
  pages: 0,
  misses: 0,
  waitingSince: null,
  anchorId: null,
  done: false,
  doneReason: null,
});

export interface HistoryLimits {
  waitMs: number;
  maxPages: number;
  maxMisses: number;
}

export type HistoryDecision =
  | { action: 'request'; state: HistoryChatState }
  | { action: 'wait' | 'skip'; state: HistoryChatState }
  | { action: 'done'; state: HistoryChatState };

/**
 * What to do for one chat now. `oldestId` is the oldest message held for it. The history arrives later
 * and unannounced, so progress is told by the oldest message changing: while it has not, the open
 * request is waited on for `waitMs`; after that it counts as a miss, and a few misses in a row end the
 * walk. The walk also ends at `maxPages`, so one chat cannot ask forever.
 */
export function decideHistory(
  prev: HistoryChatState,
  oldestId: string | null,
  nowMs: number,
  limits: HistoryLimits,
): HistoryDecision {
  if (prev.done) return { action: 'skip', state: prev };
  const finish = (reason: string): HistoryDecision => ({
    action: 'done',
    state: { ...prev, waitingSince: null, done: true, doneReason: reason },
  });
  if (!oldestId) return finish('no message to start from');

  let state = prev;
  if (state.waitingSince !== null) {
    if (oldestId !== state.anchorId) {
      state = { ...state, pages: state.pages + 1, misses: 0, waitingSince: null };
    } else if (nowMs - state.waitingSince < limits.waitMs) {
      return { action: 'wait', state };
    } else {
      state = { ...state, misses: state.misses + 1, waitingSince: null };
      if (state.misses >= limits.maxMisses) {
        return { action: 'done', state: { ...state, done: true, doneReason: 'no older messages arrived' } };
      }
    }
  }
  if (state.pages >= limits.maxPages) {
    return { action: 'done', state: { ...state, done: true, doneReason: `reached ${limits.maxPages} pages` } };
  }
  return { action: 'request', state: { ...state, waitingSince: nowMs, anchorId: oldestId } };
}
