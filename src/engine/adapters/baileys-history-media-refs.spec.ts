import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { BaileysHistory, type BaileysHistoryHost } from './baileys-history';
import { BaileysSessionStore } from './baileys-session-store';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import type { MediaRef } from '../types/baileys.types';

/**
 * A history sync delivers each attachment as a key and a path and never the file. The sync handler maps messages to
 * media-free records, so without a hook the key and path were dropped and the file could never be fetched afterwards.
 */

const ANI = '628111@s.whatsapp.net';
const key = Uint8Array.from([1, 2, 3, 4]);

function build(putMediaRefs?: BaileysHistoryHost['putMediaRefs']) {
  const store = new BaileysSessionStore(undefined, 's1');
  const logger = createLogger('baileys-history-media-refs.spec');
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger,
    loadLib: () =>
      Promise.resolve({
        normalizeMessageContent: (m: unknown) => m,
        getContentType: (m: object) => Object.keys(m)[0],
        proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
      }),
    normalizedSelfJid: () => '628999@s.whatsapp.net',
    toNeutralJid: (id: string) => store.toNeutralJid(id),
    extractEphemeralDuration: (msg: WAMessage) => store.extractEphemeralDuration(msg),
    recordMessage: (msg: WAMessage, type: Parameters<BaileysSessionStore['recordMessage']>[1]) =>
      store.recordMessage(msg, type),
    recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
      store.recordMessageEdit(...args),
    upsertContacts: () => undefined,
    getOnHistoryMessages: () => () => undefined,
    inboundLimiter: new ConcurrencyLimiter(2),
    getStoredMessage: () => Promise.resolve(null),
    updateStoredMessage: () => undefined,
    putMediaRefs,
  };
  const events = new BaileysEvents(host as unknown as BaileysEventsHost);
  const history = new BaileysHistory({
    ...host,
    applyHistoryRevoke: (...args: Parameters<BaileysEvents['applyHistoryRevoke']>) =>
      events.applyHistoryRevoke(...args),
  } as unknown as BaileysHistoryHost);
  store.upsertChats([{ id: ANI, conversationTimestamp: 100 }] as never);
  return { store, history, logger };
}

const photo = (id: string, extra: Record<string, unknown> = {}): WAMessage => ({
  key: { id, remoteJid: ANI, fromMe: false },
  message: {
    imageMessage: { mediaKey: key, directPath: `/v/${id}`, mimetype: 'image/jpeg', fileLength: 500, ...extra },
  },
  messageTimestamp: 1_760_000_000,
});
const text = (id: string): WAMessage => ({
  key: { id, remoteJid: ANI, fromMe: false },
  message: { conversation: 'hi' },
  messageTimestamp: 1_760_000_100,
});

describe('history sync keeps attachment references', () => {
  it('hands the key and path of each attachment to the store, filed under the neutral chat id', async () => {
    const put = jest.fn(() => Promise.resolve(1));
    const { history } = build(put);

    await history.captureHistoryMessages([photo('P1'), text('T1'), photo('P2', { directPath: '/v/other' })]);

    expect(put).toHaveBeenCalledTimes(1);
    const refs = (put.mock.calls[0] as unknown as [MediaRef[]])[0];
    expect(refs.map(r => [r.waMessageId, r.chatId, r.kind, r.directPath, r.fromMe])).toEqual([
      ['P1', '628111@c.us', 'image', '/v/P1', false],
      ['P2', '628111@c.us', 'image', '/v/other', false],
    ]);
    expect(refs[0].mediaKey).toBe(Buffer.from(key).toString('base64'));
    expect(refs[0].messageTimestamp).toBe(1_760_000_000);
  });

  it('keeps nothing for a batch with no attachments', async () => {
    const put = jest.fn(() => Promise.resolve(0));
    const { history } = build(put);
    await history.captureHistoryMessages([text('T1')]);
    expect(put).not.toHaveBeenCalled();
  });

  it('skips an attachment that came without a key (a thumbnail only), and still previews the chat', async () => {
    const put = jest.fn(() => Promise.resolve(0));
    const { history, store } = build(put);
    await history.captureHistoryMessages([photo('P1', { mediaKey: undefined })]);
    expect(put).not.toHaveBeenCalled();
    expect(store.listChats().find(c => c.id === '628111@c.us')?.lastMessageType).toBe('image');
  });

  it('still completes the sync when the references cannot be kept, and says so', async () => {
    const put = jest.fn(() => Promise.reject(new Error('disk is busy')));
    const { history, store, logger } = build(put);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(history.captureHistoryMessages([photo('P1'), text('T1')])).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk is busy'));
    expect(store.listChats().find(c => c.id === '628111@c.us')?.lastMessage).toBeDefined();
  });

  it('works when no store is wired (references are simply not kept)', async () => {
    const { history } = build(undefined);
    await expect(history.captureHistoryMessages([photo('P1')])).resolves.toBeUndefined();
  });
});
