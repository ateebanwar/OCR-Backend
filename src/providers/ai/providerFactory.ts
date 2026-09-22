import { AIProvider } from './AIProvider';
import { GeminiProvider } from './GeminiProvider';
import { AppConfig, getConfig } from '../../config/env';
import { ConfigurationError } from '../../errors/AppError';

// Registry of provider instances
let cachedProvider: AIProvider | null = null;

export interface ProviderRegistration {
  name: string;
  create: (config: AppConfig) => AIProvider;
}

const providerRegistry = new Map<string, (config: AppConfig) => AIProvider>();

// Register default providers
providerRegistry.set('gemini', (config: AppConfig) => new GeminiProvider(config));

/**
 * Register a custom AI provider adapter (e.g. Claude, Mock, etc.)
 */
export function registerAIProvider(name: string, factory: (config: AppConfig) => AIProvider): void {
  providerRegistry.set(name.toLowerCase(), factory);
}

/**
 * Resolves the configured AI provider based on AI_PROVIDER environment setting.
 */
export function getAIProvider(config: AppConfig = getConfig(), forceNew = false): AIProvider {
  if (cachedProvider && !forceNew) {
    return cachedProvider;
  }

  const providerName = config.aiProvider.toLowerCase();
  const factory = providerRegistry.get(providerName);

  if (!factory) {
    const supported = Array.from(providerRegistry.keys()).join(', ');
    throw new ConfigurationError(
      `Unsupported AI_PROVIDER '${config.aiProvider}'. Supported providers: ${supported}`
    );
  }

  cachedProvider = factory(config);
  return cachedProvider;
}

export function resetProviderCache(): void {
  cachedProvider = null;
}
