import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `api_keys` (auth) and `audit_logs` tables on the **main** connection.
 * The main connection was previously schema-managed only by
 * `synchronize: true`, with no migrations — so turning synchronize off would leave a
 * fresh install with no `api_keys` table and total auth failure at boot.
 *
 * This migration is what the `main` connection runs when `MAIN_DATABASE_SYNCHRONIZE=false`
 * (`migrationsRun: !synchronize` on SQLite; `migrationsRun: true` on Postgres). `IF NOT EXISTS`
 * makes it idempotent so it is also safe to adopt on a DB previously created by synchronize.
 *
 * The main connection is independently pluggable via MAIN_DATABASE_TYPE, so this migration is
 * dialect-aware — resolved from `qr.dataSource.options.type` (the dialect actually in use), the
 * same pattern the data migrations use, rather than from an env var that could disagree with the
 * live connection. SQLite keeps `datetime` + `datetime('now')`; Postgres gets `timestamp` +
 * `now()` and a schema-qualified name so the tables land in POSTGRES_MAIN_SCHEMA (not `public`).
 */
export class CreateAuthAuditTables1779900000000 implements MigrationInterface {
  name = 'CreateAuthAuditTables1779900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    // Postgres has no `CREATE INDEX IF NOT EXISTS`, but DO supports `CREATE SCHEMA IF NOT EXISTS`.
    // A non-public schema must exist before a qualified CREATE TABLE, so create it first.
    const schema = isPostgres ? (queryRunner.dataSource.options.schema || 'public') : null;
    const q = (table: string): string => (schema ? `"${schema}"."${table}"` : `"${table}"`);

    if (isPostgres) {
      await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    }

    // Timestamp column type + default per dialect. Postgres has no `datetime` type at all, and
    // `integer`/`boolean` defaults must be written in its own syntax.
    const ts = isPostgres ? 'timestamp' : 'datetime';
    const tsNow = isPostgres ? 'now()' : "datetime('now')";
    const boolDefault = isPostgres ? 'true' : '1';

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS ${q('api_keys')} (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"keyHash" varchar(64) NOT NULL, ` +
        `"keyPrefix" varchar(12) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT ('operator'), ` +
        `"allowedIps" text, ` +
        `"allowedSessions" text, ` +
        `"isActive" boolean NOT NULL DEFAULT (${boolDefault}), ` +
        `"expiresAt" ${ts}, ` +
        `"lastUsedAt" ${ts}, ` +
        `"usageCount" integer NOT NULL DEFAULT (0), ` +
        `"createdAt" ${ts} NOT NULL DEFAULT (${tsNow}), ` +
        `"updatedAt" ${ts} NOT NULL DEFAULT (${tsNow})` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_api_keys_keyHash" ON ${q('api_keys')} ("keyHash")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS ${q('audit_logs')} (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"action" varchar(50) NOT NULL, ` +
        `"severity" varchar(10) NOT NULL DEFAULT ('info'), ` +
        `"apiKeyId" varchar(36), ` +
        `"apiKeyName" varchar(100), ` +
        `"sessionId" varchar(36), ` +
        `"sessionName" varchar(100), ` +
        `"ipAddress" varchar(45), ` +
        `"userAgent" varchar(500), ` +
        `"method" varchar(10), ` +
        `"path" varchar(500), ` +
        `"statusCode" integer, ` +
        `"metadata" text, ` +
        `"errorMessage" text, ` +
        `"createdAt" ${ts} NOT NULL DEFAULT (${tsNow})` +
        `)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON ${q('audit_logs')} ("action")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_apiKeyId" ON ${q('audit_logs')} ("apiKeyId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_sessionId" ON ${q('audit_logs')} ("sessionId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_createdAt" ON ${q('audit_logs')} ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const schema = isPostgres ? (queryRunner.dataSource.options.schema || 'public') : null;
    const q = (table: string): string => (schema ? `"${schema}"."${table}"` : `"${table}"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_sessionId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_apiKeyId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_action"`);
    await queryRunner.query(`DROP TABLE IF EXISTS ${q('audit_logs')}`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_api_keys_keyHash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS ${q('api_keys')}`);
  }
}
