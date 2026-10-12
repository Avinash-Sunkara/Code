import { Request, Response, Router } from 'express';
import { CheatSheetCategory, Prisma, ProtectedType } from '@prisma/client';
import { prisma } from '../config/db';
import { apiUrl } from '../config/env';
import { E } from '../utils/http';
import { authenticate, optionalAuth } from '../middleware/auth';
import { canAccess, entitledIds, isLocked, levelOf } from '../services/access';
import { logActivity } from '../services/activity';
import * as storage from '../services/storage';
import { signFileToken, watermarkImage, watermarkPdf } from '../services/secureFile';
import { send } from './util';

const r = Router();
const idOrSlug = (v: string) => ({ OR: [{ id: v }, { slug: v }] });
const accessOut = (a: string) => (a === 'SELECTED_USERS' ? 'PRIVATE' : a === 'PREMIUM' ? 'PREMIUM' : 'FREE');

const CS_LABEL: Record<CheatSheetCategory, string> = { DSA: 'DSA', JAVA: 'Java', SQL: 'SQL', DBMS: 'DBMS', OS: 'OS', CN: 'CN', APTITUDE: 'Aptitude', GIT_GITHUB: 'Git & GitHub' };
const csFromLabel = (s: string): CheatSheetCategory | undefined => (Object.entries(CS_LABEL).find(([k, v]) => v.toLowerCase() === s.toLowerCase() || k.toLowerCase() === s.toLowerCase())?.[0] as CheatSheetCategory | undefined);

