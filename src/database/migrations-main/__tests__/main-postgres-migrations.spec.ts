import { DataSource } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';
import { MainUuidDefaults1782500000000 } from '../1782500000000-MainUuidDefaults';

/**
 * Regression locks for the MAIN (auth/audit) connection running on PostgreSQL.
 *
 * Both migrations branch on `qr.dataSource.options.type`. We assert the emitted SQL per dialect via
 * a recording QueryRunner stub, so these run without a live Postgres while still proving the
 * dialect-specific DDL (which is exactly where the Postgres cut-over broke).
 */
describe('main-connection migrations on Postgres', () => {
  /** Minimal QueryRunner stub: records SQL, reports the given dialect/schema. */
  const stubRunner = (type: string, schema: string | undefined) => {
    const queries: string[] = [];
    const qr = {
      queries,
      query: (sql: string): Promise<unknown[]> => {
        queries.push(sql);
        return Promise.resolve([]);
      },
      dataSource: { options: { type, schema } },
    };
    return qr as unknown as Parameters<CreateAuthAuditTables1779900000000['up']>[0] & { queries: string[] };
  };

  const sql = (qs: string[], re: RegExp): string => qs.find(q => re.test(q)) ?? '';

  describe('CreateAuthAuditTables', () => {
    it('uses timestamp + now() on Postgres (it has no `datetime` type)', async () => {
      const qr = stubRunner('postgres', 'main');
      await new CreateAuthAuditTables1779900000000().up(qr);

      const create = sql(qr.queries, /CREATE TABLE IF NOT EXISTS .*api_keys/);
      expect(create).toContain('"expiresAt" timestamp');
      expect(create).toContain('"createdAt" timestamp NOT NULL DEFAULT (now())');
      // The SQLite spelling must NOT leak into the Postgres branch.
      expect(create).not.toContain('datetime');
    });

    it('creates the target schema before the qualified tables (search_path is not enough)', async () => {
      const qr = stubRunner('postgres', 'main');
      await new CreateAuthAuditTables1779900000000().up(qr);

      const schemaIdx = qr.queries.findIndex(q => /CREATE SCHEMA IF NOT EXISTS "main"/.test(q));
      const tableIdx = qr.queries.findIndex(q => /CREATE TABLE IF NOT EXISTS "main"\."api_keys"/.test(q));
      expect(schemaIdx).toBeGreaterThanOrEqual(0);
      expect(tableIdx).toBeGreaterThan(schemaIdx);
    });

    it('schema-qualifies every table + index so tables land outside public', async () => {
      const qr = stubRunner('postgres', 'auth_audit');
      await new CreateAuthAuditTables1779900000000().up(qr);

      expect(sql(qr.queries, /CREATE TABLE/)).toMatch(/CREATE TABLE IF NOT EXISTS "auth_audit"\."api_keys"/);
      expect(sql(qr.queries, /CREATE TABLE IF NOT EXISTS .*audit_logs/)).toMatch(
        /CREATE TABLE IF NOT EXISTS "auth_audit"\."audit_logs"/,
      );
      expect(sql(qr.queries, /CREATE UNIQUE INDEX/)).toContain('ON "auth_audit"."api_keys"');
      expect(sql(qr.queries, /IDX_audit_logs_action/)).toContain('ON "auth_audit"."audit_logs"');
    });

    it("uses the `true` boolean default on Postgres, not SQLite's 1", async () => {
      const qr = stubRunner('postgres', 'main');
      await new CreateAuthAuditTables1779900000000().up(qr);
      expect(sql(qr.queries, /CREATE TABLE IF NOT EXISTS .*api_keys/)).toContain(
        '"isActive" boolean NOT NULL DEFAULT (true)',
      );
    });

    it('keeps the historical SQLite DDL unchanged (no schema, datetime, default 1)', async () => {
      const qr = stubRunner('better-sqlite3', undefined);
      await new CreateAuthAuditTables1779900000000().up(qr);

      const create = sql(qr.queries, /CREATE TABLE IF NOT EXISTS .*api_keys/);
      expect(create).toContain('"expiresAt" datetime');
      expect(create).toContain("DEFAULT (datetime('now'))");
      expect(create).toContain('"isActive" boolean NOT NULL DEFAULT (1)');
      // Unqualified, so the migration ledger and tables share the connection's search_path.
      expect(create).toContain('CREATE TABLE IF NOT EXISTS "api_keys"');
      expect(qr.queries.some(q => /CREATE SCHEMA/.test(q))).toBe(false);
    });

    it('drops schema-qualified tables on Postgres down()', async () => {
      const qr = stubRunner('postgres', 'main');
      await new CreateAuthAuditTables1779900000000().down(qr);
      const drops = qr.queries.filter(q => /DROP TABLE/.test(q)).join('\n');
      expect(drops).toContain('"main"."api_keys"');
      expect(drops).toContain('"main"."audit_logs"');
    });
  });

  describe('MainUuidDefaults', () => {
    // Regression: `@PrimaryGeneratedColumn('uuid')` on a varchar PK is minted CLIENT-side by
    // SQLite's driver, so the main tables shipped with no DB DEFAULT. Postgres has no client-side
    // uuid generation, so every AuditService insert (`repo.insert({action, …})`, no id) failed with
    // NOT NULL 23502 and audit writes were silently lost.
    it('sets a varchar-cast gen_random_uuid() DEFAULT on both main tables', async () => {
      const qr = stubRunner('postgres', 'main');
      await new MainUuidDefaults1782500000000().up(qr);

      const alters = qr.queries.filter(q => /ALTER COLUMN "id" SET DEFAULT/.test(q));
      expect(alters).toHaveLength(2);
      expect(sql(alters, /api_keys/)).toBe(
        'ALTER TABLE "main"."api_keys" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar',
      );
      expect(sql(alters, /audit_logs/)).toBe(
        'ALTER TABLE "main"."audit_logs" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar',
      );
    });

    // A bare gen_random_uuid() returns native uuid and is NOT assignment-coercible to varchar, so
    // Postgres rejects the DEFAULT outright — the ::varchar cast is mandatory.
    it('casts to varchar (a bare gen_random_uuid() is rejected on a varchar column)', async () => {
      const qr = stubRunner('postgres', 'main');
      await new MainUuidDefaults1782500000000().up(qr);
      for (const q of qr.queries) expect(q).toContain('::varchar');
    });

    it('is a no-op on SQLite (client-side ids already cover it)', async () => {
      const qr = stubRunner('better-sqlite3', undefined);
      await new MainUuidDefaults1782500000000().up(qr);
      expect(qr.queries).toHaveLength(0);
    });

    it('drops the DEFAULT on down()', async () => {
      const qr = stubRunner('postgres', 'main');
      await new MainUuidDefaults1782500000000().down(qr);
      expect(qr.queries.filter(q => /DROP DEFAULT/.test(q))).toHaveLength(2);
    });

    it('is idempotent — ALTER ... SET DEFAULT can be re-applied', async () => {
      const qr = stubRunner('postgres', 'main');
      const m = new MainUuidDefaults1782500000000();
      await m.up(qr);
      const first = qr.queries.length;
      await m.up(qr);
      expect(qr.queries.length).toBe(first * 2);
    });
  });

  describe('SQLite regression guard', () => {
    it('still creates the tables through a real SQLite DataSource', async () => {
      const ds = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [],
        synchronize: false,
      });
      await ds.initialize();
      const qr = ds.createQueryRunner();
      await new CreateAuthAuditTables1779900000000().up(qr);
      const tables = (await qr.query("SELECT name FROM sqlite_master WHERE type='table'")) as Array<{
        name: string;
      }>;
      const names = tables.map(t => t.name);
      expect(names).toContain('api_keys');
      expect(names).toContain('audit_logs');
      // No-op on SQLite: no DEFAULT is added.
      await new MainUuidDefaults1782500000000().up(qr);
      const cols = (await qr.query('PRAGMA table_info("api_keys")')) as Array<{ dflt_value: string | null }>;
      // The migration must be a no-op: no uuid DEFAULT may appear on SQLite.
      expect(cols.some(c => (c.dflt_value ?? '').includes('gen_random_uuid'))).toBe(false);
      await ds.destroy();
    });
  });
});
