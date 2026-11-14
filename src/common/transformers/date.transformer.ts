import { ValueTransformer } from 'typeorm';

/**
 * Cross-database date transformer.
 * - SQLite stores as ISO string TEXT, transformer converts to/from Date
 * - PostgreSQL stores as native timestamp, driver returns Date directly
 *
 * `to()` picks the write representation from the dialect of the CONNECTION THAT OWNS THE COLUMN.
 * The default `to()` uses the data connection's DATABASE_TYPE (unchanged behavior). Main-connection
 * entities (auth, audit) MUST pass 'main' so a Date is written as a native Date for pg's
 * `timestamp` column instead of an ISO string; otherwise pg rejects the string for a timestamp, or
 * a Date-valued column silently stores text.
 */

export type DateTransformerDialect = 'data' | 'main';

/** Resolve the dialect that governs a column: the data connection, or MAIN_DATABASE_TYPE. */
function resolveDialect(scope: DateTransformerDialect): 'postgres' | 'sqlite' {
  if (scope === 'main') {
    return (process.env.MAIN_DATABASE_TYPE ?? process.env.DATABASE_TYPE) === 'postgres' ? 'postgres' : 'sqlite';
  }
  return process.env.DATABASE_TYPE === 'postgres' ? 'postgres' : 'sqlite';
}

/** ValueTransformer over a date/timestamp column, bound to one connection's dialect. */
export function makeDateTransformer(scope: DateTransformerDialect = 'data'): ValueTransformer {
  return {
    from: (value: string | Date | null): Date | null => {
      if (!value) return null;
      if (value instanceof Date) return value;
      return new Date(value);
    },
    to: (value: Date | null): string | Date | null => {
      if (!value) return null;
      if (value instanceof Date) {
        return resolveDialect(scope) === 'postgres' ? value : value.toISOString();
      }
      return value;
    },
  };
}

/** Back-compat alias: identical to the historical data-connection transformer. */
export const DateTransformer: ValueTransformer = makeDateTransformer('data');

/**
 * MAIN-connection date transformer (auth/audit entities). Resolves from MAIN_DATABASE_TYPE so it
 * writes a native Date on Postgres and an ISO string on SQLite.
 */
export const MainDateTransformer: ValueTransformer = makeDateTransformer('main');
