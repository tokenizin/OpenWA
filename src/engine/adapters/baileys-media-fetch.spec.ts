import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import {
  BaileysMediaFetch,
  classifyFetchFailure,
  statusOf,
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

const boom = (
  statusCode: number,
  message = 'Failed to fetch stream from https://mmg.whatsapp.net/v/t/abc?oh=SECRET&oe=1',
) => Object.assign(new Error(message), { output: { statusCode } });

describe('statusOf', () => {
  it('reads the status of a Boom (output.statusCode), which is what Baileys throws, and a plain status', () => {
    expect(statusOf(boom(404))).toBe(404);
    expect(statusOf({ status: 410 })).toBe(410);
    expect(statusOf(new Error('x'))).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
  });
});

describe('classifyFetchFailure', () => {
  it('a failure of the first download is a plain error, with the HTTP status and no signed address', () => {
    const out = classifyFetchFailure(boom(500));
    expect(out.reason).toBe('error');
    expect(out.detail).toBe('HTTP 500: Failed to fetch stream from mmg.whatsapp.net');
    expect(out.detail).not.toContain('SECRET');
  });

  it('a re-upload the phone answers not found is final: the phone no longer has the file', () => {
    expect(classifyFetchFailure(boom(404, 'Media re-upload failed by device (NOT_FOUND)'), 'reupload')).toEqual({
      reason: 'expired',
      detail: 'the phone no longer has the file (HTTP 404: Media re-upload failed by device (NOT_FOUND))',
    });
  });

  it('any other failure of the re-upload request is an error to retry', () => {
    expect(classifyFetchFailure(boom(418, 'general error'), 'reupload').reason).toBe('error');
    expect(classifyFetchFailure(new Error('socket closed'), 'reupload').reason).toBe('error');
  });

  it('a link still dead after the re-upload is final; another failure is not', () => {
    for (const code of [403, 404, 410]) expect(classifyFetchFailure(boom(code), 'redownload').reason).toBe('expired');
    expect(classifyFetchFailure(boom(500), 'redownload').reason).toBe('error');
    expect(classifyFetchFailure(new Error('bad decrypt'), 'redownload').reason).toBe('error');
  });
});

describe('BaileysMediaFetch.fetchByRef', () => {
  it('returns the bytes and the mimetype', async () => {
    const { fetch } = build(() => chunks('ab', 'cd'));
    expect(await fetch.fetchByRef(ref())).toEqual({ ok: true, bytes: Buffer.from('abcd'), mimetype: 'image/jpeg' });
  });

  it('hands Baileys a message rebuilt from the reference, and does not use its own re-upload hook', async () => {
    const { fetch, downloadMediaMessage } = build(() => chunks('x'));
    await fetch.fetchByRef(ref());
    const [msg, type, , ctx] = downloadMediaMessage.mock.calls[0] as unknown as [WAMessage, string, unknown, unknown];
    expect(type).toBe('stream');
    expect(msg.key.remoteJid).toBe('628111@s.whatsapp.net');
    expect(ctx).toBeUndefined();
  });

  it('asks the phone to upload the file again when the link is dead, then downloads from the new address', async () => {
    const refreshed = { key: { id: 'M1' }, message: { imageMessage: { directPath: '/v/new', url: undefined } } };
    const updateMediaMessage = jest.fn(() => Promise.resolve(refreshed as unknown as WAMessage));
    let calls = 0;
    const { fetch, downloadMediaMessage } = build(() => (++calls === 1 ? Promise.reject(boom(404)) : chunks('fresh')), {
      updateMediaMessage,
    });
    const out = await fetch.fetchByRef(ref());
    expect(out).toEqual({ ok: true, bytes: Buffer.from('fresh'), mimetype: 'image/jpeg' });
    expect(updateMediaMessage).toHaveBeenCalledTimes(1);
    expect(downloadMediaMessage.mock.calls[1][0]).toBe(refreshed);
  });

  it.each([403, 404, 410])('treats HTTP %i as a dead link and asks the phone', async code => {
    const updateMediaMessage = jest.fn((m: WAMessage) => Promise.resolve(m));
    let calls = 0;
    const { fetch } = build(() => (++calls === 1 ? Promise.reject(boom(code)) : chunks('ok')), { updateMediaMessage });
    expect(await fetch.fetchByRef(ref())).toMatchObject({ ok: true });
    expect(updateMediaMessage).toHaveBeenCalledTimes(1);
  });

  it('does not bother the phone for a failure that is not about the link', async () => {
    const updateMediaMessage = jest.fn((m: WAMessage) => Promise.resolve(m));
    const { fetch } = build(() => Promise.reject(boom(500)), { updateMediaMessage });
    const out = await fetch.fetchByRef(ref());
    expect(out).toMatchObject({ ok: false, reason: 'error' });
    expect(out.ok ? '' : out.detail).toContain('HTTP 500');
    expect(updateMediaMessage).not.toHaveBeenCalled();
  });

  it('says expired when the phone answers that it no longer has the file', async () => {
    const updateMediaMessage = jest.fn(() => Promise.reject(boom(404, 'Media re-upload failed by device (NOT_FOUND)')));
    const { fetch } = build(() => Promise.reject(boom(404)), { updateMediaMessage });
    expect(await fetch.fetchByRef(ref())).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('says expired when the link is still dead after the phone uploaded the file again', async () => {
    const updateMediaMessage = jest.fn((m: WAMessage) => Promise.resolve(m));
    const { fetch } = build(() => Promise.reject(boom(410)), { updateMediaMessage });
    expect(await fetch.fetchByRef(ref())).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('says phone-unavailable when the phone never answers the re-upload request', async () => {
    const updateMediaMessage = jest.fn(() => new Promise<WAMessage>(() => undefined));
    const { fetch } = build(() => Promise.reject(boom(404)), { updateMediaMessage });
    expect(await fetch.fetchByRef(ref(), { timeoutMs: 30 })).toMatchObject({ ok: false, reason: 'phone-unavailable' });
  });

  it('refuses an address that a re-upload answer moved off WhatsApp', async () => {
    const moved = {
      message: { imageMessage: { url: 'https://evil.example/x', directPath: undefined } },
    } as unknown as WAMessage;
    const updateMediaMessage = jest.fn(() => Promise.resolve(moved));
    const { fetch, downloadMediaMessage } = build(() => Promise.reject(boom(404)), { updateMediaMessage });
    const out = await fetch.fetchByRef(ref());
    expect(out).toMatchObject({ ok: false, reason: 'refused-host' });
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
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

  it('says error, with its message, for a failure that is not about the link', async () => {
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
