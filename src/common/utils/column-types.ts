/**
 * Cross-database column type helpers.
 *
 * SQLite lacks native JSON and timestamp types, so we use `simple-json`
 * (JSON.stringify stored as TEXT) and `text` with DateTransformer.
 *
 * PostgreSQL has native `jsonb` and `timestamp` types with better
 * indexing and query performance.
 *
 * MAIN-CONNECTION entities (auth, audit) are ALSO now dialect-aware. They used to be
 * hardcoded-SQLite-only (type: 'better-sqlite3' was unconditional in app.module.ts); the main
 * connection is independently pluggable via MAIN_DATABASE_TYPE, so those entities must resolve
 * their dialect from MAIN_DATABASE_TYPE — NOT DATABASE_TYPE, which governs the data connection.
 * Hardcoding `simple-json` / `datetime` there would emit a jsonb/timestamp column on a Postgres
 * main DB (or a datetime column on SQLite, which is still supported there).
 */

const isPostgres = (): boolean => process.env.DATABASE_TYPE === 'postgres';

/**
 * Dialect of the MAIN (auth/audit) connection. Falls back to DATABASE_TYPE so a deployment that
 * sets only DATABASE_TYPE=postgres and leaves MAIN_DATABASE_TYPE unset still gets Postgres if the
 * main connection is later moved; otherwise it stays on its SQLite default.
 */
export const isMainPostgres = (): boolean =>
  (process.env.MAIN_DATABASE_TYPE ?? process.env.DATABASE_TYPE) === 'postgres';

/**
 * Always 'simple-json' (TypeORM JSON.stringify/parse over a `text` column), on BOTH dialects.
 *
 * The baseline migration created these columns as `text` on Postgres too (never `jsonb`). The pg
 * driver only auto-parses real json/jsonb columns, so a `jsonb`-typed entity reading the actual
 * `text` column hands back a RAW string — e.g. webhook.events comes through as the string
 * '["message.received"]', and the dashboard's events.map() throws (full-page crash). 'simple-json'
 * parses on read regardless of dialect, matching the real columns. No native jsonb queries exist
 * (all JSON filtering is done in JS), so nothing is lost.
 */
export const jsonColumnType = (): 'simple-json' => 'simple-json';

/**
 * Returns 'timestamp' for PostgreSQL, 'text' for SQLite.
 * Use with DateTransformer for SQLite compatibility.
 */
export const dateColumnType = (): 'timestamp' | 'text' => (isPostgres() ? 'timestamp' : 'text');

/**
 * MAIN-connection counterpart of {@link dateColumnType}: 'timestamp' on Postgres, 'datetime' on
 * SQLite. `datetime` (not `text`) preserves the historical SQLite column type, so existing
 * main.sqlite databases keep their current schema — the main-owned migrations create `datetime`
 * columns on SQLite, and 'text' would diverge from those tables.
 *
 * Always pair with {@link DateTransformer}: it normalises both directions, so a value written on
 * one dialect reads back as a Date after a migration to the other.
 */
export const mainDateColumnType = (): 'timestamp' | 'datetime' =>
  isMainPostgres() ? 'timestamp' : 'datetime';
