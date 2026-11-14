import type { Redis } from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';
interface ThrottlerRecord {
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
}
export declare class RedisThrottlerStorage implements ThrottlerStorage {
    private readonly redis;
    private readonly logger;
    constructor(redis: Redis);
    increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerRecord>;
}
export {};
