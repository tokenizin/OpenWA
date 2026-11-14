/**
 * One-shot data migration: SQLite (./data/openwa.sqlite) -> PostgreSQL (public schema).
 *
 * Built for the OpenWA engine cut-over on this host. NOT part of the app runtime.
 *
 * Design notes:
 *  - Reads SQLite row-by-row in primary-key order and INSERTs into Postgres in batches. The
 *    1 GB source is streamed, never loaded whole, so memory stays flat.
 *  - FK-safe order: sessions before its dependents (messages, webhooks, baileys_stored_messages,
 *    templates). webhooks before webhook_delivery_failures.
 *  - SQLite stores booleans as 0/1 ints; Postgres expects real booleans. `boolCols` converts.
 *  - SQLite datetime text ('YYYY-MM-DD HH:MM:SS[.sss]', UTC, no zone marker) is passed to
 *    Postgres as-is — Postgres parses that exact literal into `timestamp` fine.
 *  - `messages.body_ts` is a STORED generated column: never inserted, Postgres computes it.
 *  - ON CONFLICT DO NOTHING makes the whole run idempotent/resumable, so a partial run can be
 *    repeated without duplicate-key explosions.
 *
 * Usage (from /Users/alexshapiro/OpenWA):
 *   npm run build && node dist/scripts/migrate-sqlite-to-postgres.js
 * Reads DATABASE_* from process.env (or ~/.config/openwa/db.env).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Client } = require('pg');

const SQLITE_PATH = process.env.SOURCE_SQLITE || path.resolve(__dirname, '..', 'data', 'openwa.sqlite');
const BATCH = 500;

// FK-safe: parents first. `bool` lists columns stored as 0/1 in SQLite that are real booleans in PG.
const TABLES = [
  { name: 'sessions', boolCols: [] },
  { name: 'messages', boolCols: [], skip: ['body_ts'] },
  { name: 'webhooks', boolCols: ['active'] },
  { name: 'baileys_stored_messages', boolCols: [] },
  { name: 'lid_mappings', boolCols: [] },
  { name: 'webhook_delivery_failures', boolCols: [] },
  { name: 'conversation_mappings', boolCols: [] },
  { name: 'message_batches', boolCols: [] },
  { name: 'plugin_instances', boolCols: [] },
  { name: 'integration_delivery_failures', boolCols: [] },
  { name: 'templates', boolCols: [] },
  // `migrations` is deliberately NOT copied: the Postgres ledger already records every applied
  // migration from the migration run. Copying the SQLite ledger would make Postgres re-run
  // already-applied migrations (or conflict on the PK).
];

function loadDbEnv() {
  const p = path.join(process.env.HOME || '', '.config', 'openwa', 'db.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  loadDbEnv();
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`FATAL: source SQLite not found: ${SQLITE_PATH}`);
    process.exit(1);
  }

  const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
  const pg = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: parseInt(process.env.DATABASE_PORT || '5435', 10),
    user: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME || 'openwa',
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await pg.connect();
  console.log(`connected: pg ${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT}/${process.env.DATABASE_NAME}`);

  const report = [];
  for (const t of TABLES) {
    const exists = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(t.name);
    if (!exists) {
      console.log(`- ${t.name}: absent in source, skipped`);
      report.push([t.name, 'absent', 0]);
      continue;
    }

    const cols = sqlite.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
    const useCols = cols.filter((c) => !(t.skip || []).includes(c));
    if (useCols.length === 0) continue;

    const colList = useCols.map((c) => `"${c}"`).join(', ');
    const total = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;

    // Stream in PK order in chunks so a 23k-row table never lands in memory at once.
    const chunkRows = Math.max(1, Math.floor(BATCH / 1));
    let inserted = 0;
    let offset = 0;
    const hasId = cols.includes('id');

    while (true) {
      let rows;
      if (hasId) {
        rows = sqlite
          .prepare(`SELECT ${colList} FROM "${t.name}" ORDER BY "id" LIMIT ? OFFSET ?`)
          .all(chunkRows, offset);
      } else {
        rows = sqlite.prepare(`SELECT ${colList} FROM "${t.name}" LIMIT ? OFFSET ?`).all(chunkRows, offset);
      }
      if (rows.length === 0) break;
      offset += rows.length;

      const tuples = rows
        .map((r) => {
          const vals = useCols
            .map((c) => {
              const v = r[c];
              // Cast only to text so Postgres coerces into the real column type on INSERT;
              // casts are explicit below for the types where Postgres is strict.
              if (v === null || v === undefined) return 'NULL';
              if (t.boolCols.includes(c)) return (v === 1 || v === '1' || v === true) ? 'true' : 'false';
              if (typeof v === 'number') return String(v);
              if (typeof v === 'boolean') return v ? 'true' : 'false';
              return "'" + String(v).replace(/'/g, "''") + "'";
            })
            .join(', ');
          return `(${vals})`;
        })
        .join(', ');

      const conflict = hasId ? 'ON CONFLICT ("id") DO NOTHING' : 'ON CONFLICT DO NOTHING';
      const sql = `INSERT INTO "${t.name}" (${colList}) VALUES ${tuples} ${conflict}`;
      const res = await pg.query(sql);
      inserted += res.rowCount || 0;
    }

    const actual = (await pg.query(`SELECT COUNT(*)::int AS n FROM "${t.name}"`)).rows[0].n;
    console.log(`- ${t.name}: source=${total} inserted=${inserted} pg_now=${actual}`);
    report.push([t.name, total, actual]);
  }

  console.log('\n=== FINAL COUNTS (Postgres public schema) ===');
  for (const t of TABLES) {
    const r = await pg.query(`SELECT COUNT(*)::int AS n FROM "${t.name}"`);
    console.log(`${t.name.padEnd(32)} ${r.rows[0].n}`);
  }

  await pg.end();
  sqlite.close();
  console.log('\ndone.');
}

main().catch((e) => {
  console.error('MIGRATION FAILED:', e.message);
  if (e.position) console.error('at position', e.position);
  process.exit(1);
});
