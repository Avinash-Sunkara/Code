import { Request, Router } from 'express';
import { ZodObject, ZodTypeAny } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { E, ok, page } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { uniqueSlug } from '../utils/slug';
import { audit } from '../services/audit';
import { createNotification } from '../services/notification';

export interface CrudOpts {
  model: string;                 // prisma delegate name
  entity: string;                // audit label
  create: ZodTypeAny;
  update?: ZodTypeAny;
  searchFields?: string[];
  filterFields?: string[];
  sortable?: string[];
  defaultSort?: string;
  defaultDir?: 'asc' | 'desc';
  include?: any;
  slugFrom?: string;
  slugScope?: (data: any) => Record<string, unknown>; // uniqueness scope for slugs (e.g. per parent)
  mapData?: (data: any, req: Request, isCreate: boolean) => any;
  afterWrite?: (item: any) => Promise<void>;
  notify?: (item: any) => { title: string; message: string } | null;
}

const coerce = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v);

/** Generic, paginated, validated, audited CRUD router used for every admin CMS entity. Mount behind requireAdmin. */
export function crudRouter(o: CrudOpts) {
  const r = Router();
  const db = () => (prisma as any)[o.model];
  // refined schemas (ZodEffects) expose their object via innerType(); updates are partial and skip cross-field refinements
  const inner = ((o.create as any).innerType?.() ?? o.create) as ZodObject<any>;
  const updateSchema: ZodTypeAny = o.update ?? inner.partial();
  const modelName = o.model[0].toUpperCase() + o.model.slice(1);
  const fields = new Set(Prisma.dmmf.datamodel.models.find((m) => m.name === modelName)?.fields.map((f) => f.name) ?? []);
  const sortable = ['createdAt', 'updatedAt', 'order', ...(o.sortable ?? [])].filter((f) => fields.has(f)); // never sort by a column the model lacks

  const maybeNotify = async (item: any, req: Request) => {
    const n = o.notify?.(item);
    if (n) await createNotification({ ...n, type: 'NEW_CONTENT', createdBy: req.user!.id });
  };

  r.get('/', async (req, res) => {
    const p = pageParams(req.query, { sortable, defaultSort: o.defaultSort ?? 'createdAt', defaultDir: o.defaultDir });
    const where: any = {};
    for (const f of o.filterFields ?? []) if (req.query[f] !== undefined && req.query[f] !== '') where[f] = coerce(req.query[f]);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q && o.searchFields?.length) where.OR = o.searchFields.map((f) => ({ [f]: { contains: q, mode: 'insensitive' } }));
    const [items, total] = await Promise.all([
      db().findMany({ where, orderBy: p.orderBy, skip: p.skip, take: p.take, include: o.include }),
      db().count({ where }),
    ]);
    page(res, items, total, p.page, p.limit);
  });

  r.get('/:id', async (req, res) => {
    const item = await db().findUnique({ where: { id: req.params.id }, include: o.include });
    if (!item) throw E.notFound();
    ok(res, item);
  });

  r.post('/', async (req, res) => {
    let data: any = o.create.parse(req.body);
    if (o.slugFrom && !data.slug) data.slug = await uniqueSlug(o.model, data[o.slugFrom], o.slugScope?.(data));
    if (o.mapData) data = o.mapData(data, req, true);
    const item = await db().create({ data, include: o.include });
    await o.afterWrite?.(item);
    if (item.isPublished === true) await maybeNotify(item, req);
    await audit(req, `${o.entity}.create`, o.entity, item.id);
    ok(res, item, 'Created', 201);
  });

  r.patch('/:id', async (req, res) => {
    const existing = await db().findUnique({ where: { id: req.params.id } });
    if (!existing) throw E.notFound();
    let data: any = updateSchema.parse(req.body);
    if (o.mapData) data = o.mapData(data, req, false);
    const item = await db().update({ where: { id: req.params.id }, data, include: o.include });
    await o.afterWrite?.(item);
    if (existing.isPublished === false && item.isPublished === true) await maybeNotify(item, req);
    await audit(req, `${o.entity}.update`, o.entity, item.id, { fields: Object.keys(data) });
    ok(res, item, 'Updated');
  });

  r.delete('/:id', async (req, res) => {
    const item = await db().delete({ where: { id: req.params.id } });
    await o.afterWrite?.(item);
    await audit(req, `${o.entity}.delete`, o.entity, item.id);
    ok(res, { id: item.id }, 'Deleted');
  });

  return r;
}
