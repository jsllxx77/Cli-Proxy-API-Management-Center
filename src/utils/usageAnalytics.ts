export type UsageTimeRange = '15m' | '1h' | '6h' | '24h' | 'all';

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface UsageEvent {
  id: string;
  timestampMs: number;
  provider: string;
  executorType: string;
  model: string;
  alias: string;
  endpoint: string;
  authType: string;
  apiKey: string;
  requestId: string;
  reasoningEffort: string;
  serviceTier: string;
  source: string;
  authIndex: string;
  latencyMs: number;
  ttftMs: number;
  failed: boolean;
  failStatusCode: number;
  failBody: string;
  tokens: UsageTokens;
}

export interface UsageSummary {
  requests: number;
  successes: number;
  failures: number;
  successRate: number;
  avgLatencyMs: number;
  avgTtftMs: number;
  tokens: UsageTokens;
}

export interface TokenSeriesPoint {
  timestampMs: number;
  label: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
}

export interface UsageGroup {
  key: string;
  label: string;
  requests: number;
  failures: number;
  totalTokens: number;
  avgLatencyMs: number;
  avgTtftMs: number;
  maxLatencyMs: number;
}

const RANGE_MS: Record<Exclude<UsageTimeRange, 'all'>, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const SERIES_BUCKET_MS: Record<Exclude<UsageTimeRange, 'all'>, number> = {
  '15m': 60 * 1000,
  '1h': 5 * 60 * 1000,
  '6h': 15 * 60 * 1000,
  '24h': 60 * 60 * 1000,
};

const MAX_STORED_EVENTS = 2400;
const MAX_FAILURE_BODY_LENGTH = 900;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const stringValue = (value: unknown, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed || fallback;
};

const numberValue = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const boolValue = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
};

