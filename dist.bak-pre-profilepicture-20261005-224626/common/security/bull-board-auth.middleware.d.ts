import { NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { KeyRateLimiter } from '../../modules/mcp/mcp-rate-limit';
export declare class BullBoardAuthMiddleware implements NestMiddleware {
    private readonly authService;
    private readonly configService;
    private readonly ipRateLimiter;
    constructor(authService: AuthService, configService: ConfigService, ipRateLimiter?: KeyRateLimiter);
    private static createDefaultIpLimiter;
    use(req: Request, _res: Response, next: NextFunction): Promise<void>;
    private extractKey;
    private getClientIp;
}
