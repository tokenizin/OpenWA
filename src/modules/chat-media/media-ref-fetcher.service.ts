import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { In, Repository } from 'typeorm';
import { BaileysMediaRef } from '../../engine/adapters/baileys-media-ref.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus, type IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { MediaRef } from '../../engine/types/baileys.types';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { ChatMediaArchiveService, DEFAULT_ARCHIVE_MAX_BYTES } from './chat-media-archive.service';
import {
  decideHistory,
  isDue,
  newHistoryState,
  parseChatList,
  updateFor,
  type HistoryChatState,
  type RefResult,
} from './media-ref-fetch-policy';
import { startGuardedInterval } from '../../common/utils/guarded-interval';
import { createLogger } from '../../common/services/logger.service';

/** Retries considered per pass: enough to find one that is due without reading the whole backlog. */
const RETRY_CANDIDATES = 25;

export interface FetchTick {
  /** What this pass did with the one reference it picked; null when there was nothing to do. */
  result: { chatId: string; waMessageId: string; outcome: string } | null;
}

export interface FetchSettings {
  enabled: boolean;
  intervalMs: number;
  chats: string[];
  maxAttempts: number;
  timeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  historyEnabled: boolean;
  historyIntervalMs: number;
  historyPageSize: number;
  historyMaxPages: number;
  historyWaitMs: number;
}

/**
 * Fetches, slowly and in the background, the attachments a history sync left only references to, and
 * asks the phone for older history in the chats it is told to.
 *
 * Two independent loops, both off unless configured (see `chatMedia.refFetch`):
 *
 *   - fetch: one reference per pass. The engine downloads it from WhatsApp, or has the phone upload it
 *     again, and the file is stored through the chat-media archive and pointed at by the message row,
 *     which is what the per-message media route serves. The outcome is written back to the reference,
 *     so what has worked, what has expired and what is waiting can be read from `baileys_media_refs`.
 *   - history: per listed chat, one request for older messages when the previous answer is in. The
 *     answers come back through the history sync, which persists them and keeps their references for
 *     the loop above.
 *
 * The rate is one file per `intervalMs` and one history request per `historyIntervalMs`, deliberately
 * low: both ask WhatsApp for things a person's own app would not ask for in bulk.
 */
