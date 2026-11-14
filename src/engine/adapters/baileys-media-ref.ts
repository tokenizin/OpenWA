import type { MediaRef, MediaRefKind } from '../types/baileys.types';

/** The message a reference belongs to, as the engine files it. */
export interface MediaRefSource {
  /** `messages.waMessageId`. */
  id: string;
  /** The neutral chat id. */
  chatId: string;
  fromMe: boolean;
  /** Unix seconds. */
  timestamp: number | null;
}

/** The message-content fields that carry an attachment, and what each one is. `ptvMessage` is a video note. */
const MEDIA_NODES: ReadonlyArray<readonly [string, MediaRefKind]> = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['ptvMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
];

/** WhatsApp sizes fit a 32-bit integer; anything else is not stored rather than stored wrong. */
const MAX_INT32 = 2_147_483_647;

/** A protobuf number: a plain number, a Long, or its decimal string. Null for anything else, negative, or too big. */
function toInt(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) n = Number(value);
  else if (value && typeof (value as { toNumber?: unknown }).toNumber === 'function')
    n = (value as { toNumber(): number }).toNumber();
  else return null;
  return Number.isInteger(n) && n >= 0 && n <= MAX_INT32 ? n : null;
}

/** Bytes as base64. A string is taken as already encoded. Null for anything else, and for nothing at all. */
function toBase64(value: unknown): string | null {
  if (typeof value === 'string') return value.length ? value : null;
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    const view = value as Uint8Array;
    return view.byteLength ? Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64') : null;
  }
  return null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length ? value : null);

/**
 * The attachment reference a message carries, or null when it has none. `content` is the message content with any
 * wrapper (ephemeral, view-once, caption document) already removed, as `normalizeMessageContent` leaves it.
 *
 * A reference needs a key (without it the file cannot be decrypted) and somewhere to fetch from (a path or a URL).
 * A message missing either is not a reference worth keeping: WhatsApp sent a thumbnail or a placeholder only.
 */
export function extractMediaRef(content: object | null | undefined, source: MediaRefSource): MediaRef | null {
  if (!content || !source.id || !source.chatId) return null;
  const record = content as Record<string, unknown>;
  for (const [field, kind] of MEDIA_NODES) {
    const node = record[field] as Record<string, unknown> | null | undefined;
    if (!node || typeof node !== 'object') continue;
    const mediaKey = toBase64(node.mediaKey);
    const directPath = text(node.directPath);
    const url = text(node.url);
    if (!mediaKey || (!directPath && !url)) return null;
    return {
      waMessageId: source.id,
      chatId: source.chatId,
      fromMe: source.fromMe,
      kind,
      mimetype: text(node.mimetype),
      fileLength: toInt(node.fileLength),
      mediaKey,
      directPath,
      url,
      fileEncSha256: toBase64(node.fileEncSha256),
      fileSha256: toBase64(node.fileSha256),
      mediaKeyTimestamp: toInt(node.mediaKeyTimestamp),
      messageTimestamp:
        source.timestamp !== null && Number.isFinite(source.timestamp) ? Math.floor(source.timestamp) : null,
    };
  }
  return null;
}