/** Small, safe Markdown → HTML for admin-authored text (everything is escaped first). */
export function mdToHtml(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out: string[] = []; let list: 'ul' | 'ol' | null = null; let code: string[] | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of src.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('```')) { if (code) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else { close(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line), ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (h) { close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (ul || ol) { const want = ul ? 'ul' : 'ol'; if (list !== want) { close(); out.push(`<${want}>`); list = want; } out.push(`<li>${inline((ul ?? ol)![1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  close();
  return out.join('\n');
}

/** Admin-authored text: HTML is passed through (the frontend sanitises it); anything else is treated as Markdown. */
export const renderBody = (s: string | null | undefined) => (s && /<[a-z][\s\S]*>/i.test(s) ? s : mdToHtml(s ?? ''));

const noteSel = { id: true, title: true, slug: true, description: true, category: true, contentType: true, previewImageUrl: true, price: true, accessType: true, updatedAt: true } satisfies Prisma.NoteSelect;
const noteOut = (n: Prisma.NoteGetPayload<{ select: typeof noteSel }>, locked: boolean) => ({
  id: n.id, title: n.title, ...(n.description ? { description: n.description } : {}), category: n.category ?? 'General',
  ...(n.previewImageUrl ? { previewUrl: n.previewImageUrl } : {}), access: accessOut(n.accessType), ...(n.accessType === 'PREMIUM' ? { price: Number(n.price) } : {}),
  locked, updatedAt: n.updatedAt.toISOString(),
});

const csSel = { id: true, title: true, slug: true, category: true, description: true, previewImageUrl: true, price: true, accessType: true, fileKey: true, updatedAt: true } satisfies Prisma.CheatSheetSelect;
const csOut = (n: Prisma.CheatSheetGetPayload<{ select: typeof csSel }>, locked: boolean) => ({
  id: n.id, title: n.title, category: CS_LABEL[n.category], ...(n.description ? { description: n.description } : {}),
  ...(n.previewImageUrl ? { previewUrl: n.previewImageUrl } : {}), access: accessOut(n.accessType), ...(n.accessType === 'PREMIUM' ? { price: Number(n.price) } : {}), locked,
});

const hidden = (user: Request['user'], owned: Set<string>) => (user?.role === 'ADMIN' ? {} : { AND: [{ OR: [{ accessType: { not: 'SELECTED_USERS' as const } }, { id: { in: [...owned] } }] }] });

r.get('/certifications', async (_req: Request, res: Response) => {
  const rows = await prisma.certification.findMany({ where: { isPublished: true }, orderBy: [{ order: 'asc' }, { createdAt: 'desc' }] });
  send(res, rows.map((x) => ({ id: x.id, title: x.title, provider: x.provider, description: x.description ?? '', url: x.url, ...(x.imageUrl ? { imageUrl: x.imageUrl } : {}) })));
});

r.get('/notes', optionalAuth, async (req: Request, res: Response) => {
  const cat = String(req.query.category ?? '').trim();
  const owned = await entitledIds(req.user?.id, 'NOTE');
  const rows = await prisma.note.findMany({ where: { isPublished: true, ...(cat ? { category: { equals: cat, mode: 'insensitive' } } : {}), ...hidden(req.user, owned) }, orderBy: { createdAt: 'desc' }, select: noteSel });
  send(res, rows.map((n) => noteOut(n, isLocked(req.user, n, owned))));
});

r.get('/notes/:id', optionalAuth, async (req: Request, res: Response) => {
  const n = await prisma.note.findFirst({ where: { isPublished: true, ...idOrSlug(req.params.id) }, select: noteSel });
  if (!n) throw E.notFound('Note not found');
  const owned = await entitledIds(req.user?.id, 'NOTE');
  if (n.accessType === 'SELECTED_USERS' && req.user?.role !== 'ADMIN' && !owned.has(n.id)) throw E.notFound('Note not found');
  send(res, noteOut(n, isLocked(req.user, n, owned)));
});

r.get('/cheat-sheets', optionalAuth, async (req: Request, res: Response) => {
  const cat = csFromLabel(String(req.query.category ?? ''));
  const owned = await entitledIds(req.user?.id, 'CHEATSHEET');
  const rows = await prisma.cheatSheet.findMany({ where: { isPublished: true, ...(cat ? { category: cat } : {}), ...hidden(req.user, owned) }, orderBy: { createdAt: 'desc' }, select: csSel });
  send(res, rows.map((n) => csOut(n, isLocked(req.user, n, owned))));
});

r.get('/cheat-sheets/:id', optionalAuth, async (req: Request, res: Response) => {
  const n = await prisma.cheatSheet.findFirst({ where: { isPublished: true, ...idOrSlug(req.params.id) }, select: { ...csSel, content: true } });
  if (!n) throw E.notFound('Cheat sheet not found');
  const owned = await entitledIds(req.user?.id, 'CHEATSHEET');
  if (n.accessType === 'SELECTED_USERS' && req.user?.role !== 'ADMIN' && !owned.has(n.id)) throw E.notFound('Cheat sheet not found');
  const locked = isLocked(req.user, n, owned);
  const base = csOut(n, locked);
  if (locked) return void send(res, base);
  if (n.fileKey) return void send(res, { ...base, fileUrl: 'protected' }); // placeholder only: the file is served through /viewer + /pdf
  send(res, { ...base, html: renderBody(n.content) });
});

// ───── Viewer + streaming (cookie-authenticated, watermarked, never cached) ─────
type Kind = 'note' | 'cheatsheet';
async function loadFor(kind: Kind, key: string, req: Request) {
  const user = req.user!;
  const admin = user.role === 'ADMIN';
  if (kind === 'note') {
    const n = await prisma.note.findFirst({ where: { ...idOrSlug(key), ...(admin ? {} : { isPublished: true }) } });
    if (!n) throw E.notFound('Note not found');
    return { type: 'NOTE' as ProtectedType, item: n, fileKey: n.fileKey, pdf: n.contentType === 'PDF', image: n.contentType === 'IMAGE', allowed: await canAccess(user, 'NOTE', n) };
  }
  const c = await prisma.cheatSheet.findFirst({ where: { ...idOrSlug(key), ...(admin ? {} : { isPublished: true }) } });
  if (!c) throw E.notFound('Cheat sheet not found');
  return { type: 'CHEATSHEET' as ProtectedType, item: c, fileKey: c.fileKey, pdf: !!c.fileKey && c.fileKey.endsWith('.pdf'), image: !!c.fileKey && !c.fileKey.endsWith('.pdf'), allowed: await canAccess(user, 'CHEATSHEET', c) };
}

const base = (kind: Kind) => (kind === 'note' ? 'notes' : 'cheat-sheets');
function viewer(kind: Kind) {
  return async (req: Request, res: Response) => {
    const l = await loadFor(kind, req.params.id, req);
    if (!l.allowed) throw E.forbidden('Access required: unlock this content to read it', 'CONTENT_LOCKED');
    const item = l.item as any;
    await logActivity(req.user!.id, kind === 'note' ? 'NOTE_VIEWED' : 'CHEATSHEET_VIEWED', { refType: l.type, refId: item.id });
    const head = { id: item.id as string, title: item.title as string, watermark: req.user!.email };
    if (l.pdf && l.fileKey) return void send(res, { ...head, kind: 'pdf', pageCount: 0, pdfPath: `/${base(kind)}/${item.id}/pdf`, searchable: true });
    if (l.image && l.fileKey) {
      const token = signFileToken(req.user!.id, kind, item.id, 900);
      return void send(res, { ...head, kind: 'images', pageCount: 1, pageUrlTemplate: `${apiUrl}/api/files/${kind}/${item.id}?token=${token}&page={page}` });
    }
    if (kind === 'note') {
      if (item.contentType === 'EXTERNAL' && item.externalUrl) return void send(res, { ...head, kind: 'html', pageCount: 1, html: `<p><a href="${String(item.externalUrl).replace(/"/g, '%22')}" target="_blank" rel="noopener noreferrer">Open the resource</a></p>` });
      return void send(res, { ...head, kind: 'html', pageCount: 1, html: item.contentType === 'MARKDOWN' ? mdToHtml(item.content ?? '') : item.content ?? '' });
    }
    send(res, { ...head, kind: 'html', pageCount: 1, html: renderBody(item.content) });
  };
}

function pdfStream(kind: Kind) {
  return async (req: Request, res: Response) => {
    const l = await loadFor(kind, req.params.id, req);
    if (!l.allowed) throw E.forbidden('Access required', 'CONTENT_LOCKED');
    if (!l.fileKey || !(l.pdf || l.image)) throw E.notFound('No file attached');
    const raw = await storage.getObject(l.fileKey);
    const out = l.pdf ? await watermarkPdf(raw, req.user!.email) : await watermarkImage(raw, req.user!.email);
    res.removeHeader('X-Frame-Options');
    res.set({ 'Content-Type': l.pdf ? 'application/pdf' : l.fileKey.endsWith('.png') ? 'image/png' : l.fileKey.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
      'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(out.length) });
    res.end(out);
  };
}

for (const kind of ['note', 'cheatsheet'] as const) {
  const p = base(kind);
  r.get(`/${p}/:id/viewer`, authenticate, viewer(kind));
  r.get(`/${p}/:id/pdf`, authenticate, pdfStream(kind));
  r.get(`/${p}/:id/search`, authenticate, async (req: Request, res: Response) => {
    const l = await loadFor(kind, req.params.id, req);
    if (!l.allowed) throw E.forbidden('Access required', 'CONTENT_LOCKED');
    send(res, { pages: [] as number[] }); // PDFs are searched client-side; there is no server text index
  });
}

export { levelOf };
export default r;
