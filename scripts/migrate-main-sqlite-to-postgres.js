/**
 * One-shot auth/audit migration: SQLite (./data/main.sqlite) -> PostgreSQL (schema "main").
 *
 * Companion to migrate-sqlite-to-postgres.js (which handles the DATA connection). This one moves
 * the MAIN connection: api_keys + audit_logs.
 *
 * api_keys is the critical one: `keyHash` is a SHA-256 of the secret. Re-hashing or losing it
 * invalidates every issued API key, so the hash is copied verbatim — the new auth DB must be able
 * to authenticate the SAME keys the sidecars already hold.
 *
 * Usage (from /Users/alexshapiro/OpenWA):
 *   /opt/homebrew/opt/node@22/bin/node scripts/migrate-main-sqlite-to-postgres.js
 * Reads DATABASE_* from ~/.config/openwa/db.env.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Client } = require('pg');

const SQLITE_PATH = process.env.SOURCE_MAIN_SQLITE || path.resolve(__dirname, '..', 'data', 'main.sqlite');
const BATCH = 200;

function loadDbEnv() {
  const p = path.join(process.env.HOME || '', '.config', 'openwa', 'db.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

function quote(v, isBool) {
  if (v === null || v === undefined) return 'NULL';
  if (isBool) return (v === 1 || v === '1' || v === true) ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

async function main() {
  loadDbEnv();
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`FATAL: source main SQLite not found: ${SQLITE_PATH}`);
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
  const schema = process.env.POSTGRES_MAIN_SCHEMA || 'main';
  await pg.query(`SET search_path TO "${schema}", public`);
  console.log(`connected: pg :${process.env.DATABASE_PORT}/${process.env.DATABASE_NAME} schema=${schema}`);

  const TABLES = [
    { name: 'api_keys', boolCols: ['isActive'] },
    { name: 'audit_logs', boolCols: [] },
  ];

  for (const t of TABLES) {
    const exists = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t.name);
    if (!exists) {
      console.log(`- ${t.name}: absent in source, skipped`);
      continue;
    }
    const cols = sqlite.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const total = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;

    let inserted = 0;
    let offset = 0;
    while (true) {
      const rows = sqlite
        .prepare(`SELECT ${colList} FROM "${t.name}" ORDER BY "id" LIMIT ? OFFSET ?`)
        .all(BATCH, offset);
      if (rows.length === 0) break;
      offset += rows.length;
      const tuples = rows
        .map((r) => {
          const vals = cols
            .map((c) => {
              const v = r[c];
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
      const res = await pg.query(
        `INSERT INTO "${t.name}" (${colList}) VALUES ${tuples} ON CONFLICT ("id") DO NOTHING`,
      );
      inserted += res.rowCount || 0;
    }

    const actual = (await pg.query(`SELECT COUNT(*)::int AS n FROM "${t.name}"`)).rows[0].n;
    console.log(`- ${t.name}: source=${total} inserted=${inserted} pg_now=${actual}`);
  }

  console.log('\n=== VERIFY: api_keys rows (hash prefix must match source) ===');
  const rows = await pg.query(
    `SELECT name, keyPrefix, role, isActive, usageCount, left(keyHash, 16) AS hash16 FROM "${schema}".api_keys ORDER BY name`,
  );
  for (const r of rows.rows) console.log(JSON.stringify(r));

  await pg.end();
  sqlite.close();
  console.log('\ndone.');
}

main().catch((e) => {
  console.error('MIGRATION FAILED:', e.message);
  process.exit(1);
});
