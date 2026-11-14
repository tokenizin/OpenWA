"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateAuthAuditTables1779900000000 = void 0;
class CreateAuthAuditTables1779900000000 {
    name = 'CreateAuthAuditTables1779900000000';
    async up(queryRunner) {
        const isPostgres = queryRunner.dataSource.options.type === 'postgres';
        const schema = isPostgres ? (queryRunner.dataSource.options.schema || 'public') : null;
        const q = (table) => (schema ? `"${schema}"."${table}"` : `"${table}"`);
        if (isPostgres) {
            await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        }
        const ts = isPostgres ? 'timestamp' : 'datetime';
        const tsNow = isPostgres ? 'now()' : "datetime('now')";
        const boolDefault = isPostgres ? 'true' : '1';
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS ${q('api_keys')} (` +
            `"id" varchar PRIMARY KEY NOT NULL, ` +
            `"name" varchar(100) NOT NULL, ` +
            `"keyHash" varchar(64) NOT NULL, ` +
            `"keyPrefix" varchar(12) NOT NULL, ` +
            `"role" varchar(20) NOT NULL DEFAULT ('operator'), ` +
            `"allowedIps" text, ` +
            `"allowedSessions" text, ` +
            `"isActive" boolean NOT NULL DEFAULT (${boolDefault}), ` +
            `"expiresAt" ${ts}, ` +
            `"lastUsedAt" ${ts}, ` +
            `"usageCount" integer NOT NULL DEFAULT (0), ` +
            `"createdAt" ${ts} NOT NULL DEFAULT (${tsNow}), ` +
            `"updatedAt" ${ts} NOT NULL DEFAULT (${tsNow})` +
            `)`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_api_keys_keyHash" ON ${q('api_keys')} ("keyHash")`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS ${q('audit_logs')} (` +
            `"id" varchar PRIMARY KEY NOT NULL, ` +
            `"action" varchar(50) NOT NULL, ` +
            `"severity" varchar(10) NOT NULL DEFAULT ('info'), ` +
            `"apiKeyId" varchar(36), ` +
            `"apiKeyName" varchar(100), ` +
            `"sessionId" varchar(36), ` +
            `"sessionName" varchar(100), ` +
            `"ipAddress" varchar(45), ` +
            `"userAgent" varchar(500), ` +
            `"method" varchar(10), ` +
            `"path" varchar(500), ` +
            `"statusCode" integer, ` +
            `"metadata" text, ` +
            `"errorMessage" text, ` +
            `"createdAt" ${ts} NOT NULL DEFAULT (${tsNow})` +
            `)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON ${q('audit_logs')} ("action")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_apiKeyId" ON ${q('audit_logs')} ("apiKeyId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_sessionId" ON ${q('audit_logs')} ("sessionId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_createdAt" ON ${q('audit_logs')} ("createdAt")`);
    }
    async down(queryRunner) {
        const isPostgres = queryRunner.dataSource.options.type === 'postgres';
        const schema = isPostgres ? (queryRunner.dataSource.options.schema || 'public') : null;
        const q = (table) => (schema ? `"${schema}"."${table}"` : `"${table}"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_createdAt"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_sessionId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_apiKeyId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_action"`);
        await queryRunner.query(`DROP TABLE IF EXISTS ${q('audit_logs')}`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_api_keys_keyHash"`);
        await queryRunner.query(`DROP TABLE IF EXISTS ${q('api_keys')}`);
    }
}
exports.CreateAuthAuditTables1779900000000 = CreateAuthAuditTables1779900000000;
//# sourceMappingURL=1779900000000-CreateAuthAuditTables.js.map