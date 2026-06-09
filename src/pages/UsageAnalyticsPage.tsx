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
import { Badge } from '@/components/shadcn/ui/badge';
import { Button } from '@/components/shadcn/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
  getUsageStorageKey,
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

const axisLabelClass =
  'pointer-events-none absolute text-[9px] font-normal leading-none text-muted-foreground/55 tabular-nums';

const getAxisTickIndexes = (length: number, maxTicks = 4) => {
  if (length <= 0) return [];
  if (length <= maxTicks) return Array.from({ length }, (_, index) => index);
  return Array.from(
    new Set(
      Array.from({ length: maxTicks }, (_, index) =>
        Math.round((index * (length - 1)) / (maxTicks - 1))
      )
    )
  );
};

const formatAxisTimeLabel = (timestampMs: number, spanMs: number) => {
  const date = new Date(timestampMs);
  if (spanMs <= 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
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

const emptyBars = [
  { label: 'Gemini', width: 78 },
  { label: 'Codex', width: 62 },
  { label: 'Claude', width: 46 },
  { label: 'OpenAI', width: 34 },
  { label: 'Other', width: 24 },
];

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
    <Card className="@container/card rounded-xl bg-gradient-to-t from-muted/50 to-card shadow-sm">
      <CardHeader className="relative pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums tracking-normal @[260px]/card:text-4xl">
          {value}
        </CardTitle>
        <div className="absolute right-4 top-4">
          <Badge
            variant={tone === 'danger' ? 'destructive' : tone === 'warning' ? 'warning' : 'outline'}
            className="rounded-full"
          >
            {badge}
          </Badge>
        </div>
      </CardHeader>
      <CardFooter className="flex-col items-start gap-1 text-sm">
        <div className="flex gap-2 font-medium leading-none">
          {subtitle}
          {icon}
        </div>
        <div className="text-muted-foreground">Token / latency / request health</div>
      </CardFooter>
    </Card>
  );
}

