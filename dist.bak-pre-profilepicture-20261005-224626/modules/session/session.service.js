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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var SessionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionService = exports.EngineInitTimeoutError = exports.ACK_RECONCILE_DELAY_MS = exports.SESSION_WATCHDOG_MAX_FAILURES = exports.SESSION_WATCHDOG_PROBE_TIMEOUT_MS = exports.SESSION_WATCHDOG_INTERVAL_MS = void 0;
exports.resolveReconnectConfig = resolveReconnectConfig;
exports.clampReconnectDelay = clampReconnectDelay;
exports.resolveMaxConcurrentSessions = resolveMaxConcurrentSessions;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const session_entity_1 = require("./entities/session.entity");
const message_entity_1 = require("../message/entities/message.entity");
const message_batch_entity_1 = require("../message/entities/message-batch.entity");
const webhook_entity_1 = require("../webhook/entities/webhook.entity");
const template_entity_1 = require("../template/entities/template.entity");
const baileys_stored_message_entity_1 = require("../../engine/adapters/baileys-stored-message.entity");
const engine_factory_1 = require("../../engine/engine.factory");
const whatsapp_web_js_adapter_1 = require("../../engine/adapters/whatsapp-web-js.adapter");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const wa_id_1 = require("../../engine/identity/wa-id");
const paginate_1 = require("../../common/utils/paginate");
const unique_constraint_util_1 = require("../../common/utils/unique-constraint.util");
const feature_flags_1 = require("../../config/feature-flags");
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const logger_service_1 = require("../../common/services/logger.service");
const shutdown_service_1 = require("../../common/services/shutdown.service");
const session_reconnect_metrics_1 = require("../../common/metrics/session-reconnect-metrics");
const events_gateway_1 = require("../events/events.gateway");
const webhook_service_1 = require("../webhook/webhook.service");
const hooks_1 = require("../../core/hooks");
const message_status_util_1 = require("../message/message-status.util");
const MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'voice', 'sticker', 'document']);
const RECONNECT_BASE_DELAY_MIN_MS = 1000;
const RECONNECT_BASE_DELAY_MAX_MS = 300_000;
const RECONNECT_MAX_ATTEMPTS_CAP = 20;
const RECONNECT_DELAY_CAP_MS = 3_600_000;
const RECONNECT_STABILITY_RESET_MS = 300_000;
const RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS = 5;
exports.SESSION_WATCHDOG_INTERVAL_MS = 60_000;
exports.SESSION_WATCHDOG_PROBE_TIMEOUT_MS = 15_000;
exports.SESSION_WATCHDOG_MAX_FAILURES = 2;
exports.ACK_RECONCILE_DELAY_MS = 750;
const clampNumber = (n, min, max) => Math.min(Math.max(n, min), max);
function resolveReconnectConfig(config) {
    const baseRaw = Number(config?.reconnectBaseDelay);
    const baseDelay = clampNumber(Number.isFinite(baseRaw) ? baseRaw : 5000, RECONNECT_BASE_DELAY_MIN_MS, RECONNECT_BASE_DELAY_MAX_MS);
    const attemptsRaw = Number(config?.maxReconnectAttempts);
    const maxAttempts = Number.isFinite(attemptsRaw)
        ? Math.floor(clampNumber(attemptsRaw, 0, RECONNECT_MAX_ATTEMPTS_CAP))
        : Number.POSITIVE_INFINITY;
    return { maxAttempts, baseDelay };
}
function clampReconnectDelay(rawDelay, baseDelay) {
    return clampNumber(Number.isFinite(rawDelay) ? rawDelay : baseDelay, 0, RECONNECT_DELAY_CAP_MS);
}
function resolveMaxConcurrentSessions(configService) {
    const configured = configService?.get('sessions.maxConcurrent', 0) ?? 0;
    if (!Number.isFinite(configured) || configured <= 0)
        return null;
    return Math.floor(configured);
}
class EngineInitTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`engine.initialize() timed out after ${timeoutMs}ms`);
        this.timeoutMs = timeoutMs;
        this.name = 'EngineInitTimeoutError';
    }
}
exports.EngineInitTimeoutError = EngineInitTimeoutError;
const ENGINE_AUTH_TIMEOUT = 'auth timeout';
const ENGINE_AUTH_TIMEOUT_MESSAGE = 'WhatsApp Web authentication timed out. Verify the session proxy URL and network egress can reach ' +
    'WhatsApp; for slow first boots, raise WWEBJS_AUTH_TIMEOUT_MS.';
