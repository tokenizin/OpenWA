import type { WAMessage } from '@whiskeysockets/baileys';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';
import type { ChatStateStore } from '../adapters/baileys-chat-state-store.service';
import type { StoredChatPreviewSource } from '../adapters/baileys-stored-chat-previews.service';

/**
 * Persistence boundary for the Baileys engine's message store. The adapter depends on this narrow
 * interface (not the concrete Nest service) so it stays unit-testable with a fake.
 */
export interface BaileysMessageStore {
  /**
   * Persist a message (idempotent on the same id) so it can be referenced by reply/forward/react/delete.
   * A read of the id issued any time after this is called waits for the write, so the message is
   * readable from the moment its write starts.
   */
  put(sessionId: string, msg: WAMessage): Promise<void>;
  /** Look up a previously-seen message by its id, or null. */
  getMessage(sessionId: string, messageId: string): Promise<WAMessage | null>;
  /**
   * Look up many messages in one query. Ids the store has never seen are simply absent from the
   * result, so the caller cannot assume the order or the length matches its input.
   */
  getMessages(sessionId: string, messageIds: string[]): Promise<WAMessage[]>;
  /**
   * Rewrite a stored message in place, for an edit or a delete for everyone. `change` returns the
   * replacement, or null to leave it untouched; an id the store does not hold stays absent.
   */
  update(sessionId: string, messageId: string, change: (stored: WAMessage) => WAMessage | null): Promise<void>;
  /**
   * Delete a stored message, but only while `shouldRemove` accepts the copy held when the delete runs.
   * An id the store does not hold stays absent. Queued behind any put() or update() of the same id.
   */
  remove(sessionId: string, messageId: string, shouldRemove: (stored: WAMessage) => boolean): Promise<void>;
  /** Remove all stored messages for a session (called on logout). */
  clearSession(sessionId: string): Promise<void>;
}

/** What kind of attachment a media reference points at. */
export type MediaRefKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/**
 * Everything needed to fetch (and decrypt) one message's attachment later: the key and the WhatsApp-side path, plus the
 * size and hashes WhatsApp checks it against. History sync delivers these and no file bytes, so a history message's
 * attachment can only be fetched if its reference was kept at the time. The key decrypts the file: treat it like session data.
 */
export interface MediaRef {
  /** The message's id as the engine stores it (`messages.waMessageId`). */
  waMessageId: string;
  /** The neutral chat id the message was filed under. */
  chatId: string;
  fromMe: boolean;
  kind: MediaRefKind;
  mimetype: string | null;
  fileLength: number | null;
  /** The attachment's encryption key, base64. */
  mediaKey: string;
  directPath: string | null;
  url: string | null;
  fileEncSha256: string | null;
  fileSha256: string | null;
  /** When WhatsApp issued the key, unix seconds. */
  mediaKeyTimestamp: number | null;
  /** When the message was sent, unix seconds. */
  messageTimestamp: number | null;
}

/** Persists media references seen in a history sync. Best effort: a failed write must never fail the sync. */
export interface BaileysMediaRefStore {
  /** Insert or refresh the references; a row already tracked keeps its download progress. Returns how many were written. */
  putMany(sessionId: string, refs: MediaRef[]): Promise<number>;
}

/**
 * Per-call construction config for {@link BaileysAdapter}. Engine-neutral fields come from the
 * factory; `authDir` is the base multi-file auth directory from the opaque `engine.baileys.*` blob
 * (the adapter appends the session id to isolate each session).
 */
export interface BaileysAdapterConfig {
  /** Session UUID (Session.id) — keys the on-disk auth directory, chat state and LID provenance. */
  sessionId: string;
  /** Session UUID (Session.id) — keys the FK-bound baileys_stored_messages rows via messageStore. */
  dbSessionId: string;
  authDir: string;
  proxyUrl?: string;
  /** Persisted store for reply/forward/react/delete. Provided by the plugin; the four ops require it. */
  messageStore?: BaileysMessageStore;
  /** Persisted, cross-session lid->phone resolution table. Backs lid resolution beyond the in-memory map. */
  lidMappingStore?: LidMappingStore;
  /** Persisted per-session mute/archive/pin, so those chat fields survive a reconnect Baileys cannot resync. */
  chatStateStore?: ChatStateStore;
  /** The newest stored message per chat, read once per engine to list the chats a new engine starts without. */
  storedChatPreviews?: StoredChatPreviewSource;
  /** Where a history sync's attachment references are kept so the files can be fetched later. Optional: absent means not kept. */
  mediaRefStore?: BaileysMediaRefStore;
}

/**
 * The minimal pino-compatible logger Baileys' `makeWASocket` expects. Declared locally so we can
 * pass a fully silent logger without taking a direct `pino` dependency.
 *
 * Matches the Baileys `ILogger` contract: each log method receives `(obj: unknown, msg?: string)`.
 */
export interface BaileysLogger {
  level: string;
  child: (bindings: Record<string, unknown>) => BaileysLogger;
  trace: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}
