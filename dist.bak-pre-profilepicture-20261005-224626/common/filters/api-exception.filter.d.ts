import { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
export declare class ApiExceptionFilter implements ExceptionFilter {
    private readonly logger;
    private static readonly MAX_MESSAGE_CHARS;
    catch(exception: unknown, host: ArgumentsHost): void;
    private extractMessage;
    private static normalise;
    private static scalar;
}
