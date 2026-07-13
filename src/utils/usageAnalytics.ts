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
  /** Optional cost from Keeper (USD) */
  costUsd?: number;
  costAvailable?: boolean;
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

export const getUsageStorageKey = (apiBase?: string) =>
  `cpamc.usageAnalytics.events.v1:${apiBase || 'default'}`;

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
  const inputTokens = numberValue(
    record.input_tokens ?? record.inputTokens ?? record.prompt_tokens ?? record.promptTokens
  );
  const outputTokens = numberValue(
    record.output_tokens ??
      record.outputTokens ??
      record.completion_tokens ??
      record.completionTokens
  );
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
  const tokens = normalizeTokens(value.tokens ?? value.usage ?? value);
  const fail = asRecord(value.fail);
  const timestampMs = timestampValue(
    value.timestamp ?? value.timestampMs ?? value.created_at ?? value.createdAt,
    now
  );
  const provider = stringValue(value.provider, 'unknown');
  const model = stringValue(value.model, 'unknown');
  const alias = stringValue(value.alias, model);
  const endpoint = stringValue(value.endpoint, 'unknown');
  const requestId = stringValue(value.request_id ?? value.requestId);
  const failStatusCode = numberValue(
    fail.status_code ?? fail.statusCode ?? value.fail_status_code ?? value.failStatusCode
  );
  const statusCode = numberValue(value.status ?? value.status_code ?? value.statusCode);
  const failed = boolValue(value.failed) || failStatusCode >= 400 || statusCode >= 400;
  const latencyMs = numberValue(
    value.latency_ms ?? value.latencyMs ?? value.duration_ms ?? value.durationMs
  );
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
    failStatusCode: failStatusCode || statusCode || (failed ? 500 : 200),
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

/* -------------------------------------------------------------------------- */
/* Cost estimation (local price table, LiteLLM/OpenRouter-style per 1M tokens) */
/* -------------------------------------------------------------------------- */

export interface ModelPriceEntry {
  /** model id or alias match key (case-insensitive) */
  model: string;
  /** USD per 1M input tokens */
  inputPerMillion: number;
  /** USD per 1M output tokens */
  outputPerMillion: number;
  /** USD per 1M cached/read tokens (optional, falls back to input * 0.1) */
  cachePerMillion?: number;
}

export interface UsageCostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  reasoningCost: number;
  totalCost: number;
  priced: boolean;
}

export interface UsageGroupWithCost extends UsageGroup {
  cost: number;
  pricedRequests: number;
}

