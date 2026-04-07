import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUsageDetails } from '../src/utils/usage';
import {
  buildUsagePageSections,
  deriveUsagePageData,
  type UsagePageSectionKey
} from '../src/pages/usagePageDerived';

const ISO_NOW = '2026-04-07T15:00:00.000Z';
const NOW_MS = Date.parse(ISO_NOW);

function createUsageFixture() {
  return {
    total_requests: 3,
    success_count: 2,
    failure_count: 1,
    total_tokens: 600,
    apis: {
      'POST /v1/messages': {
        total_requests: 3,
        success_count: 2,
        failure_count: 1,
        total_tokens: 600,
        models: {
          'claude-sonnet-4': {
            total_requests: 3,
            success_count: 2,
            failure_count: 1,
            total_tokens: 600,
            details: [
              {
                timestamp: '2026-04-07T14:30:00.000Z',
                source: 'sk-recent',
                auth_index: 1,
                failed: false,
                tokens: {
                  input_tokens: 100,
                  output_tokens: 50,
                  reasoning_tokens: 10,
                  cached_tokens: 0,
                  total_tokens: 160
                }
              },
              {
                timestamp: '2026-04-07T13:15:00.000Z',
                source: 'sk-failed',
                auth_index: 2,
                failed: true,
                tokens: {
                  input_tokens: 120,
                  output_tokens: 0,
                  reasoning_tokens: 0,
                  cached_tokens: 0,
                  total_tokens: 120
                }
              },
              {
                timestamp: '2026-04-05T10:00:00.000Z',
                source: 'sk-older',
                auth_index: 3,
                failed: false,
                tokens: {
                  input_tokens: 200,
                  output_tokens: 100,
                  reasoning_tokens: 20,
                  cached_tokens: 0,
                  total_tokens: 320
                }
              }
            ]
          }
        }
      }
    }
  };
}

test('deriveUsagePageData reuses provided full details and filters only once', () => {
  const usage = createUsageFixture();
  const fullUsageDetails = collectUsageDetails(usage);

  const derived = deriveUsagePageData({
    usage,
    timeRange: '24h',
    fullUsageDetails,
    nowMs: NOW_MS
  });

  assert.equal(derived.fullUsageDetails, fullUsageDetails);
  assert.notEqual(derived.filteredUsage, usage);
  assert.equal(derived.filteredUsageDetails.length, 2);
  assert.deepEqual(
    derived.filteredUsageDetails.map((detail) => detail.source),
    fullUsageDetails.slice(0, 2).map((detail) => detail.source)
  );
});

test('deriveUsagePageData keeps original snapshot and details for the all range', () => {
  const usage = createUsageFixture();
  const fullUsageDetails = collectUsageDetails(usage);

  const derived = deriveUsagePageData({
    usage,
    timeRange: 'all',
    fullUsageDetails,
    nowMs: NOW_MS
  });

  assert.equal(derived.filteredUsage, usage);
  assert.equal(derived.filteredUsageDetails, fullUsageDetails);
});

test('buildUsagePageSections collapses heavy panels by default', () => {
  const sections = buildUsagePageSections();
  const lookup = new Map<UsagePageSectionKey, boolean>(
    sections.map((section) => [section.key, section.defaultExpanded])
  );

  assert.equal(lookup.get('summary'), true);
  assert.equal(lookup.get('serviceHealth'), true);
  assert.equal(lookup.get('charts'), true);
  assert.equal(lookup.get('tokenBreakdown'), true);
  assert.equal(lookup.get('costTrend'), false);
  assert.equal(lookup.get('apiModelBreakdown'), false);
  assert.equal(lookup.get('requestEvents'), false);
  assert.equal(lookup.get('credentialStats'), false);
  assert.equal(lookup.get('priceSettings'), false);
});
