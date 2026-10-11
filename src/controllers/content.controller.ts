import { Request, Response } from 'express';
import { z } from 'zod';
import { ProtectedType } from '@prisma/client';
import { prisma } from '../config/db';
import { apiUrl, frontendOrigins } from '../config/env';
import { E, ok, page } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { canAccess, entitledIds, isLocked, levelOf } from '../services/access';
import { logActivity } from '../services/activity';
import * as storage from '../services/storage';
import { FileKind, signFileToken, verifyFileToken, watermarkImage, watermarkPdf } from '../services/secureFile';

const idOrSlug = (v: string) => ({ OR: [{ id: v }, { slug: v }] });

// ───── Lists (metadata only: never file keys, content or external URLs) ─────
export async function listNotes(req: Request, res: Response) {
  const f = z.object({ category: z.string().max(100).optional(), q: z.string().max(100).optional(), accessType: z.enum(['FREE', 'PREMIUM', 'SELECTED_USERS']).optional() }).parse(req.query);
  const p = pageParams(req.query, { sortable: ['title', 'price'] });
  const owned = await entitledIds(req.user?.id, 'NOTE');
  const where: any = { isPublished: true, ...(f.category && { category: f.category }), ...(f.accessType && { accessType: f.accessType }),
    ...(req.user?.role === 'ADMIN' ? {} : { AND: [{ OR: [{ accessType: { not: 'SELECTED_USERS' } }, { id: { in: [...owned] } }] }] }), // selected-user content is invisible to everyone else
    ...(f.q && { OR: [{ title: { contains: f.q, mode: 'insensitive' } }, { description: { contains: f.q, mode: 'insensitive' } }] }) };
  const [rows, total] = await Promise.all([
    prisma.note.findMany({ where, orderBy: p.orderBy, skip: p.skip, take: p.take, select: { id: true, title: true, slug: true, description: true, category: true, contentType: true, previewImageUrl: true, price: true, accessType: true, createdAt: true } }),
    prisma.note.count({ where }),
  ]);
  page(res, rows.map((n) => ({ ...n, locked: isLocked(req.user, n, owned) })), total, p.page, p.limit);
}

export async function listCheatSheets(req: Request, res: Response) {
  const f = z.object({ category: z.enum(['DSA', 'JAVA', 'SQL', 'DBMS', 'OS', 'CN', 'APTITUDE', 'GIT_GITHUB']).optional(), q: z.string().max(100).optional() }).parse(req.query);
  const p = pageParams(req.query, { sortable: ['title', 'price'] });
  const owned = await entitledIds(req.user?.id, 'CHEATSHEET');
  const where: any = { isPublished: true, ...(f.category && { category: f.category }), ...(f.q && { title: { contains: f.q, mode: 'insensitive' } }),
    ...(req.user?.role === 'ADMIN' ? {} : { AND: [{ OR: [{ accessType: { not: 'SELECTED_USERS' } }, { id: { in: [...owned] } }] }] }) };
  const [rows, total] = await Promise.all([
    prisma.cheatSheet.findMany({ where, orderBy: p.orderBy, skip: p.skip, take: p.take, select: { id: true, title: true, slug: true, category: true, description: true, previewImageUrl: true, price: true, accessType: true, createdAt: true } }),
    prisma.cheatSheet.count({ where }),
  ]);
  page(res, rows.map((n) => ({ ...n, locked: isLocked(req.user, n, owned) })), total, p.page, p.limit);
}

export async function noteMeta(req: Request, res: Response) {
  const n = await prisma.note.findFirst({ where: { isPublished: true, ...idOrSlug(req.params.id) }, select: { id: true, title: true, slug: true, description: true, category: true, contentType: true, previewImageUrl: true, price: true, accessType: true } });
  if (!n) throw E.notFound();
  ok(res, { ...n, locked: isLocked(req.user, n, await entitledIds(req.user?.id, 'NOTE')) });
}
export async function cheatSheetMeta(req: Request, res: Response) {
  const n = await prisma.cheatSheet.findFirst({ where: { isPublished: true, ...idOrSlug(req.params.id) }, select: { id: true, title: true, slug: true, category: true, description: true, previewImageUrl: true, price: true, accessType: true } });
  if (!n) throw E.notFound();
  ok(res, { ...n, locked: isLocked(req.user, n, await entitledIds(req.user?.id, 'CHEATSHEET')) });
}

// ───── Protected delivery ─────
interface Loaded { type: ProtectedType; item: any; fileKey: string | null; mime: 'pdf' | 'image' | null; allowed: (u: any) => Promise<boolean>; payload: (token?: string) => any }