/** Built-in approximate prices (USD / 1M tokens). Override via localStorage. */
export const DEFAULT_MODEL_PRICES: ModelPriceEntry[] = [
  { model: 'gpt-5', inputPerMillion: 1.25, outputPerMillion: 10 },
  { model: 'gpt-5.1', inputPerMillion: 1.25, outputPerMillion: 10 },
  { model: 'gpt-5.2', inputPerMillion: 1.75, outputPerMillion: 14 },
  { model: 'gpt-5.4', inputPerMillion: 2.5, outputPerMillion: 15 },
  { model: 'gpt-5.5', inputPerMillion: 2.5, outputPerMillion: 15 },
  { model: 'gpt-5.6', inputPerMillion: 2.5, outputPerMillion: 15 },
  { model: 'gpt-4o', inputPerMillion: 2.5, outputPerMillion: 10 },
  { model: 'gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6 },
  { model: 'o3', inputPerMillion: 2, outputPerMillion: 8 },
  { model: 'o4-mini', inputPerMillion: 1.1, outputPerMillion: 4.4 },
  { model: 'claude-opus', inputPerMillion: 15, outputPerMillion: 75 },
  { model: 'claude-sonnet', inputPerMillion: 3, outputPerMillion: 15 },
  { model: 'claude-haiku', inputPerMillion: 0.8, outputPerMillion: 4 },
  { model: 'gemini-2.5-pro', inputPerMillion: 1.25, outputPerMillion: 10 },
  { model: 'gemini-2.5-flash', inputPerMillion: 0.3, outputPerMillion: 2.5 },
  { model: 'gemini-3', inputPerMillion: 2, outputPerMillion: 12 },
  { model: 'grok-4', inputPerMillion: 3, outputPerMillion: 15 },
  { model: 'grok-3', inputPerMillion: 3, outputPerMillion: 15 },
  { model: 'kimi', inputPerMillion: 0.6, outputPerMillion: 2.5 },
];

export const getModelPricesStorageKey = (apiBase?: string) =>
  `cpamc.usageAnalytics.prices.v1:${apiBase || 'default'}`;

export const loadModelPrices = (storageKey: string): ModelPriceEntry[] => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_MODEL_PRICES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_MODEL_PRICES;
    return parsed
      .map((item): ModelPriceEntry | null => {
        if (!isRecord(item)) return null;
        const model = stringValue(item.model);
        if (!model) return null;
        return {
          model,
          inputPerMillion: numberValue(item.inputPerMillion ?? item.input),
          outputPerMillion: numberValue(item.outputPerMillion ?? item.output),
          cachePerMillion:
            item.cachePerMillion !== undefined || item.cache !== undefined
              ? numberValue(item.cachePerMillion ?? item.cache)
              : undefined,
        };
      })
      .filter(Boolean) as ModelPriceEntry[];
  } catch {
    return DEFAULT_MODEL_PRICES;
  }
};

export const saveModelPrices = (storageKey: string, prices: ModelPriceEntry[]) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(prices));
  } catch {
    // ignore quota
  }
};

const normalizeModelKey = (value: string) => value.trim().toLowerCase();

export const findModelPrice = (
  prices: ModelPriceEntry[],
  model: string,
  alias?: string
): ModelPriceEntry | null => {
  const candidates = [alias, model]
    .map((value) => normalizeModelKey(value || ''))
    .filter(Boolean);
  if (!candidates.length) return null;

  // exact match first
  for (const candidate of candidates) {
    const exact = prices.find((entry) => normalizeModelKey(entry.model) === candidate);
    if (exact) return exact;
  }
  // prefix / contains match (longest key wins)
  let best: ModelPriceEntry | null = null;
  for (const candidate of candidates) {
    for (const entry of prices) {
      const key = normalizeModelKey(entry.model);
      if (!key) continue;
      if (candidate.includes(key) || key.includes(candidate)) {
        if (!best || key.length > normalizeModelKey(best.model).length) {
          best = entry;
        }
      }
    }
  }
  return best;
};

export const estimateEventCost = (
  event: UsageEvent,
  prices: ModelPriceEntry[]
): UsageCostBreakdown => {
  const price = findModelPrice(prices, event.model, event.alias);
  if (!price) {
    return {
      inputCost: 0,
      outputCost: 0,
      cacheCost: 0,
      reasoningCost: 0,
      totalCost: 0,
      priced: false,
    };
  }

  const cacheRate = price.cachePerMillion ?? price.inputPerMillion * 0.1;
  const inputCost = (event.tokens.inputTokens / 1_000_000) * price.inputPerMillion;
  const outputCost = (event.tokens.outputTokens / 1_000_000) * price.outputPerMillion;
  // treat reasoning as output-priced when present
  const reasoningCost = (event.tokens.reasoningTokens / 1_000_000) * price.outputPerMillion;
  const cacheTokens =
    event.tokens.cachedTokens + event.tokens.cacheReadTokens + event.tokens.cacheCreationTokens;
  const cacheCost = (cacheTokens / 1_000_000) * cacheRate;
  const totalCost = inputCost + outputCost + reasoningCost + cacheCost;

  return {
    inputCost,
    outputCost,
    cacheCost,
    reasoningCost,
    totalCost,
    priced: true,
  };
};

