import type { ProviderBrand } from './types';

export interface ProviderDescriptor {
  id: ProviderBrand;
  supportsName: boolean;
  supportsApiKey: boolean;
  supportsDisabled: boolean;
  supportsBaseUrl: boolean;
  baseUrlRequired: boolean;
  supportsProxyUrl: boolean;
  supportsPrefix: boolean;
  supportsModels: boolean;
  supportsHeaders: boolean;
  supportsExcludedModels: boolean;
  supportsPriority: boolean;
  supportsTestModel: boolean;
  supportsWebsockets: boolean;
  supportsCloak: boolean;
  supportsApiKeyEntries: boolean;
  supportsAmpcodeMappings: boolean;
  /** Sheet 默认宽度 */
  sheetSize: 'md' | 'lg' | 'xl';
}

const keyProviderBase = {
  supportsName: false,
  supportsApiKey: true,
  supportsDisabled: true,
  supportsBaseUrl: true,
  supportsProxyUrl: true,
  supportsPrefix: true,
  supportsModels: true,
  supportsHeaders: true,
  supportsExcludedModels: true,
  supportsPriority: true,
  supportsTestModel: false,
  supportsCloak: false,
  supportsApiKeyEntries: false,
  supportsAmpcodeMappings: false,
  sheetSize: 'md' as const,
};

export const PROVIDER_DESCRIPTORS: Record<ProviderBrand, ProviderDescriptor> = {
  gemini: {
    ...keyProviderBase,
    id: 'gemini',
    baseUrlRequired: false,
    supportsWebsockets: false,
  },
  interactions: {
    ...keyProviderBase,
    id: 'interactions',
    baseUrlRequired: false,
    supportsWebsockets: false,
  },
  codex: {
    ...keyProviderBase,
    id: 'codex',
    baseUrlRequired: true,
    supportsWebsockets: true,
  },
  xai: {
    ...keyProviderBase,
    id: 'xai',
    baseUrlRequired: false,
    supportsWebsockets: true,
  },
  claude: {
    ...keyProviderBase,
    id: 'claude',
    baseUrlRequired: false,
    supportsTestModel: true,
    supportsWebsockets: false,
    supportsCloak: true,
  },
  vertex: {
    ...keyProviderBase,
    id: 'vertex',
    baseUrlRequired: false,
    supportsWebsockets: false,
  },
  openaiCompatibility: {
    id: 'openaiCompatibility',
    supportsName: true,
    supportsApiKey: false,
    supportsDisabled: true,
    supportsBaseUrl: true,
    baseUrlRequired: true,
    supportsProxyUrl: false,
    supportsPrefix: true,
    supportsModels: true,
    supportsHeaders: true,
    supportsExcludedModels: false,
    supportsPriority: true,
    supportsTestModel: true,
    supportsWebsockets: false,
    supportsCloak: false,
    supportsApiKeyEntries: true,
    supportsAmpcodeMappings: false,
    sheetSize: 'lg',
  },
  // Ampcode was removed from CLIProxyAPI; keep type for legacy configs but hide from order.
  ampcode: {
    id: 'ampcode',
    supportsName: false,
    supportsApiKey: false,
    supportsDisabled: false,
    supportsBaseUrl: true,
    baseUrlRequired: false,
    supportsProxyUrl: false,
    supportsPrefix: false,
    supportsModels: false,
    supportsHeaders: false,
    supportsExcludedModels: false,
    supportsPriority: false,
    supportsTestModel: false,
    supportsWebsockets: false,
    supportsCloak: false,
    supportsApiKeyEntries: false,
    supportsAmpcodeMappings: true,
    sheetSize: 'lg',
  },
};

/** Visible provider brands in the workbench (ampcode excluded). */
export const PROVIDER_BRAND_ORDER: ProviderBrand[] = [
  'gemini',
  'interactions',
  'codex',
  'xai',
  'claude',
  'vertex',
  'openaiCompatibility',
];

export const PROVIDER_PATHS: Record<ProviderBrand, string> = {
  gemini: '/ai-providers/gemini',
  interactions: '/ai-providers/interactions',
  codex: '/ai-providers/codex',
  xai: '/ai-providers/xai',
  claude: '/ai-providers/claude',
  vertex: '/ai-providers/vertex',
  openaiCompatibility: '/ai-providers/openai',
  ampcode: '/ai-providers/ampcode',
};