@Injectable()
export class MediaRefFetcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('MediaRefFetcher');
  private stops: Array<() => void> = [];
  private warnedArchiveOff = false;
  private sessionCursor = 0;
  private readonly history = new Map<string, HistoryChatState>();

  constructor(
    @InjectRepository(BaileysMediaRef, 'data') private readonly refs: Repository<BaileysMediaRef>,
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
    private readonly archive: ChatMediaArchiveService,
    private readonly registry: EngineRegistry,
    private readonly configService: ConfigService,
  ) {}

  get settings(): FetchSettings {
    const c = this.configService.get<Omit<FetchSettings, 'chats'> & { chats: string }>('chatMedia.refFetch');
    return {
      enabled: c?.enabled ?? false,
      intervalMs: c?.intervalMs ?? 20_000,
      chats: parseChatList(c?.chats),
      maxAttempts: c?.maxAttempts ?? 5,
      timeoutMs: c?.timeoutMs ?? 90_000,
      retryBaseMs: c?.retryBaseMs ?? 15 * 60_000,
      retryMaxMs: c?.retryMaxMs ?? 6 * 60 * 60_000,
      historyEnabled: c?.historyEnabled ?? false,
      historyIntervalMs: c?.historyIntervalMs ?? 60_000,
      historyPageSize: c?.historyPageSize ?? 50,
      historyMaxPages: c?.historyMaxPages ?? 40,
      historyWaitMs: c?.historyWaitMs ?? 120_000,
    };
  }

  onModuleInit(): void {
    const s = this.settings;
    if (!s.enabled) return;
    const failed = (what: string) => (err: unknown) =>
      this.logger.error(`${what} failed`, err instanceof Error ? err.stack : String(err));
    this.logger.log(
      `Media fetch on: one file every ${Math.round(s.intervalMs / 1000)}s, ` +
        (s.chats.length ? `chats ${s.chats.join(', ')}` : 'all chats') +
        (s.historyEnabled
          ? `, asking for older history in those chats every ${Math.round(s.historyIntervalMs / 1000)}s`
          : ''),
    );
    this.stops.push(startGuardedInterval(() => this.fetchTick(), s.intervalMs, failed('Media fetch')));
    if (s.historyEnabled && s.chats.length > 0) {
      this.stops.push(startGuardedInterval(() => this.historyTick(), s.historyIntervalMs, failed('History request')));
    }
  }

  onModuleDestroy(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  /** The sessions whose engine can fetch, in a rotating order so one busy session cannot starve another. */
  private fetchableSessions(): Array<[string, IWhatsAppEngine]> {
    const live = this.registry
      .entries()
      .filter(([, e]) => typeof e.fetchMediaByRef === 'function' && e.getStatus() === EngineStatus.READY);
    if (live.length === 0) return [];
    const start = this.sessionCursor++ % live.length;
    return [...live.slice(start), ...live.slice(0, start)];
  }

  /** The next reference to work on in a session: never tried first, newest first, else a retry that is due. */
  private async nextRef(sessionId: string, now: number): Promise<BaileysMediaRef | null> {
    const s = this.settings;
    const base = () => {
      const qb = this.refs
        .createQueryBuilder('r')
        .where('r.sessionId = :sessionId', { sessionId })
        .andWhere("r.status = 'pending'")
        .andWhere('r.attempts < :max', { max: s.maxAttempts });
      if (s.chats.length) qb.andWhere('r.chatId IN (:...chats)', { chats: s.chats });
      return qb;
    };
    // Newest first: WhatsApp keeps recent media longest, so the files most likely to still be there go first.
    const fresh = await base()
      .andWhere('r.attempts = 0')
      .orderBy('r.messageTimestamp', 'DESC')
      .addOrderBy('r.id', 'ASC')
      .limit(1)
      .getOne();
    if (fresh) return fresh;
    const retries = await base()
      .andWhere('r.attempts > 0')
      .orderBy('r.lastAttemptAt', 'ASC')
      .limit(RETRY_CANDIDATES)
      .getMany();
    return retries.find(r => isDue(r.attempts, r.lastAttemptAt, now, s.retryBaseMs, s.retryMaxMs)) ?? null;
  }

  /** One pass: take one reference and try to bring its file in. */
  async fetchTick(now = Date.now()): Promise<FetchTick> {
    const s = this.settings;
    if (!s.enabled) return { result: null };
    if (!this.archive.enabled) {
      if (!this.warnedArchiveOff) {
        this.warnedArchiveOff = true;
        this.logger.warn(
          'Media fetch is on but the chat-media archive is off (CHAT_MEDIA_ARCHIVE_ENABLED); nothing to store into',
        );
      }
      return { result: null };
    }
    for (const [sessionId, engine] of this.fetchableSessions()) {
      const ref = await this.nextRef(sessionId, now);
      if (!ref) continue;
      const result = await this.fetchOne(sessionId, engine, ref);
      const nowSec = Math.floor(now / 1000);
      const update = updateFor(result, ref.attempts, s.maxAttempts, nowSec);
      if (update) await this.refs.update({ id: ref.id }, update);
      const outcome = update?.status ?? 'skipped';
      this.logger.log(
        `Media ${ref.kind} ${ref.waMessageId} in ${ref.chatId}: ${outcome}` +
          (update?.lastError ? ` (${update.lastError})` : ''),
      );
      return { result: { chatId: ref.chatId, waMessageId: ref.waMessageId, outcome } };
    }
    return { result: null };
  }

  private async fetchOne(sessionId: string, engine: IWhatsAppEngine, ref: BaileysMediaRef): Promise<RefResult> {
    const row = await this.archive.findMediaRow(sessionId, [ref.chatId], ref.waMessageId);
    if (!row) return { kind: 'no-row' };
    if (row.archived) return { kind: 'already-archived' };
    const media: MediaRef = {
      waMessageId: ref.waMessageId,
      chatId: ref.chatId,
      fromMe: ref.fromMe,
      kind: ref.kind,
      mimetype: ref.mimetype,
      fileLength: ref.fileLength,
      mediaKey: ref.mediaKey,
      directPath: ref.directPath,
      url: ref.url,
      fileEncSha256: ref.fileEncSha256,
      fileSha256: ref.fileSha256,
      mediaKeyTimestamp: ref.mediaKeyTimestamp,
      messageTimestamp: ref.messageTimestamp,
    };
    const s = this.settings;
    const outcome = await engine.fetchMediaByRef!(media, {
      maxBytes: this.configService.get<number>('chatMedia.maxBytes', DEFAULT_ARCHIVE_MAX_BYTES),
      timeoutMs: s.timeoutMs,
    });
    if (!outcome.ok) return { kind: 'fetch-failed', outcome };
    const stored = await this.archive.archiveFetched({ id: row.id, sessionId }, outcome.bytes, outcome.mimetype);
    switch (stored.status) {
      case 'archived':
      case 'already':
        return { kind: 'fetched' };
      case 'too-large':
        return { kind: 'archive-refused', detail: 'over the archive size cap' };
      case 'disabled':
        return { kind: 'archive-refused', detail: 'the archive was switched off' };
      case 'failed':
        return { kind: 'archive-failed' };
    }
  }

  /** The oldest message held for a chat, as the anchor older history is requested from. */
  private async oldestMessage(sessionId: string, chatId: string) {
    return this.messages.findOne({
      where: { sessionId, chatId: In([chatId]) },
      order: { timestamp: 'ASC', id: 'ASC' },
      select: { id: true, waMessageId: true, direction: true, timestamp: true, author: true },
    });
  }

  /** One pass over the listed chats: ask for older history wherever the previous answer is in. */
  async historyTick(now = Date.now()): Promise<Array<{ chatId: string; action: string }>> {
    const s = this.settings;
    const done: Array<{ chatId: string; action: string }> = [];
    if (!s.enabled || !s.historyEnabled || s.chats.length === 0) return done;
    for (const [sessionId, engine] of this.registry.entries()) {
      if (typeof engine.requestOlderHistory !== 'function' || engine.getStatus() !== EngineStatus.READY) continue;
      for (const chatId of s.chats) {
        const key = `${sessionId}\u0000${chatId}`;
        const oldest = await this.oldestMessage(sessionId, chatId);
        const decision = decideHistory(this.history.get(key) ?? newHistoryState(), oldest?.waMessageId ?? null, now, {
          waitMs: s.historyWaitMs,
          maxPages: s.historyMaxPages,
          maxMisses: 2,
        });
        this.history.set(key, decision.state);
        if (decision.action === 'done') {
          this.logger.log(
            `History for ${chatId}: stopped (${decision.state.doneReason}); ${decision.state.pages} pages in`,
          );
        }
        if (decision.action !== 'request' || !oldest) {
          done.push({ chatId, action: decision.action });
          continue;
        }
        try {
          await engine.requestOlderHistory(
            chatId,
            {
              id: oldest.waMessageId,
              fromMe: oldest.direction === MessageDirection.OUTGOING,
              timestamp: oldest.timestamp,
              ...(oldest.author && chatId.endsWith('@g.us') ? { participant: oldest.author } : {}),
            },
            s.historyPageSize,
          );
          this.logger.log(
            `History for ${chatId}: asked for ${s.historyPageSize} messages older than ${oldest.waMessageId}`,
          );
          done.push({ chatId, action: 'request' });
          // One request per pass: the pass is the rate limit.
          return done;
        } catch (err) {
          // Not sent: leave the walk where it was so the next pass asks again.
          this.history.set(key, { ...decision.state, waitingSince: null });
          this.logger.warn(`History request for ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`);
          done.push({ chatId, action: 'failed' });
        }
      }
    }
    return done;
  }
}
