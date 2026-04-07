import type { AuthFileItem } from '../types/authFile';
import type { CredentialInfo } from '../types/sourceInfo';
import {
  collectUsageDetails,
  filterUsageByTimeRange,
  normalizeAuthIndex,
  type UsageDetail,
  type UsageTimeRange
} from '../utils/usage';

export type UsagePageSectionKey =
  | 'summary'
  | 'serviceHealth'
  | 'charts'
  | 'tokenBreakdown'
  | 'costTrend'
  | 'apiModelBreakdown'
  | 'requestEvents'
  | 'credentialStats'
  | 'priceSettings';

export interface UsagePageSectionConfig {
  key: UsagePageSectionKey;
  defaultExpanded: boolean;
}

export interface DeriveUsagePageDataOptions<T> {
  usage: T | null;
  timeRange: UsageTimeRange;
  fullUsageDetails?: UsageDetail[];
  nowMs?: number;
}

export interface UsagePageDerivedData<T> {
  filteredUsage: T | null;
  fullUsageDetails: UsageDetail[];
  filteredUsageDetails: UsageDetail[];
}

export function deriveUsagePageData<T>({
  usage,
  timeRange,
  fullUsageDetails,
  nowMs
}: DeriveUsagePageDataOptions<T>): UsagePageDerivedData<T> {
  if (!usage) {
    return {
      filteredUsage: null,
      fullUsageDetails: fullUsageDetails ?? [],
      filteredUsageDetails: []
    };
  }

  const resolvedFullUsageDetails = fullUsageDetails ?? collectUsageDetails(usage);
  if (timeRange === 'all') {
    return {
      filteredUsage: usage,
      fullUsageDetails: resolvedFullUsageDetails,
      filteredUsageDetails: resolvedFullUsageDetails
    };
  }

  const filteredUsage = filterUsageByTimeRange(usage, timeRange, nowMs);
  return {
    filteredUsage,
    fullUsageDetails: resolvedFullUsageDetails,
    filteredUsageDetails: collectUsageDetails(filteredUsage)
  };
}

export function buildAuthFileMap(files: AuthFileItem[] | null | undefined): Map<string, CredentialInfo> {
  const map = new Map<string, CredentialInfo>();
  if (!Array.isArray(files)) {
    return map;
  }

  files.forEach((file) => {
    const key = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
    if (!key) {
      return;
    }
    map.set(key, {
      name: file.name || key,
      type: (file.type || file.provider || '').toString()
    });
  });

  return map;
}

export function buildUsagePageSections(): UsagePageSectionConfig[] {
  return [
    { key: 'summary', defaultExpanded: true },
    { key: 'serviceHealth', defaultExpanded: true },
    { key: 'charts', defaultExpanded: true },
    { key: 'tokenBreakdown', defaultExpanded: true },
    { key: 'costTrend', defaultExpanded: false },
    { key: 'apiModelBreakdown', defaultExpanded: false },
    { key: 'requestEvents', defaultExpanded: false },
    { key: 'credentialStats', defaultExpanded: false },
    { key: 'priceSettings', defaultExpanded: false }
  ];
}
