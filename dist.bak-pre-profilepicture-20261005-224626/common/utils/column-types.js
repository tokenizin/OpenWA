"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mainDateColumnType = exports.dateColumnType = exports.jsonColumnType = exports.isMainPostgres = void 0;
const isPostgres = () => process.env.DATABASE_TYPE === 'postgres';
const isMainPostgres = () => (process.env.MAIN_DATABASE_TYPE ?? process.env.DATABASE_TYPE) === 'postgres';
exports.isMainPostgres = isMainPostgres;
const jsonColumnType = () => 'simple-json';
exports.jsonColumnType = jsonColumnType;
const dateColumnType = () => (isPostgres() ? 'timestamp' : 'text');
exports.dateColumnType = dateColumnType;
const mainDateColumnType = () => (0, exports.isMainPostgres)() ? 'timestamp' : 'datetime';
exports.mainDateColumnType = mainDateColumnType;
//# sourceMappingURL=column-types.js.map