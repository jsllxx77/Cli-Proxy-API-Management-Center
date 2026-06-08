import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Database,
  Download,
  RefreshCw,
  Server,
  Trash2,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from '@/components/shadcn/ui/badge';
import { Button } from '@/components/shadcn/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/shadcn/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/shadcn/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/shadcn/ui/tabs';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useInterval } from '@/hooks/useInterval';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { logsApi, usageApi } from '@/services/api';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { downloadBlob } from '@/utils/download';
import {
  buildTokenSeries,
  filterUsageEventsByRange,
  formatCompactNumber,
  formatDuration,
  getFailedUsageEvents,
  groupUsageEvents,
  loadStoredUsageEvents,
  mergeUsageEvents,
  normalizeUsageEvents,
  rankUsageLatency,
  saveStoredUsageEvents,
  summarizeUsageEvents,
  type TokenSeriesPoint,
  type UsageEvent,
  type UsageGroup,
  type UsageTimeRange,
} from '@/utils/usageAnalytics';
import { cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 5000;
const USAGE_QUEUE_COUNT = 300;
const RECENT_REQUEST_LIMIT = 12;

const timeRangeOptions: Array<{ value: UsageTimeRange; labelKey: string; fallback: string }> = [
  { value: '15m', labelKey: 'usage.range_15m', fallback: '15 分钟' },
  { value: '1h', labelKey: 'usage.range_1h', fallback: '1 小时' },
  { value: '6h', labelKey: 'usage.range_6h', fallback: '6 小时' },
  { value: '24h', labelKey: 'usage.range_24h', fallback: '24 小时' },
  { value: 'all', labelKey: 'usage.range_all', fallback: '全部' },
];

const chartPalette = ['#0f172a', '#2563eb', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444'];

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '';

const formatPercent = (value: number) =>
  `${Number.isFinite(value) ? value.toFixed(value >= 99.5 || value <= 0 ? 0 : 1) : '0'}%`;

const formatRate = (requests: number, range: UsageTimeRange) => {
  if (!requests) return '0/min';
  const minutes =
    range === '15m' ? 15 : range === '1h' ? 60 : range === '6h' ? 360 : range === '24h' ? 1440 : 0;
  if (!minutes) return `${formatCompactNumber(requests)}/total`;
  const rate = requests / minutes;
  return `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)}/min`;
};

const formatTime = (timestampMs: number, locale: string) => {
  if (!timestampMs) return '-';
  return new Date(timestampMs).toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const compactLabel = (value: string, fallback = 'unknown') => value.trim() || fallback;

const tooltipNumber = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function MetricCard({
  title,
  value,
  subtitle,
  badge,
  icon,
  tone = 'neutral',
}: {
  title: string;
  value: string;
  subtitle: string;
  badge: string;
  icon: React.ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  return (
    <Card className="overflow-hidden rounded-lg border-border/80 shadow-sm">
      <CardContent className="relative flex min-h-[148px] flex-col justify-between p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <div className="mt-3 text-3xl font-semibold leading-none tracking-normal text-foreground">
              {value}
            </div>
          </div>
          <Badge
            variant={tone === 'danger' ? 'destructive' : tone === 'warning' ? 'warning' : 'outline'}
            className="shrink-0 rounded-full bg-background/75"
          >
            {badge}
          </Badge>
        </div>
        <div className="mt-6 flex items-end justify-between gap-4">
          <p className="text-sm leading-5 text-muted-foreground">{subtitle}</p>
          <div
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-md border bg-muted text-foreground',
              tone === 'success' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
              tone === 'warning' && 'border-amber-500/30 bg-amber-500/10 text-amber-700',
              tone === 'danger' && 'border-red-500/30 bg-red-500/10 text-red-700'
            )}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TokenAreaChart({ data }: { data: TokenSeriesPoint[] }) {
  const chartData = data.map((point) => ({
    label: point.label,
    total: point.totalTokens,
    input: point.inputTokens,
    output: point.outputTokens,
    reasoning: point.reasoningTokens,
    requests: point.requests,
  }));

  if (!chartData.length || !chartData.some((point) => point.requests > 0)) {
    return (
      <div className="grid h-[360px] place-items-center rounded-lg border border-dashed bg-muted/30">
        <div className="flex max-w-md items-center gap-4 px-6 text-left">
          <div className="grid size-10 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground">
            <BarChart3 className="size-5" />
          </div>
          <div>
            <div className="font-medium text-foreground">暂无统计数据</div>
            <div className="mt-1 text-sm text-muted-foreground">
              产生新的模型请求后，这里会显示实时 Token 和请求趋势。
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[360px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 10, bottom: 0 }}>
          <defs>
            <linearGradient id="tokenTotalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0f172a" stopOpacity={0.34} />
              <stop offset="95%" stopColor="#0f172a" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-color)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            minTickGap={28}
            tick={{ fill: 'var(--text-tertiary)', fontSize: 12 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => formatCompactNumber(value)}
            tick={{ fill: 'var(--text-tertiary)', fontSize: 12 }}
            width={44}
          />
          <RechartsTooltip
            cursor={{ stroke: 'var(--border-color)' }}
            formatter={(value, name) => [formatCompactNumber(tooltipNumber(value)), String(name)]}
            contentStyle={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              color: 'var(--text-primary)',
            }}
          />
          <Area
            type="monotone"
            dataKey="total"
            name="Total"
            stroke="#0f172a"
            strokeWidth={2}
            fill="url(#tokenTotalFill)"
          />
          <Area type="monotone" dataKey="input" name="Input" stroke="#2563eb" strokeWidth={1.5} fill="transparent" />
          <Area type="monotone" dataKey="output" name="Output" stroke="#10b981" strokeWidth={1.5} fill="transparent" />
          <Area type="monotone" dataKey="reasoning" name="Reasoning" stroke="#8b5cf6" strokeWidth={1.5} fill="transparent" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function DistributionBars({
  groups,
  emptyText,
  metric = 'requests',
}: {
  groups: UsageGroup[];
  emptyText: string;
  metric?: 'requests' | 'tokens' | 'latency';
}) {
  const chartData = groups.map((group, index) => ({
    name: group.label,
    value:
      metric === 'tokens'
        ? group.totalTokens
        : metric === 'latency'
          ? Math.round(group.avgLatencyMs)
          : group.requests,
    color: chartPalette[index % chartPalette.length],
  }));

  if (!chartData.length) {
    return <div className="py-8 text-sm text-muted-foreground">{emptyText}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
            <CartesianGrid horizontal={false} stroke="var(--border-color)" />
            <XAxis type="number" hide />
            <YAxis
              dataKey="name"
              type="category"
              tickLine={false}
              axisLine={false}
              width={86}
              tick={{ fill: 'var(--text-tertiary)', fontSize: 12 }}
            />
            <RechartsTooltip
              cursor={{ fill: 'color-mix(in srgb, var(--bg-secondary) 60%, transparent)' }}
              formatter={(value) => [
                metric === 'latency'
                  ? formatDuration(tooltipNumber(value))
                  : formatCompactNumber(tooltipNumber(value)),
                metric === 'tokens' ? 'Tokens' : metric === 'latency' ? 'Latency' : 'Requests',
              ]}
              contentStyle={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
              }}
            />
            <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={16}>
              {chartData.map((entry) => (
                <Cell key={entry.name} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-2">
        {groups.slice(0, 5).map((group, index) => (
          <div key={group.key} className="flex items-center justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-sm"
                style={{ background: chartPalette[index % chartPalette.length] }}
              />
              <span className="truncate font-medium">{group.label}</span>
            </div>
            <span className="shrink-0 text-muted-foreground">
              {formatCompactNumber(group.requests)} req
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LatencyList({ groups, emptyText }: { groups: UsageGroup[]; emptyText: string }) {
  const maxLatency = Math.max(...groups.map((group) => group.avgLatencyMs), 1);

  if (!groups.length) {
    return <div className="py-8 text-sm text-muted-foreground">{emptyText}</div>;
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{group.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {formatCompactNumber(group.requests)} req / {formatCompactNumber(group.totalTokens)} tok
              </div>
            </div>
            <Badge variant="outline" className="shrink-0 font-mono">
              {formatDuration(group.avgLatencyMs)}
            </Badge>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground"
              style={{ width: `${Math.max(4, (group.avgLatencyMs / maxLatency) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecentEventsTable({
  events,
  locale,
  emptyText,
  onDownload,
}: {
  events: UsageEvent[];
  locale: string;
  emptyText: string;
  onDownload: (event: UsageEvent) => void;
}) {
  if (!events.length) {
    return <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-sm text-muted-foreground">{emptyText}</div>;
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Provider / Model</TableHead>
            <TableHead>Endpoint</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Latency</TableHead>
            <TableHead className="w-[56px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatTime(event.timestampMs, locale)}
              </TableCell>
              <TableCell>
                <Badge
                  variant={event.failed ? 'destructive' : 'success'}
                  className="whitespace-nowrap rounded-full"
                >
                  {event.failed ? `HTTP ${event.failStatusCode || 500}` : 'OK'}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="max-w-[260px]">
                  <div className="truncate font-medium">{event.provider}</div>
                  <div className="truncate text-xs text-muted-foreground">{event.alias || event.model}</div>
                </div>
              </TableCell>
              <TableCell>
                <span className="block max-w-[180px] truncate font-mono text-xs text-muted-foreground">
                  {event.endpoint}
                </span>
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatCompactNumber(event.tokens.totalTokens)}
              </TableCell>
              <TableCell className="text-right font-mono">{formatDuration(event.latencyMs)}</TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={!event.requestId}
                  onClick={() => onDownload(event)}
                  aria-label="Download request log"
                >
                  <Download className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function UsageAnalyticsPage() {
  const { t, i18n } = useTranslation();
  const { showConfirmation, showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);
  const [range, setRange] = useLocalStorage<UsageTimeRange>('usageAnalytics.range', '1h');
  const [autoRefresh, setAutoRefresh] = useLocalStorage('usageAnalytics.autoRefresh', true);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const hydratedStorageKeyRef = useRef('');
  const requestInFlightRef = useRef(false);

  const storageKey = useMemo(
    () => `cpamc.usageAnalytics.events.v1:${apiBase || 'default'}`,
    [apiBase]
  );
  const usageStatisticsEnabled = config?.raw?.['usage-statistics-enabled'];
  const usageDisabled = usageStatisticsEnabled === false;

  useEffect(() => {
    hydratedStorageKeyRef.current = storageKey;
    let cancelled = false;
    window.queueMicrotask(() => {
      if (cancelled) return;
      setEvents(loadStoredUsageEvents(storageKey));
      setLastLoadedAt(null);
      setError('');
    });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useEffect(() => {
    if (hydratedStorageKeyRef.current !== storageKey) return;
    saveStoredUsageEvents(storageKey, events);
  }, [events, storageKey]);

  const loadUsageQueue = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    if (requestInFlightRef.current) return;

    requestInFlightRef.current = true;
    setLoading(true);
    try {
      const payload = await usageApi.getQueue(USAGE_QUEUE_COUNT);
      const incoming = normalizeUsageEvents(payload);
      setEvents((current) => mergeUsageEvents(current, incoming));
      setLastLoadedAt(Date.now());
      setError('');
    } catch (err: unknown) {
      setError(getErrorMessage(err) || t('usage.load_failed', { defaultValue: '加载统计数据失败' }));
    } finally {
      setLoading(false);
      requestInFlightRef.current = false;
    }
  }, [connectionStatus, t]);

  useHeaderRefresh(() => loadUsageQueue());

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    const id = window.setTimeout(() => {
      void loadUsageQueue();
    }, 0);
    return () => window.clearTimeout(id);
  }, [connectionStatus, loadUsageQueue]);

  useInterval(
    () => {
      void loadUsageQueue();
    },
    autoRefresh && connectionStatus === 'connected' ? POLL_INTERVAL_MS : null
  );

  const filteredEvents = useMemo(() => filterUsageEventsByRange(events, range), [events, range]);
  const summary = useMemo(() => summarizeUsageEvents(filteredEvents), [filteredEvents]);
  const tokenSeries = useMemo(() => buildTokenSeries(filteredEvents, range), [filteredEvents, range]);
  const latencyRanking = useMemo(() => rankUsageLatency(filteredEvents), [filteredEvents]);
  const modelDistribution = useMemo(
    () => groupUsageEvents(filteredEvents, (event) => compactLabel(event.alias || event.model), 8),
    [filteredEvents]
  );
  const providerDistribution = useMemo(
    () => groupUsageEvents(filteredEvents, (event) => compactLabel(event.provider), 8),
    [filteredEvents]
  );
  const endpointDistribution = useMemo(
    () => groupUsageEvents(filteredEvents, (event) => compactLabel(event.endpoint), 8),
    [filteredEvents]
  );
  const failedEvents = useMemo(() => getFailedUsageEvents(filteredEvents), [filteredEvents]);
  const recentEvents = useMemo(
    () => [...filteredEvents].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, RECENT_REQUEST_LIMIT),
    [filteredEvents]
  );
  const disableControls = connectionStatus !== 'connected';
  const failureRate = Math.max(0, 100 - summary.successRate);
  const topModel = modelDistribution[0]?.label ?? t('usage.empty_short', { defaultValue: '暂无数据' });
  const topProvider = providerDistribution[0]?.label ?? t('usage.empty_short', { defaultValue: '暂无数据' });

  const clearEvents = () => {
    showConfirmation({
      title: t('usage.clear_title', { defaultValue: '清空统计缓存' }),
      message: t('usage.clear_confirm', { defaultValue: '确定要清空当前浏览器保存的统计数据吗？' }),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: () => {
        setEvents([]);
        localStorage.removeItem(storageKey);
        showNotification(t('usage.clear_success', { defaultValue: '统计缓存已清空' }), 'success');
      },
    });
  };

  const downloadRequestLog = async (event: UsageEvent) => {
    if (!event.requestId) return;
    try {
      const response = await logsApi.downloadRequestLogById(event.requestId);
      downloadBlob({
        filename: `request-${event.requestId}.log`,
        blob: new Blob([response.data], { type: 'text/plain' }),
      });
      showNotification(t('logs.request_log_download_success'), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      <header className="flex flex-col gap-4 rounded-lg border bg-card p-6 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{t('nav.dashboard')}</span>
            <span>/</span>
            <span>{t('nav.usage_statistics', { defaultValue: '用量统计' })}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold leading-tight tracking-normal text-foreground">
              {t('usage.title', { defaultValue: '用量统计' })}
            </h1>
            <Badge variant={usageDisabled ? 'warning' : 'success'} className="rounded-full">
              {usageDisabled
                ? t('usage.capture_disabled', { defaultValue: '未启用' })
                : t('usage.capture_ready', { defaultValue: '已就绪' })}
            </Badge>
          </div>
          <div className="mt-4 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <Database className="size-4" />
              {t('usage.cached_events', { defaultValue: '本地事件' })}: {formatCompactNumber(events.length)}
            </div>
            <div className="flex items-center gap-2">
              <Activity className="size-4" />
              {t('usage.request_rate', { defaultValue: '请求速率' })}: {formatRate(summary.requests, range)}
            </div>
            <div className="flex items-center gap-2">
              <Server className="size-4" />
              {t('usage.providers', { defaultValue: 'Provider' })}: {topProvider}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center lg:justify-end">
          <Tabs value={range} onValueChange={(value) => setRange(value as UsageTimeRange)}>
            <TabsList className="grid grid-cols-5">
              {timeRangeOptions.map((option) => (
                <TabsTrigger key={option.value} value={option.value} className="px-3">
                  {t(option.labelKey, { defaultValue: option.fallback })}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <ToggleSwitch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              disabled={disableControls}
              label={
                <span className="inline-flex items-center gap-2 text-sm font-medium">
                  <Clock className="size-4" />
                  {t('usage.auto_refresh', { defaultValue: '自动刷新' })}
                </span>
              }
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => loadUsageQueue()}
              disabled={disableControls || loading}
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              {t('common.refresh')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={clearEvents}
              disabled={events.length === 0}
              aria-label={t('usage.clear_title', { defaultValue: '清空统计缓存' })}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={t('usage.total_requests', { defaultValue: '请求数' })}
          value={formatCompactNumber(summary.requests)}
          subtitle={`${formatCompactNumber(summary.successes)} ${t('common.success')} / ${formatCompactNumber(summary.failures)} ${t('common.failure')}`}
          badge={formatRate(summary.requests, range)}
          icon={<TrendingUp className="size-5" />}
        />
        <MetricCard
          title={t('usage.total_tokens', { defaultValue: 'Token 总量' })}
          value={formatCompactNumber(summary.tokens.totalTokens)}
          subtitle={`I ${formatCompactNumber(summary.tokens.inputTokens)} / O ${formatCompactNumber(summary.tokens.outputTokens)} / R ${formatCompactNumber(summary.tokens.reasoningTokens)}`}
          badge={`Cache ${formatCompactNumber(summary.tokens.cachedTokens + summary.tokens.cacheReadTokens)}`}
          icon={<Zap className="size-5" />}
          tone="success"
        />
        <MetricCard
          title={t('usage.success_rate', { defaultValue: '成功率' })}
          value={formatPercent(summary.successRate)}
          subtitle={t('usage.failure_count', {
            defaultValue: '{{count}} 次失败',
            count: formatCompactNumber(summary.failures),
          })}
          badge={`${formatPercent(failureRate)} fail`}
          icon={<CheckCircle2 className="size-5" />}
          tone={summary.failures > 0 ? 'warning' : 'success'}
        />
        <MetricCard
          title={t('usage.avg_latency', { defaultValue: '平均延迟' })}
          value={formatDuration(summary.avgLatencyMs)}
          subtitle={`TTFT ${formatDuration(summary.avgTtftMs)} / ${topModel}`}
          badge={latencyRanking[0] ? formatDuration(latencyRanking[0].maxLatencyMs) : '0ms'}
          icon={<Clock className="size-5" />}
        />
      </section>

      <Card className="rounded-lg">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{t('usage.token_curve', { defaultValue: 'Token 曲线' })}</CardTitle>
            <CardDescription>
              {t('usage.token_curve_subtitle', { defaultValue: 'Input / Output / Reasoning 聚合' })}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full bg-slate-900" />Total</span>
            <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full bg-blue-600" />Input</span>
            <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full bg-emerald-500" />Output</span>
            <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full bg-violet-500" />Reasoning</span>
          </div>
        </CardHeader>
        <CardContent>
          <TokenAreaChart data={tokenSeries} />
        </CardContent>
      </Card>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{t('usage.model_distribution', { defaultValue: '模型调用分布' })}</CardTitle>
            <CardDescription>Models ranked by request volume from the local usage queue.</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionBars groups={modelDistribution} emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })} />
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{t('usage.latency_ranking', { defaultValue: '延迟排行' })}</CardTitle>
            <CardDescription>Average latency grouped by provider and model.</CardDescription>
          </CardHeader>
          <CardContent>
            <LatencyList groups={latencyRanking} emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })} />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{t('usage.provider_distribution', { defaultValue: 'Provider 分布' })}</CardTitle>
            <CardDescription>Requests grouped by upstream provider.</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionBars groups={providerDistribution} emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })} />
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{t('usage.endpoint_distribution', { defaultValue: 'Endpoint 分布' })}</CardTitle>
            <CardDescription>Requests grouped by API endpoint.</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionBars groups={endpointDistribution} emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })} />
          </CardContent>
        </Card>
      </section>

      <Card className="rounded-lg">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{t('usage.recent_requests', { defaultValue: '最近请求' })}</CardTitle>
            <CardDescription>
              {lastLoadedAt
                ? t('usage.last_loaded', {
                    defaultValue: '最近 {{time}}',
                    time: formatTime(lastLoadedAt, i18n.language),
                  })
                : t('usage.not_loaded', { defaultValue: '尚未刷新' })}
            </CardDescription>
          </div>
          <Badge variant={failedEvents.length > 0 ? 'warning' : 'success'} className="w-fit rounded-full">
            {failedEvents.length > 0 ? (
              <span className="inline-flex items-center gap-1.5"><AlertTriangle className="size-3.5" />{failedEvents.length} failed</span>
            ) : (
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="size-3.5" />No failures</span>
            )}
          </Badge>
        </CardHeader>
        <CardContent>
          <RecentEventsTable
            events={recentEvents}
            locale={i18n.language}
            emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            onDownload={downloadRequestLog}
          />
        </CardContent>
      </Card>
    </div>
  );
}
