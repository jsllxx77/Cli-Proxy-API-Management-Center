import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconAlertTriangle,
  IconChartLine,
  IconCheckCircle2,
  IconDownload,
  IconRefreshCw,
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

function MetricTile({
  label,
  value,
  detail,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  icon: React.ReactNode;
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
  const points = data.map((point, index) => {
    const x = padding.left + index * xStep;
    const y = padding.top + plotHeight - (point.totalTokens / maxTokens) * plotHeight;
    return { ...point, x, y };
  });
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
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

function RankingList({
  title,
  groups,
  metric,
  emptyText,
}: {
  title: string;
  groups: UsageGroup[];
  metric: 'latency' | 'tokens' | 'requests';
  emptyText: string;
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
        <h2>{title}</h2>
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
  const failedEvents = useMemo(() => getFailedUsageEvents(filteredEvents), [filteredEvents]);
  const disableControls = connectionStatus !== 'connected';

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
      <header className={styles.header}>
        <div>
          <div className={styles.breadcrumb}>
            {t('nav.dashboard')} / {t('nav.usage_statistics', { defaultValue: '用量统计' })}
          </div>
          <h1>{t('usage.title', { defaultValue: '用量统计' })}</h1>
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
        </aside>

        <main className={styles.contentPanel}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          <section className={styles.metricsGrid}>
            <MetricTile
              label={t('usage.total_requests', { defaultValue: '请求数' })}
              value={formatCompactNumber(summary.requests)}
              detail={`${formatCompactNumber(summary.successes)} ${t('common.success')} · ${formatCompactNumber(summary.failures)} ${t('common.failure')}`}
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
              icon={<IconCheckCircle2 size={20} />}
              tone={summary.failures > 0 ? 'warning' : 'success'}
            />
            <MetricTile
              label={t('usage.total_tokens', { defaultValue: 'Token 总量' })}
              value={formatCompactNumber(summary.tokens.totalTokens)}
              detail={`I ${formatCompactNumber(summary.tokens.inputTokens)} · O ${formatCompactNumber(summary.tokens.outputTokens)} · R ${formatCompactNumber(summary.tokens.reasoningTokens)}`}
              icon={<IconChartLine size={20} />}
              tone="success"
            />
            <MetricTile
              label={t('usage.avg_latency', { defaultValue: '平均延迟' })}
              value={formatDuration(summary.avgLatencyMs)}
              detail={`TTFT ${formatDuration(summary.avgTtftMs)}`}
              icon={<IconTimer size={20} />}
              tone="neutral"
            />
          </section>

          <section className={`${styles.panel} ${styles.chartPanel}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>{t('usage.token_curve', { defaultValue: 'Token 曲线' })}</h2>
                <span>{t('usage.token_curve_subtitle', { defaultValue: 'Input / Output / Reasoning 聚合' })}</span>
              </div>
            </div>
            {tokenSeries.length === 0 || summary.requests === 0 ? (
              <EmptyState
                title={t('usage.empty_title', { defaultValue: '暂无统计数据' })}
                description={t('usage.empty_desc', {
                  defaultValue: '产生新的模型请求后，这里会显示实时用量。',
                })}
              />
            ) : (
              <TokenLineChart data={tokenSeries} />
            )}
          </section>

          <div className={styles.twoColumnGrid}>
            <RankingList
              title={t('usage.model_distribution', { defaultValue: '模型调用分布' })}
              groups={modelDistribution}
              metric="tokens"
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
            <RankingList
              title={t('usage.latency_ranking', { defaultValue: '延迟排行' })}
              groups={latencyRanking}
              metric="latency"
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
          </div>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2>{t('usage.failure_tracking', { defaultValue: '失败请求追踪' })}</h2>
                <span>{t('usage.failure_tracking_subtitle', { defaultValue: '按最近失败时间排序' })}</span>
              </div>
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
