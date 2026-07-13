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
import { apiKeysApi, authFilesApi, providersApi, usageApi, type KeeperRange } from '@/services/api';
import { useAuthStore, useConfigStore, useModelsStore } from '@/stores';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { cn } from '@/lib/utils';
import {
  emptyOverviewSummary,
  overviewSeriesToTokenSeries,
  overviewToSummary,
} from '@/utils/keeperAdapters';
import { formatCompactNumber, type TokenSeriesPoint } from '@/utils/usageAnalytics';

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
const tokenTrendRanges: Array<{ value: KeeperRange; label: string }> = [
  { value: '4h', label: '4 小时' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

const trimTrailingEmptyTokenBuckets = (series: TokenSeriesPoint[]) => {
  if (!series.length) return series;
  let end = series.length - 1;
  while (end > 0 && series[end].requests === 0 && series[end].totalTokens === 0) {
    end -= 1;
  }
  return series.slice(0, end + 1);
};

const normalizeApiKeyList = (keys?: string[]) =>
  (keys ?? []).map((k) => String(k).trim()).filter(Boolean);

function SectionCard({
  stat,
}: {
  stat: QuickStat;
}) {
  return (
    <Card className="@container/card rounded-xl bg-gradient-to-t from-muted/50 to-card shadow-sm">
      <CardHeader className="relative pb-2">
        <CardDescription>{stat.label}</CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums tracking-normal @[260px]/card:text-4xl">
          {stat.loading ? '…' : stat.value}
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
          {stat.icon}
        </div>
        <Link to={stat.path} className="text-muted-foreground underline-offset-4 hover:underline">
          打开
        </Link>
      </CardFooter>
    </Card>
  );
}

function TokenTrendChart({ data, loading }: { data: TokenSeriesPoint[]; loading?: boolean }) {
  if (loading) {
    return (
      <div className="grid h-[220px] place-items-center rounded-md border text-sm text-muted-foreground">
        加载 Keeper overview…
      </div>
    );
  }
  if (!data.length || !data.some((p) => p.requests > 0 || p.totalTokens > 0)) {
    return (
      <div className="grid h-[220px] place-items-center rounded-md border text-sm text-muted-foreground">
        暂无 overview.series 数据
      </div>
    );
  }

  const width = 720;
  const height = 200;
  const pad = { t: 16, r: 16, b: 28, l: 48 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const maxV = Math.max(...data.map((d) => d.totalTokens), 1);
  const xFor = (i: number) =>
    pad.l + (plotW * i) / Math.max(1, Math.max(data.length, 2) - 1);
  const yFor = (v: number) => pad.t + plotH - (v / maxV) * plotH;
  const points =
    data.length === 1
      ? `${pad.l},${yFor(data[0].totalTokens)} ${pad.l + plotW},${yFor(data[0].totalTokens)}`
      : data.map((d, i) => `${xFor(i)},${yFor(d.totalTokens)}`).join(' ');

  return (
    <svg className="h-[220px] w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
      {data.map((d, i) => (
        <circle key={i} cx={data.length === 1 ? pad.l + plotW / 2 : xFor(i)} cy={yFor(d.totalTokens)} r="3" fill="currentColor">
          <title>
            {d.label}: {formatCompactNumber(d.totalTokens)} tok / {d.requests} req
          </title>
        </circle>
      ))}
    </svg>
  );
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
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
  const [tokenRange, setTokenRange] = useLocalStorage<KeeperRange>('dashboard.keeperRange', '24h');
  const [usageLoading, setUsageLoading] = useState(false);
  const [tokenSeries, setTokenSeries] = useState<TokenSeriesPoint[]>([]);
  const [tokenSummary, setTokenSummary] = useState(() => emptyOverviewSummary());
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
      const keys = await apiKeysApi.list();
      const list = normalizeApiKeyList(keys);
      apiKeysCache.current = list;
      return list;
    } catch {
      return [];
    }
  }, [config?.apiKeys]);

  const fetchModels = useCallback(async () => {
    if (connectionStatus !== 'connected' || !apiBase) return;
    const apiKeys = await resolveApiKeysForModels();
    if (!apiKeys[0]) return;
    try {
      await fetchModelsFromStore(apiBase, apiKeys[0]);
    } catch {
      // ignore
    }
  }, [connectionStatus, apiBase, resolveApiKeysForModels, fetchModelsFromStore]);

  useEffect(() => {
    const configCount = (key: string) => {
      const raw = config?.raw?.[key];
      return Array.isArray(raw) ? raw.length : null;
    };
    const resolvedLength = (
      result: PromiseSettledResult<unknown[]>,
      fallback: number | null
    ) => (result.status === 'fulfilled' ? result.value.length : fallback);

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
          apiKeys: keysRes.status === 'fulfilled' ? keysRes.value.length : null,
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

  useEffect(() => {
    let cancelled = false;
    const fetchUsage = async () => {
      if (connectionStatus !== 'connected') {
        setUsageLoading(false);
        return;
      }
      setUsageLoading(true);
      try {
        // Single Keeper request: /usage/overview only
        const overview = await usageApi.getKeeperOverview(tokenRange);
        if (cancelled) return;
        setTokenSummary(overviewToSummary(overview));
        setTokenSeries(trimTrailingEmptyTokenBuckets(overviewSeriesToTokenSeries(overview)));
      } catch {
        if (!cancelled) {
          setTokenSummary(emptyOverviewSummary());
          setTokenSeries([]);
        }
      } finally {
        if (!cancelled) setUsageLoading(false);
      }
    };
    void fetchUsage();
    return () => {
      cancelled = true;
    };
  }, [connectionStatus, tokenRange]);

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
  const modelPreview = models.slice(0, 6);
  const formattedDate = new Date().toLocaleDateString(i18n.language, {
    month: '2-digit',
    day: '2-digit',
  });

  const metricCards: QuickStat[] = [
    {
      label: t('nav.dashboard'),
      value: connectionLabel,
      icon: <Wifi className="size-5" />,
      path: '/',
      loading,
      detail: connectionStatus,
      badge: connectionStatus === 'connected' ? 'ok' : 'off',
    },
    {
      label: t('nav.api_keys', { defaultValue: 'API Keys' }),
      value: stats.apiKeys ?? '-',
      icon: <KeyRound className="size-5" />,
      path: '/config',
      loading,
      detail: 'proxy api-keys',
      badge: 'keys',
    },
    {
      label: t('nav.auth_files'),
      value: stats.authFiles ?? '-',
      icon: <FileText className="size-5" />,
      path: '/auth-files',
      loading,
      detail: 'auth files',
      badge: 'auth',
    },
    {
      label: t('nav.ai_providers'),
      value: totalProviderKeys || '-',
      icon: <Bot className="size-5" />,
      path: '/ai-providers',
      loading,
      detail: 'provider keys',
      badge: 'providers',
    },
  ];

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
            <CardTitle>Token 使用趋势</CardTitle>
            <CardDescription>
              {formatCompactNumber(tokenSummary.tokens.totalTokens)} tokens /{' '}
              {formatCompactNumber(tokenSummary.requests)} requests · Keeper overview.series ·{' '}
              {formattedDate}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {tokenTrendRanges.map((range) => (
              <Button
                key={range.value}
                type="button"
                size="sm"
                variant={tokenRange === range.value ? 'default' : 'outline'}
                onClick={() => setTokenRange(range.value)}
              >
                {range.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <TokenTrendChart data={tokenSeries} loading={usageLoading} />
        </CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle>路由 / 连接</CardTitle>
            <CardDescription>routing strategy · session</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Route className="size-4" />
              {routingStrategyDisplay}
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4" />
              {connectionLabel}
            </div>
            <div className="flex items-center gap-2">
              <Satellite className="size-4" />
              {apiBase || '-'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>可用模型</CardTitle>
              <CardDescription>/v1/models 快照</CardDescription>
            </div>
            <Button type="button" size="icon" variant="ghost" onClick={() => void fetchModels()}>
              <RefreshCw className={cn('size-4', modelsLoading && 'animate-spin')} />
            </Button>
          </CardHeader>
          <CardContent>
            {modelPreview.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelPreview.map((m) => (
                    <TableRow key={m.name}>
                      <TableCell className="font-mono text-xs">{m.name}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-sm text-muted-foreground">
                {modelsLoading ? '加载中…' : '暂无模型'}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="size-4" />
            Provider 计数
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {[
            { label: 'Gemini', value: providerStats.gemini, color: providerColors[0] },
            { label: 'Codex', value: providerStats.codex, color: providerColors[1] },
            { label: 'Claude', value: providerStats.claude, color: providerColors[2] },
            { label: 'OpenAI-compat', value: providerStats.openai, color: providerColors[3] },
          ].map((item) => (
            <Badge key={item.label} variant="outline" className="rounded-full px-3 py-1">
              <span className="mr-2 inline-block size-2 rounded-full" style={{ background: item.color }} />
              {item.label}: {item.value ?? '—'}
            </Badge>
          ))}
        </CardContent>
        <CardFooter>
          <Link to="/usage" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:underline">
            <TrendingUp className="size-4" />
            打开用量（Keeper）
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
