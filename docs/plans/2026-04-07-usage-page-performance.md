# Usage Page Performance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the usage statistics page feel responsive on entry by reducing redundant full-data work and deferring heavy detail sections until the user asks for them.

**Architecture:** Keep the management API unchanged and solve the issue inside the WebUI. Introduce one shared page-level derivation layer for filtered usage details/auth metadata, then progressively mount heavy sections instead of rendering every chart and table immediately.

**Tech Stack:** React 19, TypeScript, Zustand, Chart.js, Vite

---

### Task 1: Add shared usage-page derivation helpers

**Files:**
- Create: `src/pages/usagePageDerived.ts`
- Test: `tests/usagePageDerived.test.ts`

**Step 1: Write the failing test**

Cover:
- reusing precomputed details instead of recollecting
- deriving filtered usage/details once
- preserving full usage for service health when needed

**Step 2: Run test to verify it fails**

Run: `npm exec --yes tsx --test tests/usagePageDerived.test.ts`
Expected: FAIL because the helper does not exist yet.

**Step 3: Write minimal implementation**

Implement a pure helper that accepts raw usage, time range, and optional precomputed details, then returns the derived structures needed by the page.

**Step 4: Run test to verify it passes**

Run: `npm exec --yes tsx --test tests/usagePageDerived.test.ts`
Expected: PASS

### Task 2: Add collapsible heavy sections

**Files:**
- Create: `src/components/usage/ExpandableUsageSection.tsx`
- Modify: `src/pages/UsagePage.tsx`
- Modify: `src/pages/UsagePage.module.scss`
- Test: `tests/usagePageSections.test.tsx`

**Step 1: Write the failing test**

Cover:
- heavy sections are collapsed on first render
- expand button mounts section content

**Step 2: Run test to verify it fails**

Run: `npm exec --yes vitest run tests/usagePageSections.test.tsx`
Expected: FAIL because the collapsible wrapper does not exist yet.

**Step 3: Write minimal implementation**

Add a small reusable expand/collapse wrapper and gate request events, credential statistics, and price settings behind it.

**Step 4: Run test to verify it passes**

Run: `npm exec --yes vitest run tests/usagePageSections.test.tsx`
Expected: PASS

### Task 3: Remove duplicated expensive work from heavy cards

**Files:**
- Modify: `src/components/usage/RequestEventsDetailsCard.tsx`
- Modify: `src/components/usage/CredentialStatsCard.tsx`
- Modify: `src/components/usage/ServiceHealthCard.tsx`
- Modify: `src/components/usage/StatCards.tsx`
- Modify: `src/components/usage/hooks/useSparklines.ts`
- Modify: `src/components/usage/hooks/useChartData.ts`
- Modify: `src/pages/UsagePage.tsx`
- Test: `tests/usagePageDerived.test.ts`

**Step 1: Write the failing test**

Add assertions for components/helpers consuming supplied details/auth metadata instead of recomputing internally.

**Step 2: Run test to verify it fails**

Run: `npm exec --yes tsx --test tests/usagePageDerived.test.ts`
Expected: FAIL because the new props/data flow are not wired yet.

**Step 3: Write minimal implementation**

- Thread shared `usageDetails` and auth metadata through the page.
- Remove duplicate `authFilesApi.list()` calls from child components.
- Keep service health on full-history details while using filtered details elsewhere.

**Step 4: Run test to verify it passes**

Run: `npm exec --yes tsx --test tests/usagePageDerived.test.ts`
Expected: PASS

### Task 4: Verify and ship

**Files:**
- Modify: `package.json` if a minimal test runner dependency is required

**Step 1: Run targeted verification**

Run:
- `npm exec --yes tsx --test tests/usagePageDerived.test.ts`
- `npm exec --yes vitest run tests/usagePageSections.test.tsx`
- `npm run build`

Expected: all pass, build exits with code 0.

**Step 2: Commit**

```bash
git add docs/plans tests src
git commit -m "perf: reduce usage page startup work"
```

**Step 3: Push**

```bash
git push origin main
```
