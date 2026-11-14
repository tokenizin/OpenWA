"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MainUuidDefaults1782500000000 = void 0;
class MainUuidDefaults1782500000000 {
    name = 'MainUuidDefaults1782500000000';
    static TABLES = ['api_keys', 'audit_logs'];
    async up(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'postgres')
            return;
        const schema = queryRunner.dataSource.options.schema || 'public';
        for (const t of MainUuidDefaults1782500000000.TABLES) {
            await queryRunner.query(`ALTER TABLE "${schema}"."${t}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`);
        }
    }
    async down(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'postgres')
            return;
        const schema = queryRunner.dataSource.options.schema || 'public';
        for (const t of MainUuidDefaults1782500000000.TABLES) {
            await queryRunner.query(`ALTER TABLE "${schema}"."${t}" ALTER COLUMN "id" DROP DEFAULT`);
        }
    }
}
exports.MainUuidDefaults1782500000000 = MainUuidDefaults1782500000000;
//# sourceMappingURL=1782500000000-MainUuidDefaults.js.map