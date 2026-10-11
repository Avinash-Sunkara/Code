import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import sharp from 'sharp';
import { prisma } from '../config/db';
import { E } from '../utils/http';
import { authenticate } from '../middleware/auth';
import { CONTRIBUTION_TYPES, contributionDays, getStreak, localDate } from '../services/activity';
import { unreadFor } from '../services/notification';
import { pageOf, pq, send, userOut } from './util';
import { getSettings } from './settings';

const r = Router();
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 20 } });

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function studyMinutes(userId: string) {
  const rows = await prisma.activity.findMany({ where: { userId, type: 'STUDY_SESSION' }, select: { refId: true } });
  return rows.reduce((n, a) => n + (parseInt(a.refId ?? '0') || 0), 0);
}

export async function contributionsFor(userId: string, days = 365) {
  const today = localDate();
  const from = new Date(today.getTime() - (days - 1) * 86_400_000);
  return contributionDays(userId, { gte: from, lte: today });
}

const LABEL: Record<string, string> = {
  PROBLEM_SOLVED: 'Solved', PROBLEM_REVISED: 'Revised', PERSONAL_NOTE_CREATED: 'Notes', STUDY_SESSION: 'Study', PRACTICE: 'Practice',
  ROADMAP_RESOURCE_COMPLETED: 'Roadmaps', COMMENT: 'Comments',
};

r.get('/activity/summary', authenticate, async (req: Request, res: Response) => {
  const uid = req.user!.id;
  const [contributions, streak, minutes, acts] = await Promise.all([
    contributionsFor(uid), getStreak(uid), studyMinutes(uid),
    prisma.activity.groupBy({
      by: ['type'],
      where: { userId: uid, type: { in: CONTRIBUTION_TYPES }, NOT: { refType: 'Puzzle' } },
      _count: { _all: true },
    }),
  ]);
  const byType: Record<string, number> = {};
  for (const a of acts) if (LABEL[a.type]) byType[LABEL[a.type]] = (byType[LABEL[a.type]] ?? 0) + a._count._all;
  send(res, { contributions, total: contributions.reduce((n, c) => n + c.count, 0), current: streak.current, longest: streak.longest, today: iso(localDate()), studyMinutes: minutes, byType });
});

r.get('/activity/calendar', authenticate, async (req: Request, res: Response) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month ?? ''));
  const now = localDate();
  const y = m ? +m[1] : now.getUTCFullYear(), mo = m ? +m[2] - 1 : now.getUTCMonth();
  const rows = await contributionDays(req.user!.id, {
    gte: new Date(Date.UTC(y, mo, 1)),
    lt: new Date(Date.UTC(y, mo + 1, 1)),
    lte: now,
  });
  send(res, { days: Object.fromEntries(rows.map((x) => [x.date, x.count])), streak: (await getStreak(req.user!.id)).current, today: iso(now) });
});

r.get('/activity/feed', authenticate, async (req: Request, res: Response) => {
  const p = pq(req, 20);
  const where: Prisma.ActivityWhereInput = {
    userId: req.user!.id,
    type: { notIn: ['LOGIN', 'LOGOUT'] },
    NOT: { type: 'PRACTICE', refType: 'Puzzle' },
  };
  const [rows, total] = await Promise.all([prisma.activity.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.activity.count({ where })]);
  const pids = rows.filter((a) => a.refType === 'Problem' && a.refId).map((a) => a.refId!);
  const titles = new Map((await prisma.problem.findMany({ where: { id: { in: pids } }, select: { id: true, title: true } })).map((x) => [x.id, x.title]));
  const text = (a: (typeof rows)[number]) => {
    const t = a.refId ? titles.get(a.refId) : undefined;
    switch (a.type) {
      case 'PROBLEM_SOLVED': return t ? `Solved ${t}` : 'Solved a problem';
      case 'PROBLEM_BOOKMARKED': return t ? `Bookmarked ${t}` : 'Bookmarked a problem';
      case 'PROBLEM_FLAGGED': return t ? `Flagged ${t} for revision` : 'Flagged a problem for revision';
      case 'PROBLEM_REVISED': return t ? `Revised ${t}` : 'Revised a problem';
      case 'PERSONAL_NOTE_CREATED': return t ? `Wrote a note on ${t}` : 'Wrote a note';
      case 'STUDY_SESSION': return `Studied for ${a.refId ?? ''} min`;
      case 'NOTE_VIEWED': return 'Opened a note';
      case 'CHEATSHEET_VIEWED': return 'Opened a cheat sheet';
      case 'ROADMAP_RESOURCE_COMPLETED': return 'Completed a roadmap resource';
      case 'INTERVIEW_VIEWED': return 'Read an interview experience';
      case 'COMMENT': return 'Commented on an interview experience';
      case 'LIKE': return 'Liked an interview experience';
      case 'PRACTICE': return 'Practised questions';
      case 'CONTENT_UNLOCKED': return 'Unlocked premium content';
      case 'PAYMENT': return 'Made a payment';
      default: return a.type.toLowerCase().replace(/_/g, ' ');
    }
  };
  send(res, pageOf(rows.map((a) => ({ id: a.id, type: a.type.toLowerCase(), text: text(a), at: a.createdAt.toISOString() })), total, p));
});