const timestampValue = (value: unknown, fallback: number) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const maskSensitiveValue = (value: unknown) => {
  const raw = stringValue(value);
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}...`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
};

const truncateText = (value: unknown, maxLength: number) => {
  const text = stringValue(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
};

const normalizeTokens = (value: unknown): UsageTokens => {
  const record = asRecord(value);
  const inputTokens = numberValue(record.input_tokens ?? record.inputTokens);
  const outputTokens = numberValue(record.output_tokens ?? record.outputTokens);
  const reasoningTokens = numberValue(record.reasoning_tokens ?? record.reasoningTokens);
  const cachedTokens = numberValue(record.cached_tokens ?? record.cachedTokens);
  const cacheReadTokens = numberValue(record.cache_read_tokens ?? record.cacheReadTokens);
  const cacheCreationTokens = numberValue(
    record.cache_creation_tokens ?? record.cacheCreationTokens
  );
  const explicitTotal = numberValue(record.total_tokens ?? record.totalTokens);
  const totalTokens =
    explicitTotal ||
    inputTokens + outputTokens + reasoningTokens ||
    inputTokens + outputTokens + reasoningTokens + cachedTokens;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
  };
};

export const normalizeUsageEvent = (value: unknown, index = 0): UsageEvent | null => {
  if (!isRecord(value)) return null;

  const now = Date.now();
  const tokens = normalizeTokens(value.tokens);
  const fail = asRecord(value.fail);
  const timestampMs = timestampValue(value.timestamp ?? value.timestampMs, now);
  const provider = stringValue(value.provider, 'unknown');
  const model = stringValue(value.model, 'unknown');
  const alias = stringValue(value.alias, model);
  const endpoint = stringValue(value.endpoint, 'unknown');
  const requestId = stringValue(value.request_id ?? value.requestId);
  const failStatusCode = numberValue(
    fail.status_code ?? fail.statusCode ?? value.fail_status_code ?? value.failStatusCode
  );
  const failed = boolValue(value.failed) || failStatusCode >= 400;
  const latencyMs = numberValue(value.latency_ms ?? value.latencyMs);
  const ttftMs = numberValue(value.ttft_ms ?? value.ttftMs);
  const idSource = stringValue(value.id) || [
    requestId,
    timestampMs,
    provider,
    model,
    endpoint,
    tokens.totalTokens,
    latencyMs,
    failStatusCode || (failed ? 'failed' : 'ok'),
    index,
  ].join('|');

  return {
    id: idSource,
    timestampMs,
    provider,
    executorType: stringValue(value.executor_type ?? value.executorType, 'unknown'),
    model,
    alias,
    endpoint,
    authType: stringValue(value.auth_type ?? value.authType, 'unknown'),
    apiKey: maskSensitiveValue(value.api_key ?? value.apiKey),
    requestId,
    reasoningEffort: stringValue(value.reasoning_effort ?? value.reasoningEffort),
    serviceTier: stringValue(value.service_tier ?? value.serviceTier),
    source: stringValue(value.source),
    authIndex: stringValue(value.auth_index ?? value.authIndex),
    latencyMs,
    ttftMs,
    failed,
    failStatusCode: failStatusCode || (failed ? 500 : 200),
    failBody: truncateText(fail.body ?? value.fail_body ?? value.failBody, MAX_FAILURE_BODY_LENGTH),
    tokens,
  };
};

export const normalizeUsageEvents = (payload: unknown): UsageEvent[] => {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item, index) => normalizeUsageEvent(item, index))
    .filter(Boolean) as UsageEvent[];
};

export const mergeUsageEvents = (existing: UsageEvent[], incoming: UsageEvent[]) => {
  if (!incoming.length) return existing.slice(-MAX_STORED_EVENTS);

  const map = new Map<string, UsageEvent>();
  [...existing, ...incoming].forEach((event) => {
    map.set(event.id, event);
  });

  return Array.from(map.values())
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .slice(-MAX_STORED_EVENTS);
};

export const loadStoredUsageEvents = (storageKey: string): UsageEvent[] => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index) => normalizeUsageEvent(item, index))
      .filter(Boolean) as UsageEvent[];
  } catch {
    return [];
  }
};

export const saveStoredUsageEvents = (storageKey: string, events: UsageEvent[]) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(events.slice(-MAX_STORED_EVENTS)));
  } catch {
    // Ignore quota errors; the live page state still keeps the current session.
  }
};

export const filterUsageEventsByRange = (events: UsageEvent[], range: UsageTimeRange) => {
  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  if (range === 'all') return sorted;
  const cutoff = Date.now() - RANGE_MS[range];
  return sorted.filter((event) => event.timestampMs >= cutoff);
};

export const summarizeUsageEvents = (events: UsageEvent[]): UsageSummary => {
  const emptyTokens: UsageTokens = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };

  if (!events.length) {
    return {
      requests: 0,
      successes: 0,
      failures: 0,
      successRate: 100,
      avgLatencyMs: 0,
      avgTtftMs: 0,
      tokens: emptyTokens,
    };
  }

  const totals = events.reduce(
    (acc, event) => {
      acc.requests += 1;
      if (event.failed) acc.failures += 1;
      else acc.successes += 1;
      acc.latency += event.latencyMs;
      acc.ttft += event.ttftMs;
      acc.tokens.inputTokens += event.tokens.inputTokens;
      acc.tokens.outputTokens += event.tokens.outputTokens;
      acc.tokens.reasoningTokens += event.tokens.reasoningTokens;
      acc.tokens.cachedTokens += event.tokens.cachedTokens;
      acc.tokens.cacheReadTokens += event.tokens.cacheReadTokens;
      acc.tokens.cacheCreationTokens += event.tokens.cacheCreationTokens;
      acc.tokens.totalTokens += event.tokens.totalTokens;
      return acc;
    },
    {
      requests: 0,
      successes: 0,
      failures: 0,
      latency: 0,
      ttft: 0,
      tokens: { ...emptyTokens },
    }
  );

  return {
    requests: totals.requests,
    successes: totals.successes,
    failures: totals.failures,
    successRate: totals.requests > 0 ? (totals.successes / totals.requests) * 100 : 100,
    avgLatencyMs: totals.latency / totals.requests,
    avgTtftMs: totals.ttft / totals.requests,
    tokens: totals.tokens,
  };
};

const getSeriesInterval = (events: UsageEvent[], range: UsageTimeRange) => {
  if (range !== 'all') return SERIES_BUCKET_MS[range];
  if (events.length < 2) return 60 * 1000;
  const first = events[0].timestampMs;
  const last = events[events.length - 1].timestampMs;
  return Math.max(60 * 1000, Math.ceil((last - first) / 32 / 60_000) * 60_000);
};

const formatSeriesLabel = (timestampMs: number, range: UsageTimeRange) => {
  const date = new Date(timestampMs);
  if (range === '24h' || range === 'all') {
    return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit' });
  }
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

export const buildTokenSeries = (
  events: UsageEvent[],
  range: UsageTimeRange
): TokenSeriesPoint[] => {
  if (!events.length) return [];

  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  const intervalMs = getSeriesInterval(sorted, range);
  const rangeStart =
    range === 'all' ? sorted[0].timestampMs : Date.now() - RANGE_MS[range];
  const firstBucketStart = Math.floor(rangeStart / intervalMs) * intervalMs;
  const lastEventTime = Math.max(Date.now(), sorted[sorted.length - 1].timestampMs);
  const bucketCount = Math.max(1, Math.ceil((lastEventTime - firstBucketStart) / intervalMs) + 1);

  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    timestampMs: firstBucketStart + index * intervalMs,
    label: formatSeriesLabel(firstBucketStart + index * intervalMs, range),
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    requests: 0,
  }));

  sorted.forEach((event) => {
    const index = Math.floor((event.timestampMs - firstBucketStart) / intervalMs);
    if (index < 0 || index >= buckets.length) return;
    const bucket = buckets[index];
    bucket.requests += 1;
    bucket.totalTokens += event.tokens.totalTokens;
    bucket.inputTokens += event.tokens.inputTokens;
    bucket.outputTokens += event.tokens.outputTokens;
    bucket.reasoningTokens += event.tokens.reasoningTokens;
  });

  return buckets;
};

export const groupUsageEvents = (
  events: UsageEvent[],
  getKey: (event: UsageEvent) => string,
  limit = 8
): UsageGroup[] => {
  const grouped = new Map<string, UsageGroup & { latencyTotal: number; ttftTotal: number }>();

  events.forEach((event) => {
    const key = getKey(event).trim() || 'unknown';
    const existing =
      grouped.get(key) ??
      ({
        key,
        label: key,
        requests: 0,
        failures: 0,
        totalTokens: 0,
        avgLatencyMs: 0,
        avgTtftMs: 0,
        maxLatencyMs: 0,
        latencyTotal: 0,
        ttftTotal: 0,
      } satisfies UsageGroup & { latencyTotal: number; ttftTotal: number });

    existing.requests += 1;
    existing.failures += event.failed ? 1 : 0;
    existing.totalTokens += event.tokens.totalTokens;
    existing.latencyTotal += event.latencyMs;
    existing.ttftTotal += event.ttftMs;
    existing.maxLatencyMs = Math.max(existing.maxLatencyMs, event.latencyMs);
    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map(({ latencyTotal, ttftTotal, ...group }) => ({
      ...group,
      avgLatencyMs: group.requests > 0 ? latencyTotal / group.requests : 0,
      avgTtftMs: group.requests > 0 ? ttftTotal / group.requests : 0,
    }))
    .sort((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens)
    .slice(0, limit);
};

export const rankUsageLatency = (events: UsageEvent[], limit = 8) =>
  groupUsageEvents(events, (event) => `${event.provider} / ${event.alias || event.model}`, limit)
    .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs)
    .slice(0, limit);

export const getFailedUsageEvents = (events: UsageEvent[], limit = 24) =>
  events
    .filter((event) => event.failed)
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, limit);

export const formatCompactNumber = (value: number) => {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : 0,
  }).format(value);
};

export const formatDuration = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0ms';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
};
