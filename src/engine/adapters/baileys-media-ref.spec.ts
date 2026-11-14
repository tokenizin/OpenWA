import { extractMediaRef, type MediaRefSource } from './baileys-media-ref';

/** What a history sync delivers for an attachment is a key and a path, never the file. */

const source: MediaRefSource = { id: 'ABC123', chatId: '628111@c.us', fromMe: false, timestamp: 1_760_000_000 };
const key = Uint8Array.from([1, 2, 3, 250, 251, 252]);
const keyB64 = Buffer.from(key).toString('base64');
const node = (extra: Record<string, unknown> = {}) => ({
  mediaKey: key,
  directPath: '/v/t62.7118-24/abc',
  url: 'https://mmg.whatsapp.net/v/t62.7118-24/abc',
  mimetype: 'image/jpeg',
  fileLength: 48_213,
  fileSha256: Uint8Array.from([9, 9]),
  fileEncSha256: Uint8Array.from([8, 8]),
  mediaKeyTimestamp: 1_759_000_000,
  ...extra,
});

describe('extractMediaRef', () => {
  it('reads an image attachment, with the key as base64 and the message it belongs to', () => {
    expect(extractMediaRef({ imageMessage: node() }, source)).toEqual({
      waMessageId: 'ABC123',
      chatId: '628111@c.us',
      fromMe: false,
      kind: 'image',
      mimetype: 'image/jpeg',
      fileLength: 48_213,
      mediaKey: keyB64,
      directPath: '/v/t62.7118-24/abc',
      url: 'https://mmg.whatsapp.net/v/t62.7118-24/abc',
      fileEncSha256: Buffer.from([8, 8]).toString('base64'),
      fileSha256: Buffer.from([9, 9]).toString('base64'),
      mediaKeyTimestamp: 1_759_000_000,
      messageTimestamp: 1_760_000_000,
    });
  });

  it.each([
    ['videoMessage', 'video'],
    ['ptvMessage', 'video'],
    ['audioMessage', 'audio'],
    ['documentMessage', 'document'],
    ['stickerMessage', 'sticker'],
  ])('%s is kind %s', (field, kind) => {
    expect(extractMediaRef({ [field]: node() }, source)?.kind).toBe(kind);
  });

  it('is null for a message with no attachment', () => {
    expect(extractMediaRef({ conversation: 'hello' }, source)).toBeNull();
    expect(extractMediaRef(null, source)).toBeNull();
    expect(extractMediaRef(undefined, source)).toBeNull();
  });

  it('is null when the key is missing: without it the file cannot be decrypted', () => {
    expect(extractMediaRef({ imageMessage: node({ mediaKey: undefined }) }, source)).toBeNull();
    expect(extractMediaRef({ imageMessage: node({ mediaKey: new Uint8Array(0) }) }, source)).toBeNull();
    expect(extractMediaRef({ imageMessage: node({ mediaKey: null }) }, source)).toBeNull();
  });

  it('is null when there is nowhere to fetch from', () => {
    expect(extractMediaRef({ imageMessage: node({ directPath: undefined, url: undefined }) }, source)).toBeNull();
  });

  it('keeps a reference that has a path but no URL, or a URL but no path', () => {
    expect(extractMediaRef({ imageMessage: node({ url: undefined }) }, source)?.url).toBeNull();
    expect(extractMediaRef({ imageMessage: node({ directPath: undefined }) }, source)?.directPath).toBeNull();
  });

  it('reads sizes and times that arrive as a Long, as a decimal string, or as a number', () => {
    const long = (n: number) => ({ toNumber: () => n });
    const r = extractMediaRef(
      { imageMessage: node({ fileLength: long(1234), mediaKeyTimestamp: '1759000001' }) },
      source,
    );
    expect([r?.fileLength, r?.mediaKeyTimestamp]).toEqual([1234, 1_759_000_001]);
  });

  it('stores no size it cannot hold, rather than a wrong one', () => {
    for (const bad of [-1, 2 ** 31, 1.5, 'abc', {}, NaN]) {
      expect(extractMediaRef({ imageMessage: node({ fileLength: bad }) }, source)?.fileLength).toBeNull();
    }
  });

  it('accepts a key that is already base64 text, and a Buffer view into a larger buffer', () => {
    expect(extractMediaRef({ imageMessage: node({ mediaKey: 'AQID' }) }, source)?.mediaKey).toBe('AQID');
    const big = Buffer.from([0, 0, 1, 2, 3, 0, 0]);
    expect(extractMediaRef({ imageMessage: node({ mediaKey: big.subarray(2, 5) }) }, source)?.mediaKey).toBe('AQID');
  });

  it('needs the message id and chat to file the reference under', () => {
    expect(extractMediaRef({ imageMessage: node() }, { ...source, id: '' })).toBeNull();
    expect(extractMediaRef({ imageMessage: node() }, { ...source, chatId: '' })).toBeNull();
  });

  it('leaves the time empty when the message has none', () => {
    expect(extractMediaRef({ imageMessage: node() }, { ...source, timestamp: null })?.messageTimestamp).toBeNull();
    expect(extractMediaRef({ imageMessage: node() }, { ...source, timestamp: NaN })?.messageTimestamp).toBeNull();
  });

  it('takes the first attachment node when a message somehow has more than one', () => {
    expect(extractMediaRef({ videoMessage: node(), imageMessage: node() }, source)?.kind).toBe('image');
  });
});
