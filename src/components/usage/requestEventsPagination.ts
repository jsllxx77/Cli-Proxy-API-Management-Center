const DEFAULT_PAGE_SIZE = 50;

export interface PaginatedRequestEventRows<T> {
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  rows: T[];
}

export function paginateRequestEventRows<T>(
  rows: T[],
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE
): PaginatedRequestEventRows<T> {
  const totalRows = rows.length;
  const resolvedPageSize =
    Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
  const totalPages = totalRows === 0 ? 1 : Math.ceil(totalRows / resolvedPageSize);
  const resolvedPage =
    Number.isFinite(page) && page > 0 ? Math.min(Math.floor(page), totalPages) : 1;
  const startIndex = (resolvedPage - 1) * resolvedPageSize;

  return {
    page: resolvedPage,
    pageSize: resolvedPageSize,
    totalRows,
    totalPages,
    rows: rows.slice(startIndex, startIndex + resolvedPageSize)
  };
}
