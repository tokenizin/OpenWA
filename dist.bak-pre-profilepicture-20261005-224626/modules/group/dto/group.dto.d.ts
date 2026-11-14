export declare class CreateGroupDto {
    name: string;
    participants: string[];
}
export declare class ParticipantsDto {
    participants: string[];
}
export declare class GroupSubjectDto {
    subject: string;
}
export declare class GroupDescriptionDto {
    description: string;
}
export declare class JoinGroupDto {
    inviteCode: string;
}
export declare class GroupSettingsDto {
    announce?: boolean;
    locked?: boolean;
    ephemeralSeconds?: number;
}
