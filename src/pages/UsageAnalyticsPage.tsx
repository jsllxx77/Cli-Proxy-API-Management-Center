import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconAlertTriangle,
  IconChartLine,
  IconCheckCircle2,
  IconDownload,
  IconInfo,
  IconNetwork,
  IconRefreshCw,
  IconSlidersHorizontal,
  IconTimer,
  IconTrash2,
  IconTrendingUp,
} from '@/components/ui/icons';
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
import styles from './UsageAnalyticsPage.module.scss';

const POLL_INTERVAL_MS = 5000;
const USAGE_QUEUE_COUNT = 300;
const RECENT_REQUEST_LIMIT = 10;

const timeRangeOptions: Array<{ value: UsageTimeRange; labelKey: string; fallback: string }> = [
  { value: '15m', labelKey: 'usage.range_15m', fallback: '15 分钟' },
  { value: '1h', labelKey: 'usage.range_1h', fallback: '1 小时' },
  { value: '6h', labelKey: 'usage.range_6h', fallback: '6 小时' },
  { value: '24h', labelKey: 'usage.range_24h', fallback: '24 小时' },
  { value: 'all', labelKey: 'usage.range_all', fallback: '全部' },
];

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

const getStatusLabel = (event: UsageEvent) =>
  event.failed ? `HTTP ${event.failStatusCode || 500}` : 'OK';

function MetricTile({
  label,
  value,
  detail,
  icon,
  meta,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  icon: React.ReactNode;
  meta?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = tone === 'neutral' ? '' : styles[`tone${tone}`];
  return (
    <div className={[styles.metricTile, toneClass].filter(Boolean).join(' ')}>
      <div className={styles.metricIcon}>{icon}</div>
      <div className={styles.metricText}>
        <span className={styles.metricLabel}>{label}</span>
        <strong className={styles.metricValue}>{value}</strong>
        {detail && <span className={styles.metricDetail}>{detail}</span>}
      </div>
      {meta && <span className={styles.metricMeta}>{meta}</span>}
    </div>
  );
}

function TokenLineChart({ data }: { data: TokenSeriesPoint[] }) {
  const width = 720;
  const height = 240;
  const padding = { top: 20, right: 18, bottom: 34, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxTokens = Math.max(...data.map((point) => point.totalTokens), 1);
  const xStep = data.length > 1 ? plotWidth / (data.length - 1) : plotWidth;
  const getPointValue = (point: TokenSeriesPoint, key: keyof TokenSeriesPoint) =>
    typeof point[key] === 'number' ? point[key] : 0;
  const points = data.map((point, index) => {
    const x = padding.left + index * xStep;
    const y = padding.top + plotHeight - (point.totalTokens / maxTokens) * plotHeight;
    return { ...point, x, y };
  });
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
  const seriesPath = (key: 'inputTokens' | 'outputTokens' | 'reasoningTokens') =>
    points
      .map((point, index) => {
        const value = getPointValue(point, key);
        const y = padding.top + plotHeight - (value / maxTokens) * plotHeight;
        return `${index === 0 ? 'M' : 'L'}${point.x},${y}`;
      })
      .join(' ');
  const areaPath =
    points.length > 0
      ? `${linePath} L${points[points.length - 1].x},${padding.top + plotHeight} L${points[0].x},${padding.top + plotHeight} Z`
      : '';
  const labelIndexes = Array.from(
    new Set([0, Math.floor((data.length - 1) / 2), Math.max(data.length - 1, 0)])
  ).filter((index) => index >= 0 && index < data.length);

  return (
    <svg className={styles.tokenChart} viewBox={`0 0 ${width} ${height}`} role="img">
      <title>Token curve</title>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const y = padding.top + plotHeight - ratio * plotHeight;
        return (
          <g key={ratio}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
              className={styles.chartGridLine}
            />
            <text x={padding.left - 10} y={y + 4} className={styles.chartAxisLabel}>
              {formatCompactNumber(maxTokens * ratio)}
            </text>
          </g>
        );
      })}
      {areaPath && <path d={areaPath} className={styles.chartArea} />}
      <path d={seriesPath('inputTokens')} className={`${styles.chartLineThin} ${styles.chartLineInput}`} />
      <path d={seriesPath('outputTokens')} className={`${styles.chartLineThin} ${styles.chartLineOutput}`} />
      <path d={seriesPath('reasoningTokens')} className={`${styles.chartLineThin} ${styles.chartLineReasoning}`} />
      {linePath && <path d={linePath} className={styles.chartLine} />}
      {points.map((point) =>
        point.requests > 0 ? (
          <circle key={point.timestampMs} cx={point.x} cy={point.y} r="3.5" className={styles.chartPoint}>
            <title>
              {point.label}: {formatCompactNumber(point.totalTokens)}
            </title>
          </circle>
        ) : null
      )}
      {labelIndexes.map((index) => (
        <text
          key={data[index].timestampMs}
          x={padding.left + index * xStep}
          y={height - 10}
          className={styles.chartBottomLabel}
          textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}
        >
          {data[index].label}
        </text>
      ))}
    </svg>
  );
}

