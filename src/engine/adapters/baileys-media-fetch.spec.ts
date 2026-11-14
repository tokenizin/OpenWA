import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import {
  BaileysMediaFetch,
  classifyFetchFailure,
  messageFromRef,
  type BaileysMediaFetchHost,
} from './baileys-media-fetch';
import { createLogger } from '../../common/services/logger.service';
import type { MediaRef } from '../types/baileys.types';

const ref = (over: Partial<MediaRef> = {}): MediaRef => ({
  waMessageId: 'M1',
  chatId: '628111@c.us',
  fromMe: false,
  kind: 'image',
  mimetype: 'image/jpeg',
  fileLength: 100,
  mediaKey: Buffer.from([1, 2, 3]).toString('base64'),
  directPath: '/v/t62/abc',
  url: 'https://mmg.whatsapp.net/v/t62/abc',
  fileEncSha256: Buffer.from([8]).toString('base64'),
  fileSha256: Buffer.from([9]).toString('base64'),
  mediaKeyTimestamp: 1_759_000_000,
  messageTimestamp: 1_760_000_000,
  ...over,
});

function* chunks(...parts: string[]): Generator<Buffer> {
  for (const p of parts) yield Buffer.from(p);
}

function build(download: (...args: unknown[]) => unknown, sock: Partial<WASocket> | 'closed' = {}) {
  const downloadMediaMessage = jest.fn(download);
  const host: BaileysMediaFetchHost = {
    getSocket: () => {
      if (sock === 'closed') throw new Error('closed');
      return sock as WASocket;
    },
    loadLib: () =>
      Promise.resolve({
        downloadMediaMessage,
        extractMessageContent: (m: unknown) => m,
        getContentType: (m: object) => Object.keys(m)[0],
      } as never),
    getFetchDispatcher: () => undefined,
    chatJid: id => id.replace('@c.us', '@s.whatsapp.net'),
    logger: createLogger('baileys-media-fetch.spec'),
  };
  return { fetch: new BaileysMediaFetch(host), downloadMediaMessage };
}

describe('messageFromRef', () => {
  it.each([
    ['image', 'imageMessage'],
    ['video', 'videoMessage'],
    ['audio', 'audioMessage'],
    ['document', 'documentMessage'],
    ['sticker', 'stickerMessage'],
  ] as const)('puts a %s reference in %s', (kind, field) => {
    expect(Object.keys(messageFromRef(ref({ kind }), 'x@s.whatsapp.net').message ?? {})).toEqual([field]);
  });

  it('carries the key the phone is asked about, and the media node Baileys reads', () => {
    const m = messageFromRef(ref({ fromMe: true }), '628111@s.whatsapp.net');
    expect(m.key).toEqual({ id: 'M1', remoteJid: '628111@s.whatsapp.net', fromMe: true });
    const node = (m.message as { imageMessage: Record<string, unknown> }).imageMessage;
    expect(Buffer.isBuffer(node.mediaKey)).toBe(true);
    expect([...(node.mediaKey as Buffer)]).toEqual([1, 2, 3]);
    expect(node).toMatchObject({ directPath: '/v/t62/abc', mimetype: 'image/jpeg', fileLength: 100 });
    expect('url' in node).toBe(true);
  });

  it('keeps a url key even when the reference has none, and adds the sender for a group', () => {
    const m = messageFromRef(ref({ url: null }), 'g@g.us', 'p@s.whatsapp.net');
    expect('url' in (m.message as { imageMessage: object }).imageMessage).toBe(true);
    expect(m.key.participant).toBe('p@s.whatsapp.net');
  });
});

describe('classifyFetchFailure', () => {
  it('404 and 410 are expired, as an HTTP status or as a Boom', () => {
    expect(classifyFetchFailure({ status: 404 }).reason).toBe('expired');
    expect(classifyFetchFailure({ status: 410 }).reason).toBe('expired');
    expect(
      classifyFetchFailure({ output: { statusCode: 404 }, message: 'Media re-upload failed by device (NOT_FOUND)' }),
    ).toEqual({
      reason: 'expired',
      detail: 'Media re-upload failed by device (NOT_FOUND)',
    });
  });
  it('anything else is a plain error, with its message', () => {
    expect(classifyFetchFailure(new Error('bad decrypt'))).toEqual({ reason: 'error', detail: 'bad decrypt' });
    expect(classifyFetchFailure({ status: 500 }).reason).toBe('error');
    expect(classifyFetchFailure('weird').detail).toBe('weird');
  });
});

