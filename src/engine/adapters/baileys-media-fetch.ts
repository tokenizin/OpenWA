import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { MediaFetchFailure, MediaFetchOutcome } from '../interfaces/whatsapp-engine.interface';
import type { MediaRef, MediaRefKind } from '../types/baileys.types';
import { isWhatsAppMediaSource } from './baileys-events';
import { createSilentLogger } from './baileys-logger';
import { type createLogger } from '../../common/services/logger.service';

/** Default per-file cap for a fetched attachment (the chat-media archive's own default). */
export const DEFAULT_FETCH_MAX_BYTES = 25 * 1024 * 1024;
/**
 * How long one attachment may take, the phone's answer to a re-upload request included. Baileys waits for
 * that answer with no deadline of its own, so without this one a phone that is off would hold the fetch
 * until the socket closes.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 90_000;

const NODE_OF: Record<MediaRefKind, string> = {
  image: 'imageMessage',
  video: 'videoMessage',
  audio: 'audioMessage',
  document: 'documentMessage',
  sticker: 'stickerMessage',
};

export interface BaileysMediaFetchHost {
  getSocket(): WASocket;
  loadLib(): Promise<typeof BaileysLib>;
  /** The proxy dispatcher a proxied session must fetch through; undefined when direct. */
  getFetchDispatcher(): unknown;
  /** The id a chat is filed under in the engine's own dialect. */
  chatJid(chatId: string): string;
  readonly logger: ReturnType<typeof createLogger>;
}

/**
 * Rebuild just enough of the original message for Baileys to fetch and decrypt its attachment: the key
 * (which message the phone is asked about when the copy has to be uploaded again) and the media node. The
 * node always carries `url`, even when empty, because Baileys only treats a node as media when it has one.
 */
export function messageFromRef(ref: MediaRef, remoteJid: string, participant?: string): WAMessage {
  const buf = (v: string | null): Buffer | undefined => (v ? Buffer.from(v, 'base64') : undefined);
  const node = {
    url: ref.url ?? undefined,
    directPath: ref.directPath ?? undefined,
    mediaKey: Buffer.from(ref.mediaKey, 'base64'),
    mimetype: ref.mimetype ?? undefined,
    fileLength: ref.fileLength ?? undefined,
    fileSha256: buf(ref.fileSha256),
    fileEncSha256: buf(ref.fileEncSha256),
    mediaKeyTimestamp: ref.mediaKeyTimestamp ?? undefined,
  };
  return {
    key: { id: ref.waMessageId, remoteJid, fromMe: ref.fromMe, ...(participant ? { participant } : {}) },
    message: { [NODE_OF[ref.kind]]: node },
  };
}

interface FailureShape {
  status?: unknown;
  output?: { statusCode?: unknown };
  message?: unknown;
}

/**
 * Sort a failed fetch into what a caller can do about it. A 404/410 here has already been through the
 * re-upload request (Baileys retries those once), so it means the phone does not have the file either.
 */
export function classifyFetchFailure(err: unknown): { reason: MediaFetchFailure; detail: string } {
  const e = (err ?? {}) as FailureShape;
  const detail = err instanceof Error ? err.message : typeof e.message === 'string' ? e.message : String(err);
  const code = [e.status, e.output?.statusCode].find((v): v is number => typeof v === 'number');
  if (code === 404 || code === 410) return { reason: 'expired', detail };
  return { reason: 'error', detail };
}

/**
 * Fetches attachments from the references a history sync kept. Rate and order are the caller's business;
 * this does one thing per call.
 */
export class BaileysMediaFetch {
  constructor(private readonly host: BaileysMediaFetchHost) {}

  async fetchByRef(ref: MediaRef, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<MediaFetchOutcome> {
    const maxBytes = opts.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    if (ref.fileLength !== null && ref.fileLength > maxBytes) {
      return { ok: false, reason: 'too-large', detail: `declared ${ref.fileLength} bytes, cap ${maxBytes}` };
    }
    let sock: WASocket;
    try {
      sock = this.host.getSocket();
    } catch {
      return { ok: false, reason: 'not-ready', detail: 'no connection' };
    }

    let timedOut = false;
    let stream: { destroy?: () => void } | undefined;
    const work = async (): Promise<MediaFetchOutcome> => {
      const b = await this.host.loadLib();
      const msg = messageFromRef(ref, this.host.chatJid(ref.chatId));
      // The address came from a sender, so it is checked before and after a re-upload answer.
      const guard = (m: WAMessage): WAMessage => {
        if (!isWhatsAppMediaSource(b, m.message)) throw new RefusedHostError();
        return m;
      };
      guard(msg);
      const dispatcher = this.host.getFetchDispatcher();
      const source = (await b.downloadMediaMessage(
        msg,
        'stream',
        dispatcher ? { options: { dispatcher } as RequestInit } : {},
        { logger: createSilentLogger(), reuploadRequest: async m => guard(await sock.updateMediaMessage(m)) },
      )) as AsyncIterable<Buffer> & { destroy?: () => void };
      stream = source;
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of source) {
        if (timedOut) break;
        total += chunk.length;
        if (total > maxBytes) {
          source.destroy?.();
          return { ok: false, reason: 'too-large', detail: `over ${maxBytes} bytes` };
        }
        chunks.push(chunk);
      }
      if (timedOut) return { ok: false, reason: 'phone-unavailable', detail: 'timed out' };
      return { ok: true, bytes: Buffer.concat(chunks), mimetype: ref.mimetype ?? 'application/octet-stream' };
    };

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<MediaFetchOutcome>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        stream?.destroy?.();
        resolve({
          ok: false,
          reason: 'phone-unavailable',
          detail: `no answer within ${Math.round(timeoutMs / 1000)}s (the phone may be off or offline)`,
        });
      }, timeoutMs);
    });
    const run = work().catch((err: unknown): MediaFetchOutcome => {
      if (err instanceof RefusedHostError) return { ok: false, reason: 'refused-host', detail: err.message };
      const failure = classifyFetchFailure(err);
      return { ok: false, ...failure };
    });
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}

class RefusedHostError extends Error {
  constructor() {
    super('Media address is not a WhatsApp media host; not fetched');
  }
}