async function load(kind: FileKind, idv: string, isAdmin: boolean): Promise<Loaded> {
  if (kind === 'note') {
    const n = await prisma.note.findFirst({ where: { ...idOrSlug(idv), ...(isAdmin ? {} : { isPublished: true }) } });
    if (!n) throw E.notFound();
    return { type: 'NOTE', item: n, fileKey: n.fileKey, mime: n.contentType === 'PDF' ? 'pdf' : n.contentType === 'IMAGE' ? 'image' : null,
      allowed: (u) => canAccess(u, 'NOTE', n),
      payload: (t) => n.contentType === 'EXTERNAL' ? { mode: 'external', url: n.externalUrl } : n.contentType === 'HTML' || n.contentType === 'MARKDOWN' ? { mode: 'inline', format: n.contentType, content: n.content } : { mode: 'stream', url: t, contentType: n.contentType } };
  }
  if (kind === 'cheatsheet') {
    const n = await prisma.cheatSheet.findFirst({ where: { ...idOrSlug(idv), ...(isAdmin ? {} : { isPublished: true }) } });
    if (!n) throw E.notFound();
    return { type: 'CHEATSHEET', item: n, fileKey: n.fileKey, mime: n.fileKey ? (n.fileKey.endsWith('.pdf') ? 'pdf' : 'image') : null,
      allowed: (u) => canAccess(u, 'CHEATSHEET', n),
      payload: (t) => n.fileKey ? { mode: 'stream', url: t, content: n.content } : { mode: 'inline', format: 'MARKDOWN', content: n.content } };
  }
  const r = await prisma.roadmapResource.findUnique({ where: { id: idv }, include: { topic: { include: { section: { include: { roadmap: true } } } } } });
  const rm = r?.topic.section.roadmap;
  if (!r || !rm || (!isAdmin && !rm.isPublished)) throw E.notFound();
  return { type: 'ROADMAP_RESOURCE', item: r, fileKey: r.fileKey, mime: r.type === 'PDF' ? 'pdf' : r.type === 'IMAGE' ? 'image' : null,
    allowed: (u) => canAccess(u, 'ROADMAP_RESOURCE', { id: r.id, isPremium: r.isPremium || rm.isPremium }, { type: 'ROADMAP', id: rm.id }),
    payload: (t) => r.type === 'VIDEO' ? { mode: 'external', url: r.youtubeUrl } : r.type === 'LINK' ? { mode: 'external', url: r.externalUrl } : r.type === 'TEXT' ? { mode: 'inline', format: 'MARKDOWN', content: r.content } : { mode: 'stream', url: t } };
}

/** POST /:kind/:id/access  -> checks auth, published, status, entitlement; returns inline content, external link or a 5-minute stream URL. */
export const requestAccess = (kind: FileKind) => async (req: Request, res: Response) => {
  const user = req.user!;
  const l = await load(kind, req.params.id, user.role === 'ADMIN');
  if (!(await l.allowed(user))) {
    throw E.forbidden('Access required: purchase this content or ask an admin for access', 'CONTENT_LOCKED', { contentType: l.type, contentId: l.item.id, accessType: l.item.accessType ?? (l.item.isPremium ? 'PREMIUM' : 'FREE'), price: l.item.price });
  }
  const token = signFileToken(user.id, kind, l.item.id);
  const url = `${apiUrl}/api/files/${kind}/${l.item.id}?token=${token}`;
  await logActivity(user.id, kind === 'cheatsheet' ? 'CHEATSHEET_VIEWED' : 'NOTE_VIEWED', { refType: l.type, refId: l.item.id });
  const body = l.payload(url);
  if (body.mode === 'stream') { if (!l.fileKey) throw E.notFound('No file attached'); body.expiresIn = 300; }
  ok(res, { id: l.item.id, title: l.item.title, access: levelOf(l.item), ...body });
};

/** GET /api/files/:kind/:id?token=…  Authorises again on every request, watermarks, streams. No public URL exists. */
export async function streamFile(req: Request, res: Response) {
  const kind = req.params.kind as FileKind;
  if (!['note', 'cheatsheet', 'resource'].includes(kind)) throw E.notFound();
  let t;
  try { t = verifyFileToken(String(req.query.token ?? '')); } catch { throw E.unauthorized('Link expired', 'LINK_EXPIRED'); }
  if (t.kind !== kind || t.id !== req.params.id) throw E.forbidden('Token mismatch');
  const user = await prisma.user.findUnique({ where: { id: t.userId } });
  if (!user || user.status !== 'ACTIVE') throw E.forbidden('Account not active', 'ACCOUNT_INACTIVE');
  const l = await load(kind, t.id, user.role === 'ADMIN');
  if (!(await l.allowed(user))) throw E.forbidden('Access required', 'CONTENT_LOCKED');
  if (!l.fileKey || !l.mime) throw E.notFound('No file attached');

  const raw = await storage.getObject(l.fileKey);
  const out = l.mime === 'pdf' ? await watermarkPdf(raw, user.email) : await watermarkImage(raw, user.email);
  res.removeHeader('X-Frame-Options');
  res.set({
    'Content-Type': l.mime === 'pdf' ? 'application/pdf' : l.fileKey.endsWith('.png') ? 'image/png' : l.fileKey.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
    'Content-Disposition': `inline; filename="document.${l.mime === 'pdf' ? 'pdf' : 'img'}"`,
    'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `frame-ancestors ${frontendOrigins.join(' ')}`,
    'Content-Length': String(out.length),
  });
  res.end(out);
}
