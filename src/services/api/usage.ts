import { apiClient } from './client';

const USAGE_QUEUE_TIMEOUT_MS = 15 * 1000;

export const usageApi = {
  getQueue: (count = 200) =>
    apiClient.get<unknown[]>('/usage-queue', {
      params: { count },
      timeout: USAGE_QUEUE_TIMEOUT_MS,
    }),
};
