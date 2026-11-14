import type { PluginSearchTransport } from '../../modules/search/providers/plugin-search-provider';
import type { SearchProviderRegistry } from '../../modules/search/search-provider.registry';
export interface RegisterPluginSearchProviderDeps {
    pluginId: string;
    label: string;
    transport: PluginSearchTransport;
    timeoutMs: number;
    registry: SearchProviderRegistry | undefined;
    mode: string;
}
export declare function registerPluginSearchProvider(deps: RegisterPluginSearchProviderDeps): void;
export declare function unregisterPluginSearchProvider(registry: SearchProviderRegistry | undefined, pluginId: string): void;
