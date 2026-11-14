import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { MediaFetchFailure, MediaFetchOutcome } from '../interfaces/whatsapp-engine.interface';
import type { MediaRef, MediaRefKind } from '../types/baileys.types';
import { isWhatsAppMediaSource } from './baileys-events';
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

/** The HTTP status behind a failure: Baileys throws a Boom, which carries it in `output.statusCode`. */
export function statusOf(err: unknown): number | undefined {
  const e = (err ?? {}) as FailureShape;
  return [e.status, e.output?.statusCode].find((v): v is number => typeof v === 'number');
}

/**
 * The statuses of a media link that has stopped working: gone (404, 410) or its signed address expired (403).
 * Only then is the phone asked to upload the file again.
 */
const DEAD_LINK = new Set([403, 404, 410]);

/** What a failure says, without the signed address in it (it is a credential and is long). */
function describe(err: unknown): string {
  const e = (err ?? {}) as FailureShape;
  const text = err instanceof Error ? err.message : typeof e.message === 'string' ? e.message : String(err);
  const bare = text.replace(/https?:\/\/\S+/g, u => {
    try {
      return new URL(u).host;
    } catch {
      return 'address';
    }
  });
  const code = statusOf(err);
  return code === undefined ? bare : `HTTP ${code}: ${bare}`;
}

/** Where a fetch was when it failed: the first download, the request to the phone, or the second download. */
export type FetchStage = 'download' | 'reupload' | 'redownload';

/**
 * Sort a failed fetch into what a caller can do about it. The phone has been asked by the time a failure
 * of the later stages is seen: a re-upload it answers "not found" to, or a link still dead after it, means
 * the file is gone, and is final.
 */
export function classifyFetchFailure(
  err: unknown,
  stage: FetchStage = 'download',
): { reason: MediaFetchFailure; detail: string } {
  const code = statusOf(err);
  const detail = describe(err);
  if (stage === 'reupload') {
    return code === 404
      ? { reason: 'expired', detail: `the phone no longer has the file (${detail})` }
      : { reason: 'error', detail: `re-upload request failed: ${detail}` };
  }
  if (stage === 'redownload' && code !== undefined && DEAD_LINK.has(code)) {
    return { reason: 'expired', detail: `still unavailable after the phone uploaded it again (${detail})` };
  }
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
    let stage: FetchStage = 'download';
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
      // No re-upload hook is passed: Baileys only retries through it on an error carrying `.status`, and the
      // error it throws carries the status in `output.statusCode`, so the retry never ran. It is done here.
      const download = async (m: WAMessage) =>
        (await b.downloadMediaMessage(
          m,
          'stream',
          dispatcher ? { options: { dispatcher } as RequestInit } : {},
        )) as AsyncIterable<Buffer> & { destroy?: () => void };
      let source: AsyncIterable<Buffer> & { destroy?: () => void };
      try {
        source = await download(msg);
      } catch (err) {
        const code = statusOf(err);
        if (code === undefined || !DEAD_LINK.has(code)) throw err;
        // The link is dead: the phone, if it still has the file, uploads it again at a new address.
        stage = 'reupload';
        const refreshed = guard(await sock.updateMediaMessage(msg));
        stage = 'redownload';
        source = await download(refreshed);
      }
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
      const failure = classifyFetchFailure(err, stage);
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
