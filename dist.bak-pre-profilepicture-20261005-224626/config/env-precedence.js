"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BLANK_SHADOWED_ENV_KEYS = void 0;
exports.clearBlankEnv = clearBlankEnv;
exports.BLANK_SHADOWED_ENV_KEYS = [
    'ENGINE_TYPE',
    'DATABASE_TYPE',
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_USERNAME',
    'DATABASE_NAME',
    'DATABASE_PASSWORD',
    'POSTGRES_SCHEMA',
    'STORAGE_TYPE',
    'STORAGE_LOCAL_PATH',
    'S3_BUCKET',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'REDIS_ENABLED',
    'REDIS_HOST',
    'REDIS_PORT',
    'PUPPETEER_HEADLESS',
    'SESSION_DATA_PATH',
    'PUPPETEER_ARGS',
    'RATE_LIMIT_SHORT_TTL',
    'RATE_LIMIT_SHORT_LIMIT',
    'RATE_LIMIT_MEDIUM_TTL',
    'RATE_LIMIT_MEDIUM_LIMIT',
    'RATE_LIMIT_LONG_TTL',
    'RATE_LIMIT_LONG_LIMIT',
];
function clearBlankEnv(env, keys) {
    for (const key of keys) {
        const value = env[key];
        if (value !== undefined && value.trim() === '') {
            delete env[key];
        }
    }
}
//# sourceMappingURL=env-precedence.js.map