export const summarizeUsageCost = (events: UsageEvent[], prices: ModelPriceEntry[]) => {
  return events.reduce(
    (acc, event) => {
      const cost = estimateEventCost(event, prices);
      acc.totalCost += cost.totalCost;
      acc.inputCost += cost.inputCost;
      acc.outputCost += cost.outputCost;
      acc.cacheCost += cost.cacheCost;
      acc.reasoningCost += cost.reasoningCost;
      if (cost.priced) acc.pricedRequests += 1;
      else acc.unpricedRequests += 1;
      return acc;
    },
    {
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheCost: 0,
      reasoningCost: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
    }
  );
};

export const groupUsageEventsWithCost = (
  events: UsageEvent[],
  prices: ModelPriceEntry[],
  getKey: (event: UsageEvent) => string,
  limit = 12
): UsageGroupWithCost[] => {
  const grouped = new Map<
    string,
    UsageGroupWithCost & { latencyTotal: number; ttftTotal: number }
  >();

  events.forEach((event) => {
    const key = getKey(event).trim() || 'unknown';
    const cost = estimateEventCost(event, prices);
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
        cost: 0,
        pricedRequests: 0,
        latencyTotal: 0,
        ttftTotal: 0,
      } satisfies UsageGroupWithCost & { latencyTotal: number; ttftTotal: number });

    existing.requests += 1;
    existing.failures += event.failed ? 1 : 0;
    existing.totalTokens += event.tokens.totalTokens;
    existing.latencyTotal += event.latencyMs;
    existing.ttftTotal += event.ttftMs;
    existing.maxLatencyMs = Math.max(existing.maxLatencyMs, event.latencyMs);
    existing.cost += cost.totalCost;
    if (cost.priced) existing.pricedRequests += 1;
    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map(({ latencyTotal, ttftTotal, ...group }) => ({
      ...group,
      avgLatencyMs: group.requests > 0 ? latencyTotal / group.requests : 0,
      avgTtftMs: group.requests > 0 ? ttftTotal / group.requests : 0,
    }))
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests)
    .slice(0, limit);
};

export const formatUsd = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
};

export const exportUsageEventsJsonl = (events: UsageEvent[]) =>
  events
    .map((event) =>
      JSON.stringify({
        id: event.id,
        timestamp: new Date(event.timestampMs).toISOString(),
        provider: event.provider,
        model: event.model,
        alias: event.alias,
        endpoint: event.endpoint,
        api_key: event.apiKey,
        auth_index: event.authIndex,
        request_id: event.requestId,
        latency_ms: event.latencyMs,
        ttft_ms: event.ttftMs,
        failed: event.failed,
        status_code: event.failStatusCode,
        fail_body: event.failBody,
        tokens: event.tokens,
      })
    )
    .join('\n');

export const filterUsageEvents = (
  events: UsageEvent[],
  filters: {
    provider?: string;
    model?: string;
    apiKey?: string;
    status?: 'all' | 'success' | 'failed';
    query?: string;
  }
) => {
  const provider = (filters.provider || '').trim().toLowerCase();
  const model = (filters.model || '').trim().toLowerCase();
  const apiKey = (filters.apiKey || '').trim().toLowerCase();
  const query = (filters.query || '').trim().toLowerCase();
  const status = filters.status || 'all';

  return events.filter((event) => {
    if (status === 'success' && event.failed) return false;
    if (status === 'failed' && !event.failed) return false;
    if (provider && !event.provider.toLowerCase().includes(provider)) return false;
    if (
      model &&
      !event.model.toLowerCase().includes(model) &&
      !event.alias.toLowerCase().includes(model)
    ) {
      return false;
    }
    if (apiKey && !event.apiKey.toLowerCase().includes(apiKey)) return false;
    if (query) {
      const haystack = [
        event.provider,
        event.model,
        event.alias,
        event.endpoint,
        event.apiKey,
        event.authIndex,
        event.requestId,
        event.failBody,
        String(event.failStatusCode),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
};
