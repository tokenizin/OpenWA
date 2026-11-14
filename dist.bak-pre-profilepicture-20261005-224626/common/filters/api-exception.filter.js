"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var ApiExceptionFilter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiExceptionFilter = void 0;
const common_1 = require("@nestjs/common");
let ApiExceptionFilter = class ApiExceptionFilter {
    static { ApiExceptionFilter_1 = this; }
    logger = new common_1.Logger(ApiExceptionFilter_1.name);
    static MAX_MESSAGE_CHARS = 500;
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const res = ctx.getResponse();
        const req = ctx.getRequest();
        if (res.headersSent)
            return;
        const status = exception instanceof common_1.HttpException
            ? exception.getStatus()
            : common_1.HttpStatus.INTERNAL_SERVER_ERROR;
        const raw = this.extractMessage(exception);
        const message = ApiExceptionFilter_1.normalise(raw);
        if (status >= common_1.HttpStatus.INTERNAL_SERVER_ERROR) {
            this.logger.error(`${req?.method ?? '-'} ${req?.originalUrl ?? req?.url ?? '-'} -> ${status}: ${message}`, exception instanceof Error ? exception.stack : undefined);
        }
        res.status(status).json({
            statusCode: status,
            message,
            error: common_1.HttpStatus[status] ?? 'Error',
        });
    }
    extractMessage(exception) {
        if (exception instanceof common_1.HttpException) {
            const response = exception.getResponse();
            if (Array.isArray(response))
                return response;
            if (typeof response === 'string')
                return response;
            const body = response;
            return body?.message ?? exception.message;
        }
        if (exception instanceof Error)
            return exception.message;
        return String(exception);
    }
    static normalise(value) {
        if (Array.isArray(value)) {
            const parts = value.map((v) => ApiExceptionFilter_1.scalar(v));
            return parts.length ? parts : 'Internal server error';
        }
        return ApiExceptionFilter_1.scalar(value);
    }
    static scalar(value) {
        let text;
        if (typeof value === 'string') {
            text = value;
        }
        else if (value === null || value === undefined) {
            text = 'Internal server error';
        }
        else if (typeof value === 'object') {
            try {
                text = JSON.stringify(value);
            }
            catch {
                text = 'Internal server error';
            }
        }
        else {
            text = String(value);
        }
        text = text.trim();
        if (!text)
            text = 'Internal server error';
        return text.length > ApiExceptionFilter_1.MAX_MESSAGE_CHARS
            ? `${text.slice(0, ApiExceptionFilter_1.MAX_MESSAGE_CHARS)}…`
            : text;
    }
};
exports.ApiExceptionFilter = ApiExceptionFilter;
exports.ApiExceptionFilter = ApiExceptionFilter = ApiExceptionFilter_1 = __decorate([
    (0, common_1.Catch)()
], ApiExceptionFilter);
//# sourceMappingURL=api-exception.filter.js.map