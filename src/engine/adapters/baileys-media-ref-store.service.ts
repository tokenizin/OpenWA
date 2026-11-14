import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { BaileysMediaRef } from './baileys-media-ref.entity';
import { isMissingParentSessionError } from './baileys-message-store.service';
import type { BaileysMediaRefStore, MediaRef } from '../types/baileys.types';

/** Rows per statement: well inside SQLite's bound-variable limit (about 20 columns a row) and small enough to stay quick. */
const CHUNK = 200;

/**
 * Keeps the attachment references a history sync delivers (see `BaileysMediaRef`).
 *
 * A reference seen again (another history page, a re-sync) refreshes the key and path but leaves the row's download
 * progress alone, so a file already fetched is not queued again. A write never throws: the history sync that feeds it
 * must not fail because a reference could not be kept.
 */
@Injectable()
export class BaileysMediaRefStoreService implements BaileysMediaRefStore {
  private readonly logger = createLogger('BaileysMediaRefStore');
  private readonly orphanWarned = new Set<string>();

  constructor(
    @InjectRepository(BaileysMediaRef, 'data')
    private readonly repo: Repository<BaileysMediaRef>,
  ) {}

  async putMany(sessionId: string, refs: MediaRef[]): Promise<number> {
    // The same message id can arrive twice in one batch (a chat known under two id forms): the first one wins.
    const unique = new Map<string, MediaRef>();
    for (const ref of refs) if (!unique.has(ref.waMessageId)) unique.set(ref.waMessageId, ref);
    const rows = [...unique.values()];
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      try {
        // Only the reference columns are given, so a conflict updates those and nothing about progress.
        await this.repo.upsert(
          chunk.map(ref => ({ sessionId, ...ref })),
          { conflictPaths: ['sessionId', 'waMessageId'], skipUpdateIfNoValuesChanged: true },
        );
        written += chunk.length;
      } catch (err) {
        if (isMissingParentSessionError(err)) {
          if (!this.orphanWarned.has(sessionId)) {
            this.orphanWarned.add(sessionId);
            this.logger.warn(`Not keeping media references: session ${sessionId} has no row (deleted mid-sync).`);
          }
          return written;
        }
        this.logger.warn(
          `Could not keep ${chunk.length} media reference(s): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return written;
  }
}
