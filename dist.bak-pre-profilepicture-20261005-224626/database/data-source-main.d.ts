import { DataSource, DataSourceOptions } from 'typeorm';
export declare function buildMainDataSourceOptions(env?: NodeJS.ProcessEnv): DataSourceOptions;
declare const mainDataSource: DataSource;
export default mainDataSource;