function isAuthTimeoutRejection(err) {
    return err === ENGINE_AUTH_TIMEOUT || (err instanceof Error && err.message === ENGINE_AUTH_TIMEOUT);
}
let SessionService = class SessionService {
    static { SessionService_1 = this; }
    sessionRepository;
    messageRepository;
    dataSource;
    engineFactory;
    eventsGateway;
    webhookService;
    hookManager;
    configService;
    lidMappingStore;
    shutdownService;
    logger = (0, logger_service_1.createLogger)('SessionService');
    engines = new Map();
    lidPhoneCache = new Map();
    static LID_PHONE_CACHE_MAX = 5000;
    sessionErrors = new Map();
    reconnectStates = new Map();
    livenessFailures = new Map();
    watchdogTimer = null;
    lastDispatchedStatus = new Map();
    stoppingSessions = new Set();
    initializingSessions = new Set();
    messageMutationChains = new Map();
    constructor(sessionRepository, messageRepository, dataSource, engineFactory, eventsGateway, webhookService, hookManager, configService, lidMappingStore, shutdownService) {
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.dataSource = dataSource;
        this.engineFactory = engineFactory;
        this.eventsGateway = eventsGateway;
        this.webhookService = webhookService;
        this.hookManager = hookManager;
        this.configService = configService;
        this.lidMappingStore = lidMappingStore;
        this.shutdownService = shutdownService;
    }
    async onModuleInit() {
        const activeStatuses = [
            session_entity_1.SessionStatus.READY,
            session_entity_1.SessionStatus.INITIALIZING,
            session_entity_1.SessionStatus.QR_READY,
            session_entity_1.SessionStatus.AUTHENTICATING,
        ];
        const result = await this.sessionRepository.update({ status: (0, typeorm_2.In)(activeStatuses) }, { status: session_entity_1.SessionStatus.DISCONNECTED });
        if (result.affected && result.affected > 0) {
            this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
                action: 'startup_reset',
                affected: result.affected,
            });
        }
    }
    async onApplicationBootstrap() {
        this.startWatchdog();
        if (!(0, feature_flags_1.resolveFeatureFlags)(this.configService).autoStartSessions)
            return;
        const sessions = await this.sessionRepository.find({
            where: { phone: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()), status: session_entity_1.SessionStatus.DISCONNECTED },
        });
        if (sessions.length === 0)
            return;
        this.logger.log(`Auto-starting ${sessions.length} previously authenticated session(s)`, {
            action: 'auto_start',
            count: sessions.length,
        });
        for (let i = 0; i < sessions.length; i++) {
            const session = sessions[i];
            try {
                await this.start(session.id);
                this.logger.log(`Auto-started session: ${session.name}`, {
                    sessionId: session.id,
                    action: 'auto_start_success',
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                this.logger.error(`Auto-start failed for session: ${session.name}`, errorMessage, {
                    sessionId: session.id,
                    action: 'auto_start_failed',
                });
            }
            if (i < sessions.length - 1) {
                await this.delay(2000);
            }
        }
    }
    async onModuleDestroy() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        this.livenessFailures.clear();
        for (const [, state] of this.reconnectStates) {
            if (state.timer) {
                clearTimeout(state.timer);
            }
        }
        this.reconnectStates.clear();
        await Promise.allSettled([...this.engines].map(([sessionId, engine]) => this.destroyEngineSafely(sessionId, engine)));
        this.engines.clear();
    }
    async destroyEngineSafely(sessionId, engine) {
        this.logger.log(`Destroying engine for session ${sessionId}`, { sessionId, action: 'shutdown' });
        await this.teardownEngineSafely(sessionId, engine, e => e.destroy(), 'destroy');
    }
    async teardownEngineSafely(sessionId, engine, teardown, label) {
        let timer;
        try {
            await Promise.race([
                teardown(engine),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`engine.${label}() timed out`)), 10_000);
                }),
            ]);
        }
        catch (err) {
            this.logger.error(`Failed to ${label} engine for session ${sessionId}`, String(err), {
                sessionId,
                action: `engine_${label}_failed`,
            });
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    evictAndForceDestroy(id, engine) {
        this.engines.delete(id);
        void this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
    }
    async create(dto) {
        const existing = await this.sessionRepository.findOne({
            where: { name: dto.name },
        });
        if (existing) {
            throw new common_1.ConflictException(`Session with name '${dto.name}' already exists`);
        }
        const session = this.sessionRepository.create({
            name: dto.name,
            config: dto.config || {},
            proxyUrl: dto.proxyUrl || null,
            proxyType: dto.proxyType || null,
            status: session_entity_1.SessionStatus.CREATED,
        });
        let saved;
        try {
            saved = await this.dataSource.transaction(async (manager) => {
                return await manager.save(session);
            });
        }
        catch (err) {
            if ((0, unique_constraint_util_1.isUniqueConstraintError)(err)) {
                throw new common_1.ConflictException(`Session with name '${dto.name}' already exists`);
            }
            throw err;
        }
        this.logger.log(`Session created: ${saved.name}`, {
            sessionId: saved.id,
            action: 'create',
        });
        await this.hookManager.execute('session:created', saved, {
            sessionId: saved.id,
            source: 'SessionService',
        });
        return saved;
    }
    async findAll(allowedSessions, opts = {}) {
        const { limit, offset } = (0, paginate_1.resolveListWindow)(opts.limit, opts.offset);
        const options = { order: { createdAt: 'DESC' }, take: limit, skip: offset };
        if (allowedSessions && allowedSessions.length > 0) {
            options.where = { id: (0, typeorm_2.In)(allowedSessions) };
        }
        const sessions = await this.sessionRepository.find(options);
        return sessions.map(session => this.attachLastError(session));
    }
    async findOne(id) {
        const session = await this.sessionRepository.findOne({ where: { id } });
        if (!session) {
            throw new common_1.NotFoundException(`Session with id '${id}' not found`);
        }
        return this.attachLastError(session);
    }
    attachLastError(session) {
        session.lastError = session.status === session_entity_1.SessionStatus.FAILED ? this.sessionErrors.get(session.id) : undefined;
        return session;
    }
    async findByName(name) {
        const session = await this.sessionRepository.findOne({ where: { name } });
        if (!session) {
            throw new common_1.NotFoundException(`Session with name '${name}' not found`);
        }
        return session;
    }
    async delete(id) {
        const session = await this.findOne(id);
        this.stoppingSessions.add(id);
        this.cancelReconnect(id);
        try {
            const engine = this.engines.get(id);
            if (engine) {
                await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
                if (this.isLiveEngine(id, engine))
                    this.engines.delete(id);
            }
            await this.hookManager.execute('session:deleted', {
                id: session.id,
                name: session.name,
                phone: session.phone,
                pushName: session.pushName,
            }, {
                sessionId: id,
                source: 'SessionService',
            });
            await this.dataSource.transaction(async (manager) => {
                await manager.delete(message_entity_1.Message, { sessionId: id });
                await manager.delete(message_batch_entity_1.MessageBatch, { sessionId: id });
                await manager.delete(webhook_entity_1.Webhook, { sessionId: id });
                await manager.delete(template_entity_1.Template, { sessionId: id });
                await manager.delete(baileys_stored_message_entity_1.BaileysStoredMessage, { sessionId: id });
                await manager.remove(session);
            });
            this.logger.log(`Session deleted: ${session.name}`, {
                sessionId: id,
                action: 'delete',
            });
            await this.engineFactory.purgeSessionData(session.name);
        }
        finally {
            this.stoppingSessions.delete(id);
            this.lastDispatchedStatus.delete(id);
            this.sessionErrors.delete(id);
        }
    }
    async start(id) {
        const session = await this.findOne(id);
        if (this.engines.has(id)) {
            throw new common_1.BadRequestException('Session is already started');
        }
        if (this.initializingSessions.has(id)) {
            throw new common_1.BadRequestException('Session is already starting');
        }
        const maxConcurrentSessions = resolveMaxConcurrentSessions(this.configService);
        if (maxConcurrentSessions !== null) {
            const activeCount = new Set([...this.engines.keys(), ...this.initializingSessions]).size;
            if (activeCount >= maxConcurrentSessions) {
                throw new common_1.BadRequestException(`Maximum concurrent sessions reached (${maxConcurrentSessions})`);
            }
        }
        this.initializingSessions.add(id);
        try {
            this.stoppingSessions.delete(id);
            this.cancelReconnect(id);
            await this.hookManager.execute('session:starting', { sessionId: id }, {
                sessionId: id,
                source: 'SessionService',
            });
            const { maxAttempts, baseDelay } = resolveReconnectConfig(session.config);
            this.reconnectStates.set(id, { attempts: 0, timer: null, maxAttempts, baseDelay });
            try {
                await this.initializeEngine(id, session);
            }
            catch (err) {
                const orphan = this.engines.get(id);
                if (orphan) {
                    this.engines.delete(id);
                    this.sessionErrors.set(id, err instanceof Error ? err.message : String(err));
                    await this.teardownEngineSafely(id, orphan, e => e.forceDestroy(), 'force-destroy');
                    await this.updateStatus(id, session_entity_1.SessionStatus.FAILED).catch(() => undefined);
                }
                throw err;
            }
            if (await this.isSessionRetired(id)) {
                const resurrected = this.engines.get(id);
                if (resurrected) {
                    await this.teardownEngineSafely(id, resurrected, e => e.destroy(), 'destroy');
                    if (this.isLiveEngine(id, resurrected))
                        this.engines.delete(id);
                }
            }
            return this.findOne(id);
        }
        finally {
            this.initializingSessions.delete(id);
        }
    }
    isLiveEngine(id, engine) {
        return this.engines.get(id) === engine;
    }
    async persistHistoryMessages(id, messages) {
        const storeEphemeralMessages = (0, feature_flags_1.resolveFeatureFlags)(this.configService).storeEphemeralMessages;
        const byId = new Map();
        for (const m of messages) {
            if (!m.id || m.isStatusBroadcast || !m.chatId || !m.from || !m.to) {
                continue;
            }
            if (!storeEphemeralMessages && (m.ephemeralDuration ?? 0) > 0) {
                continue;
            }
            byId.set(m.id, m);
        }
        if (byId.size === 0) {
            return;
        }
        const ids = [...byId.keys()];
        const CHUNK = 400;
        let inserted = 0;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunkIds = ids.slice(i, i + CHUNK);
            const existing = await this.messageRepository.find({
                where: { sessionId: id, waMessageId: (0, typeorm_2.In)(chunkIds) },
                select: { waMessageId: true },
            });
            const seen = new Set(existing.map(r => r.waMessageId));
            const rows = chunkIds
                .filter(x => !seen.has(x))
                .map(x => {
                const m = byId.get(x);
                const metadata = {};
                if (m.media) {
                    metadata.media = m.media;
                }
                else if (MEDIA_MESSAGE_TYPES.has(m.type)) {
                    metadata.media = { mimetype: '', omitted: true };
                }
                if (m.quotedMessage)
                    metadata.quotedMessage = m.quotedMessage;
                if (m.call)
                    metadata.call = m.call;
                const row = this.messageRepository.create({
                    sessionId: id,
                    waMessageId: m.id,
                    chatId: m.chatId,
                    from: m.from,
                    to: m.to,
                    body: m.body,
                    type: m.type,
                    direction: m.fromMe ? message_entity_1.MessageDirection.OUTGOING : message_entity_1.MessageDirection.INCOMING,
                    timestamp: m.timestamp,
                    status: message_entity_1.MessageStatus.SENT,
                    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
                });
                if (m.timestamp) {
                    row.createdAt = new Date(m.timestamp * 1000);
                }
                return row;
            });
            if (rows.length) {
                await this.messageRepository
                    .createQueryBuilder()
                    .insert()
                    .values(rows)
                    .orIgnore()
                    .execute();
                inserted += rows.length;
            }
        }
        if (inserted) {
            this.logger.log(`Persisted ${inserted} history message(s)`, {
                sessionId: id,
                inserted,
                action: 'history_messages_persisted',
            });
        }
    }
    async initializeEngine(id, session) {
        this.logger.log(`Initializing engine for session: ${session.name}`, {
            sessionId: id,
            action: 'engine_init',
            proxyEnabled: !!session.proxyUrl,
        });
        const engine = this.engineFactory.create({
            sessionId: session.name,
            dbSessionId: id,
            proxyUrl: session.proxyUrl || undefined,
            proxyType: session.proxyType || undefined,
        });
        this.engines.set(id, engine);
        this.sessionErrors.delete(id);
        await this.updateStatus(id, session_entity_1.SessionStatus.INITIALIZING);
        const initPromise = engine.initialize({
            onQRCode: (qr) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                this.logger.log('QR code generated', {
                    sessionId: id,
                    action: 'qr_generated',
                });
                void this.webhookService.dispatch(id, 'session.qr', { sessionId: id, qr });
                this.eventsGateway.emitQRCode(id, qr);
                void this.hookManager.execute('session:qr', { sessionId: id }, {
                    sessionId: id,
                    source: 'Engine',
                });
                void this.updateStatus(id, session_entity_1.SessionStatus.QR_READY);
            },
            onReady: (phone, pushName) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                this.logger.log(`Session ready: ${phone}`, {
                    sessionId: id,
                    phone,
                    pushName,
                    action: 'ready',
                });
                void this.webhookService.dispatch(id, 'session.authenticated', { sessionId: id, phone, pushName });
                this.eventsGateway.emitSessionAuthenticated(id, { phone, pushName });
                void this.hookManager.execute('session:ready', { phone, pushName }, {
                    sessionId: id,
                    source: 'Engine',
                });
                const reconnectState = this.reconnectStates.get(id);
                if (reconnectState) {
                    reconnectState.attempts = 0;
                }
                this.livenessFailures.delete(id);
                this.sessionErrors.delete(id);
                void this.sessionRepository
                    .update(id, {
                    status: session_entity_1.SessionStatus.READY,
                    phone,
                    pushName,
                    connectedAt: new Date(),
                    lastActiveAt: new Date(),
                })
                    .catch(err => this.logger.warn('Failed to persist session ready state', {
                    sessionId: id,
                    error: err instanceof Error ? err.message : String(err),
                }));
            },
            onMessage: (message) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                if (message.isStatusBroadcast) {
                    return;
                }
                if (!(0, feature_flags_1.resolveFeatureFlags)(this.configService).storeEphemeralMessages &&
                    message.ephemeralDuration &&
                    message.ephemeralDuration > 0) {
                    this.logger.debug('Skipping ephemeral message', {
                        sessionId: id,
                        messageId: message.id,
                        chatId: message.chatId,
                        ephemeralDuration: message.ephemeralDuration,
                    });
                    return;
                }
                this.logger.debug(`Message received from ${message.from}`, {
                    sessionId: id,
                    messageId: message.id,
                    from: message.from,
                    action: 'message_received',
                });
                void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
                const messageData = { ...message };
                void this.hookManager
                    .execute('message:received', messageData, {
                    sessionId: id,
                    source: 'Engine',
                })
                    .then(async ({ data: finalMessage }) => {
                    const incoming = finalMessage;
                    if ((0, feature_flags_1.resolveFeatureFlags)(this.configService).resolveLidToPhone && incoming.isLidSender && !incoming.fromMe) {
                        incoming.senderPhone = await this.resolveSenderPhone(id, incoming.author ?? incoming.from);
                    }
                    const metadata = {};
                    if (incoming.media) {
                        metadata.media = incoming.media;
                    }
                    if (incoming.quotedMessage) {
                        metadata.quotedMessage = incoming.quotedMessage;
                    }
                    if (incoming.call) {
                        metadata.call = incoming.call;
                    }
                    const chatName = incoming.contact?.pushName ?? incoming.contact?.name ?? undefined;
                    const dbMessage = this.messageRepository.create({
                        sessionId: id,
                        waMessageId: incoming.id || undefined,
                        chatId: incoming.chatId,
                        chatName,
                        from: incoming.from,
                        to: incoming.to,
                        body: incoming.body,
                        type: incoming.type,
                        direction: incoming.fromMe ? message_entity_1.MessageDirection.OUTGOING : message_entity_1.MessageDirection.INCOMING,
                        timestamp: incoming.timestamp,
                        status: message_entity_1.MessageStatus.SENT,
                        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
                    });
                    if (!this.isLiveEngine(id, engine))
                        return;
                    let isNewMessage = true;
                    let persisted = false;
                    try {
                        const result = await this.messageRepository.insert(dbMessage);
                        Object.assign(dbMessage, result.identifiers[0] ?? {}, result.generatedMaps?.[0] ?? {});
                        persisted = true;
                    }
                    catch (err) {
                        if ((0, unique_constraint_util_1.isUniqueConstraintError)(err)) {
                            isNewMessage = false;
                        }
                        else {
                            this.logger.error(`Failed to save incoming message ${incoming.id} to database`, String(err));
                        }
                    }
                    if (!isNewMessage) {
                        return;
                    }
                    if (persisted) {
                        void this.hookManager
                            .execute('message:persisted', { sessionId: id, message: dbMessage }, { sessionId: id, source: 'SessionService' })
                            .catch(() => undefined);
                    }
                    void this.webhookService.dispatch(id, 'message.received', finalMessage);
                    this.eventsGateway.emitMessage(id, finalMessage);
                })
                    .catch(err => this.logger.error(`onMessage handler failed for ${id}`, String(err)));
            },
            onHistoryMessages: (messages) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                void this.persistHistoryMessages(id, messages).catch(err => this.logger.error(`Failed to persist history messages for ${id}`, String(err)));
            },
            onMessageCreate: (message) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                if (!message.fromMe) {
                    return;
                }
                if (message.isStatusBroadcast) {
                    return;
                }
                this.logger.debug(`Message sent to ${message.to}`, {
                    sessionId: id,
                    messageId: message.id,
                    to: message.to,
                    action: 'message_sent',
                });
                void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
                const messageData = { ...message };
                void this.hookManager
                    .execute('message:sent', messageData, {
                    sessionId: id,
                    source: 'Engine',
                })
                    .then(async ({ data: finalMessage }) => {
                    const outgoing = finalMessage;
                    const metadata = {};
                    if (outgoing.media) {
                        metadata.media = outgoing.media;
                    }
                    else if (MEDIA_MESSAGE_TYPES.has(outgoing.type)) {
                        metadata.media = { mimetype: '', omitted: true };
                    }
                    if (outgoing.quotedMessage) {
                        metadata.quotedMessage = outgoing.quotedMessage;
                    }
                    if (outgoing.call) {
                        metadata.call = outgoing.call;
                    }
                    const mayPersist = (0, feature_flags_1.resolveFeatureFlags)(this.configService).storeEphemeralMessages ||
                        !(outgoing.ephemeralDuration && outgoing.ephemeralDuration > 0);
                    if (mayPersist) {
                        const dbMessage = this.messageRepository.create({
                            sessionId: id,
                            waMessageId: outgoing.id || undefined,
                            chatId: outgoing.chatId,
                            from: outgoing.from,
                            to: outgoing.to,
                            body: outgoing.body,
                            type: outgoing.type,
                            direction: message_entity_1.MessageDirection.OUTGOING,
                            timestamp: outgoing.timestamp,
                            status: message_entity_1.MessageStatus.SENT,
                            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
                        });
                        if (!this.isLiveEngine(id, engine))
                            return;
                        let persisted = false;
                        try {
                            const result = await this.messageRepository.insert(dbMessage);
                            Object.assign(dbMessage, result.identifiers[0] ?? {}, result.generatedMaps?.[0] ?? {});
                            persisted = true;
                        }
                        catch (err) {
                            if (!(0, unique_constraint_util_1.isUniqueConstraintError)(err)) {
                                this.logger.error(`Failed to save outgoing message ${outgoing.id} to database`, String(err));
                            }
                        }
                        if (persisted) {
                            void this.hookManager
                                .execute('message:persisted', { sessionId: id, message: dbMessage }, { sessionId: id, source: 'SessionService' })
                                .catch(() => undefined);
                        }
                    }
                    void this.webhookService.dispatch(id, 'message.sent', finalMessage);
                    this.eventsGateway.emitMessageSent(id, finalMessage);
                })
                    .catch(err => this.logger.error(`onMessageCreate handler failed for ${id}`, String(err)));
            },
            onMessageAck: (messageId, status) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                this.logger.debug(`Message ack: ${messageId} -> ${status}`, {
                    sessionId: id,
                    messageId,
                    status,
                    action: 'message_ack',
                });
                const messageStatus = (0, message_status_util_1.deliveryStatusToMessageStatus)(status);
                if (messageStatus) {
                    const advanceAck = () => this.messageRepository
                        .update({ sessionId: id, waMessageId: messageId, status: (0, typeorm_2.In)((0, message_status_util_1.ackStatusTransitionFrom)(messageStatus)) }, { status: messageStatus })
                        .then(result => result.affected ?? 0);
                    const logNoop = () => this.logger.debug(`Message ack ${messageId}: no status row advanced to ${messageStatus} (${status})`, {
                        sessionId: id,
                        messageId,
                        status,
                        action: 'message_ack_noop',
                    });
                    const onAckError = (err) => this.logger.error(`Failed to advance ack for ${messageId}`, String(err));
                    void advanceAck()
                        .then(affected => {
                        if (affected > 0)
                            return;
                        const timer = setTimeout(() => {
                            void advanceAck()
                                .then(retried => {
                                if (retried === 0)
                                    logNoop();
                            })
                                .catch(onAckError);
                        }, exports.ACK_RECONCILE_DELAY_MS);
                        timer.unref?.();
                    })
                        .catch(onAckError);
                }
                const ackPayload = { id: messageId, messageId, status, ack: (0, message_status_util_1.deliveryStatusToAck)(status) };
                this.eventsGateway.emitMessageAck(id, ackPayload);
                void this.webhookService.dispatch(id, 'message.ack', ackPayload);
                if (status === 'failed') {
                    void this.webhookService.dispatch(id, 'message.failed', { ...ackPayload });
                }
                void this.hookManager.execute('message:ack', { messageId, status, ack: (0, message_status_util_1.deliveryStatusToAck)(status) }, { sessionId: id, source: 'Engine' });
            },
            onMessageRevoked: (message) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                this.logger.debug(`Message revoked: ${message.id}`, {
                    sessionId: id,
                    messageId: message.id,
                    action: 'message_revoked',
                });
                const revokedWaMessageId = message.revokedId ?? message.id;
                void this.messageRepository
                    .update({ sessionId: id, waMessageId: revokedWaMessageId }, { body: '', type: 'revoked' })
                    .catch(err => {
                    this.logger.error(`Failed to update revoked message: ${revokedWaMessageId}`, String(err));
                });
                const revokedPayload = message;
                void this.webhookService.dispatch(id, 'message.revoked', revokedPayload);
                this.eventsGateway.emitMessageRevoked(id, revokedPayload);
            },
            onMessageReaction: (event) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                if (!event.messageId) {
                    this.logger.warn('Ignoring message reaction without a target message id', {
                        sessionId: id,
                        action: 'message_reaction_ignored',
                    });
                    return;
                }
                this.logger.debug(`Message reaction received: ${event.messageId} -> ${event.reaction}`, {
                    sessionId: id,
                    messageId: event.messageId,
                    action: 'message_reaction_received',
                });
                this.enqueueMessageMutation(id, event.messageId, () => this.applyReaction(id, event));
            },
            onMessageEdited: (message) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                if (!message.messageId) {
                    this.logger.warn('Ignoring message edit without a target message id', {
                        sessionId: id,
                        action: 'message_edit_ignored',
                    });
                    return;
                }
                this.logger.debug(`Message edited: ${message.messageId}`, {
                    sessionId: id,
                    messageId: message.messageId,
                    action: 'message_edited',
                });
                this.enqueueMessageMutation(id, message.messageId, () => this.applyMessageEdit(id, message));
            },
            onGroupEvent: (event) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                this.logger.debug(`Group event: ${event.kind} in ${event.groupId}`, {
                    sessionId: id,
                    groupId: event.groupId,
                    kind: event.kind,
                    action: 'group_event',
                });
                this.dispatchGroupEvent(id, event);
            },
            onCall: (event) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                this.logger.log(`Incoming call from ${event.from}`, {
                    sessionId: id,
                    callId: event.callId,
                    isVideo: event.isVideo,
                    isGroup: event.isGroup,
                    action: 'call_received',
                });
                const payload = { ...event };
                this.eventsGateway.emitCallReceived(id, payload);
                void this.webhookService.dispatch(id, 'call.received', payload);
                void this.maybeAutoRejectCall(id, engine, event.callId);
            },
            onDisconnected: (reason) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                void this.handleEngineDisconnected(id, reason);
            },
            onStateChanged: (engineState) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                const statusMap = {
                    [whatsapp_engine_interface_1.EngineStatus.DISCONNECTED]: session_entity_1.SessionStatus.DISCONNECTED,
                    [whatsapp_engine_interface_1.EngineStatus.INITIALIZING]: session_entity_1.SessionStatus.INITIALIZING,
                    [whatsapp_engine_interface_1.EngineStatus.QR_READY]: session_entity_1.SessionStatus.QR_READY,
                    [whatsapp_engine_interface_1.EngineStatus.AUTHENTICATING]: session_entity_1.SessionStatus.AUTHENTICATING,
                    [whatsapp_engine_interface_1.EngineStatus.READY]: session_entity_1.SessionStatus.READY,
                    [whatsapp_engine_interface_1.EngineStatus.FAILED]: session_entity_1.SessionStatus.FAILED,
                };
                const newStatus = statusMap[engineState];
                if (newStatus) {
                    void this.updateStatus(id, newStatus);
                }
            },
            onError: (reason) => {
                if (!this.isLiveEngine(id, engine))
                    return;
                this.logger.error(`Session engine failed: ${reason}`, undefined, {
                    sessionId: id,
                    reason,
                    action: 'engine_error',
                });
                this.sessionErrors.set(id, reason);
                this.cancelReconnect(id);
                void this.hookManager.execute('session:error', { reason }, {
                    sessionId: id,
                    source: 'Engine',
                });
                void this.updateStatus(id, session_entity_1.SessionStatus.FAILED);
                this.evictAndForceDestroy(id, engine);
            },
        });
        const engineInitTimeoutMs = Math.max(60_000, ((0, whatsapp_web_js_adapter_1.resolveAuthTimeoutMs)() ?? 30_000) + 30_000);
        initPromise.catch(() => undefined);
        let initTimer;
        try {
            await Promise.race([
                initPromise,
                new Promise((_, reject) => {
                    initTimer = setTimeout(() => reject(new EngineInitTimeoutError(engineInitTimeoutMs)), engineInitTimeoutMs);
                }),
            ]);
        }
        catch (err) {
            if (err instanceof EngineInitTimeoutError) {
                this.logger.error(`Engine initialization timed out for session ${session.name}`, undefined, {
                    sessionId: id,
                    action: 'engine_init_timeout',
                });
                this.sessionErrors.set(id, err.message);
                this.engines.delete(id);
                await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
                await this.updateStatus(id, session_entity_1.SessionStatus.DISCONNECTED);
                throw new common_1.HttpException(`Engine initialization timed out after ${err.timeoutMs}ms — the browser process did not complete ` +
                    'startup in time (often a container memory/resource limit or a stalled Chromium, not a network ' +
                    'issue). Retry the session; for chronically slow first boots, raise WWEBJS_AUTH_TIMEOUT_MS.', common_1.HttpStatus.GATEWAY_TIMEOUT);
            }
            else if (isAuthTimeoutRejection(err)) {
                throw new common_1.HttpException(ENGINE_AUTH_TIMEOUT_MESSAGE, common_1.HttpStatus.GATEWAY_TIMEOUT);
            }
            throw err;
        }
        finally {
            if (initTimer)
                clearTimeout(initTimer);
        }
    }
    async applyReaction(id, event) {
        try {
            if (!event.messageId)
                return;
            const msg = await this.messageRepository.findOne({ where: { sessionId: id, waMessageId: event.messageId } });
            if (!msg)
                return;
            const metadata = msg.metadata || {};
            const reactions = metadata.reactions || {};
            if (!event.reaction) {
                delete reactions[event.senderId];
            }
            else {
                reactions[event.senderId] = event.reaction;
            }
            metadata.reactions = reactions;
            await this.messageRepository.update({ sessionId: id, waMessageId: event.messageId }, {
                metadata,
            });
            this.eventsGateway.emitMessageReaction(id, { ...event, reactions });
            void this.webhookService.dispatch(id, 'message.reaction', { ...event, reactions });
        }
        catch (err) {
            this.logger.error(`Failed to update message reaction: ${event.messageId}`, String(err));
        }
    }
    enqueueMessageMutation(id, messageId, work) {
        const key = `${id}:${messageId}`;
        const prior = this.messageMutationChains.get(key) ?? Promise.resolve();
        const next = prior
            .catch(() => undefined)
            .then(work)
            .catch(err => {
            this.logger.error(`Unexpected failure applying message mutation: ${messageId}`, String(err));
        });
        this.messageMutationChains.set(key, next);
        void next.finally(() => {
            if (this.messageMutationChains.get(key) === next) {
                this.messageMutationChains.delete(key);
            }
        });
    }
    async applyMessageEdit(id, message) {
        try {
            await this.messageRepository.update({ sessionId: id, waMessageId: message.messageId }, { body: message.body });
        }
        catch (err) {
            this.logger.error(`Failed to update edited message: ${message.messageId}`, String(err));
        }
        const editedPayload = message;
        this.eventsGateway.emitMessageEdited(id, editedPayload);
        void this.webhookService.dispatch(id, 'message.edited', editedPayload);
    }
    async recordOutboundMessageEdit(sessionId, messageId, body) {
        await new Promise(resolve => {
            this.enqueueMessageMutation(sessionId, messageId, async () => {
                try {
                    await this.messageRepository.update({ sessionId, waMessageId: messageId }, { body });
                }
                catch (err) {
                    this.logger.warn(`Failed to update stored body of edited message ${messageId}`, { error: String(err) });
                }
                finally {
                    resolve();
                }
            });
        });
    }
    dispatchGroupEvent(id, event) {
        const payload = {
            groupId: event.groupId,
            participantIds: event.participantIds,
            timestamp: event.timestamp,
        };
        if (event.actorId !== undefined) {
            payload.actorId = event.actorId;
        }
        if (event.changes !== undefined) {
            payload.changes = event.changes;
        }
        switch (event.kind) {
            case 'join':
                this.eventsGateway.emitGroupJoin(id, payload);
                void this.webhookService.dispatch(id, 'group.join', payload);
                break;
            case 'leave':
                this.eventsGateway.emitGroupLeave(id, payload);
                void this.webhookService.dispatch(id, 'group.leave', payload);
                break;
            case 'update':
                this.eventsGateway.emitGroupUpdate(id, payload);
                void this.webhookService.dispatch(id, 'group.update', payload);
                break;
        }
    }
    async maybeAutoRejectCall(id, engine, callId) {
        let session;
        try {
            session = await this.sessionRepository.findOne({ where: { id } });
        }
        catch (err) {
            this.logger.error('Failed to reload the session for call auto-reject', String(err), {
                sessionId: id,
                action: 'call_auto_reject_error',
            });
            return;
        }
        if (session?.config?.autoRejectCalls !== true) {
            return;
        }
        try {
            await engine.rejectCall(callId);
            this.logger.log('Auto-rejected incoming call', {
                sessionId: id,
                callId,
                action: 'call_auto_rejected',
            });
        }
        catch (err) {
            this.logger.warn('Failed to auto-reject incoming call', {
                sessionId: id,
                callId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    async handleEngineDisconnected(id, reason) {
        this.logger.warn(`Session disconnected: ${reason}`, {
            sessionId: id,
            reason,
            action: 'disconnected',
        });
        void this.webhookService.dispatch(id, 'session.disconnected', { sessionId: id, reason });
        this.eventsGateway.emitSessionDisconnected(id, { reason });
        void this.hookManager.execute('session:disconnected', { reason }, {
            sessionId: id,
            source: 'Engine',
        });
        void this.updateStatus(id, session_entity_1.SessionStatus.DISCONNECTED);
        let session;
        try {
            session = await this.sessionRepository.findOne({ where: { id } });
        }
        catch (err) {
            this.logger.error('Failed to reload the session for reconnect scheduling', String(err), {
                sessionId: id,
                action: 'reconnect_schedule_error',
            });
            return;
        }
        if (!session)
            return;
        this.scheduleReconnect(id, session);
    }
    startWatchdog() {
        if (this.watchdogTimer)
            return;
        this.watchdogTimer = setInterval(() => {
            void this.runWatchdogTick();
        }, exports.SESSION_WATCHDOG_INTERVAL_MS);
        this.watchdogTimer.unref();
    }
    async runWatchdogTick() {
        if (this.shutdownService?.isShuttingDown()) {
            return;
        }
        await Promise.allSettled([...this.engines].map(([id, engine]) => this.probeSessionLiveness(id, engine)));
    }
    async probeSessionLiveness(id, engine) {
        if (engine.getStatus() !== whatsapp_engine_interface_1.EngineStatus.READY) {
            this.livenessFailures.delete(id);
            return;
        }
        if (typeof engine.probeLiveness !== 'function') {
            return;
        }
        let alive;
        let probeTimer;
        try {
            alive = await Promise.race([
                engine.probeLiveness(),
                new Promise((_, reject) => {
                    probeTimer = setTimeout(() => reject(new Error('liveness probe timed out')), exports.SESSION_WATCHDOG_PROBE_TIMEOUT_MS);
                }),
            ]);
        }
        catch {
            alive = false;
        }
        finally {
            if (probeTimer)
                clearTimeout(probeTimer);
        }
        if (!this.isLiveEngine(id, engine)) {
            return;
        }
        if (alive) {
            this.livenessFailures.delete(id);
            return;
        }
        const failures = (this.livenessFailures.get(id) ?? 0) + 1;
        if (failures < exports.SESSION_WATCHDOG_MAX_FAILURES) {
            this.livenessFailures.set(id, failures);
            this.logger.warn('Liveness probe failed; will treat the session as dead after repeated failures', {
                sessionId: id,
                failures,
                action: 'watchdog_probe_failed',
            });
            return;
        }
        this.livenessFailures.delete(id);
        this.logger.warn('Liveness probe failed repeatedly; handling the session as disconnected', {
            sessionId: id,
            failures,
            action: 'watchdog_disconnect',
        });
        await this.handleEngineDisconnected(id, 'liveness probe failed (watchdog)');
    }
    scheduleReconnect(id, session) {
        if (this.shutdownService?.isShuttingDown()) {
            this.logger.log(`Skipping reconnect during shutdown for session: ${session.name}`, { sessionId: id });
            return;
        }
        const state = this.reconnectStates.get(id);
        if (!state)
            return;
        if (state.lastAttemptAt !== undefined && Date.now() - state.lastAttemptAt >= RECONNECT_STABILITY_RESET_MS) {
            state.attempts = 0;
        }
        if (state.attempts >= state.maxAttempts) {
            this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
                sessionId: id,
                attempts: state.attempts,
                action: 'reconnect_failed',
            });
            this.sessionErrors.set(id, state.maxAttempts === 0
                ? 'Auto-reconnect is disabled (max attempts set to 0); the session was left disconnected — restart it manually.'
                : `Reconnection failed after ${state.attempts} attempts — restart the session.`);
            void this.updateStatus(id, session_entity_1.SessionStatus.FAILED);
            return;
        }
        const delay = clampReconnectDelay(state.baseDelay * Math.pow(2, state.attempts) + Math.random() * 1000, state.baseDelay);
        state.attempts++;
        state.lastAttemptAt = Date.now();
        const maxAttemptsLabel = Number.isFinite(state.maxAttempts) ? String(state.maxAttempts) : '∞';
        this.logger.log(`Scheduling reconnect attempt ${state.attempts}/${maxAttemptsLabel} in ${Math.round(delay / 1000)}s`, {
            sessionId: id,
            attempt: state.attempts,
            delayMs: delay,
            action: 'reconnect_scheduled',
        });
        (0, session_reconnect_metrics_1.incrementSessionReconnectAttempts)();
        if (state.attempts > 0 && state.attempts % RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS === 0) {
            this.logger.warn(`Session is reconnect-looping: attempt ${state.attempts} scheduled`, {
                sessionId: id,
                attempts: state.attempts,
                nextDelayMs: delay,
                action: 'reconnect_loop',
            });
            (0, session_reconnect_metrics_1.incrementSessionReconnectLoopAlerts)();
            void this.webhookService.dispatch(id, 'session.reconnect_loop', {
                sessionId: id,
                attempts: state.attempts,
                nextDelayMs: delay,
            });
        }
        if (state.timer)
            clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            void this.executeReconnect(id, session, state);
        }, delay);
    }
    async isSessionRetired(id) {
        if (this.stoppingSessions.has(id)) {
            return true;
        }
        return (await this.sessionRepository.findOne({ where: { id } })) == null;
    }
    async executeReconnect(id, session, state) {
        if (this.stoppingSessions.has(id)) {
            return;
        }
        try {
            const oldEngine = this.engines.get(id);
            if (oldEngine) {
                await this.teardownEngineSafely(id, oldEngine, e => e.destroy(), 'destroy');
                if (this.isLiveEngine(id, oldEngine))
                    this.engines.delete(id);
            }
            await this.initializeEngine(id, session);
            let retired;
            try {
                retired = await this.isSessionRetired(id);
            }
            catch {
                retired = false;
            }
            if (retired) {
                const resurrected = this.engines.get(id);
                if (resurrected) {
                    await this.teardownEngineSafely(id, resurrected, e => e.destroy(), 'destroy');
                    if (this.isLiveEngine(id, resurrected))
                        this.engines.delete(id);
                }
                return;
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
                sessionId: id,
                action: 'reconnect_error',
            });
            const halfBuilt = this.engines.get(id);
            if (halfBuilt) {
                this.evictAndForceDestroy(id, halfBuilt);
            }
            this.scheduleReconnect(id, session);
        }
    }
    cancelReconnect(id) {
        const state = this.reconnectStates.get(id);
        if (state?.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        this.reconnectStates.delete(id);
    }
    async stop(id) {
        const session = await this.findOne(id);
        this.stoppingSessions.add(id);
        this.cancelReconnect(id);
        const engine = this.engines.get(id);
        if (engine) {
            await this.teardownEngineSafely(id, engine, e => e.disconnect(), 'disconnect');
            if (this.isLiveEngine(id, engine))
                this.engines.delete(id);
        }
        this.logger.log(`Session stopped: ${session.name}`, {
            sessionId: id,
            action: 'stop',
        });
        await this.updateStatus(id, session_entity_1.SessionStatus.DISCONNECTED);
        return this.findOne(id);
    }
    async forceKill(id) {
        const session = await this.findOne(id);
        this.stoppingSessions.add(id);
        this.cancelReconnect(id);
        const engine = this.engines.get(id);
        if (engine) {
            await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
            if (this.isLiveEngine(id, engine))
                this.engines.delete(id);
        }
        this.logger.warn(`Session force-killed: ${session.name}`, {
            sessionId: id,
            action: 'force_kill',
        });
        await this.updateStatus(id, session_entity_1.SessionStatus.DISCONNECTED);
        return this.findOne(id);
    }
    async getQRCode(id) {
        const session = await this.findOne(id);
        const engine = this.engines.get(id);
        if (!engine) {
            throw new common_1.BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
        }
        const qrCode = engine.getQRCode();
        if (!qrCode) {
            if (session.status === session_entity_1.SessionStatus.READY) {
                throw new common_1.BadRequestException('Session is already authenticated, no QR code needed');
            }
            throw new common_1.BadRequestException('QR code is not ready yet. Please wait...');
        }
        return {
            qrCode,
            status: session.status,
        };
    }
    async requestPairingCode(id, phoneNumber) {
        const session = await this.findOne(id);
        const engine = this.engines.get(id);
        if (!engine) {
            throw new common_1.BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
        }
        if (session.status === session_entity_1.SessionStatus.READY) {
            throw new common_1.BadRequestException('Session is already authenticated, no pairing needed');
        }
        const pairingCode = await engine.requestPairingCode(phoneNumber);
        return { pairingCode, status: session.status };
    }
    getEngine(id) {
        return this.engines.get(id);
    }
    async resolveSenderPhone(sessionId, contactId) {
        const key = `${sessionId}:${contactId}`;
        const cached = this.lidPhoneCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        let phone;
        try {
            phone = (await this.getEngine(sessionId)?.resolveContactPhone(contactId)) ?? null;
        }
        catch {
            phone = null;
        }
        if (this.lidPhoneCache.size >= SessionService_1.LID_PHONE_CACHE_MAX) {
            for (const oldest of this.lidPhoneCache.keys()) {
                this.lidPhoneCache.delete(oldest);
                break;
            }
        }
        this.lidPhoneCache.set(key, phone);
        if (phone) {
            void this.lidMappingStore?.remember((0, wa_id_1.userPart)(contactId), phone, sessionId)?.catch(() => { });
        }
        return phone;
    }
    async getGroups(id, opts = {}) {
        await this.findOne(id);
        const engine = this.engines.get(id);
        if (!engine) {
            throw new common_1.BadRequestException('Session is not started');
        }
        const groups = await engine.getGroups();
        const mapped = groups.map(g => ({
            id: g.id,
            name: g.name,
            linkedParentJID: g.linkedParentJID,
        }));
        return (0, paginate_1.paginate)(mapped, opts.limit, opts.offset);
    }
    async getChats(id, opts = {}) {
        await this.findOne(id);
        const engine = this.engines.get(id);
        if (!engine) {
            throw new common_1.BadRequestException('Session is not started');
        }
        const chats = [...(await engine.getChats())].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return (0, paginate_1.paginate)(chats, opts.limit, opts.offset);
    }
    async sendSeen(id, chatId) {
        await this.findOne(id);
        const engine = this.engines.get(id);
        if (!engine) {
            throw new common_1.BadRequestException('Session is not started');
        }
        return engine.sendSeen(chatId);
    }
    async markUnread(id, chatId) {
        await this.findOne(id);
        const engine = this.engines.get(id);
        if (!engine) {
            throw new common_1.BadRequestException('Session is not started');
        }
        return engine.markUnread(chatId);
    }
    async deleteChat(id, chatId) {
        await this.findOne(id);
        const engine = this.engines.get(id);
        if (!engine) {
            throw new common_1.BadRequestException('Session is not started');
        }
        return engine.deleteChat(chatId);
    }
    async sendChatState(id, chatId, state) {
        await this.findOne(id);
        const engine = this.engines.get(id);
        if (!engine) {
            throw new common_1.BadRequestException('Session is not started');
        }
        await engine.sendChatState(chatId, state);
    }
    async updateStatus(id, status) {
        await this.sessionRepository.update(id, { status });
        this.logger.debug(`Session status updated to ${status}`, {
            sessionId: id,
            status,
            action: 'status_update',
        });
        if (this.lastDispatchedStatus.get(id) !== status) {
            this.lastDispatchedStatus.set(id, status);
            this.eventsGateway.emitSessionStatus(id, status);
            void this.webhookService.dispatch(id, 'session.status', { sessionId: id, status });
        }
    }
    async getStats(allowedSessions) {
        const scope = allowedSessions && allowedSessions.length > 0 ? allowedSessions : null;
        const qb = this.sessionRepository
            .createQueryBuilder('session')
            .select('session.status', 'status')
            .addSelect('COUNT(session.id)', 'count');
        if (scope) {
            qb.where('session.id IN (:...scope)', { scope });
        }
        const rows = await qb.groupBy('session.status').getRawMany();
        const byStatus = {};
        let total = 0;
        for (const row of rows) {
            const count = Number(row.count) || 0;
            byStatus[row.status] = count;
            total += count;
        }
        const memory = process.memoryUsage();
        return {
            total,
            active: scope ? [...this.engines.keys()].filter(id => scope.includes(id)).length : this.engines.size,
            ready: byStatus[session_entity_1.SessionStatus.READY] || 0,
            disconnected: byStatus[session_entity_1.SessionStatus.DISCONNECTED] || 0,
            byStatus,
            memoryUsage: {
                heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
                rss: Math.round(memory.rss / 1024 / 1024),
            },
        };
    }
    getActiveCount() {
        return this.engines.size;
    }
    isActive(id) {
        return this.engines.has(id);
    }
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};
exports.SessionService = SessionService;
exports.SessionService = SessionService = SessionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(session_entity_1.Session, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(message_entity_1.Message, 'data')),
    __param(2, (0, typeorm_1.InjectDataSource)('data')),
    __param(7, (0, common_1.Optional)()),
    __param(8, (0, common_1.Optional)()),
    __param(9, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.DataSource,
        engine_factory_1.EngineFactory,
        events_gateway_1.EventsGateway,
        webhook_service_1.WebhookService,
        hooks_1.HookManager,
        config_1.ConfigService,
        lid_mapping_store_service_1.LidMappingStoreService,
        shutdown_service_1.ShutdownService])
], SessionService);
//# sourceMappingURL=session.service.js.map