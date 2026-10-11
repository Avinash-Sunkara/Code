import { Request, RequestHandler, Response, Router } from 'express';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { ProtectedType } from '@prisma/client';
import { prisma } from '../config/db';
import { ApiError, E } from '../utils/http';
import { audit } from '../services/audit';
import { grantEntitlement } from '../services/payment';
import * as storage from '../services/storage';
import { upload } from './me';
import { pageOf, pq, send } from './util';

// ───── Body helpers (JSON or multipart; multipart sends everything as strings) ─────
export const s = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v).trim());
export const sn = (v: unknown): string | null | undefined => { const x = s(v); return x === undefined ? undefined : x === '' ? null : x; }; // '' clears
export const n = (v: unknown): number | undefined => { if (v === undefined || v === null || v === '') return undefined; const x = Number(v); if (!Number.isFinite(x)) throw new ApiError(422, 'INVALID', 'Expected a number'); return x; };
export const b = (v: unknown): boolean | undefined => (v === undefined || v === null || v === '' ? undefined : v === true || v === 'true' || v === '1' || v === 'on');
export const arr = (v: unknown): string[] | undefined => (v === undefined || v === null ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean));
export const need = <T>(v: T | undefined | null, label: string): T => { if (v === undefined || v === null || (v as unknown) === '') throw new ApiError(422, 'REQUIRED', `${label} is required`); return v; };
export const strip = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T; // undefined = "not sent" → leave column unchanged
export const urlOrNull = (v: unknown) => { const x = sn(v); if (x && !/^https?:\/\//i.test(x)) throw new ApiError(422, 'INVALID_URL', 'URLs must start with http:// or https://'); return x; };

export const filesOf = (req: Request, field: string) => ((req.files as Express.Multer.File[] | undefined) ?? []).filter((f) => f.fieldname === field || f.fieldname === `${field}[]`);

/** Resize to a small WebP and inline it as a data URL (avoids needing a public bucket for logos, avatars and previews). */
export async function imageData(f: Express.Multer.File, size: number) {
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(f.mimetype)) throw new ApiError(422, 'UNSUPPORTED_FILE_TYPE', 'Use a PNG, JPG, WebP or GIF image');
  try { return `data:image/webp;base64,${(await sharp(f.buffer).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()).toString('base64')}`; }
  catch { throw new ApiError(422, 'INVALID_IMAGE', 'That file is not a valid image'); }
}

/** One PDF stays a PDF; several images are merged, in order, into a single PDF. Returns a private storage key. */
export async function storeDocument(files: Express.Multer.File[], folder: string): Promise<string> {
  if (!files.length) throw E.badRequest('No file uploaded');
  const pdfs = files.filter((f) => f.mimetype === 'application/pdf');
  if (pdfs.length) {
    if (files.length > 1) throw new ApiError(422, 'MIXED_FILES', 'Upload one PDF, or several images — not both');
    if (pdfs[0].buffer.subarray(0, 5).toString() !== '%PDF-') throw new ApiError(422, 'INVALID_PDF', 'That file is not a valid PDF');
    return storage.putObject(storage.newKey(folder, 'application/pdf'), pdfs[0].buffer, 'application/pdf');
  }
  const doc = await PDFDocument.create();
  for (const f of files) {
    if (!/^image\/(png|jpe?g|webp)$/.test(f.mimetype)) throw new ApiError(422, 'UNSUPPORTED_FILE_TYPE', 'Only PDF, PNG, JPG and WebP files are allowed');
    const jpg = await sharp(f.buffer).rotate().resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const img = await doc.embedJpg(jpg);
    doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return storage.putObject(storage.newKey(folder, 'application/pdf'), Buffer.from(await doc.save()), 'application/pdf');
}

// ───── Access (FREE | PREMIUM | PRIVATE) ↔ AccessType + price + per-email grants ─────
export const accessIn = (body: any) => {
  const a = s(body.access);
  if (a === undefined) return {};
  if (!['FREE', 'PREMIUM', 'PRIVATE'].includes(a)) throw new ApiError(422, 'INVALID', 'Invalid access type');
  const price = a === 'PREMIUM' ? n(body.price) ?? 0 : 0;
  if (a === 'PREMIUM' && price <= 0) throw new ApiError(422, 'PRICE_REQUIRED', 'Premium content needs a price greater than 0');
  return { accessType: (a === 'PRIVATE' ? 'SELECTED_USERS' : a) as 'FREE' | 'PREMIUM' | 'SELECTED_USERS', price };
};
export const accessOut = (x: { accessType: string; price: unknown }) => ({ access: x.accessType === 'SELECTED_USERS' ? 'PRIVATE' : x.accessType, ...(x.accessType === 'PREMIUM' ? { price: Number(x.price) } : {}) });

export async function allowedEmailsOf(type: ProtectedType, id: string) {
  const [granted, pending] = await Promise.all([
    prisma.contentEntitlement.findMany({ where: { contentType: type, contentId: id, source: 'ADMIN_GRANT' }, select: { user: { select: { email: true } } } }),
    prisma.pendingEntitlement.findMany({ where: { contentType: type, contentId: id }, select: { email: true } }),
  ]);
  return [...new Set([...granted.map((g) => g.user.email), ...pending.map((p) => p.email)])].sort();
}

/** Make the set of admin-granted emails equal to `emails` (verified accounts get access now, others are held until verified). */
export async function syncAllowedEmails(type: ProtectedType, id: string, emails: string[], adminId: string) {
  const want = new Set(emails.map((e) => e.toLowerCase()));
  for (const e of want) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new ApiError(422, 'INVALID_EMAIL', `"${e}" is not a valid email address`);
  const users = await prisma.user.findMany({ where: { email: { in: [...want] } } });
  const byEmail = new Map(users.map((u) => [u.email, u]));
  for (const email of want) {
    const u = byEmail.get(email);
    if (u?.emailVerified) await grantEntitlement(u.id, type, id, 'ADMIN_GRANT', adminId);
    else await prisma.pendingEntitlement.upsert({ where: { email_contentType_contentId: { email, contentType: type, contentId: id } }, create: { email, contentType: type, contentId: id, grantedBy: adminId }, update: {} });
  }
  await prisma.contentEntitlement.deleteMany({ where: { contentType: type, contentId: id, source: 'ADMIN_GRANT', user: { email: { notIn: [...want] } } } });
  await prisma.pendingEntitlement.deleteMany({ where: { contentType: type, contentId: id, email: { notIn: [...want] } } });
}

// ───── Generic CRUD router ─────
export interface Spec {
  path: string; model: string; entity: string;
  search?: string[]; orderBy: any; include?: any;
  filter?: (req: Request) => Record<string, unknown>;
  row: (r: any) => unknown | Promise<unknown>;
  /** returns prisma create/update data (undefined values are ignored) */
  write: (req: Request, body: any, create: boolean, existing?: any) => Promise<Record<string, unknown>>;
  after?: (item: any, body: any, req: Request, create: boolean) => Promise<void>;
  publishField?: string; orderField?: string;
  siblings?: (row: any) => Record<string, unknown>;
  onDelete?: (row: any) => Promise<void>;
}

const hasFiles: RequestHandler = (req, res, next) => (req.is('multipart/form-data') ? upload.any()(req, res, next) : next());

export function crud(sp: Spec) {
  const r = Router();
  const db = () => (prisma as any)[sp.model];

  r.get('/', async (req: Request, res: Response) => {
    const p = pq(req, 20, 200);
    const where: any = { ...(sp.filter?.(req) ?? {}) };
    if (p.q && sp.search?.length) where.OR = sp.search.map((f) => ({ [f]: { contains: p.q, mode: 'insensitive' } }));
    const [items, total] = await Promise.all([db().findMany({ where, orderBy: sp.orderBy, skip: p.skip, take: p.take, include: sp.include }), db().count({ where })]);
    send(res, pageOf(await Promise.all(items.map(sp.row)), total, p));
  });

  r.post('/', hasFiles, async (req: Request, res: Response) => {
    const data = strip(await sp.write(req, req.body ?? {}, true));
    const item = await db().create({ data, include: sp.include });
    await sp.after?.(item, req.body ?? {}, req, true);
    await audit(req, `${sp.entity}.create`, sp.entity, item.id);
    send(res, await sp.row(await db().findUnique({ where: { id: item.id }, include: sp.include })), 201);
  });

  r.put('/:id', hasFiles, async (req: Request, res: Response) => {
    const existing = await db().findUnique({ where: { id: req.params.id }, include: sp.include });
    if (!existing) throw E.notFound(`${sp.entity} not found`);
    const data = strip(await sp.write(req, req.body ?? {}, false, existing));
    const item = Object.keys(data).length ? await db().update({ where: { id: existing.id }, data, include: sp.include }) : existing;
    await sp.after?.(item, req.body ?? {}, req, false);
    await audit(req, `${sp.entity}.update`, sp.entity, item.id, { fields: Object.keys(data) });
    send(res, await sp.row(await db().findUnique({ where: { id: item.id }, include: sp.include })));
  });

  r.delete('/:id', async (req: Request, res: Response) => {
    const existing = await db().findUnique({ where: { id: req.params.id }, include: sp.include });
    if (!existing) throw E.notFound(`${sp.entity} not found`);
    await db().delete({ where: { id: existing.id } });
    await sp.onDelete?.(existing);
    await audit(req, `${sp.entity}.delete`, sp.entity, existing.id);
    res.status(204).end();
  });

  if (sp.publishField) {
    r.patch('/:id/publish', async (req: Request, res: Response) => {
      const published = b(req.body?.published);
      if (published === undefined) throw new ApiError(422, 'REQUIRED', 'published is required');
      const item = await db().update({ where: { id: req.params.id }, data: { [sp.publishField!]: published }, include: sp.include });
      await sp.after?.(item, {}, req, false);
      await audit(req, `${sp.entity}.${published ? 'publish' : 'unpublish'}`, sp.entity, item.id);
      send(res, await sp.row(item));
    });
  }

  if (sp.orderField) {
    r.patch('/:id/reorder', async (req: Request, res: Response) => {
      const dir = req.body?.direction === 'up' ? -1 : req.body?.direction === 'down' ? 1 : 0;
      if (!dir) throw new ApiError(422, 'INVALID', 'direction must be up or down');
      const item = await db().findUnique({ where: { id: req.params.id } });
      if (!item) throw E.notFound(`${sp.entity} not found`);
      const list: { id: string }[] = await db().findMany({ where: sp.siblings?.(item) ?? {}, orderBy: [{ [sp.orderField!]: 'asc' }, { id: 'asc' }], select: { id: true } });
      const i = list.findIndex((x) => x.id === item.id), j = i + dir;
      if (j < 0 || j >= list.length) return void send(res, { moved: false });
      [list[i], list[j]] = [list[j], list[i]];
      await prisma.$transaction(list.map((x, k) => db().update({ where: { id: x.id }, data: { [sp.orderField!]: k } })));
      send(res, { moved: true });
    });
  }
  return r;
}
