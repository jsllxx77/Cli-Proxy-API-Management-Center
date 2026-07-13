import { apiClient } from './client';
import {
  keeperApi,
  mapPanelRangeToKeeper,
  type KeeperAnalysisResponse,
  type KeeperEventsResponse,
  type KeeperOverviewResponse,
} from './keeper';

const USAGE_QUEUE_TIMEOUT_MS = 15 * 1000;

/**
 * Legacy CPA in-memory queue pop. Prefer Keeper APIs for analytics —
 * multiple consumers will steal events from each other.
 */
export const usageApi = {
  /** @deprecated Prefer Keeper overview/events. Destructive pop of CPA usage-queue. */
  getQueue: (count = 200) =>
    apiClient.get<unknown[]>('/usage-queue', {
      params: { count },
      timeout: USAGE_QUEUE_TIMEOUT_MS,
    }),

  getKeeperOverview: (range: '15m' | '1h' | '6h' | '24h' | 'all') =>
    keeperApi.getOverview(mapPanelRangeToKeeper(range)) as Promise<KeeperOverviewResponse>,

  getKeeperAnalysis: (range: '15m' | '1h' | '6h' | '24h' | 'all') =>
    keeperApi.getAnalysis(mapPanelRangeToKeeper(range)) as Promise<KeeperAnalysisResponse>,

  getKeeperEvents: (params: {
    range: '15m' | '1h' | '6h' | '24h' | 'all';
    page?: number;
    page_size?: number;
    failed?: boolean;
    q?: string;
  }) =>
    keeperApi.getEvents({
      range: mapPanelRangeToKeeper(params.range),
      page: params.page ?? 1,
      page_size: params.page_size ?? 50,
      failed: params.failed,
      q: params.q,
    }) as Promise<KeeperEventsResponse>,

  getKeeperHealth: () => keeperApi.healthz(),
  getKeeperStatus: () => keeperApi.getStatus(),
};
