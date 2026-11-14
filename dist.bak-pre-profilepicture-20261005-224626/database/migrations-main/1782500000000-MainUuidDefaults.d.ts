import { MigrationInterface, QueryRunner } from 'typeorm';
export declare class MainUuidDefaults1782500000000 implements MigrationInterface {
    name: string;
    private static readonly TABLES;
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}