function TokenAreaChart({ data }: { data: TokenSeriesPoint[] }) {
  const chartData = data.map((point) => ({
    label: point.label,
    timestampMs: point.timestampMs,
    total: point.totalTokens,
    input: point.inputTokens,
    output: point.outputTokens,
    reasoning: point.reasoningTokens,
    requests: point.requests,
  }));

  if (!chartData.length || !chartData.some((point) => point.requests > 0)) {
    const width = 960;
    const height = 320;
    const padding = { top: 24, right: 24, bottom: 38, left: 58 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const bottom = padding.top + plotHeight;
    const xLabels = [
      { label: '-60m', x: padding.left },
      { label: '-30m', x: padding.left + plotWidth * 0.5 },
      { label: 'now', x: padding.left + plotWidth },
    ];
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio, index) => ({
      y: bottom - ratio * plotHeight,
      label: index === 0 ? '0' : `${index * 25}%`,
    }));
    const previewPoints = [
      [padding.left, bottom - plotHeight * 0.18],
      [padding.left + plotWidth * 0.16, bottom - plotHeight * 0.28],
      [padding.left + plotWidth * 0.3, bottom - plotHeight * 0.2],
      [padding.left + plotWidth * 0.46, bottom - plotHeight * 0.42],
      [padding.left + plotWidth * 0.62, bottom - plotHeight * 0.36],
      [padding.left + plotWidth * 0.78, bottom - plotHeight * 0.54],
      [padding.left + plotWidth, bottom - plotHeight * 0.44],
    ]
      .map(([x, y]) => `${x},${y}`)
      .join(' ');

    return (
      <div className="relative h-[360px] w-full overflow-hidden rounded-md border bg-background">
        <svg
          className="h-full w-full"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Token usage trend placeholder"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="tokenEmptyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#2563eb" stopOpacity={0.18} />
              <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <rect width={width} height={height} fill="var(--bg-primary)" />
          {yTicks.map((tick) => (
            <g key={tick.label}>
              <line
                x1={padding.left}
                x2={padding.left + plotWidth}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--border-color)"
                strokeDasharray="4 6"
              />
            </g>
          ))}
          <polygon
            points={`${padding.left},${bottom} ${previewPoints} ${padding.left + plotWidth},${bottom}`}
            fill="url(#tokenEmptyFill)"
          />
          <polyline
            points={previewPoints}
            fill="none"
            stroke="#2563eb"
            strokeWidth="3"
            strokeDasharray="10 8"
            strokeLinejoin="round"
            opacity="0.72"
          />
        </svg>
        {yTicks.map((tick) => (
          <span
            key={tick.label}
            className={axisLabelClass}
            style={{
              left: `${((padding.left - 12) / width) * 100}%`,
              top: `${(tick.y / height) * 100}%`,
              transform: 'translate(-100%, -50%)',
            }}
          >
            {tick.label}
          </span>
        ))}
        {xLabels.map((tick, index) => (
          <span
            key={tick.label}
            className={axisLabelClass}
            style={{
              left: `${(tick.x / width) * 100}%`,
              bottom: '8px',
              transform:
                index === 0
                  ? 'translateX(0)'
                  : index === xLabels.length - 1
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            {tick.label}
          </span>
        ))}
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex max-w-md items-center gap-4 rounded-md border bg-card/95 p-5 text-left shadow-sm">
            <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
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
      </div>
    );
  }

  const width = 960;
  const height = 320;
  const padding = { top: 24, right: 24, bottom: 38, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const bottom = padding.top + plotHeight;
  const maxValue = Math.max(...chartData.map((point) => point.total), 1);
  const xFor = (index: number) =>
    padding.left + (plotWidth * index) / Math.max(1, chartData.length - 1);
  const yFor = (value: number) => bottom - (Math.max(0, value) / maxValue) * plotHeight;
  const linePoints = (key: 'total' | 'input' | 'output' | 'reasoning') =>
    chartData.map((point, index) => `${xFor(index)},${yFor(point[key])}`).join(' ');
  const totalPoints = linePoints('total');
  const totalArea = `${padding.left},${bottom} ${totalPoints} ${padding.left + plotWidth},${bottom}`;
  const xTickIndexes = getAxisTickIndexes(chartData.length, 4);
  const spanMs =
    chartData.length > 1
      ? chartData[chartData.length - 1].timestampMs - chartData[0].timestampMs
      : 0;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: bottom - ratio * plotHeight,
    label: formatCompactNumber(maxValue * ratio),
  }));

  return (
    <div className="relative h-[360px] w-full overflow-hidden rounded-md border bg-background">
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Token usage trend"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="tokenTotalFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#0f172a" stopOpacity={0.22} />
            <stop offset="95%" stopColor="#0f172a" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <rect width={width} height={height} fill="var(--bg-primary)" />
        {yTicks.map((tick) => (
          <g key={tick.label}>
            <line
              x1={padding.left}
              x2={padding.left + plotWidth}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--border-color)"
              strokeDasharray="4 6"
            />
          </g>
        ))}
        <polygon points={totalArea} fill="url(#tokenTotalFill)" />
        <polyline points={totalPoints} fill="none" stroke="#0f172a" strokeWidth="3" strokeLinejoin="round" />
        <polyline points={linePoints('input')} fill="none" stroke="#2563eb" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={linePoints('output')} fill="none" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={linePoints('reasoning')} fill="none" stroke="#8b5cf6" strokeWidth="2" strokeLinejoin="round" />
        {chartData.map((point, index) => (
          <g key={`${point.label}-${index}`}>
            <circle cx={xFor(index)} cy={yFor(point.total)} r="3" fill="#0f172a">
              <title>
                {point.label}: {formatCompactNumber(point.total)} tokens / {formatCompactNumber(point.requests)} req
              </title>
            </circle>
          </g>
        ))}
      </svg>
      {yTicks.map((tick) => (
        <span
          key={tick.label}
          className={axisLabelClass}
          style={{
            left: `${((padding.left - 12) / width) * 100}%`,
            top: `${(tick.y / height) * 100}%`,
            transform: 'translate(-100%, -50%)',
          }}
        >
          {tick.label}
        </span>
      ))}
      {xTickIndexes.map((index) => {
        const point = chartData[index];
        return (
          <span
            key={`${point.timestampMs}-${index}`}
            className={axisLabelClass}
            style={{
              left: `${(xFor(index) / width) * 100}%`,
              bottom: '8px',
              transform:
                index === 0
                  ? 'translateX(0)'
                  : index === chartData.length - 1
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            {formatAxisTimeLabel(point.timestampMs, spanMs)}
          </span>
        );
      })}
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
  const rows = groups.map((group, index) => {
    const value =
      metric === 'tokens'
        ? group.totalTokens
        : metric === 'latency'
          ? Math.round(group.avgLatencyMs)
          : group.requests;
    return {
      group,
      value,
      color: chartPalette[index % chartPalette.length],
    };
  });
  const maxValue = Math.max(...rows.map((row) => row.value), 1);

  if (!rows.length) {
    return (
      <div className="space-y-3">
        {emptyBars.map((bar, index) => (
          <div key={bar.label} className="space-y-2" aria-hidden="true">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-sm opacity-50"
                  style={{ background: chartPalette[index % chartPalette.length] }}
                />
                <span className="truncate font-medium text-muted-foreground">{bar.label}</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">0</span>
            </div>
            <div className="h-9 rounded-md border bg-muted/35 p-1">
              <div
                className="h-full rounded-sm bg-muted-foreground/20"
                style={{ width: `${bar.width}%` }}
              />
            </div>
          </div>
        ))}
        <div className="rounded-md border border-dashed bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {emptyText}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map(({ group, value, color }) => (
        <div key={group.key} className="space-y-2">
          <div className="flex items-start justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} />
              <span className="truncate font-medium">{group.label}</span>
            </div>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {metric === 'latency' ? formatDuration(value) : formatCompactNumber(value)}
            </span>
          </div>
          <div className="h-9 rounded-md border bg-muted/35 p-1">
            <div
              className="flex h-full min-w-8 items-center justify-end rounded-sm px-2 text-[11px] font-medium text-white"
              style={{
                width: `${Math.max(8, (value / maxValue) * 100)}%`,
                background: color,
              }}
            >
              {formatCompactNumber(group.requests)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LatencyList({ groups, emptyText }: { groups: UsageGroup[]; emptyText: string }) {
  const maxLatency = Math.max(...groups.map((group) => group.avgLatencyMs), 1);

  if (!groups.length) {
    return (
      <div className="space-y-4">
        {emptyBars.slice(0, 4).map((bar) => (
          <div key={bar.label} className="space-y-2" aria-hidden="true">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="h-4 w-32 rounded bg-muted" />
                <div className="mt-2 h-3 w-24 rounded bg-muted/70" />
              </div>
              <Badge variant="outline" className="shrink-0 font-mono">
                0ms
              </Badge>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-muted-foreground/20" style={{ width: `${bar.width}%` }} />
            </div>
          </div>
        ))}
        <div className="rounded-md border border-dashed bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {emptyText}
        </div>
      </div>
    );
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
    return (
      <div className="overflow-hidden rounded-md border">
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
            {[0, 1, 2, 3, 4].map((index) => (
              <TableRow key={index} aria-hidden="true">
                <TableCell><div className="h-4 w-28 rounded bg-muted" /></TableCell>
                <TableCell><div className="h-6 w-14 rounded-full bg-muted" /></TableCell>
                <TableCell>
                  <div className="space-y-2">
                    <div className="h-4 w-36 rounded bg-muted" />
                    <div className="h-3 w-24 rounded bg-muted/70" />
                  </div>
                </TableCell>
                <TableCell><div className="h-4 w-32 rounded bg-muted" /></TableCell>
                <TableCell><div className="ml-auto h-4 w-14 rounded bg-muted" /></TableCell>
                <TableCell><div className="ml-auto h-4 w-16 rounded bg-muted" /></TableCell>
                <TableCell />
              </TableRow>
            ))}
            <TableRow>
              <TableCell colSpan={7} className="bg-muted/25 py-5 text-center text-sm text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border">
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
  const [storageHydrated, setStorageHydrated] = useState(false);
  const hydratedStorageKeyRef = useRef('');
  const requestInFlightRef = useRef(false);

  const storageKey = useMemo(() => getUsageStorageKey(apiBase), [apiBase]);
  const usageStatisticsEnabled = config?.raw?.['usage-statistics-enabled'];
  const usageDisabled = usageStatisticsEnabled === false;

  useEffect(() => {
    let cancelled = false;
    setStorageHydrated(false);
    window.queueMicrotask(() => {
      if (cancelled) return;
      setEvents(loadStoredUsageEvents(storageKey));
      setLastLoadedAt(null);
      setError('');
      hydratedStorageKeyRef.current = storageKey;
      setStorageHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!storageHydrated) return;
    if (hydratedStorageKeyRef.current !== storageKey) return;
    saveStoredUsageEvents(storageKey, events);
  }, [events, storageHydrated, storageKey]);

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
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant={usageDisabled ? 'warning' : 'success'} className="rounded-full">
          {usageDisabled
            ? t('usage.capture_disabled', { defaultValue: '未启用' })
            : t('usage.capture_ready', { defaultValue: '已就绪' })}
        </Badge>
        <span className="inline-flex items-center gap-1.5">
          <Database className="size-4" />
          {t('usage.cached_events', { defaultValue: '本地事件' })}: {formatCompactNumber(events.length)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Activity className="size-4" />
          {t('usage.request_rate', { defaultValue: '请求速率' })}: {formatRate(summary.requests, range)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Server className="size-4" />
          {t('usage.providers', { defaultValue: 'Provider' })}: {topProvider}
        </span>
      </div>

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

      <Card className="rounded-xl">
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
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={range} onValueChange={(value) => setRange(value as UsageTimeRange)}>
              <TabsList>
                {timeRangeOptions.slice(1).map((option) => (
                  <TabsTrigger key={option.value} value={option.value} className="px-3">
                    {t(option.labelKey, { defaultValue: option.fallback })}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
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
        </CardHeader>
        <CardContent>
          <TokenAreaChart data={tokenSeries} />
        </CardContent>
      </Card>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle>{t('usage.model_distribution', { defaultValue: '模型调用分布' })}</CardTitle>
            <CardDescription>按本地队列中的请求量聚合模型调用。</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionBars groups={modelDistribution} emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })} />
          </CardContent>
        </Card>

        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle>{t('usage.latency_ranking', { defaultValue: '延迟排行' })}</CardTitle>
            <CardDescription>按 Provider 与模型聚合平均延迟。</CardDescription>
          </CardHeader>
          <CardContent>
            <LatencyList groups={latencyRanking} emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })} />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle>{t('usage.provider_distribution', { defaultValue: 'Provider 分布' })}</CardTitle>
            <CardDescription>按上游 Provider 聚合请求。</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionBars groups={providerDistribution} emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })} />
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle>{t('usage.endpoint_distribution', { defaultValue: 'Endpoint 分布' })}</CardTitle>
            <CardDescription>按 API Endpoint 聚合请求。</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionBars groups={endpointDistribution} emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })} />
          </CardContent>
        </Card>
      </section>

      <Card className="rounded-xl">
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
