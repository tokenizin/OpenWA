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
var BullBoardAuthMiddleware_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BullBoardAuthMiddleware = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const auth_service_1 = require("../../modules/auth/auth.service");
const api_key_entity_1 = require("../../modules/auth/entities/api-key.entity");
const mcp_rate_limit_1 = require("../../modules/mcp/mcp-rate-limit");
const ip_1 = require("../utils/ip");
let BullBoardAuthMiddleware = BullBoardAuthMiddleware_1 = class BullBoardAuthMiddleware {
    authService;
    configService;
    ipRateLimiter;
    constructor(authService, configService, ipRateLimiter) {
        this.authService = authService;
        this.configService = configService;
        this.ipRateLimiter = ipRateLimiter ?? BullBoardAuthMiddleware_1.createDefaultIpLimiter();
    }
    static createDefaultIpLimiter() {
        const { max, windowMs } = (0, mcp_rate_limit_1.readIpRateLimitConfig)();
        return new mcp_rate_limit_1.KeyRateLimiter(max, windowMs);
    }
    async use(req, _res, next) {
        try {
            const clientIp = this.getClientIp(req);
            this.ipRateLimiter.check(clientIp);
            const rawKey = this.extractKey(req);
            if (!rawKey) {
                throw new common_1.UnauthorizedException('API key is required to access the queue dashboard');
            }
            const apiKey = await this.authService.validateApiKey(rawKey, clientIp);
            if (!this.authService.hasPermission(apiKey, api_key_entity_1.ApiKeyRole.ADMIN)) {
                throw new common_1.ForbiddenException('Admin role required to access the queue dashboard');
            }
            next();
        }
        catch (err) {
            next(err);
        }
    }
    extractKey(req) {
        const header = req.headers['x-api-key'];
        if (typeof header === 'string' && header)
            return header;
        const authHeader = req.headers['authorization'];
        if (authHeader?.startsWith('Bearer '))
            return authHeader.slice(7);
        return undefined;
    }
    getClientIp(req) {
        const trustedProxies = this.configService.get('security.trustedProxies') ?? [];
        return (0, ip_1.resolveClientIp)(req, trustedProxies);
    }
};
exports.BullBoardAuthMiddleware = BullBoardAuthMiddleware;
exports.BullBoardAuthMiddleware = BullBoardAuthMiddleware = BullBoardAuthMiddleware_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [auth_service_1.AuthService,
        config_1.ConfigService,
        mcp_rate_limit_1.KeyRateLimiter])
], BullBoardAuthMiddleware);
//# sourceMappingURL=bull-board-auth.middleware.js.map