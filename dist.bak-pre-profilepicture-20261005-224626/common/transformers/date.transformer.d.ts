import { ValueTransformer } from 'typeorm';
export type DateTransformerDialect = 'data' | 'main';
export declare function makeDateTransformer(scope?: DateTransformerDialect): ValueTransformer;
export declare const DateTransformer: ValueTransformer;
export declare const MainDateTransformer: ValueTransformer;
