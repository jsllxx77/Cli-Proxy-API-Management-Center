/**
 * CPA Usage Keeper API client.
 * Keeper runs as a sidecar service; the panel uses its /api/v1 endpoints
 * for persisted usage analytics while keeping the shadcn UI.
 */

import axios, { type AxiosInstance } from 'axios';
import { getErrorMessage, isRecord } from '@/utils/helpers';

const KEEPER_BASE_STORAGE_KEY = 'cpamc.keeper.baseUrl';
const KEEPER_ENABLED_STORAGE_KEY = 'cpamc.keeper.enabled';

/**
 * Same-origin path preferred: nginx gateway on CPA port proxies
 * `/keeper/` → Keeper service. Avoids extra open ports / CORS issues.
 */
export const detectKeeperBaseUrl = (): string => {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8317/keeper';
  const { protocol, host } = window.location;
  // e.g. http://140.245.44.107:8317/keeper
  return `${protocol}//${host}/keeper`;
};

export const getStoredKeeperBaseUrl = (): string => {
  try {
    const raw = localStorage.getItem(KEEPER_BASE_STORAGE_KEY);
    if (raw && raw.trim()) {
      const normalized = raw.trim().replace(/\/+$/, '');
      // Migrate old :18317 direct URL to same-origin /keeper
      if (/:18317\/?$/.test(normalized)) {
        return detectKeeperBaseUrl();
      }
      return normalized;
    }
  } catch {
    // ignore
  }
  return detectKeeperBaseUrl();
};

export const setStoredKeeperBaseUrl = (value: string) => {
  const normalized = value.trim().replace(/\/+$/, '');
  localStorage.setItem(KEEPER_BASE_STORAGE_KEY, normalized);
};

export const isKeeperEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(KEEPER_ENABLED_STORAGE_KEY);
    if (raw === null) return true; // default on once integrated
    return raw === '1' || raw === 'true';
  } catch {
    return true;
  }
};

export const setKeeperEnabled = (enabled: boolean) => {
  localStorage.setItem(KEEPER_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
};

export type KeeperRange =
  | '15m'
  | '1h'
  | '6h'
  | '24h'
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'all';

export interface KeeperTokens {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  total_tokens?: number;
}

export interface KeeperUsageEvent {
  id: string;
  timestamp: string;
  api_key?: string;
  model?: string;
  model_alias?: string;
  service_tier?: string;
  executor_type?: string;
  endpoint?: string;
  source?: string;
  source_type?: string;
  auth_index?: string;
  request_id?: string;
  failed?: boolean;
  fail_status_code?: number;
  fail_body?: string;
  latency_ms?: number;
  ttft_ms?: number;
  speed_tps?: number;
  tokens?: KeeperTokens;
  cost_usd?: number;
  cost_available?: boolean;
}

export interface KeeperEventsResponse {
  events: KeeperUsageEvent[];
  total_count: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface KeeperOverviewResponse {
  usage?: {
    total_requests?: number;
    success_count?: number;
    failure_count?: number;
    total_tokens?: number;
  };
  summary?: {
    request_count?: number;
    token_count?: number;
    window_minutes?: number;
    rpm?: number;
    tpm?: number;
    total_cost?: number;
    cost_available?: boolean;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    reasoning_tokens?: number;
  };
  series?: {
    requests?: Record<string, number>;
    tokens?: Record<string, number>;
    rpm?: Record<string, number>;
    tpm?: Record<string, number>;
    cost?: Record<string, number>;
  };
  service_health?: {
    total_success?: number;
    total_failure?: number;
    success_rate?: number;
  };
  timezone?: string;
  range_start?: string;
  range_end?: string;
}

export interface KeeperCompositionItem {
  key?: string;
  label?: string;
  total_tokens?: number;
  requests?: number;
  percent?: number;
  cost_usd?: number;
  cost_available?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  failures?: number;
  failure_count?: number;
  avg_latency_ms?: number;
}

export interface KeeperAnalysisResponse {
  granularity?: string;
  timezone?: string;
  range_start?: string;
  range_end?: string;
  token_usage?: Array<Record<string, unknown>>;
  api_key_composition?: KeeperCompositionItem[];
  model_composition?: KeeperCompositionItem[];
  auth_files_composition?: KeeperCompositionItem[];
  ai_provider_composition?: KeeperCompositionItem[];
  cost_breakdown?: Record<string, unknown>;
  model_efficiency?: Array<Record<string, unknown>>;
  latency_diagnostics?: Array<Record<string, unknown>>;
}

export interface KeeperStatusResponse {
  running?: boolean;
  sync_running?: boolean;
  timezone?: string;
  last_run_at?: string;
  last_status?: string;
}

export interface KeeperPricingEntry {
  model?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  [key: string]: unknown;
}

const createClient = (baseUrl: string): AxiosInstance =>
  axios.create({
    baseURL: `${baseUrl.replace(/\/+$/, '')}/api/v1`,
    timeout: 30_000,
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
      'X-CPA-Usage-Keeper-Request': 'cpamc',
    },
  });

const unwrapError = (error: unknown): Error => {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (isRecord(data) && typeof data.error === 'string') {
      return new Error(data.error);
    }
    return new Error(error.message || 'Keeper request failed');
  }
  return new Error(getErrorMessage(error, 'Keeper request failed'));
};

