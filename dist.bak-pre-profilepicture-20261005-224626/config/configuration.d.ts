declare const _default: () => {
    port: number;
    http: {
        requestTimeoutMs: number;
        headersTimeoutMs: number;
        keepAliveTimeoutMs: number;
    };
    search: {
        enabled: boolean;
        provider: string;
        limitMax: number;
    };
    features: import("./feature-flags").FeatureFlags;
    redis: {
        host: string;
        port: number;
        username: string | undefined;
        password: string | undefined;
        connectTimeoutMs: number;
    };
    queue: {
        enabled: boolean;
    };
    cache: {
        enabled: boolean;
    };
    database: {
        type: "sqlite" | "postgres";
        database: string;
        host: string;
        port: number;
        username: string | undefined;
        password: string | undefined;
        name: string;
        schema: string;
        poolSize: number;
        ssl: boolean;
        sslRejectUnauthorized: boolean;
        synchronize: boolean;
        logging: boolean;
    };
    dataDatabase: {
        type: string;
        database: string;
        name: string;
        schema: string;
        host: string;
        port: number;
        username: string | undefined;
        password: string | undefined;
        synchronize: boolean;
        logging: boolean;
        poolSize: number;
        statementTimeoutMs: number;
        idleTimeoutMs: number;
        connectionTimeoutMs: number;
        ssl: boolean;
        sslRejectUnauthorized: boolean;
    };
    engine: {
        type: string;
        puppeteer: {
            headless: boolean;
            args: string[];
            executablePath: string | undefined;
        };
        sessionDataPath: string;
        baileys: {
            authDir: string;
        };
    };
    sessions: {
        maxConcurrent: number;
    };
    webhook: {
        timeout: number;
        retryDelay: number;
        dispatchConcurrency: number;
        dispatchMaxQueued: number;
    };
    api: {
        rateLimit: {
            shortTtl: number;
            shortLimit: number;
            mediumTtl: number;
            mediumLimit: number;
            longTtl: number;
            longLimit: number;
        };
    };
    security: {
        trustedProxies: string[];
    };
    plugins: {
        dir: string;
        catalogUrl: string;
        downloadMaxBytes: number;
    };
    storage: {
        type: string;
        localPath: string;
        s3: {
            bucket: string | undefined;
            region: string | undefined;
            accessKeyId: string | undefined;
            secretAccessKey: string | undefined;
            endpoint: string | undefined;
        };
    };
};
export default _default;
