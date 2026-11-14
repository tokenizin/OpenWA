import { SessionService } from '../session/session.service';
import type { Status, StatusResult, StatusPostOptions } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
export declare class StatusService {
    private readonly sessionService;
    private readonly hookManager;
    constructor(sessionService: SessionService, hookManager: HookManager);
    private gate;
    private guardGatedMedia;
    getStatuses(sessionId: string): Promise<Status[]>;
    getContactStatus(sessionId: string, contactId: string): Promise<Status[]>;
    postTextStatus(sessionId: string, text: string, options: StatusPostOptions): Promise<StatusResult>;
    postImageStatus(sessionId: string, media: {
        url?: string;
        base64?: string;
        mimetype?: string;
    } | undefined, options: StatusPostOptions): Promise<StatusResult>;
    postVideoStatus(sessionId: string, media: {
        url?: string;
        base64?: string;
        mimetype?: string;
    } | undefined, options: StatusPostOptions): Promise<StatusResult>;
    deleteStatus(sessionId: string, statusId: string): Promise<void>;
}
