import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { BaileysHistory, type BaileysHistoryHost } from './baileys-history';
import { BaileysSessionStore } from './baileys-session-store';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import type { MediaRef } from '../types/baileys.types';

/**
 * Asking the phone for older history goes out as a request and comes back as an ordinary history sync tagged
 * with the request's id. The request resolves from that sync, after its messages and attachment references
 * have been stored.
 */

const JID = '628111@s.whatsapp.net';
const key = Uint8Array.from([1, 2, 3, 4]);

function build() {
  const store = new BaileysSessionStore(undefined, 's1');
  const order: string[] = [];
  const fetchMessageHistory = jest.fn<Promise<string>, unknown[]>(() => Promise.resolve('req-9'));
  const host = {
    getSocket: () => ({ fetchMessageHistory }) as unknown as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('baileys-history-request-flow.spec'),
    loadLib: () =>
      Promise.resolve({
        normalizeMessageContent: (m: unknown) => m,
        getContentType: (m: object) => Object.keys(m)[0],
        proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
      }),
    normalizedSelfJid: () => '628999@s.whatsapp.net',
    toNeutralJid: (id: string) => store.toNeutralJid(id),
    chatJid: (id: string) => id.replace('@c.us', '@s.whatsapp.net'),
    extractEphemeralDuration: (msg: WAMessage) => store.extractEphemeralDuration(msg),
    recordMessage: (msg: WAMessage, type: Parameters<BaileysSessionStore['recordMessage']>[1]) =>
      store.recordMessage(msg, type),
    recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
      store.recordMessageEdit(...args),
    upsertContacts: () => undefined,
    getOnHistoryMessages: () => () => {
      order.push('stored');
    },
    inboundLimiter: new ConcurrencyLimiter(2),
    getStoredMessage: () => Promise.resolve(null),
    updateStoredMessage: () => undefined,
    putMediaRefs: (refs: MediaRef[]) => {
      order.push(`refs:${refs.length}`);
      return Promise.resolve(refs.length);
    },
  };
  const events = new BaileysEvents(host as unknown as BaileysEventsHost);
  const history = new BaileysHistory({
    ...host,
    applyHistoryRevoke: (...args: Parameters<BaileysEvents['applyHistoryRevoke']>) =>
      events.applyHistoryRevoke(...args),
  } as unknown as BaileysHistoryHost);
  store.upsertChats([{ id: JID, conversationTimestamp: 100 }] as never);
  return { history, fetchMessageHistory, order };
}

const photo = (id: string, ts: number): WAMessage => ({
  key: { id, remoteJid: JID, fromMe: false },
  message: { imageMessage: { mediaKey: key, directPath: `/v/${id}`, mimetype: 'image/jpeg', fileLength: 5 } },
  messageTimestamp: ts,
});

describe('requesting older history', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('names the chat in the phone’s own form, with the anchor and the count', async () => {
    const { history, fetchMessageHistory } = build();
    const pending = history.requestOlder(
      '628111@c.us',
      { id: 'ANCHOR', fromMe: true, timestamp: 1_700_000_000 },
      50,
      1_000,
    );
    await jest.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(fetchMessageHistory).toHaveBeenCalledWith(50, { remoteJid: JID, id: 'ANCHOR', fromMe: true }, 1_700_000_000);
  });

  it('is answered by the history sync tagged with its id, after the references were kept', async () => {
    const { history, order } = build();
    const pending = history.requestOlder('628111@c.us', { id: 'ANCHOR', fromMe: false, timestamp: 900 }, 50, 60_000);
    await jest.advanceTimersByTimeAsync(0);
    await history.captureHistoryMessages([photo('P2', 500), photo('P1', 300)], 'req-9');
    await jest.advanceTimersByTimeAsync(3_000);
    const answer = await pending;
    expect(answer).toMatchObject({
      requestId: 'req-9',
      answered: true,
      messages: 2,
      oldest: { id: 'P1', timestamp: 300, fromMe: false },
    });
    expect(order[0]).toBe('refs:2');
  });

  it('an answer with no messages says the phone has nothing older', async () => {
    const { history } = build();
    const pending = history.requestOlder('628111@c.us', { id: 'ANCHOR', fromMe: false, timestamp: 900 }, 50, 60_000);
    await jest.advanceTimersByTimeAsync(0);
    await history.captureHistoryMessages([], 'req-9');
    await jest.advanceTimersByTimeAsync(3_000);
    expect(await pending).toEqual({ requestId: 'req-9', answered: true, messages: 0, oldest: null });
  });

  it('an ordinary sync, with no request id, does not answer anything', async () => {
    const { history } = build();
    const pending = history.requestOlder('628111@c.us', { id: 'ANCHOR', fromMe: false, timestamp: 900 }, 50, 5_000);
    await jest.advanceTimersByTimeAsync(0);
    await history.captureHistoryMessages([photo('P1', 300)]);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ answered: false });
  });

  it('still reports the batch when storing it failed', async () => {
    const { history } = build();
    const pending = history.requestOlder('628111@c.us', { id: 'ANCHOR', fromMe: false, timestamp: 900 }, 50, 60_000);
    await jest.advanceTimersByTimeAsync(0);
    jest
      .spyOn(history as unknown as { captureBatch: () => Promise<void> }, 'captureBatch')
      .mockRejectedValue(new Error('boom'));
    await history.captureHistoryMessages([photo('P1', 300)], 'req-9').catch(() => undefined);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ requestId: 'req-9', answered: true });
  });
});
