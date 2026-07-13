/**
 * Map CPA Usage Keeper API payloads into structures used by the usage analytics UI.
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
  avgLatencyMs: number;
  avgTtftMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  tokens: UsageTokens;
  totalCost: number;
  costAvailable: boolean;
  rpm: number;
  tpm: number;
};

/** Average latency / TTFT from per-request event rows (preferred source). */
export const averageLatencyFromEvents = (events: UsageEvent[]) => {
  if (!events.length) {
    return { avgLatencyMs: 0, avgTtftMs: 0, maxLatencyMs: 0 };
  }
  let latencyTotal = 0;
  let ttftTotal = 0;
  let maxLatencyMs = 0;
  let latencyCount = 0;
  let ttftCount = 0;
  for (const event of events) {
    if (event.latencyMs > 0) {
      latencyTotal += event.latencyMs;
      latencyCount += 1;
      maxLatencyMs = Math.max(maxLatencyMs, event.latencyMs);
    }
    if (event.ttftMs > 0) {
      ttftTotal += event.ttftMs;
      ttftCount += 1;
    }
  }
  return {
    avgLatencyMs: latencyCount > 0 ? latencyTotal / latencyCount : 0,
    avgTtftMs: ttftCount > 0 ? ttftTotal / ttftCount : 0,
    maxLatencyMs,
  };
};

/** Fallback averages from analysis.latency_diagnostics scatter points. */
export const latencyFromDiagnostics = (
  diagnostics: KeeperAnalysisResponse['latency_diagnostics'] | unknown
) => {
  const record = isRecordLike(diagnostics) ? diagnostics : null;
  const points = Array.isArray(record?.points) ? record.points : [];
  let latencyTotal = 0;
  let ttftTotal = 0;
  let latencyCount = 0;
  let ttftCount = 0;
  for (const point of points) {
    if (!isRecordLike(point)) continue;
    const latency = numberValue(point.latency_ms);
    const ttft = numberValue(point.ttft_ms);
    if (latency > 0) {
      latencyTotal += latency;
      latencyCount += 1;
    }
    if (ttft > 0) {
      ttftTotal += ttft;
      ttftCount += 1;
    }
  }
  return {
    avgLatencyMs: latencyCount > 0 ? latencyTotal / latencyCount : 0,
    avgTtftMs: ttftCount > 0 ? ttftTotal / ttftCount : 0,
    p95LatencyMs: numberValue(record?.p95_latency_ms),
    maxLatencyMs: numberValue(record?.max_latency_ms),
  };
};

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const overviewToSummary = (
  overview: KeeperOverviewResponse | null,
  extras?: {
    avgLatencyMs?: number;
    avgTtftMs?: number;
    p95LatencyMs?: number;
    maxLatencyMs?: number;
  }
): OverviewSummary => {
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

  const tokens: UsageTokens = {
    inputTokens: numberValue(summary?.input_tokens),
    outputTokens: numberValue(
      (summary as { output_tokens?: number } | undefined)?.output_tokens
    ),
    reasoningTokens: numberValue(summary?.reasoning_tokens),
    cachedTokens: 0,
    cacheReadTokens: numberValue(summary?.cache_read_tokens),
    cacheCreationTokens: numberValue(summary?.cache_creation_tokens),
    totalTokens: numberValue(usage?.total_tokens ?? summary?.token_count),
  };

  return {
    requests,
    successes,
    failures,
    successRate,
    avgLatencyMs: numberValue(extras?.avgLatencyMs),
    avgTtftMs: numberValue(extras?.avgTtftMs),
    p95LatencyMs: numberValue(extras?.p95LatencyMs),
    maxLatencyMs: numberValue(extras?.maxLatencyMs),
    tokens,
    totalCost: numberValue(summary?.total_cost),
    costAvailable: Boolean(summary?.cost_available),
    rpm: numberValue(summary?.rpm),
    tpm: numberValue(summary?.tpm),
  };
};

