import { apiClient } from './client';
import { keeperApi, type KeeperRange } from './keeper';

const USAGE_QUEUE_TIMEOUT_MS = 15 * 1000;

/**
 * Legacy CPA in-memory queue pop — do not use for analytics (steals Keeper feed).
 */
export const usageApi = {
  /** @deprecated Destructive pop of CPA usage-queue. */
  getQueue: (count = 200) =>
    apiClient.get<unknown[]>('/usage-queue', {
      params: { count },
      timeout: USAGE_QUEUE_TIMEOUT_MS,
    }),

  /** Keeper overview only (totals + hour/day series). */
  getKeeperOverview: (range: KeeperRange) => keeperApi.getOverview(range),

  /** Keeper analysis only (composition, cost, latency diagnostics, token_usage). */
  getKeeperAnalysis: (range: KeeperRange) => keeperApi.getAnalysis(range),

  /** Keeper events only (request-level list). */
  getKeeperEvents: (params: {
    range: KeeperRange;
    page?: number;
    page_size?: number;
    failed?: boolean;
  }) => keeperApi.getEvents(params),
};
