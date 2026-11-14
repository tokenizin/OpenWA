import type {
  HistoryAnchor,
  HistoryAnswer,
  MediaFetchOutcome,
} from '../../engine/interfaces/whatsapp-engine.interface';

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
  /** Where the next request starts: the message the previous answer's oldest one was. Null before the first. */
  anchor: HistoryAnchor | null;
  /** Requests answered with messages so far. */
  pages: number;
  /** Requests in a row the phone did not answer. */
  misses: number;
  done: boolean;
  doneReason: string | null;
}

export const newHistoryState = (): HistoryChatState => ({
  anchor: null,
  pages: 0,
  misses: 0,
  done: false,
  doneReason: null,
});

export interface HistoryLimits {
  maxPages: number;
  /** Unanswered requests in a row that end the walk (the phone is off, or does not serve this chat). */
  maxMisses: number;
}

/**
 * Where the walk stands after one request. It starts at the newest message held, so the first answers
 * re-deliver messages already stored (their attachment references are what is wanted, and an answer is
 * kept even for a message that is already a row), and carries on past the oldest one held into history
 * the gateway never had. Each answer's oldest message is the next anchor. It ends on an answer with no
 * messages (nothing older), on a few requests in a row left unanswered, on an answer that does not move
 * (the same anchor again), or at the page limit, so one chat cannot ask forever.
 */
export function afterHistoryAnswer(
  prev: HistoryChatState,
  sentFrom: HistoryAnchor,
  answer: Pick<HistoryAnswer, 'answered' | 'messages' | 'oldest'>,
  limits: HistoryLimits,
): HistoryChatState {
  const stop = (state: HistoryChatState, reason: string): HistoryChatState => ({
    ...state,
    done: true,
    doneReason: reason,
  });
  if (!answer.answered) {
    const misses = prev.misses + 1;
    const next = { ...prev, anchor: sentFrom, misses };
    return misses >= limits.maxMisses ? stop(next, 'the phone did not answer (off or offline?)') : next;
  }
  if (answer.messages === 0 || !answer.oldest)
    return stop({ ...prev, anchor: sentFrom, misses: 0 }, 'no older messages');
  const next: HistoryChatState = { ...prev, anchor: answer.oldest, pages: prev.pages + 1, misses: 0 };
  if (answer.oldest.id === sentFrom.id) return stop(next, 'the answer did not go any further back');
  if (next.pages >= limits.maxPages) return stop(next, `reached ${limits.maxPages} pages`);
  return next;
}
