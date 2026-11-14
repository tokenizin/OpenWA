import mainDataSource, { buildMainDataSourceOptions } from './data-source-main';

// The app runs the MAIN connection (auth/audit) as a separate connection, independently pluggable
// via MAIN_DATABASE_TYPE (SQLite by default, Postgres when set). The default data-source.ts CLI only
// manages the DATA connection's migrations, so this standalone DataSource exists so the CLI can
// run/generate the main-owned migrations too.
//
// The dialect assertions go through buildMainDataSourceOptions(env) with an EXPLICIT env, so they
// never depend on the developer's .env (which may pin postgres for a real deployment).
describe('main CLI DataSource', () => {
  const sqliteEnv = { MAIN_DATABASE_TYPE: 'sqlite' } as NodeJS.ProcessEnv;

  it('defaults to SQLite on the main connection when MAIN_DATABASE_TYPE is unset', () => {
    expect(buildMainDataSourceOptions({}).type).toBe('better-sqlite3');
  });

  it('uses the main-owned migrations dir, not the data migrations dir', () => {
    const migrations = (mainDataSource.options.migrations as string[]).join(' ');
    expect(migrations).toContain('migrations-main');
  });

  it('covers the auth and audit entities (the main connection owns them)', () => {
    const entities = (mainDataSource.options.entities as string[]).join(' ');
    expect(entities).toContain('auth');
    expect(entities).toContain('audit');
  });

  it("defaults to './data/main.sqlite' for the SQLite dialect", () => {
    const opts = buildMainDataSourceOptions({ ...sqliteEnv, MAIN_DATABASE_NAME: undefined });
    expect(String(opts.database)).toBe('./data/main.sqlite');
  });

  it('honors MAIN_DATABASE_NAME when set (mirrors configuration.ts)', () => {
    const opts = buildMainDataSourceOptions({ ...sqliteEnv, MAIN_DATABASE_NAME: '/tmp/test-main.sqlite' });
    expect(String(opts.database)).toBe('/tmp/test-main.sqlite');
  });

  // jest.resetModules() + a typed require forces a fresh evaluation of the module with the env var
  // we set, proving MAIN_DATABASE_NAME flows into the DataSource options (not just the cached
  // top-level import, which was evaluated with whatever env existed at spec load).
  it('flows MAIN_DATABASE_NAME into a freshly evaluated module (SQLite dialect)', () => {
    const previousType = process.env.MAIN_DATABASE_TYPE;
    const previousName = process.env.MAIN_DATABASE_NAME;
    process.env.MAIN_DATABASE_TYPE = 'sqlite';
    process.env.MAIN_DATABASE_NAME = '/tmp/test-main.sqlite';
    jest.resetModules();
    try {
      // require() (not dynamic import()) — the relative specifier trips TS2835 under
      // moduleResolution:nodenext; jest.resetModules() above still forces a fresh evaluation.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./data-source-main') as typeof import('./data-source-main');
      expect(mod.default.options.type).toBe('better-sqlite3');
      expect(String(mod.default.options.database)).toBe('/tmp/test-main.sqlite');
    } finally {
      if (previousType !== undefined) process.env.MAIN_DATABASE_TYPE = previousType;
      else delete process.env.MAIN_DATABASE_TYPE;
      if (previousName !== undefined) process.env.MAIN_DATABASE_NAME = previousName;
      else delete process.env.MAIN_DATABASE_NAME;
    }
  });

  describe('Postgres dialect (MAIN_DATABASE_TYPE=postgres)', () => {
    const pgEnv = {
      MAIN_DATABASE_TYPE: 'postgres',
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: '5435',
      DATABASE_NAME: 'openwa',
      DATABASE_USERNAME: 'openwa',
      DATABASE_PASSWORD: 'secret',
    } as NodeJS.ProcessEnv;

    it('selects the postgres driver', () => {
      expect(buildMainDataSourceOptions(pgEnv).type).toBe('postgres');
    });

    it('inherits the DATA connection credentials so one set of creds drives both connections', () => {
      const o = buildMainDataSourceOptions(pgEnv) as {
        host?: string;
        port?: number;
        username?: string;
        password?: string;
        database?: string;
      };
      expect(o.host).toBe('127.0.0.1');
      expect(o.port).toBe(5435);
      expect(o.username).toBe('openwa');
      expect(o.password).toBe('secret');
      expect(o.database).toBe('openwa');
    });

    it('prefers MAIN_DATABASE_* over the DATA connection values when both are set', () => {
      const o = buildMainDataSourceOptions({
        ...pgEnv,
        MAIN_DATABASE_HOST: 'main-host',
        MAIN_DATABASE_PORT: '6000',
        MAIN_DATABASE_USERNAME: 'main-user',
        MAIN_DATABASE_PASSWORD: 'main-secret',
      }) as { host?: string; port?: number; username?: string; password?: string };
      expect(o.host).toBe('main-host');
      expect(o.port).toBe(6000);
      expect(o.username).toBe('main-user');
      expect(o.password).toBe('main-secret');
    });

    it('isolates auth/audit in its own schema and sets the matching search_path', () => {
      const o = buildMainDataSourceOptions(pgEnv) as { schema?: string; extra?: { options?: string } };
      expect(o.schema).toBe('main');
      expect(o.extra?.options).toBe('-c search_path=main,public');
    });

    it('honors POSTGRES_MAIN_SCHEMA', () => {
      const o = buildMainDataSourceOptions({ ...pgEnv, POSTGRES_MAIN_SCHEMA: 'auth_audit' }) as {
        schema?: string;
        extra?: { options?: string };
      };
      expect(o.schema).toBe('auth_audit');
      expect(o.extra?.options).toBe('-c search_path=auth_audit,public');
    });

    it('does not set search_path for the public schema (matches the data connection)', () => {
      const o = buildMainDataSourceOptions({ ...pgEnv, POSTGRES_MAIN_SCHEMA: 'public' }) as {
        extra?: { options?: string };
      };
      expect(o.extra?.options).toBeUndefined();
    });

    it('never synchronizes (migrations manage the schema)', () => {
      expect(buildMainDataSourceOptions(pgEnv).synchronize).toBe(false);
    });

    it('reads MAIN_DATABASE_NAME_PG for the database name, not the SQLite file path', () => {
      const o = buildMainDataSourceOptions({
        ...pgEnv,
        MAIN_DATABASE_NAME: './data/main.sqlite',
        MAIN_DATABASE_NAME_PG: 'openwa_auth',
      }) as { database?: string };
      expect(o.database).toBe('openwa_auth');
    });
  });
});
