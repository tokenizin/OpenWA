import { ArgumentsHost, HttpException, HttpStatus, InternalServerErrorException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiExceptionFilter } from './api-exception.filter';

/**
 * Regression cover for the `[object Object]` media-send failure.
 *
 * A whatsapp-web.js in-page send failure reaches Nest as a bare `Error`. With no global filter the
 * stock handler emits `{ statusCode: 500, message: 'Internal server error' }` — no `error` key — so a
 * client that detects the Nest envelope by key (the `@rmyndharis/openwa` SDK's `isNestEnvelope`)
 * falls back to `String()`-ing the whole body. These tests pin the two properties that prevent that:
 * a complete envelope, and a `message` that is never a bare object.
 */
describe('ApiExceptionFilter', () => {
  let json: jest.Mock;
  let res: Partial<Response>;
  let host: ArgumentsHost;

  const request = { method: 'POST', originalUrl: '/api/sessions/x/messages/send-image' } as Request;

  beforeEach(() => {
    json = jest.fn();
    res = { status: jest.fn().mockReturnThis(), json, headersSent: false };
    host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => request }) } as unknown as ArgumentsHost;
  });

  /** The envelope the filter writes; any extra keys a body carried are kept alongside it. */
  interface Body {
    statusCode: number;
    message: unknown;
    error: string;
    [key: string]: unknown;
  }

  const run = (exception: unknown): Body => {
    new ApiExceptionFilter().catch(exception, host);
    const [first] = json.mock.calls[0] as [Body];
    return first;
  };

  it('keeps the real reason for a bare Error instead of "Internal server error"', () => {
    const body = run(new Error('Media fetch failed with status 403'));

    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Media fetch failed with status 403');
  });

  it('always emits a complete Nest envelope (statusCode + message + error)', () => {
    const body = run(new Error('boom'));

    // `error` is the key the SDK's isNestEnvelope() checks; omitting it is what caused the
    // whole-body String() fallback and the literal "[object Object]".
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect(body.error).toBe('INTERNAL_SERVER_ERROR');
  });

  it('keeps the fields an HttpException body carries (the readiness probe reads details.shutdown)', () => {
    // The health controller answers 503 with { status, details: { shutdown: { status } } }. The envelope is
    // added, but the body's own fields must survive: the load balancer reads the draining state from them.
    const body = run(new HttpException({ status: 'error', details: { shutdown: { status: 'draining' } } }, 503));

    expect(body.details).toEqual({ shutdown: { status: 'draining' } });
    expect(body.status).toBe('error');
    expect(body.statusCode).toBe(503);
    expect(body.error).toBe('SERVICE_UNAVAILABLE');
  });

  it('never renders an object message as [object Object]', () => {
    // The exact shape that reached the dashboard before: message is a non-string object.
    const body = run(new HttpException({ message: { code: 'E_MEDIA', detail: 'upload rejected' } }, 500));

    expect(typeof body.message).toBe('string');
    expect(body.message).not.toContain('[object Object]');
    expect(body.message).toContain('upload rejected');
  });

  it('preserves HttpException status codes and array messages', () => {
    const body = run(new HttpException(['url must be a URL', 'chatId is required'], HttpStatus.BAD_REQUEST));

    expect(body.statusCode).toBe(400);
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toEqual(['url must be a URL', 'chatId is required']);
  });

  it('keeps an InternalServerErrorException message verbatim', () => {
    const body = run(
      new InternalServerErrorException(
        'the engine returned no message for this send, so it may not have been delivered — check the chat before retrying',
      ),
    );

    expect(body.statusCode).toBe(500);
    expect(body.message).toContain('may not have been delivered');
  });

  it('caps very long messages so a stack cannot balloon a response body', () => {
    const body = run(new Error('x'.repeat(5000)));

    expect(String(body.message).length).toBeLessThanOrEqual(501); // 500 + ellipsis
  });

  it('does nothing when the response has already been sent', () => {
    (res as Response & { headersSent: boolean }).headersSent = true;

    new ApiExceptionFilter().catch(new Error('late'), host);

    expect(json).not.toHaveBeenCalled();
  });
});
