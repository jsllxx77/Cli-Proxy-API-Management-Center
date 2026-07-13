/**
 * Thin mappers: Keeper API → UI display shapes.
 * Does not invent finer buckets than Keeper; only zero-fills missing
 * hour/day slots inside the API range so a single sparse point is not
 * stretched into a full-width flat line.
 */

import type {
  KeeperAnalysisResponse,
  KeeperCompositionItem,
  KeeperOverviewResponse,
  KeeperUsageEvent,
} from '@/services/api/keeper';
import type { TokenSeriesPoint, UsageEvent, UsageGroup, UsageTokens } from '@/utils/usageAnalytics';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const numberValue = (value: unknown, fallback = 0) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

const parseOffsetMinutes = (value?: string | null): number | null => {
  if (!value) return null;
  const match = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
};

const formatOffset = (offsetMin: number) => {
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
};

const parseBucketKey = (key: string, offsetMin: number) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return Date.parse(`${key}T00:00:00${formatOffset(offsetMin)}`);
  }
  const parsed = Date.parse(key);
  return Number.isFinite(parsed) ? parsed : NaN;
};

const floorToBucket = (ms: number, offsetMin: number, bucketMs: number) => {
  const local = ms + offsetMin * 60_000;
  return Math.floor(local / bucketMs) * bucketMs - offsetMin * 60_000;
};