// ───── Purchases ─────
const STATUS: Record<string, string> = { SUCCESS: 'PAID', PENDING: 'PENDING', MANUAL_REVIEW: 'PENDING', FAILED: 'FAILED', CANCELLED: 'FAILED' };
export async function titleOf(type: string, id: string): Promise<{ title: string; kind: string }> {
  const t = async () => {
    switch (type) {
      case 'NOTE': return (await prisma.note.findUnique({ where: { id }, select: { title: true } }))?.title;
      case 'CHEATSHEET': return (await prisma.cheatSheet.findUnique({ where: { id }, select: { title: true } }))?.title;
      case 'ROADMAP': return (await prisma.roadmap.findUnique({ where: { id }, select: { title: true } }))?.title;
      case 'ROADMAP_RESOURCE': return (await prisma.roadmapResource.findUnique({ where: { id }, select: { title: true } }))?.title;
      default: return (await prisma.problem.findUnique({ where: { id }, select: { title: true } }))?.title;
    }
  };
  return { title: (await t()) ?? 'Removed content', kind: type.toLowerCase().replace('_', '-') };
}

r.get('/me/purchases', authenticate, async (req: Request, res: Response) => {
  const rows = await prisma.payment.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  const out = await Promise.all(rows.map(async (p) => ({ id: p.id, ...(await titleOf(p.contentType, p.contentId)), amount: Number(p.amount), status: STATUS[p.status] ?? p.status, at: p.createdAt.toISOString() })));
  send(res, out);
});

// ───── Avatar: resized to 256px WebP and stored inline (no public bucket needed) ─────
r.post('/me/avatar', authenticate, upload.single('avatar'), async (req: Request, res: Response) => {
  const f = req.file;
  if (!f) throw E.badRequest('No image uploaded');
  if (f.size > 2 * 1024 * 1024) throw new (await import('../utils/http')).ApiError(422, 'FILE_TOO_LARGE', 'Image must be 2 MB or smaller');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.mimetype)) throw new (await import('../utils/http')).ApiError(422, 'UNSUPPORTED_FILE_TYPE', 'Use a PNG, JPG or WebP image');
  let buf: Buffer;
  try { buf = await sharp(f.buffer).rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 82 }).toBuffer(); }
  catch { throw E.badRequest('That file is not a valid image'); }
  const u = await prisma.user.update({ where: { id: req.user!.id }, data: { avatarUrl: `data:image/webp;base64,${buf.toString('base64')}` } });
  send(res, userOut(u));
});

// ───── Popup notifications (shown ~5s, marked seen) ─────
const POPUP: Record<string, 'info' | 'success' | 'warning'> = { INFO: 'info', NEW_CONTENT: 'success', ANNOUNCEMENT: 'warning' };
r.get('/notifications/popups', authenticate, async (req: Request, res: Response) => {
  const [items, cfg] = await Promise.all([unreadFor(req.user!), getSettings()]);
  send(res, items.slice(0, 5).map((n) => ({ id: n.id, title: n.title, message: n.message, type: POPUP[n.type] ?? 'info', durationMs: (n.durationSeconds ?? cfg.defaultPopupSeconds) * 1000 })));
});
r.post('/notifications/popups/:id/seen', authenticate, async (req: Request, res: Response) => {
  const notificationId = req.params.id, userId = req.user!.id;
  const n = await prisma.notification.findUnique({ where: { id: notificationId }, select: { id: true } });
  if (!n) throw E.notFound('Notification not found');
  await prisma.notificationRecipient.upsert({ where: { notificationId_userId: { notificationId, userId } }, create: { notificationId, userId, readAt: new Date() }, update: { readAt: new Date() } });
  send(res, { ok: true });
});

// ───── Public landing data ─────
r.get('/public/testimonials', async (_req: Request, res: Response) => {
  const rows = await prisma.testimonial.findMany({ where: { isPublished: true }, orderBy: { order: 'asc' }, take: 30 });
  send(res, rows.map((t) => ({ id: t.id, name: t.name, ...(t.handle ? { handle: t.handle } : {}), ...(t.location ? { location: t.location } : {}), quote: t.message, rating: t.rating, ...(t.avatarUrl ? { avatarUrl: t.avatarUrl } : {}) })));
});
r.get('/public/courses', async (_req: Request, res: Response) => {
  const rows = await prisma.course.findMany({ where: { isPublished: true }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }], take: 12 });
  send(res, rows.map((c) => ({
    id: c.id, title: c.title, description: c.description,
    ...(c.thumbnailUrl ? { thumbnailUrl: c.thumbnailUrl } : {}), ...(c.level ? { level: c.level } : {}), ...(c.duration ? { duration: c.duration } : {}), ...(c.priceLabel ? { priceLabel: c.priceLabel } : {}),
    highlights: Array.isArray(c.highlights) ? (c.highlights as unknown[]).map(String) : [],
    ...(c.ctaLabel ? { ctaLabel: c.ctaLabel } : {}), ...(c.ctaUrl ? { ctaUrl: c.ctaUrl } : {}),
  })));
});
r.get('/public/founder', async (_req: Request, res: Response) => {
  const row = await prisma.siteSetting.findUnique({ where: { key: 'founder' } });
  if (!row) return void res.status(404).json({ message: 'Not configured' });
  send(res, row.value);
});

export default r;
