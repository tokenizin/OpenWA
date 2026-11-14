import {
  decideHistory,
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

describe('decideHistory', () => {
  const limits: HistoryLimits = { waitMs: 1000, maxPages: 3, maxMisses: 2 };

  it('asks first, from the oldest message held', () => {
    const d = decideHistory(newHistoryState(), 'A', 0, limits);
    expect(d.action).toBe('request');
    expect(d.state).toMatchObject({ waitingSince: 0, anchorId: 'A' });
  });

  it('has nothing to ask from when the chat holds no message', () => {
    expect(decideHistory(newHistoryState(), null, 0, limits)).toMatchObject({ action: 'done', state: { done: true } });
  });

  it('waits while the answer is expected and the oldest message has not changed', () => {
    const open = decideHistory(newHistoryState(), 'A', 0, limits).state;
    expect(decideHistory(open, 'A', 999, limits).action).toBe('wait');
  });

  it('counts an answer when the oldest message changes, then asks again from the new one', () => {
    const open = decideHistory(newHistoryState(), 'A', 0, limits).state;
    const d = decideHistory(open, 'B', 100, limits);
    expect(d.action).toBe('request');
    expect(d.state).toMatchObject({ pages: 1, misses: 0, anchorId: 'B', waitingSince: 100 });
  });

  it('counts a miss when nothing came in time, asks once more, and then stops', () => {
    let s = decideHistory(newHistoryState(), 'A', 0, limits).state;
    let d = decideHistory(s, 'A', 1000, limits);
    expect(d.action).toBe('request');
    expect(d.state.misses).toBe(1);
    s = d.state;
    d = decideHistory(s, 'A', 2000, limits);
    expect(d).toMatchObject({ action: 'done', state: { done: true, doneReason: 'no older messages arrived' } });
  });

  it('stops after the page limit', () => {
    let s = newHistoryState();
    let now = 0;
    const ids = ['A', 'B', 'C', 'D'];
    let d = decideHistory(s, ids[0], now, limits);
    for (let i = 1; i < ids.length; i++) {
      now += 100;
      s = d.state;
      d = decideHistory(s, ids[i], now, limits);
    }
    expect(d).toMatchObject({ action: 'done', state: { pages: 3, doneReason: 'reached 3 pages' } });
  });

  it('does nothing once done', () => {
    const done = decideHistory(newHistoryState(), null, 0, limits).state;
    expect(decideHistory(done, 'A', 5, limits).action).toBe('skip');
  });
});