class KeeperApi {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl = getStoredKeeperBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.client = createClient(this.baseUrl);
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  setBaseUrl(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.client = createClient(this.baseUrl);
    setStoredKeeperBaseUrl(this.baseUrl);
  }

  async healthz(): Promise<boolean> {
    try {
      const res = await axios.get(`${this.baseUrl}/healthz`, { timeout: 5_000 });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<KeeperStatusResponse> {
    try {
      const { data } = await this.client.get<KeeperStatusResponse>('/status');
      return data;
    } catch (error) {
      throw unwrapError(error);
    }
  }

  async getOverview(range: string, params?: Record<string, string | number>) {
    try {
      const { data } = await this.client.get<KeeperOverviewResponse>('/usage/overview', {
        params: { range, ...params },
      });
      return data;
    } catch (error) {
      throw unwrapError(error);
    }
  }

  async getOverviewRealtime(params?: Record<string, string | number>) {
    try {
      const { data } = await this.client.get<KeeperOverviewResponse>('/usage/overview/realtime', {
        params,
      });
      return data;
    } catch (error) {
      throw unwrapError(error);
    }
  }

  async getAnalysis(range: string, params?: Record<string, string | number>) {
    try {
      const { data } = await this.client.get<KeeperAnalysisResponse>('/usage/analysis', {
        params: { range, ...params },
      });
      return data;
    } catch (error) {
      throw unwrapError(error);
    }
  }

  async getEvents(params: {
    range?: string;
    page?: number;
    page_size?: number;
    model?: string;
    source?: string;
    auth_index?: string;
    api_key?: string;
    failed?: boolean | string;
    q?: string;
  }) {
    try {
      const { data } = await this.client.get<KeeperEventsResponse>('/usage/events', {
        params: {
          page: 1,
          page_size: 50,
          ...params,
        },
      });
      return data;
    } catch (error) {
      throw unwrapError(error);
    }
  }

  async getPricing() {
    try {
      const { data } = await this.client.get<{ pricing?: KeeperPricingEntry[] }>('/pricing');
      return data.pricing ?? [];
    } catch (error) {
      throw unwrapError(error);
    }
  }
}

export const keeperApi = new KeeperApi();

/**
 * Map panel time-range tabs to Keeper range query values.
 * Keeper presets: 4h, 8h, 12h, 24h, today, yesterday, 7d, 30d (+ custom).
 */
export const mapPanelRangeToKeeper = (
  range: '15m' | '1h' | '6h' | '24h' | 'all'
): string => {
  switch (range) {
    case '15m':
    case '1h':
      return '4h';
    case '6h':
      return '8h';
    case '24h':
      return '24h';
    case 'all':
      return '30d';
    default:
      return '24h';
  }
};
