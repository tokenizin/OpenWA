import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `baileys_media_refs`: the key and path of every attachment a history sync delivered, kept so the file can be
 * downloaded later (the sync carries references, never bytes). CASCADE-deleted with its session. Hand-authored because
 * `synchronize` is off for the `data` connection on Postgres (and optional on SQLite).
 */
export class AddBaileysMediaRefs1791900000000 implements MigrationInterface {
  name = 'AddBaileysMediaRefs1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('baileys_media_refs')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    const columns = (id: string, bool: string, created: string): string =>
      `${id}, "sessionId" varchar NOT NULL, "waMessageId" varchar NOT NULL, "chatId" varchar NOT NULL, ` +
      `"fromMe" ${bool}, "kind" varchar NOT NULL, "mimetype" varchar, "fileLength" integer, "mediaKey" text NOT NULL, ` +
      `"directPath" text, "url" text, "fileEncSha256" varchar, "fileSha256" varchar, "mediaKeyTimestamp" integer, ` +
      `"messageTimestamp" integer, "status" varchar NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT 0, ` +
      `"lastAttemptAt" integer, "lastError" text, "createdAt" ${created}, "updatedAt" ${created}, ` +
      `CONSTRAINT "FK_baileys_media_refs_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION`;

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "baileys_media_refs" (${columns(
          '"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar',
          'boolean NOT NULL DEFAULT false',
          'timestamp NOT NULL DEFAULT NOW()',
        )})`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "baileys_media_refs" (${columns(
          '"id" varchar PRIMARY KEY NOT NULL',
          'boolean NOT NULL DEFAULT (0)',
          "datetime NOT NULL DEFAULT (datetime('now'))",
        )})`,
      );
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_baileys_media_refs_session_wamsg" ON "baileys_media_refs" ("sessionId", "waMessageId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_baileys_media_refs_session_status" ON "baileys_media_refs" ("sessionId", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so a revert is idempotent on a synchronize-bootstrapped DB, where this migration was recorded through
    // the up() hasTable early return and the named indexes were never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_baileys_media_refs_session_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_baileys_media_refs_session_wamsg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "baileys_media_refs"`);
  }
}
