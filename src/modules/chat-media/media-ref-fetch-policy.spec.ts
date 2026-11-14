import type { HistoryAnchor } from '../../engine/interfaces/whatsapp-engine.interface';
import {
  afterHistoryAnswer,
  isDue,
  newHistoryState,
  parseChatList,
  retryDelayMs,
  updateFor,
  type HistoryLimits,
  type RefResult,
} from './media-ref-fetch-policy';

const failed = (
  reason: 'expired' | 'phone-unavailable' | 'too-large' | 'refused-host' | 'not-ready' | 'error',
  detail = 'd',
): RefResult => ({
  kind: 'fetch-failed',
  outcome: { ok: false, reason, detail },
});

describe('updateFor', () => {
  const at = (r: RefResult, attempts = 0, max = 3) => updateFor(r, attempts, max, 1000);

  it('a fetched file, or one already stored, is done', () => {
    expect(at({ kind: 'fetched' })).toEqual({ status: 'done', attempts: 1, lastError: null, lastAttemptAt: 1000 });
    expect(at({ kind: 'already-archived' }, 2)).toMatchObject({ status: 'done', attempts: 3 });
  });

  it('expired is final on the first try', () => {
    expect(at(failed('expired', 'gone'))).toEqual({
      status: 'expired',
      attempts: 1,
      lastError: 'gone',
      lastAttemptAt: 1000,
    });
  });

  it('too large and a refused host are final', () => {
    expect(at(failed('too-large', 'big'))).toMatchObject({ status: 'failed', lastError: 'too-large: big' });
    expect(at(failed('refused-host'))).toMatchObject({ status: 'failed' });
  });

  it('a phone that did not answer, or a plain error, is tried again until the attempts run out', () => {
    expect(at(failed('phone-unavailable', 'no answer'))).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'phone-unavailable: no answer',
    });
    expect(at(failed('error', 'x'), 1)).toMatchObject({ status: 'pending', attempts: 2 });
    expect(at(failed('phone-unavailable', 'no answer'), 2)).toEqual({
      status: 'failed',
      attempts: 3,
      lastError: 'phone-unavailable: no answer (gave up after 3 attempts)',
      lastAttemptAt: 1000,
    });
  });

  it('a missing message row or a failed write is retried, then given up on', () => {
    expect(at({ kind: 'no-row' })).toMatchObject({ status: 'pending', lastError: 'message row not found' });
    expect(at({ kind: 'archive-failed' }, 2)).toMatchObject({ status: 'failed' });
  });

  it('a file the archive will not take is final', () => {
    expect(at({ kind: 'archive-refused', detail: 'over the archive cap' })).toMatchObject({
      status: 'failed',
      lastError: 'over the archive cap',
    });
  });

  it('leaves the record alone when nothing was attempted (no connection)', () => {
    expect(at(failed('not-ready'))).toBeNull();
  });
});

describe('retry timing', () => {
  it('doubles from the base up to the cap', () => {
    expect([1, 2, 3, 4, 5].map(n => retryDelayMs(n, 10, 50))).toEqual([10, 20, 40, 50, 50]);
  });
  it('is due at once with no attempt, and only after the delay otherwise', () => {
    expect(isDue(0, null, 0, 1000, 5000)).toBe(true);
    expect(isDue(1, 100, 100_000 + 999, 1000, 5000)).toBe(false);
    expect(isDue(1, 100, 100_000 + 1000, 1000, 5000)).toBe(true);
    expect(isDue(3, 100, 100_000 + 3999, 1000, 5000)).toBe(false);
  });
});

describe('parseChatList', () => {
  it('reads ids, bare numbers and numbers with a plus, once each', () => {
    expect(parseChatList('85294970208@c.us, +852 9497 0208;85294970208 ')).toEqual(['85294970208@c.us']);
    expect(parseChatList('628111@c.us, 123@g.us\nabc@lid')).toEqual(['628111@c.us', '123@g.us', 'abc@lid']);
  });
  it('is empty for nothing', () => {
    expect(parseChatList(undefined)).toEqual([]);
    expect(parseChatList(' , ')).toEqual([]);
  });
});

describe('afterHistoryAnswer', () => {
  const limits: HistoryLimits = { maxPages: 3, maxMisses: 2 };
  const at = (id: string, timestamp = 100): HistoryAnchor => ({ id, fromMe: false, timestamp });
  const answer = (messages: number, oldest: HistoryAnchor | null, answered = true) => ({ answered, messages, oldest });

  it('moves the anchor to the oldest message of the answer', () => {
    const s = afterHistoryAnswer(newHistoryState(), at('NEWEST'), answer(50, at('B', 50)), limits);
    expect(s).toMatchObject({ anchor: { id: 'B' }, pages: 1, misses: 0, done: false });
  });

  it('ends when the answer holds nothing older', () => {
    const s = afterHistoryAnswer(newHistoryState(), at('A'), answer(0, null), limits);
    expect(s).toMatchObject({ done: true, doneReason: 'no older messages' });
  });

  it('ends when the answer does not go any further back than where it started', () => {
    const s = afterHistoryAnswer(newHistoryState(), at('A'), answer(1, at('A')), limits);
    expect(s).toMatchObject({ done: true, doneReason: 'the answer did not go any further back' });
  });

  it('asks again from the same place when the phone did not answer, and stops after a few in a row', () => {
    const first = afterHistoryAnswer(newHistoryState(), at('A'), answer(0, null, false), limits);
    expect(first).toMatchObject({ done: false, misses: 1, anchor: { id: 'A' } });
    const second = afterHistoryAnswer(first, at('A'), answer(0, null, false), limits);
    expect(second).toMatchObject({ done: true });
    expect(second.doneReason).toContain('did not answer');
  });

  it('an answer clears the count of misses', () => {
    const missed = afterHistoryAnswer(newHistoryState(), at('A'), answer(0, null, false), limits);
    expect(afterHistoryAnswer(missed, at('A'), answer(5, at('B')), limits).misses).toBe(0);
  });

  it('stops at the page limit', () => {
    let s = newHistoryState();
    for (const id of ['B', 'C', 'D']) s = afterHistoryAnswer(s, s.anchor ?? at('A'), answer(5, at(id)), limits);
    expect(s).toMatchObject({ done: true, pages: 3, doneReason: 'reached 3 pages' });
  });
});
