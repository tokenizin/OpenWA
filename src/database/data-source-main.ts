import { DataSource, DataSourceOptions } from 'typeorm';
import { loadCliEnv } from './load-cli-env';

// Load environment variables with the app's precedence (mirrors data-source.ts / main.ts).
loadCliEnv();

/**
 * Standalone TypeORM CLI DataSource for the MAIN connection (auth + audit).
 *
 * The app runs the main connection as a separate connection (app.module.ts), distinct from the
 * pluggable data connection. The default data-source.ts CLI only manages the data connection's
 * migrations, so without this the CLI could not run/generate the main-owned migrations
 * (migrations-main) — which matters the moment boot auto-migration is turned off
 * (MAIN_DATABASE_SYNCHRONIZE=false), where the schema must be managed via the CLI instead.
 *
 * Mirrors the runtime main connection exactly: MAIN_DATABASE_TYPE selects sqlite (default,
 * ./data/main.sqlite) or postgres (falling back to the DATA connection's DATABASE_* credentials,
 * with auth/audit isolated in POSTGRES_MAIN_SCHEMA), auth/audit entities, migrations-main.
 * synchronize is always false here — the CLI manages schema via migrations.
 *
 * Usage: `npm run migration:run:main` (dev) / `migration:run:main:prod` (compiled).
 */
/** Build the main-connection options from an explicit env (unit-testable without mutating process.env). */
export function buildMainDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  const entities = [
    __dirname + '/../modules/auth/**/*.entity{.ts,.js}',
    __dirname + '/../modules/audit/**/*.entity{.ts,.js}',
  ];
  const migrations = [__dirname + '/migrations-main/*{.ts,.js}'];
  const logging = env.DATABASE_LOGGING === 'true';

  if (env.MAIN_DATABASE_TYPE === 'postgres') {
    const schema = env.POSTGRES_MAIN_SCHEMA || 'main';
    const useCustomSearchPath = schema !== 'public';
    return {
      type: 'postgres',
      schema,
      host: env.MAIN_DATABASE_HOST || env.DATABASE_HOST || 'localhost',
      port: parseInt(env.MAIN_DATABASE_PORT || env.DATABASE_PORT || '5432', 10),
      username: env.MAIN_DATABASE_USERNAME || env.DATABASE_USERNAME,
      password: env.MAIN_DATABASE_PASSWORD || env.DATABASE_PASSWORD,
      database: env.MAIN_DATABASE_NAME_PG || env.DATABASE_NAME || 'openwa',
      entities,
      migrations,
      synchronize: false,
      logging,
      ssl:
        env.DATABASE_SSL === 'true'
          ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : false,
      extra: {
        max: parseInt(env.MAIN_DATABASE_POOL_SIZE || env.DATABASE_POOL_SIZE || '10', 10),
        ...(useCustomSearchPath ? { options: `-c search_path=${schema},public` } : {}),
      },
    };
  }

  return {
    type: 'better-sqlite3',
    // Mirrors the runtime main path (configuration.ts) — MAIN_DATABASE_NAME overrides the default
    // ./data/main.sqlite (e.g. e2e points it at a temp file), so the CLI and the app never target
    // different main databases.
    database: env.MAIN_DATABASE_NAME || './data/main.sqlite',
    entities,
    migrations,
    synchronize: false,
    logging,
  };
}

const mainDataSource = new DataSource(buildMainDataSourceOptions());

export default mainDataSource;