function ChartEmptySkeleton({ title, description }: { title: string; description: string }) {
  return (
    <div className={styles.chartEmpty}>
      <div className={styles.chartEmptyGrid} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className={styles.chartEmptyContent}>
        <IconChartLine size={22} />
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
    </div>
  );
}

function DataChip({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div className={`${styles.dataChip} ${styles[`chip${tone}`]}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TokenBreakdownCard({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: 'input' | 'output' | 'reasoning' | 'cache';
}) {
  const percent = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className={styles.tokenBreakdownCard}>
      <div className={styles.tokenBreakdownTop}>
        <span className={`${styles.tokenDot} ${styles[`tokenDot${tone}`]}`} />
        <span>{label}</span>
      </div>
      <strong>{formatCompactNumber(value)}</strong>
      <div className={styles.tokenBreakdownTrack} aria-hidden="true">
        <span className={styles[`tokenFill${tone}`]} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function RankingList({
  title,
  groups,
  metric,
  emptyText,
  caption,
}: {
  title: string;
  groups: UsageGroup[];
  metric: 'latency' | 'tokens' | 'requests';
  emptyText: string;
  caption?: string;
}) {
  const maxValue = Math.max(
    ...groups.map((group) =>
      metric === 'latency'
        ? group.avgLatencyMs
        : metric === 'tokens'
          ? group.totalTokens
          : group.requests
    ),
    1
  );

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2>{title}</h2>
          {caption && <span>{caption}</span>}
        </div>
      </div>
      {groups.length === 0 ? (
        <div className={styles.mutedState}>{emptyText}</div>
      ) : (
        <div className={styles.rankingList}>
          {groups.map((group) => {
            const value =
              metric === 'latency'
                ? group.avgLatencyMs
                : metric === 'tokens'
                  ? group.totalTokens
                  : group.requests;
            return (
              <div key={group.key} className={styles.rankRow}>
                <div className={styles.rankMeta}>
                  <span className={styles.rankLabel} title={group.label}>
                    {group.label}
                  </span>
                  <span className={styles.rankSub}>
                    {formatCompactNumber(group.requests)} req · {formatCompactNumber(group.totalTokens)} tok
                  </span>
                </div>
                <div className={styles.rankMeasure}>
                  <span>
                    {metric === 'latency'
                      ? formatDuration(value)
                      : metric === 'tokens'
                        ? formatCompactNumber(value)
                        : formatCompactNumber(value)}
                  </span>
                  <div className={styles.rankTrack} aria-hidden="true">
                    <div
                      className={styles.rankFill}
                      style={{ width: `${Math.max(4, (value / maxValue) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DistributionPanel({
  title,
  caption,
  groups,
  emptyText,
}: {
  title: string;
  caption: string;
  groups: UsageGroup[];
  emptyText: string;
}) {
  const total = groups.reduce((sum, group) => sum + group.requests, 0);
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2>{title}</h2>
          <span>{caption}</span>
        </div>
      </div>
      {groups.length === 0 ? (
        <div className={styles.mutedState}>{emptyText}</div>
      ) : (
        <div className={styles.distributionList}>
          {groups.map((group, index) => {
            const percent = total > 0 ? (group.requests / total) * 100 : 0;
            return (
              <div className={styles.distributionRow} key={group.key}>
                <div className={styles.distributionMeta}>
                  <span className={`${styles.distributionSwatch} ${styles[`swatch${index % 6}`]}`} />
                  <span title={group.label}>{group.label}</span>
                </div>
                <div className={styles.distributionMeasure}>
                  <strong>{formatCompactNumber(group.requests)}</strong>
                  <span>{formatPercent(percent)}</span>
                </div>
                <div className={styles.distributionTrack} aria-hidden="true">
                  <span style={{ width: `${Math.max(3, percent)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RecentRequestsTable({
  events,
  locale,
  emptyText,
}: {
  events: UsageEvent[];
  locale: string;
  emptyText: string;
}) {
  if (events.length === 0) {
    return <div className={styles.mutedState}>{emptyText}</div>;
  }

  return (
    <div className={styles.compactTableWrap}>
      <table className={styles.compactTable}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Status</th>
            <th>Provider / Model</th>
            <th>Endpoint</th>
            <th>Tokens</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{formatTime(event.timestampMs, locale)}</td>
              <td>
                <span className={`${styles.eventStatus} ${event.failed ? styles.eventFailed : styles.eventOk}`}>
                  {getStatusLabel(event)}
                </span>
              </td>
              <td>
                <div className={styles.tableMainCell}>
                  <strong>{event.provider}</strong>
                  <span>{event.alias || event.model}</span>
                </div>
              </td>
              <td>
                <span className={styles.requestId} title={event.endpoint}>
                  {event.endpoint}
                </span>
              </td>
              <td>{formatCompactNumber(event.tokens.totalTokens)}</td>
              <td>{formatDuration(event.latencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
    () => groupUsageEvents(filteredEvents, (event) => event.alias || event.model, 10),
    [filteredEvents]
  );
  const providerDistribution = useMemo(
    () => groupUsageEvents(filteredEvents, (event) => event.provider, 8),
    [filteredEvents]
  );
  const endpointDistribution = useMemo(
    () => groupUsageEvents(filteredEvents, (event) => event.endpoint, 8),
    [filteredEvents]
  );
  const executorDistribution = useMemo(
    () => groupUsageEvents(filteredEvents, (event) => event.executorType, 6),
    [filteredEvents]
  );
  const authDistribution = useMemo(
    () => groupUsageEvents(filteredEvents, (event) => event.authType, 6),
    [filteredEvents]
  );
  const failedEvents = useMemo(() => getFailedUsageEvents(filteredEvents), [filteredEvents]);
  const recentEvents = useMemo(
    () => [...filteredEvents].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, RECENT_REQUEST_LIMIT),
    [filteredEvents]
  );
  const disableControls = connectionStatus !== 'connected';
  const busiestModel = modelDistribution[0]?.label ?? t('usage.empty_short', { defaultValue: '暂无数据' });
  const slowestRoute = latencyRanking[0]?.label ?? t('usage.empty_short', { defaultValue: '暂无数据' });
  const failureTone = summary.failures > 0 ? 'warning' : 'success';

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
    <div className={styles.usagePage}>
      <section className={styles.pageInset}>
        <header className={styles.header}>
          <div>
            <div className={styles.breadcrumb}>
              <span>{t('nav.dashboard')}</span>
              <span>/</span>
              <span>{t('nav.usage_statistics', { defaultValue: '用量统计' })}</span>
            </div>
            <h1>{t('usage.title', { defaultValue: '用量统计' })}</h1>
            <div className={styles.headerMeta}>
              <DataChip
                label={t('usage.capture_status', { defaultValue: '采集状态' })}
                value={
                  usageDisabled
                    ? t('usage.capture_disabled', { defaultValue: '未启用' })
                    : t('usage.capture_ready', { defaultValue: '已就绪' })
                }
                tone={usageDisabled ? 'warning' : 'success'}
              />
              <DataChip
                label={t('usage.cached_events', { defaultValue: '本地事件' })}
                value={formatCompactNumber(events.length)}
              />
              <DataChip
                label={t('usage.request_rate', { defaultValue: '请求速率' })}
                value={formatRate(summary.requests, range)}
              />
            </div>
          </div>
          <div className={styles.headerActions}>
            <ToggleSwitch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              disabled={disableControls}
              label={
                <span className={styles.switchLabel}>
                  <IconTimer size={16} />
                  {t('usage.auto_refresh', { defaultValue: '自动刷新' })}
                </span>
              }
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => loadUsageQueue()}
              loading={loading}
              disabled={disableControls}
            >
              <span className={styles.buttonContent}>
                <IconRefreshCw size={16} />
                {t('common.refresh')}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearEvents}
              disabled={events.length === 0}
              title={t('usage.clear_title', { defaultValue: '清空统计缓存' })}
              aria-label={t('usage.clear_title', { defaultValue: '清空统计缓存' })}
            >
              <IconTrash2 size={16} />
            </Button>
          </div>
        </header>

        <div className={styles.secondaryBar}>
          <div className={styles.rangeBar} role="tablist" aria-label={t('usage.range_label', { defaultValue: '时间范围' })}>
            {timeRangeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.rangeButton} ${range === option.value ? styles.rangeButtonActive : ''}`}
                onClick={() => setRange(option.value)}
                aria-pressed={range === option.value}
              >
                {t(option.labelKey, { defaultValue: option.fallback })}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.statusGrid}>
          <div className={styles.statusCard}>
            <IconNetwork size={18} />
            <span>{t('usage.connection', { defaultValue: '连接' })}</span>
            <strong>{t(`common.${connectionStatus}`, { defaultValue: connectionStatus })}</strong>
          </div>
          <div className={styles.statusCard}>
            <IconSlidersHorizontal size={18} />
            <span>{t('usage.queue_sample', { defaultValue: '队列采样' })}</span>
            <strong>{USAGE_QUEUE_COUNT}</strong>
          </div>
          <div className={styles.statusCard}>
            <IconInfo size={18} />
            <span>{t('usage.last_loaded_label', { defaultValue: '最后刷新' })}</span>
            <strong>
              {lastLoadedAt
                ? formatTime(lastLoadedAt, i18n.language)
                : t('usage.not_loaded', { defaultValue: '尚未刷新' })}
            </strong>
          </div>
          <div className={styles.statusCard}>
            <IconChartLine size={18} />
            <span>{t('usage.top_model', { defaultValue: '高频模型' })}</span>
            <strong title={busiestModel}>{busiestModel}</strong>
          </div>
        </div>
      </section>

      <div className={styles.analyticsShell}>
        <aside className={styles.insightRail}>
          <div className={styles.railBlock}>
            <span className={styles.railLabel}>{t('usage.capture_status', { defaultValue: '采集状态' })}</span>
            <span className={`${styles.statusPill} ${usageDisabled ? styles.statusWarning : styles.statusOk}`}>
              {usageDisabled
                ? t('usage.capture_disabled', { defaultValue: '未启用' })
                : t('usage.capture_ready', { defaultValue: '已就绪' })}
            </span>
          </div>
          <div className={styles.railBlock}>
            <span className={styles.railLabel}>{t('usage.cached_events', { defaultValue: '本地事件' })}</span>
            <strong>{formatCompactNumber(events.length)}</strong>
            <span className={styles.railHint}>
              {lastLoadedAt
                ? t('usage.last_loaded', {
                    defaultValue: '最近 {{time}}',
                    time: formatTime(lastLoadedAt, i18n.language),
                  })
                : t('usage.not_loaded', { defaultValue: '尚未刷新' })}
            </span>
          </div>
          <div className={styles.railBlock}>
            <span className={styles.railLabel}>{t('usage.slowest_route', { defaultValue: '最慢路由' })}</span>
            <strong className={styles.railValueSmall} title={slowestRoute}>
              {slowestRoute}
            </strong>
            <span className={styles.railHint}>
              {latencyRanking[0]
                ? formatDuration(latencyRanking[0].avgLatencyMs)
                : t('usage.empty_short', { defaultValue: '暂无数据' })}
            </span>
          </div>
          <div className={styles.railBlock}>
            <span className={styles.railLabel}>{t('usage.providers', { defaultValue: 'Provider' })}</span>
            <div className={styles.providerStack}>
              {providerDistribution.length === 0 ? (
                <span className={styles.railHint}>{t('usage.empty_short', { defaultValue: '暂无数据' })}</span>
              ) : (
                providerDistribution.map((provider) => (
                  <div key={provider.key} className={styles.providerRow}>
                    <span>{provider.label}</span>
                    <strong>{formatCompactNumber(provider.requests)}</strong>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className={styles.railBlock}>
            <span className={styles.railLabel}>{t('usage.auth_type', { defaultValue: '认证类型' })}</span>
            <div className={styles.providerStack}>
              {authDistribution.length === 0 ? (
                <span className={styles.railHint}>{t('usage.empty_short', { defaultValue: '暂无数据' })}</span>
              ) : (
                authDistribution.map((auth) => (
                  <div key={auth.key} className={styles.providerRow}>
                    <span>{auth.label}</span>
                    <strong>{formatCompactNumber(auth.requests)}</strong>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

        <main className={styles.contentPanel}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          <section className={styles.metricsGrid} id="usage-overview">
            <MetricTile
              label={t('usage.total_requests', { defaultValue: '请求数' })}
              value={formatCompactNumber(summary.requests)}
              detail={`${formatCompactNumber(summary.successes)} ${t('common.success')} · ${formatCompactNumber(summary.failures)} ${t('common.failure')}`}
              meta={formatRate(summary.requests, range)}
              icon={<IconTrendingUp size={20} />}
              tone="neutral"
            />
            <MetricTile
              label={t('usage.success_rate', { defaultValue: '成功率' })}
              value={formatPercent(summary.successRate)}
              detail={t('usage.failure_count', {
                defaultValue: '{{count}} 次失败',
                count: formatCompactNumber(summary.failures),
              })}
              meta={formatPercent(100 - summary.successRate)}
              icon={<IconCheckCircle2 size={20} />}
              tone={failureTone}
            />
            <MetricTile
              label={t('usage.total_tokens', { defaultValue: 'Token 总量' })}
              value={formatCompactNumber(summary.tokens.totalTokens)}
              detail={`I ${formatCompactNumber(summary.tokens.inputTokens)} · O ${formatCompactNumber(summary.tokens.outputTokens)} · R ${formatCompactNumber(summary.tokens.reasoningTokens)}`}
              meta={t('usage.cached_tokens_short', {
                defaultValue: 'Cache {{count}}',
                count: formatCompactNumber(summary.tokens.cachedTokens + summary.tokens.cacheReadTokens),
              })}
              icon={<IconChartLine size={20} />}
              tone="success"
            />
            <MetricTile
              label={t('usage.avg_latency', { defaultValue: '平均延迟' })}
              value={formatDuration(summary.avgLatencyMs)}
              detail={`TTFT ${formatDuration(summary.avgTtftMs)}`}
              meta={
                latencyRanking[0]
                  ? formatDuration(latencyRanking[0].maxLatencyMs)
                  : t('usage.empty_short', { defaultValue: '暂无数据' })
              }
              icon={<IconTimer size={20} />}
              tone="neutral"
            />
          </section>

          <section className={`${styles.panel} ${styles.chartPanel}`} id="usage-token">
            <div className={styles.panelHeader}>
              <div>
                <h2>{t('usage.token_curve', { defaultValue: 'Token 曲线' })}</h2>
                <span>{t('usage.token_curve_subtitle', { defaultValue: 'Input / Output / Reasoning 聚合' })}</span>
              </div>
              <div className={styles.chartLegend} aria-hidden="true">
                <span><i className={styles.legendTotal} />Total</span>
                <span><i className={styles.legendInput} />Input</span>
                <span><i className={styles.legendOutput} />Output</span>
                <span><i className={styles.legendReasoning} />Reasoning</span>
              </div>
            </div>
            {tokenSeries.length === 0 || summary.requests === 0 ? (
              <ChartEmptySkeleton
                title={t('usage.empty_title', { defaultValue: '暂无统计数据' })}
                description={t('usage.empty_desc', {
                  defaultValue: '产生新的模型请求后，这里会显示实时用量。',
                })}
              />
            ) : (
              <TokenLineChart data={tokenSeries} />
            )}
            <div className={styles.tokenBreakdownGrid}>
              <TokenBreakdownCard
                label={t('usage.input_tokens', { defaultValue: 'Input' })}
                value={summary.tokens.inputTokens}
                total={summary.tokens.totalTokens}
                tone="input"
              />
              <TokenBreakdownCard
                label={t('usage.output_tokens', { defaultValue: 'Output' })}
                value={summary.tokens.outputTokens}
                total={summary.tokens.totalTokens}
                tone="output"
              />
              <TokenBreakdownCard
                label={t('usage.reasoning_tokens', { defaultValue: 'Reasoning' })}
                value={summary.tokens.reasoningTokens}
                total={summary.tokens.totalTokens}
                tone="reasoning"
              />
              <TokenBreakdownCard
                label={t('usage.cache_tokens', { defaultValue: 'Cache' })}
                value={summary.tokens.cachedTokens + summary.tokens.cacheReadTokens + summary.tokens.cacheCreationTokens}
                total={summary.tokens.totalTokens}
                tone="cache"
              />
            </div>
          </section>

          <div className={styles.twoColumnGrid} id="usage-distribution">
            <DistributionPanel
              title={t('usage.model_distribution', { defaultValue: '模型调用分布' })}
              caption={t('usage.model_distribution_caption', { defaultValue: '按请求量排序' })}
              groups={modelDistribution}
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
            <RankingList
              title={t('usage.latency_ranking', { defaultValue: '延迟排行' })}
              caption={t('usage.latency_ranking_caption', { defaultValue: '按平均延迟排序' })}
              groups={latencyRanking}
              metric="latency"
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
          </div>

          <div className={styles.threeColumnGrid}>
            <DistributionPanel
              title={t('usage.endpoint_distribution', { defaultValue: 'Endpoint 分布' })}
              caption={t('usage.endpoint_distribution_caption', { defaultValue: '按接口路径聚合' })}
              groups={endpointDistribution}
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
            <DistributionPanel
              title={t('usage.provider_distribution', { defaultValue: 'Provider 分布' })}
              caption={t('usage.provider_distribution_caption', { defaultValue: '按上游提供商聚合' })}
              groups={providerDistribution}
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
            <DistributionPanel
              title={t('usage.executor_distribution', { defaultValue: 'Executor 分布' })}
              caption={t('usage.executor_distribution_caption', { defaultValue: '按执行器类型聚合' })}
              groups={executorDistribution}
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
          </div>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2>{t('usage.recent_requests', { defaultValue: '最近请求' })}</h2>
                <span>{t('usage.recent_requests_caption', { defaultValue: '最近 {{count}} 条事件', count: RECENT_REQUEST_LIMIT })}</span>
              </div>
            </div>
            <RecentRequestsTable
              events={recentEvents}
              locale={i18n.language}
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
          </section>

          <section className={styles.panel} id="usage-failures">
            <div className={styles.panelHeader}>
              <div>
                <h2>{t('usage.failure_tracking', { defaultValue: '失败请求追踪' })}</h2>
                <span>{t('usage.failure_tracking_subtitle', { defaultValue: '按最近失败时间排序' })}</span>
              </div>
              <DataChip
                label={t('usage.failure_count_label', { defaultValue: '失败数' })}
                value={formatCompactNumber(failedEvents.length)}
                tone={failedEvents.length > 0 ? 'warning' : 'success'}
              />
            </div>
            {failedEvents.length === 0 ? (
              <div className={styles.cleanState}>
                <IconCheckCircle2 size={18} />
                <span>{t('usage.no_failures', { defaultValue: '当前范围内没有失败请求' })}</span>
              </div>
            ) : (
              <div className={styles.failureTableWrap}>
                <table className={styles.failureTable}>
                  <thead>
                    <tr>
                      <th>{t('usage.time', { defaultValue: '时间' })}</th>
                      <th>{t('usage.status', { defaultValue: '状态' })}</th>
                      <th>{t('usage.provider_model', { defaultValue: 'Provider / 模型' })}</th>
                      <th>{t('usage.request_id', { defaultValue: 'Request ID' })}</th>
                      <th>{t('usage.error_body', { defaultValue: '错误' })}</th>
                      <th>{t('common.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedEvents.map((event) => (
                      <tr key={event.id}>
                        <td>{formatTime(event.timestampMs, i18n.language)}</td>
                        <td>
                          <span className={styles.statusCode}>
                            <IconAlertTriangle size={14} />
                            {event.failStatusCode}
                          </span>
                        </td>
                        <td>
                          <div className={styles.tableMainCell}>
                            <strong>{event.provider}</strong>
                            <span>{event.alias || event.model}</span>
                          </div>
                        </td>
                        <td>
                          <span className={styles.requestId} title={event.requestId || '-'}>
                            {event.requestId || '-'}
                          </span>
                        </td>
                        <td>
                          <span className={styles.failBody} title={event.failBody}>
                            {event.failBody || '-'}
                          </span>
                        </td>
                        <td>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => downloadRequestLog(event)}
                            disabled={!event.requestId}
                            title={t('logs.request_log_download_title')}
                            aria-label={t('logs.request_log_download_title')}
                          >
                            <IconDownload size={16} />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
