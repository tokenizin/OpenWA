import { BaileysHistoryRequests } from './baileys-history-requests';
import type { HistoryAnchor } from '../interfaces/whatsapp-engine.interface';

const at = (id: string, timestamp: number): HistoryAnchor => ({ id, fromMe: false, timestamp });

describe('BaileysHistoryRequests', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves with the count and the oldest message once the answer has stopped arriving', async () => {
    const r = new BaileysHistoryRequests(100);
    const pending = r.request(() => Promise.resolve('req-1'), 10_000);
    await jest.advanceTimersByTimeAsync(0);
    r.noteBatch('req-1', [at('B', 200), at('A', 100), at('C', 300)]);
    await jest.advanceTimersByTimeAsync(99);
    let settled = false;
    void pending.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ requestId: 'req-1', answered: true, messages: 3, oldest: at('A', 100) });
  });

  it('puts the chunks of one answer together, and waits for a late one', async () => {
    const r = new BaileysHistoryRequests(100);
    const pending = r.request(() => Promise.resolve('req-2'), 10_000);
    await jest.advanceTimersByTimeAsync(0);
    r.noteBatch('req-2', [at('B', 200)]);
    await jest.advanceTimersByTimeAsync(80);
    r.noteBatch('req-2', [at('A', 50)]);
    await jest.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ answered: true, messages: 2, oldest: { id: 'A' } });
  });

  it('an empty answer is an answer: the phone has nothing older', async () => {
    const r = new BaileysHistoryRequests(10);
    const pending = r.request(() => Promise.resolve('req-3'), 10_000);
    await jest.advanceTimersByTimeAsync(0);
    r.noteBatch('req-3', []);
    await jest.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual({ requestId: 'req-3', answered: true, messages: 0, oldest: null });
  });

  it('resolves unanswered when nothing arrives in time', async () => {
    const r = new BaileysHistoryRequests(10);
    const pending = r.request(() => Promise.resolve('req-4'), 5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ requestId: 'req-4', answered: false, messages: 0, oldest: null });
  });

  it('keeps an answer that lands before the request has returned', async () => {
    const r = new BaileysHistoryRequests(10);
    const pending = r.request(() => {
      r.noteBatch('req-5', [at('A', 100)]);
      return Promise.resolve('req-5');
    }, 5_000);
    await jest.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ answered: true, messages: 1 });
  });

  it('ignores batches with no request id (an ordinary sync) and ones nobody asked for', async () => {
    const r = new BaileysHistoryRequests(10);
    r.noteBatch(undefined, [at('A', 1)]);
    r.noteBatch(null, [at('A', 1)]);
    const pending = r.request(() => Promise.resolve('req-6'), 100);
    await jest.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ answered: false });
  });

  it('close() ends a wait as unanswered instead of leaving it hanging', async () => {
    const r = new BaileysHistoryRequests(10);
    const pending = r.request(() => Promise.resolve('req-7'), 60_000);
    await jest.advanceTimersByTimeAsync(0);
    r.close();
    expect(await pending).toMatchObject({ answered: false });
  });

  it('keeps the answers of two open requests apart by their ids', async () => {
    const r = new BaileysHistoryRequests(10);
    const a = r.request(() => Promise.resolve('a'), 1_000);
    const b = r.request(() => Promise.resolve('b'), 1_000);
    await jest.advanceTimersByTimeAsync(0);
    r.noteBatch('b', [at('X', 5)]);
    await jest.advanceTimersByTimeAsync(10);
    expect(await b).toMatchObject({ requestId: 'b', messages: 1 });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await a).toMatchObject({ requestId: 'a', answered: false });
  });
});
