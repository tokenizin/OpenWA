"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MainDateTransformer = exports.DateTransformer = void 0;
exports.makeDateTransformer = makeDateTransformer;
function resolveDialect(scope) {
    if (scope === 'main') {
        return (process.env.MAIN_DATABASE_TYPE ?? process.env.DATABASE_TYPE) === 'postgres'
            ? 'postgres'
            : 'sqlite';
    }
    return process.env.DATABASE_TYPE === 'postgres' ? 'postgres' : 'sqlite';
}
function makeDateTransformer(scope = 'data') {
    return {
        from: (value) => {
            if (!value)
                return null;
            if (value instanceof Date)
                return value;
            return new Date(value);
        },
        to: (value) => {
            if (!value)
                return null;
            if (value instanceof Date) {
                return resolveDialect(scope) === 'postgres' ? value : value.toISOString();
            }
            return value;
        },
    };
}
exports.DateTransformer = makeDateTransformer('data');
exports.MainDateTransformer = makeDateTransformer('main');
//# sourceMappingURL=date.transformer.js.map