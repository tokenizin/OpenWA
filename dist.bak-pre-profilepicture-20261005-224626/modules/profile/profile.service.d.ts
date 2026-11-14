import { SessionService } from '../session/session.service';
import { SetProfilePictureDto } from './dto/profile.dto';
export declare class ProfileService {
    private readonly sessionService;
    constructor(sessionService: SessionService);
    private getEngine;
    setProfileName(sessionId: string, name: string): Promise<void>;
    setProfileStatus(sessionId: string, status: string): Promise<void>;
    setProfilePicture(sessionId: string, dto: SetProfilePictureDto): Promise<void>;
}