describe('BaileysMediaFetch.fetchByRef', () => {
  it('returns the bytes and the mimetype', async () => {
    const { fetch } = build(() => chunks('ab', 'cd'));
    expect(await fetch.fetchByRef(ref())).toEqual({ ok: true, bytes: Buffer.from('abcd'), mimetype: 'image/jpeg' });
  });

  it('hands Baileys a message rebuilt from the reference, and a re-upload hook backed by the phone', async () => {
    const updateMediaMessage = jest.fn((m: WAMessage) => Promise.resolve(m));
    const { fetch, downloadMediaMessage } = build(() => chunks('x'), { updateMediaMessage });
    await fetch.fetchByRef(ref());
    const [msg, type, , ctx] = downloadMediaMessage.mock.calls[0] as unknown as [
      WAMessage,
      string,
      unknown,
      { reuploadRequest: (m: WAMessage) => Promise<WAMessage> },
    ];
    expect(type).toBe('stream');
    expect(msg.key.remoteJid).toBe('628111@s.whatsapp.net');
    await ctx.reuploadRequest(msg);
    expect(updateMediaMessage).toHaveBeenCalledWith(msg);
  });

  it('refuses an address that a re-upload answer moved off WhatsApp', async () => {
    const moved = {
      message: { imageMessage: { url: 'https://evil.example/x', directPath: undefined } },
    } as unknown as WAMessage;
    const updateMediaMessage = jest.fn(() => Promise.resolve(moved));
    const { fetch, downloadMediaMessage } = build(
      async (...args: unknown[]) => {
        const ctx = args[3] as { reuploadRequest: (m: WAMessage) => Promise<WAMessage> };
        await ctx.reuploadRequest(args[0] as WAMessage);
        return chunks('x');
      },
      { updateMediaMessage },
    );
    const out = await fetch.fetchByRef(ref());
    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, reason: 'refused-host' });
  });

  it('does not fetch from an address that is not a WhatsApp media host', async () => {
    const { fetch, downloadMediaMessage } = build(() => chunks('x'));
    const out = await fetch.fetchByRef(ref({ directPath: null, url: 'https://evil.example/x' }));
    expect(out).toMatchObject({ ok: false, reason: 'refused-host' });
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('is too-large without downloading when the declared size is over the cap', async () => {
    const { fetch, downloadMediaMessage } = build(() => chunks('x'));
    expect(await fetch.fetchByRef(ref({ fileLength: 5000 }), { maxBytes: 1000 })).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('stops reading and is too-large when the real size passes the cap', async () => {
    const destroy = jest.fn();
    const stream = Object.assign(chunks('aaaa', 'bbbb', 'cccc'), { destroy });
    const { fetch } = build(() => stream);
    expect(await fetch.fetchByRef(ref({ fileLength: null }), { maxBytes: 6 })).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
    expect(destroy).toHaveBeenCalled();
  });

  it('is not-ready when the engine has no connection', async () => {
    const { fetch } = build(() => chunks('x'), 'closed');
    expect(await fetch.fetchByRef(ref())).toMatchObject({ ok: false, reason: 'not-ready' });
  });

  it('says expired when WhatsApp and the phone both no longer have the file', async () => {
    const { fetch } = build(() =>
      Promise.reject(
        Object.assign(new Error('Media re-upload failed by device (NOT_FOUND)'), { output: { statusCode: 404 } }),
      ),
    );
    expect(await fetch.fetchByRef(ref())).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('says error for a failure that is not about the file being gone', async () => {
    const { fetch } = build(() => Promise.reject(new Error('Invalid media key')));
    expect(await fetch.fetchByRef(ref())).toEqual({ ok: false, reason: 'error', detail: 'Invalid media key' });
  });

  it('gives up at the deadline when the phone never answers, and says to try again later', async () => {
    const { fetch } = build(() => new Promise(() => undefined));
    const out = await fetch.fetchByRef(ref(), { timeoutMs: 20 });
    expect(out).toMatchObject({ ok: false, reason: 'phone-unavailable' });
  });

  it('stops a download that is still streaming at the deadline', async () => {
    const destroy = jest.fn();
    async function* slow(): AsyncGenerator<Buffer> {
      yield Buffer.from('a');
      await new Promise(r => setTimeout(r, 60));
      yield Buffer.from('b');
    }
    const stream = Object.assign(slow(), { destroy });
    const { fetch } = build(() => stream);
    const out = await fetch.fetchByRef(ref(), { timeoutMs: 20 });
    expect(out).toMatchObject({ ok: false, reason: 'phone-unavailable' });
    expect(destroy).toHaveBeenCalled();
  });
});

describe('BaileysMediaFetch.requestOlder', () => {
  it('asks the phone for older messages, keyed by the engine form of the chat', async () => {
    const fetchMessageHistory = jest.fn(() => Promise.resolve('token-1'));
    const { fetch } = build(() => chunks(''), { fetchMessageHistory });
    expect(await fetch.requestOlder('628111@c.us', { id: 'OLD1', fromMe: true, timestamp: 1_700_000_000 }, 50)).toBe(
      'token-1',
    );
    expect(fetchMessageHistory).toHaveBeenCalledWith(
      50,
      { remoteJid: '628111@s.whatsapp.net', id: 'OLD1', fromMe: true },
      1_700_000_000,
    );
  });

  it('names the sender for a group message', async () => {
    const fetchMessageHistory = jest.fn(() => Promise.resolve('t'));
    const { fetch } = build(() => chunks(''), { fetchMessageHistory });
    await fetch.requestOlder('g@g.us', { id: 'O', fromMe: false, timestamp: 1, participant: 'p@s.whatsapp.net' }, 10);
    expect(fetchMessageHistory).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ participant: 'p@s.whatsapp.net' }),
      1,
    );
  });
});
