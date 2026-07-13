/**
 * CPA Usage Keeper API client — thin wrapper over Keeper /api/v1 only.
 * No client-side re-aggregation; UI maps responses as Keeper returns them.
 */

import axios, { type AxiosInstance } from 'axios';
import { getErrorMessage, isRecord } from '@/utils/helpers';

const KEEPER_BASE_STORAGE_KEY = 'cpamc.keeper.baseUrl';

/** Keeper-native time ranges (overview / analysis / events). */
export type KeeperRange =
  | '4h'
  | '8h'
  | '12h'
  | '24h'
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d';

export const KEEPER_RANGE_OPTIONS: Array<{ value: KeeperRange; label: string }> = [
  { value: '4h', label: '4 小时' },
  { value: '8h', label: '8 小时' },
  { value: '12h', label: '12 小时' },
  { value: '24h', label: '24 小时' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

/**
 * Same-origin path: nginx on CPA port proxies `/keeper/` → Keeper.
 */
export const detectKeeperBaseUrl = (): string => {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8317/keeper';
  const { protocol, host } = window.location;
  return `${protocol}//${host}/keeper`;
};

export const getStoredKeeperBaseUrl = (): string => {
  try {
    const raw = localStorage.getItem(KEEPER_BASE_STORAGE_KEY);
    if (raw && raw.trim()) {
      const normalized = raw.trim().replace(/\/+$/, '');
      if (/:18317\/?$/.test(normalized)) return detectKeeperBaseUrl();
      return normalized;
    }
  } catch {
    // ignore
  }
  return detectKeeperBaseUrl();
};

export const setStoredKeeperBaseUrl = (value: string) => {
  localStorage.setItem(KEEPER_BASE_STORAGE_KEY, value.trim().replace(/\/+$/, ''));
};

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
    cache_read_rate?: Record<string, number | null>;
  };
  service_health?: {
    total_success?: number;
    total_failure?: number;
    success_rate?: number;
    rows?: number;
    columns?: number;
    bucket_seconds?: number;
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
  token_usage?: Array<{
    bucket?: string;
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    total_tokens?: number;
    requests?: number;
    cost_usd?: number;
    cost_available?: boolean;
  }>;
  api_key_composition?: KeeperCompositionItem[];
  model_composition?: KeeperCompositionItem[];
  auth_files_composition?: KeeperCompositionItem[];
  ai_provider_composition?: KeeperCompositionItem[];
  cost_breakdown?: Record<string, unknown>;
  model_efficiency?: Array<Record<string, unknown>>;
  latency_diagnostics?: {
    points?: Array<{ ttft_ms?: number; latency_ms?: number }>;
    p95_ttft_ms?: number;
    p95_latency_ms?: number;
    max_ttft_ms?: number;
    max_latency_ms?: number;
    total_points?: number;
  };
}

export interface KeeperStatusResponse {
  running?: boolean;
  sync_running?: boolean;
  timezone?: string;
  last_run_at?: string;
  last_status?: string;
}

const createClient = (baseUrl: string): AxiosInstance =>
  axios.create({
    baseURL: `${baseUrl.replace(/\/+$/, '')}/api/v1`,
    timeout: 30_000,
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
      'X-CPA-Usage-Keeper-Request': 'fetch',
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

  async getStatus(): Promise<KeeperStatusResponse> {
    try {
      const { data } = await this.client.get<KeeperStatusResponse>('/status');
      return data;
    } catch (error) {
      throw unwrapError(error);
    }
  }

  async getOverview(range: KeeperRange) {
    try {
      const { data } = await this.client.get<KeeperOverviewResponse>('/usage/overview', {
        params: { range },
      });
      return data;
    } catch (error) {
      throw unwrapError(error);
    }
  }

  async getAnalysis(range: KeeperRange) {
    try {
      const { data } = await this.client.get<KeeperAnalysisResponse>('/usage/analysis', {
        params: { range },
      });
      return data;
    } catch (error) {
      throw unwrapError(error);
    }
  }

  async getEvents(params: {
    range: KeeperRange;
    page?: number;
    page_size?: number;
    model?: string;
    source?: string;
    auth_index?: string;
    failed?: boolean;
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
}

export const keeperApi = new KeeperApi();
