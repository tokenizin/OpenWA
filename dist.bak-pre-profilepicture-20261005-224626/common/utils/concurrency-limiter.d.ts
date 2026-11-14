export declare class ConcurrencyLimiter {
    private readonly max;
    private readonly maxQueued;
    private active;
    private readonly waiters;
    constructor(max: number, maxQueued?: number);
    run<T>(task: () => Promise<T>): Promise<T>;
}
