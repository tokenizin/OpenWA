"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveSessionScope = resolveSessionScope;
function resolveSessionScope(allowedSessions, requestedSessionId) {
    const scoped = allowedSessions != null && allowedSessions.length > 0;
    if (scoped) {
        return requestedSessionId ? allowedSessions.filter(s => s === requestedSessionId) : allowedSessions;
    }
    return requestedSessionId ? [requestedSessionId] : null;
}
//# sourceMappingURL=session-scope.js.map