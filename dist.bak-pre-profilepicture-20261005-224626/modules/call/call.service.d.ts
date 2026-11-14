import { SessionService } from '../session/session.service';
export declare class CallService {
    private readonly sessionService;
    constructor(sessionService: SessionService);
    private getEngine;
    rejectCall(sessionId: string, callId: string): Promise<void>;
}
