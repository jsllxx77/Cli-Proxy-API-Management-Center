# Usage Page Performance Design

**Problem:** Entering the usage statistics page becomes janky when the usage snapshot grows large because the page eagerly performs repeated full-data scans and mounts all heavy subviews at once.

**Goal:** Reduce first-entry main-thread work without changing the management API contract, and keep existing usage features available through progressive disclosure.

## Root Cause

- The page receives an ever-growing `/usage` snapshot and immediately runs `filterUsageByTimeRange()` over the full history.
- Multiple components re-scan the same usage snapshot independently instead of sharing derived results.
- Heavy sections such as request events and credential statistics mount on first render even though they are not required for the first meaningful paint.
- The page issues duplicate auth file lookups from multiple child components.

## Chosen Approach

Keep the backend contract unchanged and optimize the WebUI in three layers:

1. Add a shared derived-usage hook that computes filtered usage, filtered details, auth-file metadata, and lightweight aggregates once per page render.
2. Gate heavy panels behind explicit expansion so the first render only mounts summary cards and charts.
3. Update the heavy panels to consume precomputed details/auth metadata instead of recomputing them internally.

## Rejected Alternatives

### Backend pagination or summary-only usage endpoint

This would likely help the most long term, but it requires coordinated changes with the main CLIProxyAPI server and risks breaking existing single-file deployment expectations.

### Virtualize the request events table only

This reduces DOM cost but does not address the more expensive full-data mapping, sorting, chart preparation, and duplicated scans across the page.

## Data Flow

- `useUsageData()` still owns loading the raw usage snapshot from the Zustand store.
- A new page-level hook or helper computes:
  - filtered usage snapshot for charts/cards
  - filtered `usageDetails`
  - full-history `usageDetails` only where still necessary
  - shared auth-file map
- Lightweight components use the filtered derived data directly.
- Heavy detail cards mount only after the user expands them.

## UX Changes

- First screen still shows key metrics, service health, main charts, token breakdown, and cost trend.
- Request events, credential statistics, and price settings become collapsed cards with an explicit expand action.
- Existing export/import behavior remains unchanged.

## Risk Management

- No API shape changes.
- No behavior changes for filters or totals, only when certain secondary sections render.
- Keep heavy sections fully functional after expansion.

## Validation

- Add regression coverage for the new collapse/expand behavior.
- Add unit coverage for the new shared derivation helper to ensure it reuses provided details and auth metadata correctly.
- Run build and targeted tests before push.
