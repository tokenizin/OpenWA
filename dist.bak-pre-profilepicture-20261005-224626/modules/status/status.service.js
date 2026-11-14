"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusService = void 0;
const common_1 = require("@nestjs/common");
const session_service_1 = require("../session/session.service");
const media_cap_util_1 = require("../message/media-cap.util");
const hooks_1 = require("../../core/hooks");
let StatusService = class StatusService {
    sessionService;
    hookManager;
    constructor(sessionService, hookManager) {
        this.sessionService = sessionService;
        this.hookManager = hookManager;
    }
    gate(sessionId, type, input) {
        return (0, hooks_1.applySendingGate)(this.hookManager, sessionId, type, input, 'StatusService');
    }
    guardGatedMedia(media) {
        const data = (0, media_cap_util_1.stripBase64DataUri)(media.data) ?? media.data;
        (0, media_cap_util_1.assertBase64WithinMediaCap)(data);
        return { mimetype: media.mimetype, data };
    }
    async getStatuses(sessionId) {
        const engine = this.sessionService.getEngine(sessionId);
        if (!engine) {
            throw new common_1.NotFoundException(`Session ${sessionId} not found or not connected`);
        }
        return engine.getContactStatuses();
    }
    async getContactStatus(sessionId, contactId) {
        const engine = this.sessionService.getEngine(sessionId);
        if (!engine) {
            throw new common_1.NotFoundException(`Session ${sessionId} not found or not connected`);
        }
        return engine.getContactStatus(contactId);
    }
    async postTextStatus(sessionId, text, options) {
        const engine = this.sessionService.getEngine(sessionId);
        if (!engine) {
            throw new common_1.NotFoundException(`Session ${sessionId} not found or not connected`);
        }
        const gated = await this.gate(sessionId, 'status-text', { text, options });
        return engine.postTextStatus(gated.text, gated.options);
    }
    async postImageStatus(sessionId, media, options) {
        const base64 = (0, media_cap_util_1.stripBase64DataUri)(media?.base64);
        const url = media?.url;
        const mimetype = media?.mimetype;
        if (!url && !base64) {
            throw new common_1.BadRequestException('Either url or base64 must be provided');
        }
        (0, media_cap_util_1.assertBase64WithinMediaCap)(base64);
        const engine = this.sessionService.getEngine(sessionId);
        if (!engine) {
            throw new common_1.NotFoundException(`Session ${sessionId} not found or not connected`);
        }
        const gated = await this.gate(sessionId, 'status-image', {
            media: { mimetype: mimetype ?? 'image/jpeg', data: base64 || url || '' },
            options,
        });
        return engine.postImageStatus(this.guardGatedMedia(gated.media), gated.options);
    }
    async postVideoStatus(sessionId, media, options) {
        const base64 = (0, media_cap_util_1.stripBase64DataUri)(media?.base64);
        const url = media?.url;
        const mimetype = media?.mimetype;
        if (!url && !base64) {
            throw new common_1.BadRequestException('Either url or base64 must be provided');
        }
        (0, media_cap_util_1.assertBase64WithinMediaCap)(base64);
        const engine = this.sessionService.getEngine(sessionId);
        if (!engine) {
            throw new common_1.NotFoundException(`Session ${sessionId} not found or not connected`);
        }
        const gated = await this.gate(sessionId, 'status-video', {
            media: { mimetype: mimetype ?? 'video/mp4', data: base64 || url || '' },
            options,
        });
        return engine.postVideoStatus(this.guardGatedMedia(gated.media), gated.options);
    }
    async deleteStatus(sessionId, statusId) {
        const engine = this.sessionService.getEngine(sessionId);
        if (!engine) {
            throw new common_1.NotFoundException(`Session ${sessionId} not found or not connected`);
        }
        return engine.deleteStatus(statusId);
    }
};
exports.StatusService = StatusService;
exports.StatusService = StatusService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [session_service_1.SessionService,
        hooks_1.HookManager])
], StatusService);
//# sourceMappingURL=status.service.js.map