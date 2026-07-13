import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Clock,
  Database,
  DollarSign,
  Download,
  Filter,
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
import {
  getStoredKeeperBaseUrl,
  KEEPER_RANGE_OPTIONS,
  keeperApi,
  logsApi,
  setStoredKeeperBaseUrl,
  usageApi,
  type KeeperRange,
} from '@/services/api';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { downloadBlob } from '@/utils/download';
import {
  analysisToCostGroups,
  analysisToDistributions,
  analysisTokenUsageToSeries,
  emptyOverviewSummary,
  keeperEventsToUsageEvents,
  latencyFromDiagnostics,
  overviewSeriesToTokenSeries,
  overviewToSummary,
} from '@/utils/keeperAdapters';
import {
  exportUsageEventsJsonl,
  formatCompactNumber,
  formatDuration,
  formatUsd,
  type TokenSeriesPoint,
  type UsageEvent,
  type UsageGroup,
} from '@/utils/usageAnalytics';
import { cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 15_000;
const RECENT_REQUEST_LIMIT = 50;

type UsageViewMode = 'overview' | 'monitoring' | 'cost';

const chartPalette = ['#0f172a', '#2563eb', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444'];

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '';

const formatPercent = (value: number) =>
  `${Number.isFinite(value) ? value.toFixed(value >= 99.5 || value <= 0 ? 0 : 1) : '0'}%`;



// Match CardDescription style used by "Input / Output / Reasoning 聚合"
const axisLabelClass =
  'pointer-events-none absolute text-sm font-normal leading-none text-muted-foreground tabular-nums';

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
  const padding = { top: 28, right: 24, bottom: 44, left: 64 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const bottom = padding.top + plotHeight;
  const maxValue = Math.max(
    ...chartData.map((point) => Math.max(point.total, point.input, point.output, point.reasoning)),
    1
  );
  const xFor = (index: number) =>
    chartData.length <= 1
      ? padding.left + plotWidth * 0.5
      : padding.left + (plotWidth * index) / (chartData.length - 1);
  const yFor = (value: number) => bottom - (Math.max(0, value) / maxValue) * plotHeight;
  const linePoints = (key: 'total' | 'input' | 'output' | 'reasoning') => {
    if (chartData.length === 1) {
      // Short stub around the single point — never stretch across the full width.
      const x = xFor(0);
      const y = yFor(chartData[0][key]);
      const half = Math.min(36, plotWidth * 0.08);
      return `${x - half},${y} ${x + half},${y}`;
    }
    return chartData.map((point, index) => `${xFor(index)},${yFor(point[key])}`).join(' ');
  };
  const totalPoints = linePoints('total');
  const totalArea =
    chartData.length === 1
      ? (() => {
          const x = xFor(0);
          const y = yFor(chartData[0].total);
          const half = Math.min(36, plotWidth * 0.08);
          return `${x - half},${bottom} ${x - half},${y} ${x + half},${y} ${x + half},${bottom}`;
        })()
      : `${padding.left},${bottom} ${totalPoints} ${xFor(chartData.length - 1)},${bottom}`;
  const xTickIndexes = getAxisTickIndexes(chartData.length, 5);
  const spanMs =
    chartData.length > 1
      ? chartData[chartData.length - 1].timestampMs - chartData[0].timestampMs
      : 0;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: bottom - ratio * plotHeight,
    label: formatCompactNumber(maxValue * ratio),
  }));
  const hasInput = chartData.some((point) => point.input > 0);
  const hasOutput = chartData.some((point) => point.output > 0);
  const hasReasoning = chartData.some((point) => point.reasoning > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-[#0f172a]" />
          Total
        </span>
        {hasInput ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm bg-[#2563eb]" />
            Input
          </span>
        ) : null}
        {hasOutput ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm bg-[#10b981]" />
            Output
          </span>
        ) : null}
        {hasReasoning ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm bg-[#8b5cf6]" />
            Reasoning
          </span>
        ) : null}
      </div>
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
          <polyline
            points={totalPoints}
            fill="none"
            stroke="#0f172a"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          {hasInput ? (
            <polyline
              points={linePoints('input')}
              fill="none"
              stroke="#2563eb"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          ) : null}
          {hasOutput ? (
            <polyline
              points={linePoints('output')}
              fill="none"
              stroke="#10b981"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          ) : null}
          {hasReasoning ? (
            <polyline
              points={linePoints('reasoning')}
              fill="none"
              stroke="#8b5cf6"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          ) : null}
          {chartData.map((point, index) =>
            point.total > 0 || point.requests > 0 ? (
              <g key={`${point.label}-${index}`}>
                <circle cx={xFor(index)} cy={yFor(point.total)} r="3.5" fill="#0f172a">
                  <title>
                    {point.label}: {formatCompactNumber(point.total)} tokens /{' '}
                    {formatCompactNumber(point.requests)} req
                  </title>
                </circle>
              </g>
            ) : null
          )}
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
                bottom: '10px',
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

function RecentEventsTable({
  events,
  locale,
  emptyText,
  onDownload,
  showCost = false,
  showFailBody = false,
}: {
  events: UsageEvent[];
  locale: string;
  emptyText: string;
  onDownload: (event: UsageEvent) => void;
  showCost?: boolean;
  showFailBody?: boolean;
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
            <TableHead>API Key</TableHead>
            <TableHead>Endpoint</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            {showCost ? <TableHead className="text-right">Cost</TableHead> : null}
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
                  {showFailBody && event.failed && event.failBody ? (
                    <div className="mt-1 max-w-[220px] truncate text-[11px] text-destructive/80">
                      {event.failBody}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <div className="max-w-[260px]">
                    <div className="truncate font-medium">{event.provider}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {event.alias || event.model}
                    </div>
                    {event.authIndex ? (
                      <div className="truncate text-[11px] text-muted-foreground/80">
                        {event.authIndex}
                      </div>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="block max-w-[120px] truncate font-mono text-xs text-muted-foreground">
                    {event.apiKey || '-'}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="block max-w-[180px] truncate font-mono text-xs text-muted-foreground">
                    {event.endpoint}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatCompactNumber(event.tokens.totalTokens)}
                </TableCell>
                {showCost ? (
                  <TableCell className="text-right font-mono">
                    {event.costAvailable ? formatUsd(event.costUsd ?? 0) : '—'}
                  </TableCell>
                ) : null}
                <TableCell className="text-right font-mono">
                  {formatDuration(event.latencyMs)}
                </TableCell>
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
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const config = useConfigStore((state) => state.config);
  // Keeper-native ranges only
  const [range, setRange] = useLocalStorage<KeeperRange>('usageAnalytics.keeperRange', '24h');
  const [autoRefresh, setAutoRefresh] = useLocalStorage('usageAnalytics.autoRefresh', true);
  const [viewMode, setViewMode] = useLocalStorage<UsageViewMode>('usageAnalytics.view', 'overview');
  const [monitorStatus, setMonitorStatus] = useLocalStorage<'all' | 'success' | 'failed'>(
    'usageAnalytics.monitorStatus',
    'all'
  );
  const [keeperBaseInput, setKeeperBaseInput] = useState(() => getStoredKeeperBaseUrl());
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [overviewSummary, setOverviewSummary] = useState(emptyOverviewSummary);
  const [tokenSeries, setTokenSeries] = useState<TokenSeriesPoint[]>([]);
  const [seriesGranularity, setSeriesGranularity] = useState('hourly');
  const [modelDistribution, setModelDistribution] = useState<UsageGroup[]>([]);
  const [providerDistribution, setProviderDistribution] = useState<UsageGroup[]>([]);
  const [apiKeyDistribution, setApiKeyDistribution] = useState<UsageGroup[]>([]);
  const [costByModel, setCostByModel] = useState<
    Array<{ label: string; requests: number; totalTokens: number; cost: number; failures: number }>
  >([]);
  const [costByProvider, setCostByProvider] = useState<
    Array<{ label: string; requests: number; totalTokens: number; cost: number; failures: number }>
  >([]);
  const [costByApiKey, setCostByApiKey] = useState<
    Array<{ label: string; requests: number; totalTokens: number; cost: number; failures: number }>
  >([]);
  const [costByAccount, setCostByAccount] = useState<
    Array<{ label: string; requests: number; totalTokens: number; cost: number; failures: number }>
  >([]);
  const [latencyDiag, setLatencyDiag] = useState({
    p95LatencyMs: 0,
    p95TtftMs: 0,
    maxLatencyMs: 0,
    maxTtftMs: 0,
    totalPoints: 0,
  });
  const [keeperOnline, setKeeperOnline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const requestInFlightRef = useRef(false);

  const usageStatisticsEnabled = config?.raw?.['usage-statistics-enabled'];
  const usageDisabled = usageStatisticsEnabled === false;

  /**
   * Keeper-native loads (no client re-aggregation):
   * overview  → overview + analysis（analysis 提供 latency_diagnostics P95）
   * cost      → analysis
   * monitoring → events
   */
  const loadKeeperData = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    if (requestInFlightRef.current) return;

    requestInFlightRef.current = true;
    setLoading(true);
    try {
      if (viewMode === 'overview') {
        // overview 本身没有延迟字段；P95 在 analysis.latency_diagnostics
        const [overviewResult, analysisResult] = await Promise.allSettled([
          usageApi.getKeeperOverview(range),
          usageApi.getKeeperAnalysis(range),
        ]);

        if (overviewResult.status !== 'fulfilled') {
          throw overviewResult.reason;
        }

        const overview = overviewResult.value;
        setKeeperOnline(true);
        let summary = overviewToSummary(overview);
        setTokenSeries(overviewSeriesToTokenSeries(overview));
        setSeriesGranularity(range === '7d' || range === '30d' ? 'daily' : 'hourly');

        if (analysisResult.status === 'fulfilled') {
          const analysis = analysisResult.value;
          const latency = latencyFromDiagnostics(analysis);
          setLatencyDiag(latency);
          summary = {
            ...summary,
            p95LatencyMs: latency.p95LatencyMs,
            maxLatencyMs: latency.maxLatencyMs,
          };
          // analysis.token_usage 带 Input/Output/Reasoning，优先用于曲线
          const analysisSeries = analysisTokenUsageToSeries(analysis);
          if (analysisSeries.some((point) => point.totalTokens > 0 || point.requests > 0)) {
            setTokenSeries(analysisSeries);
            setSeriesGranularity(analysis.granularity || 'hourly');
          }
        }

        setOverviewSummary(summary);
      } else if (viewMode === 'cost') {
        const analysis = await usageApi.getKeeperAnalysis(range);
        setKeeperOnline(true);
        const distributions = analysisToDistributions(analysis);
        setModelDistribution(distributions.models);
        setProviderDistribution(distributions.providers);
        setApiKeyDistribution(distributions.apiKeys);
        setSeriesGranularity(distributions.granularity);
        setTokenSeries(analysisTokenUsageToSeries(analysis));
        const costs = analysisToCostGroups(analysis);
        setCostByModel(costs.byModel);
        setCostByProvider(costs.byProvider);
        setCostByApiKey(costs.byApiKey);
        setCostByAccount(costs.byAccount);
        const latency = latencyFromDiagnostics(analysis);
        setLatencyDiag(latency);
        const totalCost = costs.byModel.reduce((s, m) => s + m.cost, 0);
        const totalReq = costs.byModel.reduce((s, m) => s + m.requests, 0);
        const totalTok = costs.byModel.reduce((s, m) => s + m.totalTokens, 0);
        setOverviewSummary((prev) => ({
          ...prev,
          requests: totalReq || prev.requests,
          tokens: { ...prev.tokens, totalTokens: totalTok || prev.tokens.totalTokens },
          totalCost: totalCost || prev.totalCost,
          costAvailable: costs.byModel.some((m) => m.cost > 0) || prev.costAvailable,
          p95LatencyMs: latency.p95LatencyMs,
          maxLatencyMs: latency.maxLatencyMs,
          granularityHint: distributions.granularity,
        }));
      } else {
        const failedFilter =
          monitorStatus === 'failed' ? true : monitorStatus === 'success' ? false : undefined;
        const eventsRes = await usageApi.getKeeperEvents({
          range,
          page: 1,
          page_size: 50,
          failed: failedFilter,
        });
        setKeeperOnline(true);
        setEvents(keeperEventsToUsageEvents(eventsRes.events));
        setEventsTotal(eventsRes.total_count ?? eventsRes.events?.length ?? 0);
      }

      setLastLoadedAt(Date.now());
      setError('');
    } catch (err: unknown) {
      setKeeperOnline(false);
      setError(
        getErrorMessage(err) ||
          t('usage.load_failed', { defaultValue: '加载统计数据失败（Keeper）' })
      );
    } finally {
      setLoading(false);
      requestInFlightRef.current = false;
    }
  }, [connectionStatus, monitorStatus, range, t, viewMode]);

  useHeaderRefresh(() => loadKeeperData());

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    const id = window.setTimeout(() => {
      void loadKeeperData();
    }, 0);
    return () => window.clearTimeout(id);
  }, [connectionStatus, loadKeeperData]);

  useInterval(
    () => {
      void loadKeeperData();
    },
    autoRefresh && connectionStatus === 'connected' ? POLL_INTERVAL_MS : null
  );

  const filteredEvents = events;
  const summary = overviewSummary;
  const costSummary = {
    totalCost: overviewSummary.totalCost,
    pricedRequests: overviewSummary.costAvailable ? overviewSummary.requests : 0,
    unpricedRequests: overviewSummary.costAvailable ? 0 : overviewSummary.requests,
  };
  const recentEvents = useMemo(
    () =>
      [...filteredEvents].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, RECENT_REQUEST_LIMIT),
    [filteredEvents]
  );
  const disableControls = connectionStatus !== 'connected';
  const failureRate = Math.max(0, 100 - summary.successRate);
  const topProvider =
    providerDistribution[0]?.label ?? t('usage.empty_short', { defaultValue: '暂无数据' });

  const applyKeeperBase = () => {
    const next = keeperBaseInput.trim().replace(/\/+$/, '');
    if (!next) return;
    setStoredKeeperBaseUrl(next);
    keeperApi.setBaseUrl(next);
    showNotification(
      t('usage.keeper_base_saved', { defaultValue: 'Keeper 地址已保存' }),
      'success'
    );
    void loadKeeperData();
  };

  const clearEvents = () => {
    setEvents([]);
    setEventsTotal(0);
    showNotification(
      t('usage.clear_local_only', {
        defaultValue: '已清空当前列表（Keeper SQLite 不受影响）',
      }),
      'success'
    );
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

  const exportJsonl = () => {
    const payload = exportUsageEventsJsonl(filteredEvents);
    if (!payload) {
      showNotification(t('usage.empty_short', { defaultValue: '暂无数据' }), 'warning');
      return;
    }
    downloadBlob({
      filename: `usage-events-${range}.jsonl`,
      blob: new Blob([payload], { type: 'application/x-ndjson' }),
    });
    showNotification(t('usage.export_success', { defaultValue: '已导出 JSONL' }), 'success');
  };

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge
            variant={usageDisabled ? 'warning' : keeperOnline ? 'success' : 'warning'}
            className="rounded-full"
          >
            {usageDisabled
              ? t('usage.capture_disabled', { defaultValue: 'CPA 统计关闭' })
              : keeperOnline
                ? t('usage.keeper_online', { defaultValue: 'Keeper 已连接' })
                : t('usage.keeper_offline_short', { defaultValue: 'Keeper 离线' })}
          </Badge>
          <span className="inline-flex items-center gap-1.5">
            <Database className="size-4" />
            {t('usage.events_loaded', { defaultValue: '事件' })}:{' '}
            {formatCompactNumber(events.length)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Activity className="size-4" />
            RPM: {summary.rpm ? summary.rpm.toFixed(2) : '0'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Server className="size-4" />
            {t('usage.providers', { defaultValue: 'Provider' })}: {topProvider}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <DollarSign className="size-4" />
            {t('usage.est_cost', { defaultValue: '估算成本' })}: {formatUsd(costSummary.totalCost)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as UsageViewMode)}>
            <TabsList>
              <TabsTrigger value="overview" className="px-3">
                {t('usage.view_overview', { defaultValue: '总览' })}
              </TabsTrigger>
              <TabsTrigger value="monitoring" className="px-3">
                {t('usage.view_monitoring', { defaultValue: '监控' })}
              </TabsTrigger>
              <TabsTrigger value="cost" className="px-3">
                {t('usage.view_cost', { defaultValue: '成本' })}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button type="button" variant="outline" size="sm" onClick={exportJsonl} disabled={!filteredEvents.length}>
            <Download className="size-4" />
            {t('usage.export_jsonl', { defaultValue: '导出 JSONL' })}
          </Button>
        </div>
      </div>

      <Card className="rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t('usage.keeper_settings', { defaultValue: 'Keeper 数据源' })}
          </CardTitle>
          <CardDescription>
            {t('usage.keeper_settings_desc', {
              defaultValue: '用量数据由 CPA Usage Keeper 持久化；本页仅调用其 API，UI 仍为本主题。',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <input
            className="h-9 min-w-[280px] flex-1 rounded-md border border-border bg-background px-3 text-sm"
            value={keeperBaseInput}
            onChange={(e) => setKeeperBaseInput(e.target.value)}
            placeholder="http://host:8317/keeper"
          />
          <Button type="button" variant="outline" size="sm" onClick={applyKeeperBase}>
            {t('common.save', { defaultValue: '保存' })}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadKeeperData()}
            disabled={disableControls || loading}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            {t('common.refresh')}
          </Button>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          title={t('usage.total_requests', { defaultValue: '请求数' })}
          value={formatCompactNumber(summary.requests)}
          subtitle={`${formatCompactNumber(summary.successes)} ${t('common.success')} / ${formatCompactNumber(summary.failures)} ${t('common.failure')}`}
          badge={summary.rpm ? `${summary.rpm.toFixed(2)} RPM` : 'RPM'}
          icon={<TrendingUp className="size-5" />}
        />
        <MetricCard
          title={t('usage.total_tokens', { defaultValue: 'Token 总量' })}
          value={formatCompactNumber(summary.tokens.totalTokens)}
          subtitle={`I ${formatCompactNumber(summary.tokens.inputTokens)} / R ${formatCompactNumber(summary.tokens.reasoningTokens)} / Cache ${formatCompactNumber(summary.tokens.cacheReadTokens)}`}
          badge={summary.tpm ? `${formatCompactNumber(summary.tpm)} TPM` : 'TPM'}
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
          title={t('usage.latency_p95', { defaultValue: '延迟 P95' })}
          value={
            latencyDiag.p95LatencyMs > 0 || summary.p95LatencyMs > 0
              ? formatDuration(latencyDiag.p95LatencyMs || summary.p95LatencyMs)
              : '—'
          }
          subtitle={
            latencyDiag.p95TtftMs > 0
              ? `TTFT P95 ${formatDuration(latencyDiag.p95TtftMs)}`
              : latencyDiag.totalPoints > 0
                ? `${latencyDiag.totalPoints} samples`
                : t('usage.latency_from_analysis', {
                    defaultValue: 'analysis.latency_diagnostics',
                  })
          }
          badge={
            latencyDiag.maxLatencyMs > 0
              ? `max ${formatDuration(latencyDiag.maxLatencyMs)}`
              : seriesGranularity
          }
          icon={<Clock className="size-5" />}
        />
        <MetricCard
          title={t('usage.est_cost', { defaultValue: '估算成本' })}
          value={formatUsd(costSummary.totalCost)}
          subtitle={
            summary.costAvailable
              ? t('usage.cost_available', { defaultValue: '已按价格表估算' })
              : t('usage.cost_unavailable', { defaultValue: '未配置模型价格' })
          }
          badge={summary.windowMinutes ? `${summary.windowMinutes}m` : 'cost'}
          icon={<DollarSign className="size-5" />}
          tone="success"
        />
      </section>

      <Card className="rounded-xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>
              {viewMode === 'monitoring'
                ? t('usage.view_monitoring', { defaultValue: '请求事件' })
                : viewMode === 'cost'
                  ? t('usage.view_cost', { defaultValue: '分析 / 成本' })
                  : t('usage.token_curve', { defaultValue: 'Token 曲线' })}
            </CardTitle>
            <CardDescription>
              {viewMode === 'monitoring'
                ? t('usage.monitoring_subtitle', {
                    defaultValue: 'Keeper /usage/events · 请求级明细',
                  })
                : viewMode === 'cost'
                  ? t('usage.cost_subtitle', {
                      defaultValue: 'Input / Output / Reasoning 聚合',
                    })
                  : t('usage.token_curve_subtitle', {
                      defaultValue: 'Input / Output / Reasoning 聚合',
                    })}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={range} onValueChange={(value) => setRange(value as KeeperRange)}>
              <TabsList>
                {KEEPER_RANGE_OPTIONS.map((option) => (
                  <TabsTrigger key={option.value} value={option.value} className="px-3">
                    {option.label}
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
              onClick={() => void loadKeeperData()}
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
        {viewMode !== 'monitoring' ? (
          <CardContent>
            <TokenAreaChart data={tokenSeries} />
          </CardContent>
        ) : null}
      </Card>

      {viewMode === 'monitoring' ? (
        <Card className="rounded-xl">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Filter className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">
                {t('usage.filters', { defaultValue: '结果筛选' })} · {eventsTotal} total
              </CardTitle>
            </div>
            <Tabs
              value={monitorStatus}
              onValueChange={(value) => setMonitorStatus(value as 'all' | 'success' | 'failed')}
            >
              <TabsList>
                <TabsTrigger value="all" className="px-3">
                  {t('usage.filter_all', { defaultValue: '全部' })}
                </TabsTrigger>
                <TabsTrigger value="success" className="px-3">
                  {t('usage.filter_success', { defaultValue: '成功' })}
                </TabsTrigger>
                <TabsTrigger value="failed" className="px-3">
                  {t('usage.filter_failed', { defaultValue: '失败' })}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <RecentEventsTable
              events={recentEvents}
              locale={i18n.language}
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
              onDownload={downloadRequestLog}
              showCost
              showFailBody
            />
          </CardContent>
        </Card>
      ) : null}

      {viewMode === 'overview' ? (
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle>{t('usage.overview_meta', { defaultValue: '窗口信息' })}</CardTitle>
            <CardDescription>
              {lastLoadedAt
                ? t('usage.last_loaded', {
                    defaultValue: '最近 {{time}}',
                    time: formatTime(lastLoadedAt, i18n.language),
                  })
                : t('usage.not_loaded', { defaultValue: '尚未刷新' })}
              {' · '}
              series buckets: {tokenSeries.length}
              {' · '}
              window: {summary.windowMinutes || '—'} min
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {t('usage.overview_note', {
              defaultValue:
                '总览：/usage/overview（汇总）+ /usage/analysis（P95 延迟与 Token 拆分）。模型成本构成见「成本」页；请求明细见「监控」页。',
            })}
          </CardContent>
        </Card>
      ) : null}

      {viewMode === 'cost' ? (
        <>
          <section className="grid gap-4 lg:grid-cols-2">
            <Card className="rounded-xl">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>{t('usage.cost_by_model', { defaultValue: '模型成本排行' })}</CardTitle>
                  <CardDescription>
                    {t('usage.cost_by_model_desc', {
                      defaultValue: `model_composition · ${seriesGranularity}`,
                    })}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <CostRankTable
                  groups={costByModel}
                  emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
                />
              </CardContent>
            </Card>
            <Card className="rounded-xl">
              <CardHeader>
                <CardTitle>
                  {t('usage.cost_by_provider', { defaultValue: 'AI Provider' })}
                </CardTitle>
                <CardDescription>ai_provider_composition</CardDescription>
              </CardHeader>
              <CardContent>
                <CostRankTable
                  groups={costByProvider}
                  emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
                />
              </CardContent>
            </Card>
            <Card className="rounded-xl">
              <CardHeader>
                <CardTitle>{t('usage.cost_by_key', { defaultValue: 'API Key' })}</CardTitle>
                <CardDescription>api_key_composition</CardDescription>
              </CardHeader>
              <CardContent>
                <CostRankTable
                  groups={costByApiKey}
                  emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
                />
              </CardContent>
            </Card>
            <Card className="rounded-xl">
              <CardHeader>
                <CardTitle>
                  {t('usage.cost_by_account', { defaultValue: 'Auth Files' })}
                </CardTitle>
                <CardDescription>auth_files_composition</CardDescription>
              </CardHeader>
              <CardContent>
                <CostRankTable
                  groups={costByAccount}
                  emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
                />
              </CardContent>
            </Card>
          </section>
          <Card className="rounded-xl">
            <CardHeader>
              <CardTitle>
                {t('usage.latency_diagnostics', { defaultValue: '延迟诊断' })}
              </CardTitle>
              <CardDescription>
                P95 latency {formatDuration(latencyDiag.p95LatencyMs)} · P95 TTFT{' '}
                {formatDuration(latencyDiag.p95TtftMs)} · max{' '}
                {formatDuration(latencyDiag.maxLatencyMs)} · points {latencyDiag.totalPoints}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <DistributionBars
                groups={modelDistribution}
                emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
              />
              <DistributionBars
                groups={apiKeyDistribution}
                emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
              />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function CostRankTable({
  groups,
  emptyText,
}: {
  groups: Array<{
    label: string;
    requests: number;
    totalTokens: number;
    cost: number;
    failures: number;
  }>;
  emptyText: string;
}) {
  if (!groups.length) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{emptyText}</div>;
  }
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Fail</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => (
            <TableRow key={group.label}>
              <TableCell className="max-w-[220px] truncate font-medium">{group.label}</TableCell>
              <TableCell className="text-right font-mono">
                {formatCompactNumber(group.requests)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatCompactNumber(group.totalTokens)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatCompactNumber(group.failures)}
              </TableCell>
              <TableCell className="text-right font-mono">{formatUsd(group.cost)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
