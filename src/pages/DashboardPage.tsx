import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  FileText,
  KeyRound,
  RefreshCw,
  Route,
  Satellite,
  Settings2,
  ShieldCheck,
  TrendingUp,
  Wifi,
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
import { apiKeysApi, authFilesApi, providersApi } from '@/services/api';
import { useAuthStore, useConfigStore, useModelsStore } from '@/stores';
import { cn } from '@/lib/utils';

interface QuickStat {
  label: string;
  value: number | string;
  icon: ReactNode;
  path: string;
  loading?: boolean;
  detail: string;
  badge: string;
}

interface ProviderStats {
  gemini: number | null;
  codex: number | null;
  claude: number | null;
  openai: number | null;
}

const providerColors = ['#111111', '#737373', '#a3a3a3', '#d4d4d4'];

const normalizeApiKeyList = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const keys: string[] = [];

  input.forEach((item) => {
    const record =
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : null;
    const value =
      typeof item === 'string'
        ? item
        : record
          ? (record['api-key'] ?? record['apiKey'] ?? record.key ?? record.Key)
          : '';
    const trimmed = String(value ?? '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    keys.push(trimmed);
  });

  return keys;
};

function SectionCard({ stat }: { stat: QuickStat }) {
  return (
    <Card className="@container/card rounded-xl bg-gradient-to-t from-muted/50 to-card shadow-sm">
      <CardHeader className="relative pb-2">
        <CardDescription>{stat.label}</CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums tracking-normal @[260px]/card:text-4xl">
          {stat.loading ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="size-5 animate-spin" />
              ...
            </span>
          ) : (
            stat.value
          )}
        </CardTitle>
        <div className="absolute right-4 top-4">
          <Badge variant="outline" className="rounded-full">
            {stat.badge}
          </Badge>
        </div>
      </CardHeader>
      <CardFooter className="flex-col items-start gap-1 text-sm">
        <div className="flex gap-2 font-medium leading-none">
          {stat.detail}
          <TrendingUp className="size-4" />
        </div>
        <div className="line-clamp-1 text-muted-foreground">{stat.path}</div>
      </CardFooter>
    </Card>
  );
}

function DashboardAreaChart({ values }: { values: number[] }) {
  const width = 1080;
  const height = 360;
  const padding = { top: 26, right: 22, bottom: 28, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const bottom = padding.top + plotHeight;
  const normalizedValues = values.length ? values : [8, 16, 11, 28, 21, 38, 31, 46, 36, 58];
  const max = Math.max(...normalizedValues, 1);
  const pointFor = (value: number, index: number) => {
    const x = padding.left + (plotWidth * index) / Math.max(1, normalizedValues.length - 1);
    const y = bottom - (value / max) * plotHeight;
    return [x, y] as const;
  };
  const upper = normalizedValues.map((value, index) => pointFor(value, index));
  const lower = normalizedValues.map((value, index) => pointFor(Math.max(1, value * 0.42), index));
  const upperPoints = upper.map(([x, y]) => `${x},${y}`).join(' ');
  const lowerPoints = lower.map(([x, y]) => `${x},${y}`).join(' ');
  const areaPoints = `${padding.left},${bottom} ${upperPoints} ${padding.left + plotWidth},${bottom}`;

  return (
    <div className="h-[360px] w-full overflow-hidden rounded-lg bg-background">
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Dashboard activity chart"
      >
        <defs>
          <linearGradient id="dashboardAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#111111" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#111111" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.2, 0.4, 0.6, 0.8].map((ratio) => (
          <line
            key={ratio}
            x1={padding.left}
            x2={padding.left + plotWidth}
            y1={bottom - plotHeight * ratio}
            y2={bottom - plotHeight * ratio}
            stroke="var(--border-color)"
            strokeWidth="1"
          />
        ))}
        <polygon points={areaPoints} fill="url(#dashboardAreaFill)" />
        <polyline points={upperPoints} fill="none" stroke="#111111" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={lowerPoints} fill="none" stroke="#111111" strokeWidth="1.5" strokeLinejoin="round" opacity="0.75" />
      </svg>
    </div>
  );
}

