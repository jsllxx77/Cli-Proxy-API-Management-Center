import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock,
  FileText,
  KeyRound,
  RefreshCw,
  Route,
  Satellite,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Badge } from '@/components/shadcn/ui/badge';
import { Button } from '@/components/shadcn/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/shadcn/ui/card';
import { apiKeysApi, authFilesApi, providersApi } from '@/services/api';
import { useAuthStore, useConfigStore, useModelsStore } from '@/stores';
import { cn } from '@/lib/utils';

interface QuickStat {
  label: string;
  value: number | string;
  icon: ReactNode;
  path: string;
  loading?: boolean;
  sublabel?: string;
  tone: 'neutral' | 'success' | 'warning';
}

interface ProviderStats {
  gemini: number | null;
  codex: number | null;
  claude: number | null;
  openai: number | null;
}

type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

const providerColors = ['#2563eb', '#10b981', '#8b5cf6', '#f59e0b'];

const LoadingValue = () => (
  <span className="inline-flex items-center gap-1 text-muted-foreground">
    <RefreshCw className="size-4 animate-spin" />
    ...
  </span>
);

function OverviewCard({ stat }: { stat: QuickStat }) {
  return (
    <Link to={stat.path} className="block focus:outline-none focus:ring-2 focus:ring-ring">
      <Card className="h-full rounded-md shadow-sm transition-colors hover:border-ring/60 hover:bg-accent/30">
        <CardContent className="flex min-h-[164px] flex-col justify-between p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="grid size-10 place-items-center rounded-md border bg-muted text-foreground">
              {stat.icon}
            </div>
            <Badge
              variant={
                stat.tone === 'success' ? 'success' : stat.tone === 'warning' ? 'warning' : 'outline'
              }
              className="rounded-full"
            >
              {stat.loading ? 'Loading' : 'Ready'}
            </Badge>
          </div>
          <div className="min-w-0">
            <div className="text-3xl font-semibold leading-none tracking-normal text-foreground">
              {stat.loading ? <LoadingValue /> : stat.value}
            </div>
            <div className="mt-3 text-sm font-medium text-foreground">{stat.label}</div>
            {stat.sublabel && (
              <div className="mt-1 truncate text-xs text-muted-foreground">{stat.sublabel}</div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function ProviderBars({
  rows,
  loading,
  emptyText,
}: {
  rows: Array<{ label: string; value: number | null; color: string }>;
  loading: boolean;
  emptyText: string;
}) {
  const readyRows = rows.filter((row) => row.value !== null);
  const maxValue = Math.max(...readyRows.map((row) => row.value ?? 0), 1);

  if (loading && readyRows.length === 0) {
    return (
      <div className="space-y-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="space-y-2">
            <div className="h-4 w-28 rounded bg-muted" />
            <div className="h-9 rounded-md border bg-muted/50" />
          </div>
        ))}
      </div>
    );
  }

  if (readyRows.length === 0) {
    return <div className="rounded-md border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground">{emptyText}</div>;
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
            <div className="h-9 rounded-md border bg-muted/35 p-1">
              <div
                className="flex h-full min-w-8 items-center justify-end rounded-sm px-2 text-[11px] font-medium text-white"
                style={{
                  width: `${Math.max(8, (value / maxValue) * 100)}%`,
                  background: providerColors[index % providerColors.length],
                }}
              >
                {value}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConfigBadge({
  icon,
  label,
  value,
  state = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  state?: 'neutral' | 'on' | 'off';
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-md border bg-card px-3 py-2">
      <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div
          className={cn(
            'truncate text-sm font-medium',
            state === 'on' && 'text-emerald-700',
            state === 'off' && 'text-muted-foreground'
          )}
        >
          {value}
        </div>
      </div>
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

  const [stats, setStats] = useState<{
    apiKeys: number | null;
    authFiles: number | null;
  }>({
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
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>(getTimeOfDay);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const apiKeysCache = useRef<string[]>([]);

  useEffect(() => {
    apiKeysCache.current = [];
  }, [apiBase, config?.apiKeys]);

  useEffect(() => {
    const id = setInterval(() => {
      setTimeOfDay(getTimeOfDay());
      setCurrentTime(new Date());
    }, 60_000);
    return () => clearInterval(id);
  }, []);

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

  const resolveApiKeysForModels = useCallback(async () => {
    if (apiKeysCache.current.length) {
      return apiKeysCache.current;
    }

    const configKeys = normalizeApiKeyList(config?.apiKeys);
    if (configKeys.length) {
      apiKeysCache.current = configKeys;
      return configKeys;
    }

    try {
      const list = await apiKeysApi.list();
      const normalized = normalizeApiKeyList(list);
      if (normalized.length) {
        apiKeysCache.current = normalized;
      }
      return normalized;
    } catch {
      return [];
    }
  }, [config?.apiKeys]);

  const fetchModels = useCallback(async () => {
    if (connectionStatus !== 'connected' || !apiBase) {
      return;
    }

    try {
      const apiKeys = await resolveApiKeysForModels();
      const primaryKey = apiKeys[0];
      await fetchModelsFromStore(apiBase, primaryKey);
    } catch {
      // Dashboard should stay readable even when model probing is unavailable.
    }
  }, [connectionStatus, apiBase, resolveApiKeysForModels, fetchModelsFromStore]);

  useEffect(() => {
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
          gemini: geminiRes.status === 'fulfilled' ? geminiRes.value.length : null,
          codex: codexRes.status === 'fulfilled' ? codexRes.value.length : null,
          claude: claudeRes.status === 'fulfilled' ? claudeRes.value.length : null,
          openai: openaiRes.status === 'fulfilled' ? openaiRes.value.length : null,
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
  }, [connectionStatus, fetchModels]);

  const providerStatsReady =
    providerStats.gemini !== null &&
    providerStats.codex !== null &&
    providerStats.claude !== null &&
    providerStats.openai !== null;
  const hasProviderStats =
    providerStats.gemini !== null ||
    providerStats.codex !== null ||
    providerStats.claude !== null ||
    providerStats.openai !== null;
  const totalProviderKeys = providerStatsReady
    ? (providerStats.gemini ?? 0) +
      (providerStats.codex ?? 0) +
      (providerStats.claude ?? 0) +
      (providerStats.openai ?? 0)
    : 0;

  const quickStats: QuickStat[] = [
    {
      label: t('dashboard.management_keys'),
      value: stats.apiKeys ?? '-',
      icon: <KeyRound className="size-5" />,
      path: '/config',
      loading: loading && stats.apiKeys === null,
      sublabel: t('nav.config_management'),
      tone: 'neutral',
    },
    {
      label: t('nav.ai_providers'),
      value: loading ? '-' : providerStatsReady ? totalProviderKeys : '-',
      icon: <Bot className="size-5" />,
      path: '/ai-providers',
      loading,
      sublabel: hasProviderStats
        ? t('dashboard.provider_keys_detail', {
            gemini: providerStats.gemini ?? '-',
            codex: providerStats.codex ?? '-',
            claude: providerStats.claude ?? '-',
            openai: providerStats.openai ?? '-',
          })
        : undefined,
      tone: providerStatsReady ? 'success' : 'warning',
    },
    {
      label: t('nav.auth_files'),
      value: stats.authFiles ?? '-',
      icon: <FileText className="size-5" />,
      path: '/auth-files',
      loading: loading && stats.authFiles === null,
      sublabel: t('dashboard.oauth_credentials'),
      tone: 'neutral',
    },
    {
      label: t('dashboard.available_models'),
      value: modelsLoading ? '-' : models.length,
      icon: <Satellite className="size-5" />,
      path: '/system',
      loading: modelsLoading,
      sublabel: t('dashboard.available_models_desc'),
      tone: models.length > 0 ? 'success' : 'warning',
    },
  ];

  const routingStrategyRaw = config?.routingStrategy?.trim() || '';
  const routingStrategyDisplay = !routingStrategyRaw
    ? '-'
    : routingStrategyRaw === 'round-robin'
      ? t('basic_settings.routing_strategy_round_robin')
      : routingStrategyRaw === 'fill-first'
        ? t('basic_settings.routing_strategy_fill_first')
        : routingStrategyRaw;

  const formattedDate = currentTime.toLocaleDateString(i18n.language, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const formattedTime = currentTime.toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  });

  const providerRows = [
    { label: 'Gemini', value: providerStats.gemini, color: providerColors[0] },
    { label: 'Codex', value: providerStats.codex, color: providerColors[1] },
    { label: 'Claude', value: providerStats.claude, color: providerColors[2] },
    { label: 'OpenAI', value: providerStats.openai, color: providerColors[3] },
  ];

  const modelPreview = useMemo(() => models.slice(0, 8), [models]);
  const getModelLabel = (model: (typeof models)[number]) => model.alias || model.name;
  const greetingKey = `dashboard.greeting_${timeOfDay}`;
  const caringKey = `dashboard.caring_${timeOfDay}`;
  const connectionLabel = t(
    connectionStatus === 'connected'
      ? 'common.connected'
      : connectionStatus === 'connecting'
        ? 'common.connecting'
        : 'common.disconnected'
  );

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      <header className="flex flex-col gap-5 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{t('nav.dashboard')}</span>
            <span>/</span>
            <span>{t('dashboard.system_overview')}</span>
            <Badge
              variant={connectionStatus === 'connected' ? 'success' : 'warning'}
              className="ml-1 rounded-full"
            >
              {connectionStatus === 'connected' ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <WifiOff className="size-3.5" />
              )}
              {connectionLabel}
            </Badge>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <h1 className="text-3xl font-semibold leading-tight tracking-normal text-foreground md:text-4xl">
              {t('dashboard.welcome_back')}
            </h1>
            <span className="pb-1 text-sm font-medium text-muted-foreground">
              {t(greetingKey)}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            {t(caringKey)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Badge variant="outline" className="rounded-full">
            <Clock className="size-3.5" />
            {formattedTime}
          </Badge>
          <Badge variant="outline" className="rounded-full">
            {formattedDate}
          </Badge>
          <Badge variant="outline" className="rounded-full">
            <Server className="size-3.5" />
            {serverVersion ? `v${serverVersion.trim().replace(/^[vV]+/, '')}` : '-'}
          </Badge>
          {serverBuildDate && (
            <Badge variant="outline" className="rounded-full">
              {new Date(serverBuildDate).toLocaleDateString(i18n.language)}
            </Badge>
          )}
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {quickStats.map((stat) => (
          <OverviewCard key={stat.path} stat={stat} />
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <Card className="rounded-md">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>{t('nav.ai_providers')}</CardTitle>
              <CardDescription>
                {hasProviderStats
                  ? t('dashboard.provider_keys_detail', {
                      gemini: providerStats.gemini ?? '-',
                      codex: providerStats.codex ?? '-',
                      claude: providerStats.claude ?? '-',
                      openai: providerStats.openai ?? '-',
                    })
                  : t('usage.empty_short', { defaultValue: '暂无数据' })}
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
              loading={loading}
              emptyText={t('usage.empty_short', { defaultValue: '暂无数据' })}
            />
          </CardContent>
        </Card>

        <Card className="rounded-md">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>{t('dashboard.available_models')}</CardTitle>
              <CardDescription>{t('dashboard.available_models_desc')}</CardDescription>
            </div>
            <Badge variant={models.length > 0 ? 'success' : 'warning'} className="w-fit rounded-full">
              <Satellite className="size-3.5" />
              {modelsLoading ? 'Loading' : models.length}
            </Badge>
          </CardHeader>
          <CardContent>
            {modelsLoading ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <div key={index} className="h-10 rounded-md border bg-muted/50" />
                ))}
              </div>
            ) : modelPreview.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {modelPreview.map((model) => (
                  <div
                    key={model.name}
                    className="flex min-h-10 items-center rounded-md border bg-card px-3 text-sm"
                  >
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {getModelLabel(model)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground">
                {t('usage.empty_short', { defaultValue: '暂无数据' })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <Card className="rounded-md">
          <CardHeader>
            <CardTitle>{t('dashboard.current_config')}</CardTitle>
            <CardDescription>{apiBase || 'CLI Proxy API'}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <ConfigBadge
              icon={<Activity className="size-4" />}
              label={t('basic_settings.debug_enable')}
              value={config?.debug ? t('common.yes') : t('common.no')}
              state={config?.debug ? 'on' : 'off'}
            />
            <ConfigBadge
              icon={<ShieldCheck className="size-4" />}
              label={t('basic_settings.logging_to_file_enable')}
              value={config?.loggingToFile ? t('common.yes') : t('common.no')}
              state={config?.loggingToFile ? 'on' : 'off'}
            />
            <ConfigBadge
              icon={<RefreshCw className="size-4" />}
              label={t('basic_settings.retry_count_label')}
              value={config?.requestRetry ?? 0}
            />
            <ConfigBadge
              icon={<Wifi className="size-4" />}
              label={t('basic_settings.ws_auth_enable')}
              value={config?.wsAuth ? t('common.yes') : t('common.no')}
              state={config?.wsAuth ? 'on' : 'off'}
            />
            <ConfigBadge
              icon={<Route className="size-4" />}
              label={t('dashboard.routing_strategy')}
              value={routingStrategyDisplay}
            />
            <ConfigBadge
              icon={<SlidersHorizontal className="size-4" />}
              label={t('nav.config_management')}
              value={t('dashboard.edit_settings')}
            />
          </CardContent>
        </Card>

        <Card className="rounded-md">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>{t('dashboard.system_overview')}</CardTitle>
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
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border bg-muted/25 p-4">
                <div className="text-xs text-muted-foreground">{t('dashboard.management_keys')}</div>
                <div className="mt-2 text-2xl font-semibold">{stats.apiKeys ?? '-'}</div>
              </div>
              <div className="rounded-md border bg-muted/25 p-4">
                <div className="text-xs text-muted-foreground">{t('nav.auth_files')}</div>
                <div className="mt-2 text-2xl font-semibold">{stats.authFiles ?? '-'}</div>
              </div>
              <div className="rounded-md border bg-muted/25 p-4">
                <div className="text-xs text-muted-foreground">{t('nav.ai_providers')}</div>
                <div className="mt-2 text-2xl font-semibold">
                  {providerStatsReady ? totalProviderKeys : '-'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
