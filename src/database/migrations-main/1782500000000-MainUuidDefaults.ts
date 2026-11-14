import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives the MAIN connection's `api_keys` / `audit_logs` tables a DB-side uuid DEFAULT on Postgres.
 *
 * `@PrimaryGeneratedColumn('uuid')` on a `varchar` PK means SQLite mints the id CLIENT-side (its
 * driver always supplies a value), so the tables worked with no DEFAULT at all. Postgres does not:
 * it requires the column to produce its own value, so every insert that omits `id` fails with
 * `null value in column "id" ... violates not-null constraint` (23502). AuditService writes exactly
 * that way (`repo.insert({ action, … })`), so on a Postgres auth DB every audit write was silently
 * failing — including `api_key_auth_failed` records.
 *
 * Mirrors the data connection's fix (1770200000000-NormalizeSynchronizeUuidColumns), which applies
 * the same `gen_random_uuid()::varchar` DEFAULT to its own generated-uuid PKs. The `::varchar` cast
 * is required: a bare `gen_random_uuid()` returns native `uuid` and is not assignment-coercible to
 * varchar, so Postgres rejects the DEFAULT outright.
 *
 * No-op on SQLite, where the client-side id already covers it.
 */
export class MainUuidDefaults1782500000000 implements MigrationInterface {
  name = 'MainUuidDefaults1782500000000';

  private static readonly TABLES = ['api_keys', 'audit_logs'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    const schema = queryRunner.dataSource.options.schema || 'public';
    for (const t of MainUuidDefaults1782500000000.TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${schema}"."${t}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    const schema = queryRunner.dataSource.options.schema || 'public';
    for (const t of MainUuidDefaults1782500000000.TABLES) {
      await queryRunner.query(`ALTER TABLE "${schema}"."${t}" ALTER COLUMN "id" DROP DEFAULT`);
    }
  }
}