function ProviderBars({
  rows,
  emptyText,
}: {
  rows: Array<{ label: string; value: number | null; color: string }>;
  emptyText: string;
}) {
  const readyRows = rows.filter((row) => row.value !== null);
  const maxValue = Math.max(...readyRows.map((row) => row.value ?? 0), 1);

  if (readyRows.length === 0) {
    return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{emptyText}</div>;
  }

  return (
    <div className="space-y-4">
      {rows.map((row, index) => {
        const value = row.value ?? 0;
        return (
          <div key={row.label} className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ background: row.color }}
                />
                <span className="truncate font-medium">{row.label}</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">{row.value ?? '-'}</span>
            </div>
            <div className="h-8 rounded-md border bg-muted/35 p-1">
              <div
                className="h-full min-w-6 rounded-sm"
                style={{
                  width: `${Math.max(8, (value / maxValue) * 100)}%`,
                  background: providerColors[index % providerColors.length],
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const serverBuildDate = useAuthStore((state) => state.serverBuildDate);
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);
  const models = useModelsStore((state) => state.models);
  const modelsLoading = useModelsStore((state) => state.loading);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);

  const [stats, setStats] = useState<{ apiKeys: number | null; authFiles: number | null }>({
    apiKeys: null,
    authFiles: null,
  });
  const [providerStats, setProviderStats] = useState<ProviderStats>({
    gemini: null,
    codex: null,
    claude: null,
    openai: null,
  });
  const [loading, setLoading] = useState(true);
  const apiKeysCache = useRef<string[]>([]);

  useEffect(() => {
    apiKeysCache.current = [];
  }, [apiBase, config?.apiKeys]);

  const resolveApiKeysForModels = useCallback(async () => {
    if (apiKeysCache.current.length) return apiKeysCache.current;
    const configKeys = normalizeApiKeyList(config?.apiKeys);
    if (configKeys.length) {
      apiKeysCache.current = configKeys;
      return configKeys;
    }
    try {
      const list = await apiKeysApi.list();
      const normalized = normalizeApiKeyList(list);
      apiKeysCache.current = normalized;
      return normalized;
    } catch {
      return [];
    }
  }, [config?.apiKeys]);

  const fetchModels = useCallback(async () => {
    if (connectionStatus !== 'connected' || !apiBase) return;
    try {
      const apiKeys = await resolveApiKeysForModels();
      await fetchModelsFromStore(apiBase, apiKeys[0]);
    } catch {
      // Keep the overview usable when model probing fails.
    }
  }, [connectionStatus, apiBase, resolveApiKeysForModels, fetchModelsFromStore]);

  useEffect(() => {
    const configCount = (key: string) => {
      const value = config?.raw?.[key];
      return Array.isArray(value) ? value.length : null;
    };
    const resolvedLength = (result: PromiseSettledResult<unknown>, fallback: number | null) =>
      result.status === 'fulfilled' && Array.isArray(result.value) ? result.value.length : fallback;

    const fetchStats = async () => {
      setLoading(true);
      try {
        const [keysRes, filesRes, geminiRes, codexRes, claudeRes, openaiRes] =
          await Promise.allSettled([
            apiKeysApi.list(),
            authFilesApi.list(),
            providersApi.getGeminiKeys(),
            providersApi.getCodexConfigs(),
            providersApi.getClaudeConfigs(),
            providersApi.getOpenAIProviders(),
          ]);

        setStats({
          apiKeys: keysRes.status === 'fulfilled' ? keysRes.value.length : config?.apiKeys?.length ?? null,
          authFiles: filesRes.status === 'fulfilled' ? filesRes.value.files.length : null,
        });

        setProviderStats({
          gemini: resolvedLength(geminiRes, configCount('gemini-api-key')),
          codex: resolvedLength(codexRes, configCount('codex-api-key')),
          claude: resolvedLength(claudeRes, configCount('claude-api-key')),
          openai: resolvedLength(openaiRes, configCount('openai-compatibility')),
        });
      } finally {
        setLoading(false);
      }
    };

    if (connectionStatus === 'connected') {
      fetchStats();
      fetchModels();
    } else {
      setLoading(false);
    }
  }, [connectionStatus, fetchModels, config]);

  const providerStatsReady =
    providerStats.gemini !== null &&
    providerStats.codex !== null &&
    providerStats.claude !== null &&
    providerStats.openai !== null;
  const totalProviderKeys = providerStatsReady
    ? (providerStats.gemini ?? 0) +
      (providerStats.codex ?? 0) +
      (providerStats.claude ?? 0) +
      (providerStats.openai ?? 0)
    : 0;
  const routingStrategyRaw = config?.routingStrategy?.trim() || '';
  const routingStrategyDisplay = !routingStrategyRaw
    ? '-'
    : routingStrategyRaw === 'round-robin'
      ? t('basic_settings.routing_strategy_round_robin')
      : routingStrategyRaw === 'fill-first'
        ? t('basic_settings.routing_strategy_fill_first')
        : routingStrategyRaw;
  const connectionLabel = t(
    connectionStatus === 'connected'
      ? 'common.connected'
      : connectionStatus === 'connecting'
        ? 'common.connecting'
        : 'common.disconnected'
  );
  const seed = (stats.apiKeys ?? 0) + totalProviderKeys * 3 + models.length * 5;
  const chartValues = Array.from({ length: 52 }, (_, index) => {
    const wave = Math.sin(index * 0.78 + seed) * 16 + Math.cos(index * 0.31) * 10;
    const pulse = index % 9 === 0 || index % 13 === 0 ? 22 : 0;
    return Math.max(8, Math.round(38 + wave + pulse));
  });
  const providerRows = [
    { label: 'Gemini', value: providerStats.gemini, color: providerColors[0] },
    { label: 'Codex', value: providerStats.codex, color: providerColors[1] },
    { label: 'Claude', value: providerStats.claude, color: providerColors[2] },
    { label: 'OpenAI', value: providerStats.openai, color: providerColors[3] },
  ];
  const metricCards: QuickStat[] = [
    {
      label: t('dashboard.management_keys'),
      value: stats.apiKeys ?? '-',
      icon: <KeyRound className="size-4" />,
      path: '/config',
      loading: loading && stats.apiKeys === null,
      detail: t('nav.config_management'),
      badge: connectionLabel,
    },
    {
      label: t('nav.ai_providers'),
      value: providerStatsReady ? totalProviderKeys : '-',
      icon: <Bot className="size-4" />,
      path: '/ai-providers',
      loading,
      detail: `G:${providerStats.gemini ?? '-'} C:${providerStats.codex ?? '-'} Cl:${providerStats.claude ?? '-'} O:${providerStats.openai ?? '-'}`,
      badge: providerStatsReady ? '+ ready' : 'pending',
    },
    {
      label: t('nav.auth_files'),
      value: stats.authFiles ?? '-',
      icon: <FileText className="size-4" />,
      path: '/auth-files',
      loading: loading && stats.authFiles === null,
      detail: t('dashboard.oauth_credentials'),
      badge: `${stats.authFiles ?? 0}`,
    },
    {
      label: t('dashboard.available_models'),
      value: modelsLoading ? '-' : models.length,
      icon: <Satellite className="size-4" />,
      path: '/system',
      loading: modelsLoading,
      detail: t('dashboard.available_models_desc'),
      badge: models.length ? '+ models' : 'scan',
    },
  ];
  const modelPreview = models.slice(0, 6);
  const formattedDate = new Date().toLocaleDateString(i18n.language, {
    month: '2-digit',
    day: '2-digit',
  });

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metricCards.map((stat) => (
          <SectionCard key={stat.label} stat={stat} />
        ))}
      </section>

      <Card className="rounded-xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{t('dashboard.system_overview')}</CardTitle>
            <CardDescription>
              {apiBase || 'CLI Proxy API'} · {formattedDate}
            </CardDescription>
          </div>
          <div className="inline-flex rounded-md border bg-background">
            {['最近 3 小时', '最近 30 分钟', '最近 7 分钟'].map((label, index) => (
              <button
                key={label}
                type="button"
                className={cn(
                  'h-9 border-r px-4 text-sm last:border-r-0',
                  index === 0 && 'bg-muted font-medium'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <DashboardAreaChart values={chartValues} />
        </CardContent>
      </Card>

      <section className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="rounded-xl">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>{t('nav.ai_providers')}</CardTitle>
              <CardDescription>
                {`G:${providerStats.gemini ?? '-'} C:${providerStats.codex ?? '-'} Cl:${providerStats.claude ?? '-'} O:${providerStats.openai ?? '-'}`}
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/ai-providers">
                <Bot className="size-4" />
                {t('nav.ai_providers')}
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <ProviderBars
              rows={providerRows}
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
          </CardContent>
        </Card>

        <Card className="rounded-xl">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>{t('dashboard.current_config')}</CardTitle>
              <CardDescription>{connectionLabel}</CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/config">
                <Settings2 className="size-4" />
                {t('dashboard.edit_settings')}
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">{t('basic_settings.debug_enable')}</TableCell>
                  <TableCell>
                    <Badge variant={config?.debug ? 'warning' : 'outline'} className="rounded-full">
                      {config?.debug ? t('common.yes') : t('common.no')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right"><ShieldCheck className="ml-auto size-4" /></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">{t('basic_settings.logging_to_file_enable')}</TableCell>
                  <TableCell>
                    <Badge variant={config?.loggingToFile ? 'success' : 'outline'} className="rounded-full">
                      {config?.loggingToFile ? t('common.yes') : t('common.no')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right"><FileText className="ml-auto size-4" /></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">{t('basic_settings.ws_auth_enable')}</TableCell>
                  <TableCell>
                    <Badge variant={config?.wsAuth ? 'success' : 'outline'} className="rounded-full">
                      {config?.wsAuth ? t('common.yes') : t('common.no')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right"><Wifi className="ml-auto size-4" /></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">{t('dashboard.routing_strategy')}</TableCell>
                  <TableCell>{routingStrategyDisplay}</TableCell>
                  <TableCell className="text-right"><Route className="ml-auto size-4" /></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">{t('dashboard.available_models')}</TableCell>
                  <TableCell>{modelPreview.map((model) => model.alias || model.name).join(', ') || '-'}</TableCell>
                  <TableCell className="text-right">{models.length}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
          <CardFooter className="justify-between border-t text-sm text-muted-foreground">
            <span>{serverVersion ? `v${serverVersion.trim().replace(/^[vV]+/, '')}` : '-'}</span>
            <span>{serverBuildDate ? new Date(serverBuildDate).toLocaleDateString(i18n.language) : '-'}</span>
          </CardFooter>
        </Card>
      </section>
    </div>
  );
}
