import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { EngineFactory } from '../../engine/engine.factory';
import { DockerService } from '../docker';
import { CacheService } from '../../common/cache/cache.service';
import { StorageService } from '../../common/storage/storage.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { AuditService } from '../audit/audit.service';
import { ImportStorageDto } from './dto/import-storage.dto';
interface InfraStatus {
    database: {
        connected: boolean;
        type: string;
        host: string;
        builtIn: boolean;
    };
    redis: {
        enabled: boolean;
        connected: boolean;
        host: string;
        port: number;
        builtIn: boolean;
    };
    queue: {
        enabled: boolean;
        webhooks: {
            pending: number;
            completed: number;
            failed: number;
        };
    };
    storage: {
        type: 'local' | 's3';
        path?: string;
        bucket?: string;
        builtIn: boolean;
        s3Available?: boolean;
    };
    engine: {
        type: string;
        headless: boolean;
        sessionDataPath: string;
        browserArgs: string;
        webVersion?: string | null;
        webVersionSource?: 'pinned' | 'auto' | 'native';
    };
}
declare class DatabaseConfigDto {
    type: 'sqlite' | 'postgres';
    builtIn?: boolean;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    schema?: string;
    poolSize?: number;
    sslEnabled?: boolean;
    sslRejectUnauthorized?: boolean;
}
declare class RedisConfigDto {
    enabled?: boolean;
    builtIn?: boolean;
    host?: string;
    port?: string;
    password?: string;
}
declare class QueueConfigDto {
    enabled?: boolean;
}
declare class StorageConfigDto {
    type: 'local' | 's3';
    builtIn?: boolean;
    localPath?: string;
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
}
declare class EngineConfigDto {
    type?: string;
    headless?: boolean;
    sessionDataPath?: string;
    browserArgs?: string;
}
declare class SaveConfigDto {
    database?: DatabaseConfigDto;
    redis?: RedisConfigDto;
    queue?: QueueConfigDto;
    storage?: StorageConfigDto;
    engine?: EngineConfigDto;
}
declare class RestartDto {
    profiles?: string[];
    profilesToRemove?: string[];
}
interface SessionRow {
    id: string;
    name: string;
    status: string;
    phone: string | null;
    pushName: string | null;
    config: string | Record<string, unknown>;
    proxyUrl: string | null;
    proxyType: string | null;
    connectedAt: string | null;
    lastActiveAt: string | null;
    createdAt: string;
    updatedAt: string;
}
interface WebhookRow {
    id: string;
    sessionId: string;
    url: string;
    events: string | string[];
    secret: string | null;
    headers: string | Record<string, string>;
    filters: string | Record<string, unknown> | null;
    active: boolean | number;
    retryCount: number;
    lastTriggeredAt: string | null;
    createdAt: string;
    updatedAt: string;
}
interface MessageRow {
    id: string;
    sessionId: string;
    waMessageId: string | null;
    chatId: string;
    chatName: string | null;
    from: string;
    to: string;
    body: string | null;
    type: string;
    direction: string;
    timestamp: number | string | null;
    metadata: string | Record<string, unknown> | null;
    status: string;
    createdAt: string;
}
interface MessageBatchRow {
    id: string;
    batch_id: string;
    session_id: string;
    status: string;
    messages: string | unknown[];
    options: string | Record<string, unknown> | null;
    progress: string | Record<string, unknown> | null;
    results: string | unknown[] | null;
    current_index: number;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    completed_at: string | null;
}
interface TemplateRow {
    id: string;
    sessionId: string;
    name: string;
    body: string;
    header: string | null;
    footer: string | null;
    createdAt: string;
    updatedAt: string;
}
interface BaileysStoredMessageRow {
    id: string;
    sessionId: string;
    waMessageId: string;
    serializedMessage: string;
    createdAt: string;
}
interface LidMappingRow {
    lid: string;
    phone: string | null;
    sessionId: string | null;
    updatedAt: string;
}
interface PluginInstanceRow {
    id: string;
    pluginId: string;
    instanceId: string;
    sessionScope: string | null;
    secret: string;
    verifyToken: string | null;
    config: string | Record<string, unknown> | null;
    enabled: boolean | number;
    createdAt: string;
    updatedAt: string;
}
interface ConversationMappingRow {
    id: string;
    sessionId: string;
    chatId: string;
    pluginId: string;
    instanceId: string;
    providerConversationId: string;
    handoverState: string;
    metadata: string | Record<string, unknown> | null;
    updatedAt: string;
}
interface IngressEventRow {
    id: string;
    instanceId: string;
    pluginId: string;
    providerDeliveryId: string;
    route: string;
    payload: string | Record<string, unknown>;
    sessionId: string | null;
    createdAt: string;
}
interface WebhookDeliveryFailureRow {
    id: string;
    webhookId: string;
    sessionId: string;
    event: string;
    url: string;
    idempotencyKey: string | null;
    deliveryId: string | null;
    attempts: number;
    lastStatusCode: number | null;
    lastError: string;
    createdAt: string;
}
interface IntegrationDeliveryFailureRow {
    id: string;
    direction: string;
    pluginId: string;
    instanceId: string;
    sessionId: string | null;
    deliveryId: string | null;
    attempts: number;
    lastError: string;
    payload: string | Record<string, unknown> | null;
    redriven: boolean | number;
    createdAt: string;
}
interface MigrationTables {
    sessions: SessionRow[];
    webhooks: WebhookRow[];
    messages: MessageRow[];
    messageBatches: MessageBatchRow[];
    templates: TemplateRow[];
    baileysStoredMessages: BaileysStoredMessageRow[];
    lidMappings: LidMappingRow[];
    pluginInstances: PluginInstanceRow[];
    conversationMappings: ConversationMappingRow[];
    ingressEvents: IngressEventRow[];
    webhookDeliveryFailures: WebhookDeliveryFailureRow[];
    integrationDeliveryFailures: IntegrationDeliveryFailureRow[];
}
interface SavedConfigResponse {
    database: {
        type: 'sqlite' | 'postgres';
        builtIn: boolean;
        host: string;
        port: string;
        username: string;
        database: string;
        schema: string;
        poolSize: number;
        sslEnabled: boolean;
        sslRejectUnauthorized: boolean;
        passwordSet: boolean;
    };
    redis: {
        enabled: boolean;
        builtIn: boolean;
        host: string;
        port: string;
        passwordSet: boolean;
    };
    queue: {
        enabled: boolean;
    };
    storage: {
        type: 'local' | 's3';
        builtIn: boolean;
        localPath: string;
        s3Bucket: string;
        s3Region: string;
        s3Endpoint: string;
        s3CredentialsSet: boolean;
    };
    engine: {
        type: string;
        headless: boolean;
        sessionDataPath: string;
        browserArgs: string;
    };
}
export declare class InfraController {
    private readonly configService;
    private readonly mainDataSource;
    private readonly dataDataSource;
    private readonly engineFactory;
    private readonly dockerService;
    private readonly cacheService;
    private readonly storageService;
    private readonly shutdownService;
    private readonly webhookQueue?;
    private readonly auditService?;
    private readonly logger;
    constructor(configService: ConfigService, mainDataSource: DataSource, dataDataSource: DataSource, engineFactory: EngineFactory, dockerService: DockerService, cacheService: CacheService, storageService: StorageService, shutdownService: ShutdownService, webhookQueue?: Queue | undefined, auditService?: AuditService | undefined);
    private static readonly DB_PROBE_TIMEOUT_MS;
    private probeDbConnected;
    getStatus(): Promise<InfraStatus>;
    private readSavedBuiltinFlags;
    getEngines(): Array<{
        id: string;
        name: string;
        enabled: boolean;
        features: string[];
    }>;
    getCurrentEngine(): {
        engineType: string;
    };
    getConfig(): SavedConfigResponse;
    saveConfig(config: SaveConfigDto): {
        message: string;
        saved: boolean;
        envPath: string;
        profiles: string[];
    };
    requestRestart(body?: RestartDto): Promise<{
        message: string;
        restarting: boolean;
        profiles: string[];
        profilesToRemove: string[];
        estimatedTime: number;
        orchestration?: object;
        removal?: object;
    }>;
    healthCheck(): {
        status: string;
        timestamp: string;
    };
    exportData(): Promise<{
        exportedAt: string;
        dataDbType: string;
        tables: MigrationTables;
        counts: {
            sessions: number;
            webhooks: number;
            messages: number;
            messageBatches: number;
            templates: number;
            baileysStoredMessages: number;
            lidMappings: number;
            pluginInstances: number;
            conversationMappings: number;
            ingressEvents: number;
            webhookDeliveryFailures: number;
            integrationDeliveryFailures: number;
        };
    }>;
    importData(data: {
        tables: Partial<MigrationTables>;
    }): Promise<{
        imported: boolean;
        counts: {
            sessions: number;
            webhooks: number;
            messages: number;
            messageBatches: number;
            templates: number;
            baileysStoredMessages: number;
            lidMappings: number;
            pluginInstances: number;
            conversationMappings: number;
            ingressEvents: number;
            webhookDeliveryFailures: number;
            integrationDeliveryFailures: number;
        };
        warnings: string[];
    }>;
    getStorageFileCount(): Promise<{
        storageType: string;
        count: number;
        sizeBytes: number;
        sizeMB: string;
    }>;
    exportStorage(): Promise<{
        message: string;
        download: string;
    }>;
    importStorage(body: ImportStorageDto): Promise<{
        imported: boolean;
        count: number;
        storageType: string;
    }>;
}
export {};
