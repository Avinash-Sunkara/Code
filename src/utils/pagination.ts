export interface PageOpts { sortable?: string[]; defaultSort?: string; defaultDir?: 'asc' | 'desc'; maxLimit?: number; defaultLimit?: number }

export function pageParams(q: Record<string, any>, o: PageOpts = {}) {
  const page = Math.max(1, parseInt(String(q.page)) || 1);
  const limit = Math.min(o.maxLimit ?? 100, Math.max(1, parseInt(String(q.limit)) || o.defaultLimit || 20));
  const sortable = o.sortable ?? [];
  const field = sortable.includes(String(q.sort)) ? String(q.sort) : o.defaultSort ?? 'createdAt';
  const dir = q.order === 'asc' || q.order === 'desc' ? (q.order as 'asc' | 'desc') : o.defaultDir ?? 'desc';
  return { page, limit, skip: (page - 1) * limit, take: limit, orderBy: { [field]: dir } as Record<string, 'asc' | 'desc'> };
}
