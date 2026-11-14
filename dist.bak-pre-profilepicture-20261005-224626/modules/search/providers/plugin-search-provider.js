"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginSearchProvider = void 0;
const common_1 = require("@nestjs/common");
class PluginSearchProvider {
    label;
    transport;
    timeoutMs;
    id;
    constructor(pluginId, label, transport, timeoutMs) {
        this.label = label;
        this.transport = transport;
        this.timeoutMs = timeoutMs;
        this.id = `plugin:${pluginId}`;
    }
    async search(query) {
        const reply = await this.transport.dispatchSearch({ query, timeoutMs: this.timeoutMs });
        if (!reply.ok)
            throw new common_1.ServiceUnavailableException(reply.error);
        if (!query.sessionIds || !query.sessionIds.length)
            return reply.results;
        const allowed = new Set(query.sessionIds);
        const scoped = reply.results.hits.filter(h => allowed.has(h.sessionId));
        const leaked = reply.results.hits.length - scoped.length;
        return {
            hits: scoped,
            total: leaked > 0 ? scoped.length : reply.results.total,
            tookMs: reply.results.tookMs,
            provider: reply.results.provider,
        };
    }
    async health() {
        const result = await this.transport.healthCheck(this.timeoutMs);
        return { ok: result.healthy, detail: result.message };
    }
}
exports.PluginSearchProvider = PluginSearchProvider;
//# sourceMappingURL=plugin-search-provider.js.map