export const overviewSeriesToTokenSeries = (
  overview: KeeperOverviewResponse | null
): TokenSeriesPoint[] => {
  const requests = overview?.series?.requests ?? {};
  const tokens = overview?.series?.tokens ?? {};
  const keys = Array.from(new Set([...Object.keys(requests), ...Object.keys(tokens)])).sort();

  return keys.map((key) => {
    const timestampMs = Date.parse(key) || 0;
    const label = Number.isFinite(timestampMs)
      ? new Date(timestampMs).toLocaleTimeString(undefined, {
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

const RANGE_MS: Record<'15m' | '1h' | '6h' | '24h' | 'all', number> = {
  '15m': 15 * 60 * 1000,
  '1h': 4 * 60 * 60 * 1000, // maps to Keeper 4h
  '6h': 8 * 60 * 60 * 1000, // maps to Keeper 8h
  '24h': 24 * 60 * 60 * 1000,
  all: 30 * 24 * 60 * 60 * 1000,
};

const SERIES_BUCKET_MS: Record<'15m' | '1h' | '6h' | '24h' | 'all', number> = {
  '15m': 60 * 1000,
  '1h': 5 * 60 * 1000,
  '6h': 15 * 60 * 1000,
  '24h': 30 * 60 * 1000,
  all: 6 * 60 * 60 * 1000,
};

/**
 * Build a multi-bucket token curve from event rows.
 * Prefer this over overview.series when Keeper only returns a single coarse bucket
 * (common for short retention / single-hour traffic).
 */
export const buildTokenSeriesFromEvents = (
  events: UsageEvent[],
  range: '15m' | '1h' | '6h' | '24h' | 'all',
  nowMs = Date.now()
): TokenSeriesPoint[] => {
  const spanMs = RANGE_MS[range] ?? RANGE_MS['24h'];
  const bucketMs = SERIES_BUCKET_MS[range] ?? SERIES_BUCKET_MS['24h'];
  const endMs = nowMs;
  const startMs = endMs - spanMs;
  const firstBucket = Math.floor(startMs / bucketMs) * bucketMs;
  const lastBucket = Math.floor(endMs / bucketMs) * bucketMs;
  const bucketCount = Math.max(1, Math.floor((lastBucket - firstBucket) / bucketMs) + 1);

  const buckets: TokenSeriesPoint[] = Array.from({ length: bucketCount }, (_, index) => {
    const timestampMs = firstBucket + index * bucketMs;
    return {
      timestampMs,
      label: new Date(timestampMs).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      }),
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requests: 0,
    };
  });

  for (const event of events) {
    if (event.timestampMs < startMs || event.timestampMs > endMs + bucketMs) continue;
    const index = Math.floor((event.timestampMs - firstBucket) / bucketMs);
    if (index < 0 || index >= buckets.length) continue;
    const bucket = buckets[index];
    bucket.requests += 1;
    bucket.totalTokens += event.tokens.totalTokens;
    bucket.inputTokens += event.tokens.inputTokens;
    bucket.outputTokens += event.tokens.outputTokens;
    bucket.reasoningTokens += event.tokens.reasoningTokens;
  }

  return buckets;
};

/** Prefer event-based series when it has more temporal resolution than overview. */
export const pickTokenSeries = (
  overview: KeeperOverviewResponse | null,
  events: UsageEvent[],
  range: '15m' | '1h' | '6h' | '24h' | 'all'
): TokenSeriesPoint[] => {
  const fromEvents = buildTokenSeriesFromEvents(events, range);
  const fromOverview = overviewSeriesToTokenSeries(overview);
  const eventActive = fromEvents.filter((p) => p.requests > 0).length;
  const overviewActive = fromOverview.filter((p) => p.requests > 0).length;

  // Overview often collapses everything into 1 hourly bucket → flat/static chart.
  if (eventActive >= 2 || fromEvents.length > fromOverview.length) {
    return fromEvents;
  }
  if (overviewActive >= 1 && fromOverview.length >= 2) {
    return fromOverview;
  }
  // Single overview bucket still worse than a filled event timeline
  if (fromEvents.some((p) => p.requests > 0)) {
    return fromEvents;
  }
  return fromOverview;
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
});
