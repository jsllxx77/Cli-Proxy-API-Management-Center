import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateRequestEventRows } from '../src/components/usage/requestEventsPagination';

type Row = { id: string };

const rows: Row[] = Array.from({ length: 125 }, (_, index) => ({
  id: `row-${index + 1}`
}));

test('paginateRequestEventRows returns first page and total page count', () => {
  const result = paginateRequestEventRows(rows, 1, 50);

  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 50);
  assert.equal(result.totalRows, 125);
  assert.equal(result.totalPages, 3);
  assert.equal(result.rows.length, 50);
  assert.equal(result.rows[0]?.id, 'row-1');
  assert.equal(result.rows[49]?.id, 'row-50');
});

test('paginateRequestEventRows clamps page into valid range', () => {
  const result = paginateRequestEventRows(rows, 999, 50);

  assert.equal(result.page, 3);
  assert.equal(result.rows.length, 25);
  assert.equal(result.rows[0]?.id, 'row-101');
  assert.equal(result.rows[24]?.id, 'row-125');
});

test('paginateRequestEventRows falls back to page 1 for invalid page size', () => {
  const result = paginateRequestEventRows(rows, -2, 0);

  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 50);
  assert.equal(result.rows.length, 50);
});