const seriesLabel = (timestampMs: number, mode: 'hour' | 'day') => {
  if (!Number.isFinite(timestampMs)) return '-';
  if (mode === 'day') {
    return new Date(timestampMs).toLocaleDateString(undefined, {
      month: '2-digit',
      day: '2-digit',
    });
  }
  return new Date(timestampMs).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

type SparsePoint = {
  timestampMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
};

/**
 * Expand sparse Keeper hour/day points across [rangeStart, rangeEnd].
 * Values stay exactly as returned; missing slots are 0.
 */
const fillSeriesWindow = (
  sparse: SparsePoint[],
  rangeStart?: string,
  rangeEnd?: string,
  granularity?: string,
  sourceKeys: string[] = []
): TokenSeriesPoint[] => {
  const offsetMin =
    parseOffsetMinutes(sourceKeys[0]) ??
    parseOffsetMinutes(rangeStart) ??
    parseOffsetMinutes(rangeEnd) ??
    8 * 60;

  let mode: 'hour' | 'day' =
    granularity === 'daily' || granularity === 'day' ? 'day' : 'hour';

  // Day keys look like "2026-07-14" without a time component.
  if (sourceKeys.length > 0 && sourceKeys.every((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))) {
    mode = 'day';
  } else if (granularity !== 'hourly' && sparse.length > 1) {
    const allMidnight = sparse.every((point) => {
      const local = new Date(point.timestampMs + offsetMin * 60_000);
      return local.getUTCHours() === 0 && local.getUTCMinutes() === 0;
    });
    const span = sparse[sparse.length - 1].timestampMs - sparse[0].timestampMs;
    if (allMidnight && span >= DAY_MS) mode = 'day';
  }

  const bucketMs = mode === 'day' ? DAY_MS : HOUR_MS;
  const byBucket = new Map<number, SparsePoint>();
  for (const point of sparse) {
    if (!Number.isFinite(point.timestampMs)) continue;
    const bucket = floorToBucket(point.timestampMs, offsetMin, bucketMs);
    const prev = byBucket.get(bucket);
    if (!prev) {
      byBucket.set(bucket, { ...point, timestampMs: bucket });
    } else {
      byBucket.set(bucket, {
        timestampMs: bucket,
        totalTokens: prev.totalTokens + point.totalTokens,
        inputTokens: prev.inputTokens + point.inputTokens,
        outputTokens: prev.outputTokens + point.outputTokens,
        reasoningTokens: prev.reasoningTokens + point.reasoningTokens,
        requests: prev.requests + point.requests,
      });
    }
  }

  const startRaw = rangeStart ? Date.parse(rangeStart) : NaN;
  const endRaw = rangeEnd ? Date.parse(rangeEnd) : NaN;
  const dataTimes = Array.from(byBucket.keys()).sort((a, b) => a - b);
  const startMs = Number.isFinite(startRaw) ? startRaw : dataTimes[0] ?? NaN;
  const endMs = Number.isFinite(endRaw)
    ? endRaw
    : dataTimes[dataTimes.length - 1] ?? Date.now();

  const toPoint = (point: SparsePoint): TokenSeriesPoint => ({
    timestampMs: point.timestampMs,
    label: seriesLabel(point.timestampMs, mode),
    totalTokens: point.totalTokens,
    inputTokens: point.inputTokens,
    outputTokens: point.outputTokens,
    reasoningTokens: point.reasoningTokens,
    requests: point.requests,
  });

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return sparse
      .slice()
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map(toPoint);
  }

  const points: TokenSeriesPoint[] = [];
  let cursor = floorToBucket(startMs, offsetMin, bucketMs);
  const last = floorToBucket(endMs, offsetMin, bucketMs);
  let guard = 0;
  while (cursor <= last && guard < 800) {
    const hit = byBucket.get(cursor);
    points.push({
      timestampMs: cursor,
      label: seriesLabel(cursor, mode),
      totalTokens: hit?.totalTokens ?? 0,
      inputTokens: hit?.inputTokens ?? 0,
      outputTokens: hit?.outputTokens ?? 0,
      reasoningTokens: hit?.reasoningTokens ?? 0,
      requests: hit?.requests ?? 0,
    });
    cursor += bucketMs;
    guard += 1;
  }

  return points.length ? points : sparse.map(toPoint);
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

/** Map Keeper overview.series and zero-fill missing hour/day slots in range. */
export const overviewSeriesToTokenSeries = (
  overview: KeeperOverviewResponse | null
): TokenSeriesPoint[] => {
  const requests = overview?.series?.requests ?? {};
  const tokens = overview?.series?.tokens ?? {};
  const keys = Array.from(new Set([...Object.keys(requests), ...Object.keys(tokens)])).sort();
  const offsetMin =
    parseOffsetMinutes(keys[0]) ??
    parseOffsetMinutes(overview?.range_start) ??
    parseOffsetMinutes(overview?.range_end) ??
    8 * 60;

  const sparse: SparsePoint[] = keys.map((key) => {
    const timestampMs = parseBucketKey(key, offsetMin);
    return {
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
      totalTokens: numberValue(tokens[key]),
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requests: numberValue(requests[key]),
    };
  });

  // 7d / 30d overview series uses day keys; short windows use hour keys.
  const granularity = keys.some((key) => key.includes('T')) ? 'hourly' : 'daily';

  return fillSeriesWindow(
    sparse,
    overview?.range_start,
    overview?.range_end,
    granularity,
    keys
  );
};

/** Map analysis.token_usage and zero-fill missing slots in analysis range. */
export const analysisTokenUsageToSeries = (
  analysis: KeeperAnalysisResponse | null
): TokenSeriesPoint[] => {
  const rows = analysis?.token_usage ?? [];
  const keys = rows.map((row) => String(row.bucket ?? '')).filter(Boolean);
  const offsetMin =
    parseOffsetMinutes(keys[0]) ??
    parseOffsetMinutes(analysis?.range_start) ??
    parseOffsetMinutes(analysis?.range_end) ??
    8 * 60;

  const sparse: SparsePoint[] = rows.map((row) => {
    const key = String(row.bucket ?? '');
    const timestampMs = parseBucketKey(key, offsetMin);
    return {
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
      totalTokens: numberValue(row.total_tokens),
      inputTokens: numberValue(row.input_tokens),
      outputTokens: numberValue(row.output_tokens),
      reasoningTokens: numberValue(row.reasoning_tokens),
      requests: numberValue(row.requests),
    };
  });

  return fillSeriesWindow(
    sparse,
    analysis?.range_start,
    analysis?.range_end,
    analysis?.granularity,
    keys
  );
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
