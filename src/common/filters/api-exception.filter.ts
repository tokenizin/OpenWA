import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Global catch-all that guarantees two things the stock Nest behaviour does not.
 *
 * 1. The response is ALWAYS a well-formed Nest envelope: `{ statusCode, message, error }`.
 *    A stock `HttpException` response omits nothing, but a bare `Error` reaches Nest's default
 *    handler as `{ statusCode: 500, message: 'Internal server error' }` — no `error` key. Clients
 *    that detect the envelope by key (the `@rmyndharis/openwa` SDK's `isNestEnvelope`) then treat the
 *    whole body as the message and `String()` it, which renders an object as `[object Object]` and
 *    throws the real reason away.
 *
 * 2. The reason SURVIVES for non-HttpException throws. `whatsapp-web-js.adapter.ts` documents why
 *    this matters (see `toStatusResult`): without a global filter a bare `Error` is flattened to
 *    `'Internal server error'`, so `message:failed` consumers and API callers cannot tell a transient
 *    media failure from a permanent one.
 *
 * Deliberately does NOT widen what is exposed: `MessageService.toClientFacingError` already maps
 * SSRF-blocked fetches to a generic 400 so the resolved internal address never reaches a caller, and
 * that mapping is untouched here. This filter only stops the *loss* of detail that is safe to show,
 * and caps it so a stack-ish message cannot balloon a response body.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  /** Upper bound on a single echoed message. Long engine/JS stacks are logged, not returned. */
  private static readonly MAX_MESSAGE_CHARS = 500;

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    // A batch/rpc transport may not expose an Express-style response; fall back to the generic host.
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (res.headersSent) return;

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const raw = this.extractMessage(exception);
    const message = ApiExceptionFilter.normalise(raw);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${req?.method ?? '-'} ${req?.originalUrl ?? req?.url ?? '-'} -> ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    res.status(status).json({
      statusCode: status,
      message,
      error: HttpStatus[status] ?? 'Error',
    });
  }

  /**
   * Pull the message out of whatever was thrown, without ever yielding a non-string.
   * A plain object (or array of objects) here is exactly the case that used to become
   * `[object Object]` downstream, so it is serialised rather than coerced.
   */
  private extractMessage(exception: unknown): unknown {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      // `new HttpException([...], status)` keeps the array as the whole response, whereas the
      // ValidationPipe builds `{ message: [...] }`. Accept both so array messages survive either way.
      if (Array.isArray(response)) return response;
      if (typeof response === 'string') return response;
      const body = response as { message?: unknown };
      return body?.message ?? exception.message;
    }
    if (exception instanceof Error) return exception.message;
    return String(exception);
  }

  private static normalise(value: unknown): string | string[] {
    if (Array.isArray(value)) {
      const parts = value.map((v) => ApiExceptionFilter.scalar(v));
      return parts.length ? parts : 'Internal server error';
    }
    return ApiExceptionFilter.scalar(value);
  }

  private static scalar(value: unknown): string {
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else if (value === null || value === undefined) {
      text = 'Internal server error';
    } else if (typeof value === 'object') {
      // JSON, not String(): String({...}) is precisely the '[object Object]' we are eliminating.
      try {
        text = JSON.stringify(value);
      } catch {
        text = 'Internal server error';
      }
    } else {
      text = String(value);
    }
    text = text.trim();
    if (!text) text = 'Internal server error';
    return text.length > ApiExceptionFilter.MAX_MESSAGE_CHARS
      ? `${text.slice(0, ApiExceptionFilter.MAX_MESSAGE_CHARS)}…`
      : text;
  }
}
