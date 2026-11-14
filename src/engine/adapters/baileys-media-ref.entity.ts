import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Session } from '../../modules/session/entities/session.entity';
import type { MediaRefKind } from '../types/baileys.types';

/** Where a reference stands: waiting to be downloaded, downloaded, gone from WhatsApp, or failed for now. */
export type MediaRefStatus = 'pending' | 'done' | 'expired' | 'failed';

/**
 * One attachment seen in a history sync, kept so it can be downloaded later.
 *
 * History sync sends each message's attachment as a key and a WhatsApp-side path, never the file. The sync handler used
 * to turn messages into media-free records and discard those, so the file could never be fetched afterwards. This table
 * keeps them. `baileys_stored_messages` is not used for it: that table is capped (newest N, default 5000) and exists to
 * resolve a message for reply/forward/react, not to hold a backlog.
 *
 * CASCADE-deleted with its session. `mediaKey` decrypts the file, so the row is as sensitive as the session's auth data.
 */
@Entity('baileys_media_refs')
@Index(['sessionId', 'waMessageId'], { unique: true })
@Index('IDX_baileys_media_refs_session_status', ['sessionId', 'status'])
export class BaileysMediaRef {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session?: Session;

  @Column()
  waMessageId!: string;

  @Column()
  chatId!: string;

  @Column({ type: 'boolean', default: false })
  fromMe!: boolean;

  @Column({ type: 'varchar' })
  kind!: MediaRefKind;

  @Column({ type: 'varchar', nullable: true })
  mimetype!: string | null;

  @Column({ type: 'integer', nullable: true })
  fileLength!: number | null;

  @Column({ type: 'text' })
  mediaKey!: string;

  @Column({ type: 'text', nullable: true })
  directPath!: string | null;

  @Column({ type: 'text', nullable: true })
  url!: string | null;

  @Column({ type: 'varchar', nullable: true })
  fileEncSha256!: string | null;

  @Column({ type: 'varchar', nullable: true })
  fileSha256!: string | null;

  @Column({ type: 'integer', nullable: true })
  mediaKeyTimestamp!: number | null;

  @Column({ type: 'integer', nullable: true })
  messageTimestamp!: number | null;

  @Column({ type: 'varchar', default: 'pending' })
  status!: MediaRefStatus;

  /** How many download attempts have been made. */
  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  /** When the last attempt ran, unix seconds (a plain number: the same on SQLite and Postgres). */
  @Column({ type: 'integer', nullable: true })
  lastAttemptAt!: number | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
