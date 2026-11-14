"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = validateEnv;
const path_1 = require("path");
const MAIN_DB_PATH = './data/main.sqlite';
function validateEnv(config) {
    const errors = [];
    const str = (key) => {
        const value = config[key];
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    };
    const dbType = str('DATABASE_TYPE');
    if (dbType && dbType !== 'sqlite' && dbType !== 'postgres') {
        errors.push(`DATABASE_TYPE must be "sqlite" or "postgres" (got "${dbType}")`);
    }
    const mainDbType = str('MAIN_DATABASE_TYPE');
    if (mainDbType && mainDbType !== 'sqlite' && mainDbType !== 'postgres') {
        errors.push(`MAIN_DATABASE_TYPE must be "sqlite" or "postgres" (got "${mainDbType}")`);
    }
    const checkEnum = (key, allowed) => {
        const value = str(key);
        if (value !== undefined && !allowed.includes(value)) {
            errors.push(`${key} must be one of ${allowed.map(v => `"${v}"`).join(', ')} (got "${value}")`);
        }
    };
    checkEnum('ENGINE_TYPE', ['whatsapp-web.js', 'baileys']);
    checkEnum('STORAGE_TYPE', ['local', 's3']);
    if (dbType === 'postgres') {
        for (const key of ['DATABASE_HOST', 'DATABASE_USERNAME', 'DATABASE_PASSWORD']) {
            if (!str(key)) {
                errors.push(`${key} is required when DATABASE_TYPE=postgres`);
            }
        }
        if (config['DATABASE_SYNCHRONIZE'] === 'true') {
            errors.push('DATABASE_SYNCHRONIZE=true is not allowed with DATABASE_TYPE=postgres: the Postgres data connection always runs migrations, and synchronize would drop the migration-created body_ts tsvector column that /search depends on (returns 501 on every restart). Set DATABASE_SYNCHRONIZE=false (the production default) and manage the schema via migrations.');
        }
        const pgSchema = str('POSTGRES_SCHEMA');
        if (pgSchema !== undefined) {
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(pgSchema)) {
                errors.push(`POSTGRES_SCHEMA must be a valid Postgres identifier (a letter or underscore, then letters/digits/underscores, max 63 chars; got ${JSON.stringify(pgSchema)})`);
            }
            else if (pgSchema.toLowerCase().startsWith('pg_')) {
                errors.push(`POSTGRES_SCHEMA must not use the reserved "pg_" prefix (got ${JSON.stringify(pgSchema)})`);
            }
        }
    }
    else {
        const dataDbName = str('DATABASE_NAME');
        if (dataDbName && (0, path_1.resolve)(dataDbName) === (0, path_1.resolve)(MAIN_DB_PATH)) {
            errors.push(`DATABASE_NAME must not point at the main database file (${MAIN_DB_PATH}); use a separate file`);
        }
        if (dataDbName && !dataDbName.includes('/') && !dataDbName.includes('\\') && !/\.(sqlite|db)$/i.test(dataDbName)) {
            errors.push(`DATABASE_NAME must be a file path under the data volume for SQLite (e.g. ./data/openwa.sqlite); got ${JSON.stringify(dataDbName)}. A bare name is the PostgreSQL DB name — leave DATABASE_NAME unset for SQLite to use the default ./data/openwa.sqlite.`);
        }
    }
    if (mainDbType === 'postgres') {
        const resolved = (mainKey, dataKey) => str(mainKey) ?? str(dataKey);
        for (const [mainKey, dataKey] of [
            ['MAIN_DATABASE_USERNAME', 'DATABASE_USERNAME'],
            ['MAIN_DATABASE_PASSWORD', 'DATABASE_PASSWORD'],
        ]) {
            if (!resolved(mainKey, dataKey)) {
                errors.push(`${mainKey} (or ${dataKey}) is required when MAIN_DATABASE_TYPE=postgres`);
            }
        }
        const mainPgSchema = str('POSTGRES_MAIN_SCHEMA');
        if (mainPgSchema !== undefined) {
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(mainPgSchema)) {
                errors.push(`POSTGRES_MAIN_SCHEMA must be a valid Postgres identifier (a letter or underscore, then letters/digits/underscores, max 63 chars; got ${JSON.stringify(mainPgSchema)})`);
            }
            else if (mainPgSchema.toLowerCase().startsWith('pg_')) {
                errors.push(`POSTGRES_MAIN_SCHEMA must not use the reserved "pg_" prefix (got ${JSON.stringify(mainPgSchema)})`);
            }
        }
        if (str('MAIN_DATABASE_NAME') && !str('MAIN_DATABASE_NAME_PG')) {
            errors.push('MAIN_DATABASE_NAME is the SQLite file path and is ignored when MAIN_DATABASE_TYPE=postgres; set MAIN_DATABASE_NAME_PG to the Postgres database name (defaults to DATABASE_NAME).');
        }
        if (config['MAIN_DATABASE_SYNCHRONIZE'] === 'true') {
            errors.push('MAIN_DATABASE_SYNCHRONIZE=true has no effect when MAIN_DATABASE_TYPE=postgres: the Postgres auth connection always runs the main-owned migrations instead of synchronize. Unset it (the default) and manage the schema via `npm run migration:run:main`.');
        }
    }
    const checkPort = (key) => {
        const raw = str(key);
        if (raw === undefined)
            return;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
            errors.push(`${key} must be an integer port in [1, 65535] (got "${raw}")`);
        }
    };
    checkPort('PORT');
    checkPort('DATABASE_PORT');
    checkPort('REDIS_PORT');
    const checkNonNegativeInt = (key) => {
        const raw = str(key);
        if (raw === undefined)
            return;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
            errors.push(`${key} must be a non-negative integer (got "${raw}")`);
        }
    };
    for (const key of [
        'RATE_LIMIT_SHORT_TTL',
        'RATE_LIMIT_MEDIUM_TTL',
        'RATE_LIMIT_LONG_TTL',
        'WEBHOOK_RETRY_DELAY',
        'DATABASE_POOL_SIZE',
        'DATABASE_STATEMENT_TIMEOUT_MS',
        'DATABASE_IDLE_TIMEOUT_MS',
        'DATABASE_CONNECTION_TIMEOUT_MS',
        'REDIS_CONNECT_TIMEOUT_MS',
        'MAX_CONCURRENT_SESSIONS',
        'INGRESS_INSTANCE_TTL',
        'WEBHOOK_DISPATCH_MAX_QUEUED',
    ]) {
        checkNonNegativeInt(key);
    }
    const checkPositiveInt = (key) => {
        const raw = str(key);
        if (raw === undefined)
            return;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
            errors.push(`${key} must be a positive integer (got "${raw}")`);
        }
    };
    for (const key of [
        'RATE_LIMIT_SHORT_LIMIT',
        'RATE_LIMIT_MEDIUM_LIMIT',
        'RATE_LIMIT_LONG_LIMIT',
        'WEBHOOK_TIMEOUT',
        'INGRESS_INSTANCE_LIMIT',
        'REQUEST_TIMEOUT_MS',
        'HEADERS_TIMEOUT_MS',
        'KEEPALIVE_TIMEOUT_MS',
        'WEBHOOK_DISPATCH_CONCURRENCY',
    ]) {
        checkPositiveInt(key);
    }
    const checkBool = (key) => {
        const raw = config[key];
        if (raw === undefined)
            return;
        if (typeof raw !== 'string') {
            errors.push(`${key} must be "true" or "false"`);
            return;
        }
        if (raw.trim() === '')
            return;
        if (raw !== 'true' && raw !== 'false') {
            errors.push(`${key} must be "true" or "false" (got ${JSON.stringify(raw)})`);
        }
    };
    for (const key of [
        'QUEUE_ENABLED',
        'MCP_ENABLED',
        'SERVE_DASHBOARD',
        'AUTO_START_SESSIONS',
        'STORE_EPHEMERAL_MESSAGES',
        'RESOLVE_LID_TO_PHONE',
        'SIMULATE_TYPING',
        'SEARCH_ENABLED',
    ]) {
        checkBool(key);
    }
    const provider = config['SEARCH_PROVIDER'];
    if (provider !== undefined && provider !== '' && !['auto', 'builtin-fts', 'none'].includes(provider)) {
        errors.push(`SEARCH_PROVIDER must be one of: auto, builtin-fts, none (got ${JSON.stringify(provider)})`);
    }
    if (errors.length > 0) {
        throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
    }
    return config;
}
//# sourceMappingURL=env.validation.js.map