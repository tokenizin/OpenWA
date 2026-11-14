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
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationRetentionService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const ingress_event_entity_1 = require("./entities/ingress-event.entity");
const integration_delivery_failure_entity_1 = require("./entities/integration-delivery-failure.entity");
const logger_service_1 = require("../../common/services/logger.service");
let IntegrationRetentionService = class IntegrationRetentionService {
    eventRepository;
    failureRepository;
    logger = (0, logger_service_1.createLogger)('IntegrationRetentionService');
    cleanupTimer;
    constructor(eventRepository, failureRepository) {
        this.eventRepository = eventRepository;
        this.failureRepository = failureRepository;
    }
    onModuleInit() {
        const parsed = Number.parseInt(process.env.INGRESS_RETENTION_DAYS ?? '', 10);
        const retentionDays = Number.isInteger(parsed) ? Math.max(0, parsed) : 90;
        if (retentionDays <= 0) {
            this.logger.log('Integration ingress retention disabled (INGRESS_RETENTION_DAYS <= 0)');
            return;
        }
        const runPrune = () => {
            this.pruneOlderThan(retentionDays)
                .then(({ events, failures }) => {
                if (events > 0)
                    this.logger.log(`Pruned ${events} ingress event(s) older than ${retentionDays} day(s)`);
                if (failures > 0) {
                    this.logger.log(`Pruned ${failures} integration delivery-failure(s) older than ${retentionDays} day(s)`);
                }
            })
                .catch(err => this.logger.error('Integration ingress retention failed', err instanceof Error ? err.stack : String(err)));
        };
        runPrune();
        this.cleanupTimer = setInterval(runPrune, 24 * 60 * 60 * 1000);
        this.cleanupTimer.unref?.();
    }
    onModuleDestroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
    }
    async pruneOlderThan(olderThanDays) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - olderThanDays);
        const [eventsResult, failuresResult] = await Promise.all([
            this.eventRepository.delete({ createdAt: (0, typeorm_2.LessThan)(cutoff) }),
            this.failureRepository.delete({ createdAt: (0, typeorm_2.LessThan)(cutoff) }),
        ]);
        return { events: eventsResult.affected || 0, failures: failuresResult.affected || 0 };
    }
};
exports.IntegrationRetentionService = IntegrationRetentionService;
exports.IntegrationRetentionService = IntegrationRetentionService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(ingress_event_entity_1.IngressEvent, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(integration_delivery_failure_entity_1.IntegrationDeliveryFailure, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], IntegrationRetentionService);
//# sourceMappingURL=integration-retention.service.js.map