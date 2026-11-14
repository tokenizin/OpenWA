import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { mainDateColumnType } from '../../../common/utils/column-types';
import { MainDateTransformer } from '../../../common/transformers/date.transformer';

export enum ApiKeyRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
  VIEWER = 'viewer',
}

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  keyHash: string;

  // 12 to fit the 12-char prefix that auth.service writes (was varchar(8); harmless on the
  // hardcoded-SQLite `main` connection, but kept consistent with the code).
  @Column({ type: 'varchar', length: 12 })
  keyPrefix: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: ApiKeyRole.OPERATOR,
  })
  role: ApiKeyRole;

  @Column({ type: 'simple-array', nullable: true })
  allowedIps: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  allowedSessions: string[] | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  // mainDateColumnType() → 'datetime' on SQLite (unchanged) / 'timestamp' on Postgres. MainDateTransformer
  // keeps a JS Date on both sides and writes a native Date to pg's timestamp, while SQLite keeps
  // its historical ISO-string form — so expiry checks behave identically either way.
  @Column({ type: mainDateColumnType(), nullable: true, transformer: MainDateTransformer })
  expiresAt: Date | null;

  @Column({ type: mainDateColumnType(), nullable: true, transformer: MainDateTransformer })
  lastUsedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  usageCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
