/**
 * Thin mappers: Keeper API → UI display shapes.
 * No re-bucketing / no inventing series finer than Keeper returns.
 */

import type {
  KeeperAnalysisResponse,
  KeeperCompositionItem,
  KeeperOverviewResponse,
  KeeperUsageEvent,
} from '@/services/api/keeper';
import type { TokenSeriesPoint, UsageEvent, UsageGroup, UsageTokens } from '@/utils/usageAnalytics';

const numberValue = (value: unknown, fallback = 0) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const emptyTokens = (): UsageTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
});

export const keeperEventToUsageEvent = (event: KeeperUsageEvent): UsageEvent => {
  const tokens = event.tokens ?? {};
  const inputTokens = numberValue(tokens.input_tokens);
  const outputTokens = numberValue(tokens.output_tokens);
  const reasoningTokens = numberValue(tokens.reasoning_tokens);
  const cacheReadTokens = numberValue(tokens.cache_read_tokens);
  const cacheCreationTokens = numberValue(tokens.cache_creation_tokens);
  const totalTokens =
    numberValue(tokens.total_tokens) ||
    inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheCreationTokens;
  const timestampMs = Date.parse(event.timestamp || '') || Date.now();
  const failed = Boolean(event.failed);

  return {
    id: String(event.id || `${timestampMs}-${event.request_id || ''}`),
    timestampMs,
    provider: event.source_type || event.executor_type || 'unknown',
    executorType: event.executor_type || 'unknown',
    model: event.model || 'unknown',
    alias: event.model_alias || event.model || 'unknown',
    endpoint: event.endpoint || 'unknown',
    authType: event.source_type || 'unknown',
    apiKey: event.api_key || '',
    requestId: event.request_id || '',
    reasoningEffort: '',
    serviceTier: event.service_tier || '',
    source: event.source || '',
    authIndex: event.auth_index || '',
    latencyMs: numberValue(event.latency_ms),
    ttftMs: numberValue(event.ttft_ms),
    failed,
    failStatusCode: numberValue(event.fail_status_code, failed ? 500 : 200),
    failBody: event.fail_body || '',
    tokens: {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens: 0,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
    },
    costUsd: numberValue(event.cost_usd),
    costAvailable: Boolean(event.cost_available),
  };
};

export const keeperEventsToUsageEvents = (events: KeeperUsageEvent[] | undefined): UsageEvent[] =>
  (events ?? []).map(keeperEventToUsageEvent);

export type OverviewSummary = {
  requests: number;
  successes: number;
  failures: number;
  successRate: number;
  /** Overview API does not expose avg latency; left 0 unless filled by analysis. */
  avgLatencyMs: number;
  avgTtftMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  tokens: UsageTokens;
  totalCost: number;
  costAvailable: boolean;
  rpm: number;
  tpm: number;
  windowMinutes: number;
  granularityHint: string;
};

export const overviewToSummary = (overview: KeeperOverviewResponse | null): OverviewSummary => {
  const usage = overview?.usage;
  const summary = overview?.summary;
  const health = overview?.service_health;
  const requests = numberValue(usage?.total_requests ?? summary?.request_count);
  const successes = numberValue(usage?.success_count);
  const failures = numberValue(usage?.failure_count);
  const successRate =
    health?.success_rate !== undefined
      ? numberValue(health.success_rate)
      : requests > 0
        ? (successes / requests) * 100
        : 100;

  return {
    requests,
    successes,
    failures,
    successRate,
    avgLatencyMs: 0,
    avgTtftMs: 0,
    p95LatencyMs: 0,
    maxLatencyMs: 0,
    tokens: {
      inputTokens: numberValue(summary?.input_tokens),
      outputTokens: numberValue(summary?.output_tokens),
      reasoningTokens: numberValue(summary?.reasoning_tokens),
      cachedTokens: 0,
      cacheReadTokens: numberValue(summary?.cache_read_tokens),
      cacheCreationTokens: numberValue(summary?.cache_creation_tokens),
      totalTokens: numberValue(usage?.total_tokens ?? summary?.token_count),
    },
    totalCost: numberValue(summary?.total_cost),
    costAvailable: Boolean(summary?.cost_available),
    rpm: numberValue(summary?.rpm),
    tpm: numberValue(summary?.tpm),
    windowMinutes: numberValue(summary?.window_minutes),
    // Keeper overview series is hour-based for short windows
    granularityHint: 'hourly',
  };
};

