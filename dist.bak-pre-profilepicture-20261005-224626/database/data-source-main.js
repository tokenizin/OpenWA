"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMainDataSourceOptions = buildMainDataSourceOptions;
const typeorm_1 = require("typeorm");
const load_cli_env_1 = require("./load-cli-env");
(0, load_cli_env_1.loadCliEnv)();
function buildMainDataSourceOptions(env = process.env) {
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
            ssl: env.DATABASE_SSL === 'true'
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
        database: env.MAIN_DATABASE_NAME || './data/main.sqlite',
        entities,
        migrations,
        synchronize: false,
        logging,
    };
}
const mainDataSource = new typeorm_1.DataSource(buildMainDataSourceOptions());
exports.default = mainDataSource;
//# sourceMappingURL=data-source-main.js.map