/** Map Keeper overview.series maps exactly (hour/day keys as returned). */
export const overviewSeriesToTokenSeries = (
  overview: KeeperOverviewResponse | null
): TokenSeriesPoint[] => {
  const requests = overview?.series?.requests ?? {};
  const tokens = overview?.series?.tokens ?? {};
  const keys = Array.from(new Set([...Object.keys(requests), ...Object.keys(tokens)])).sort();

  return keys.map((key) => {
    const timestampMs = Date.parse(key) || 0;
    const label = Number.isFinite(timestampMs)
      ? new Date(timestampMs).toLocaleString(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : key;
    return {
      timestampMs,
      label,
      totalTokens: numberValue(tokens[key]),
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requests: numberValue(requests[key]),
    };
  });
};

/** Prefer analysis.token_usage when present (same hourly/daily as Keeper analysis). */
export const analysisTokenUsageToSeries = (
  analysis: KeeperAnalysisResponse | null
): TokenSeriesPoint[] => {
  const rows = analysis?.token_usage ?? [];
  return rows.map((row) => {
    const key = String(row.bucket ?? '');
    const timestampMs = Date.parse(key) || 0;
    return {
      timestampMs,
      label: Number.isFinite(timestampMs)
        ? new Date(timestampMs).toLocaleString(undefined, {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
        : key,
      totalTokens: numberValue(row.total_tokens),
      inputTokens: numberValue(row.input_tokens),
      outputTokens: numberValue(row.output_tokens),
      reasoningTokens: numberValue(row.reasoning_tokens),
      requests: numberValue(row.requests),
    };
  });
};

const compositionToGroups = (
  items: KeeperCompositionItem[] | undefined,
  limit = 12
): UsageGroup[] =>
  (items ?? [])
    .map((item) => ({
      key: String(item.key ?? item.label ?? 'unknown'),
      label: String(item.label ?? item.key ?? 'unknown'),
      requests: numberValue(item.requests),
      failures: numberValue(item.failures ?? item.failure_count),
      totalTokens: numberValue(item.total_tokens),
      avgLatencyMs: numberValue(item.avg_latency_ms),
      avgTtftMs: 0,
      maxLatencyMs: 0,
    }))
    .sort((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens)
    .slice(0, limit);

export const analysisToDistributions = (analysis: KeeperAnalysisResponse | null) => ({
  models: compositionToGroups(analysis?.model_composition),
  providers: compositionToGroups(analysis?.ai_provider_composition),
  apiKeys: compositionToGroups(analysis?.api_key_composition),
  authFiles: compositionToGroups(analysis?.auth_files_composition),
  granularity: analysis?.granularity || 'hourly',
});

export const analysisToCostGroups = (analysis: KeeperAnalysisResponse | null) => {
  const mapCost = (items: KeeperCompositionItem[] | undefined) =>
    (items ?? [])
      .map((item) => ({
        label: String(item.label ?? item.key ?? 'unknown'),
        requests: numberValue(item.requests),
        totalTokens: numberValue(item.total_tokens),
        cost: numberValue(item.cost_usd),
        failures: numberValue(item.failures ?? item.failure_count),
      }))
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests)
      .slice(0, 12);

  return {
    byModel: mapCost(analysis?.model_composition),
    byProvider: mapCost(analysis?.ai_provider_composition),
    byApiKey: mapCost(analysis?.api_key_composition),
    byAccount: mapCost(analysis?.auth_files_composition),
  };
};

export const latencyFromDiagnostics = (analysis: KeeperAnalysisResponse | null) => {
  const d = analysis?.latency_diagnostics;
  return {
    p95LatencyMs: numberValue(d?.p95_latency_ms),
    p95TtftMs: numberValue(d?.p95_ttft_ms),
    maxLatencyMs: numberValue(d?.max_latency_ms),
    maxTtftMs: numberValue(d?.max_ttft_ms),
    totalPoints: numberValue(d?.total_points),
  };
};

export const emptyOverviewSummary = (): OverviewSummary => ({
  requests: 0,
  successes: 0,
  failures: 0,
  successRate: 100,
  avgLatencyMs: 0,
  avgTtftMs: 0,
  p95LatencyMs: 0,
  maxLatencyMs: 0,
  tokens: emptyTokens(),
  totalCost: 0,
  costAvailable: false,
  rpm: 0,
  tpm: 0,
  windowMinutes: 0,
  granularityHint: 'hourly',
});
