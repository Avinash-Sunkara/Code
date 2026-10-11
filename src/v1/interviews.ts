import { Request, Response, Router } from 'express';
import { InterviewStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/db';
import { E } from '../utils/http';
import { uniqueSlug } from '../utils/slug';
import { safeText } from '../validators/common';
import { authenticate, optionalAuth } from '../middleware/auth';
import { logActivity, rebuildDailyActivity } from '../services/activity';
import { diffIn, diffOut, pageOf, pq, send } from './util';
import { renderBody } from './content';

const r = Router();
const ST_OUT: Record<InterviewStatus, 'Selected' | 'Rejected' | 'Pending'> = { SELECTED: 'Selected', REJECTED: 'Rejected', PENDING: 'Pending' };
const stIn = (s: unknown): InterviewStatus | undefined => { const v = String(s ?? '').toUpperCase(); return v === 'SELECTED' || v === 'REJECTED' || v === 'PENDING' ? (v as InterviewStatus) : undefined; };

const card = {
  id: true, title: true, company: true, role: true, experienceLevel: true, difficulty: true, status: true, roundCount: true, summary: true,
  tags: true, createdAt: true, updatedAt: true, isAnonymous: true, author: { select: { name: true } },
  _count: { select: { comments: { where: { isDeleted: false } }, likes: true } },
} satisfies Prisma.InterviewExperienceSelect;
type Row = Prisma.InterviewExperienceGetPayload<{ select: typeof card }>;

const out = (x: Row, liked: boolean) => ({
  id: x.id, company: x.company, role: x.role, ...(x.experienceLevel ? { level: x.experienceLevel } : {}), difficulty: diffOut(x.difficulty), rounds: x.roundCount,
  status: ST_OUT[x.status], title: x.title, ...(x.summary ? { summary: x.summary } : {}), tags: x.tags, likes: x._count.likes, comments: x._count.comments, liked,
  createdAt: x.createdAt.toISOString(), author: x.isAnonymous ? 'Anonymous' : x.author?.name ?? 'Anonymous', edited: x.updatedAt.getTime() - x.createdAt.getTime() > 60_000,
});

const likedSet = async (uid: string | undefined, ids: string[]) =>
  new Set(uid ? (await prisma.interviewLike.findMany({ where: { userId: uid, experienceId: { in: ids } }, select: { experienceId: true } })).map((l) => l.experienceId) : []);

r.get('/interviews/stats', async (_req: Request, res: Response) => {
  const where = { isPublished: true };
  const [experiences, selected, groups] = await Promise.all([
    prisma.interviewExperience.count({ where }), prisma.interviewExperience.count({ where: { ...where, status: 'SELECTED' } }),
    prisma.interviewExperience.findMany({ where, select: { company: true, role: true }, distinct: ['company', 'role'] }),
  ]);
  const companyNames = [...new Set(groups.map((g) => g.company))].sort();
  send(res, { experiences, companies: companyNames.length, selected, companyNames, roles: [...new Set(groups.map((g) => g.role))].sort() });
});

r.get('/interviews', optionalAuth, async (req: Request, res: Response) => {
  const p = pq(req, 12, 50);
  const status = stIn(req.query.status), difficulty = diffIn(req.query.difficulty);
  const role = String(req.query.role ?? '').trim(), company = String(req.query.company ?? '').trim();
  const where: Prisma.InterviewExperienceWhereInput = {
    isPublished: true, ...(status ? { status } : {}), ...(difficulty ? { difficulty } : {}),
    ...(company ? { company: { equals: company, mode: 'insensitive' } } : {}), ...(role ? { role: { contains: role, mode: 'insensitive' } } : {}),
    ...(p.q ? { OR: [{ title: { contains: p.q, mode: 'insensitive' } }, { company: { contains: p.q, mode: 'insensitive' } }, { role: { contains: p.q, mode: 'insensitive' } }, { tags: { has: p.q } }] } : {}),
  };
  const top = req.query.sort === 'top';
  const [rows, total] = await Promise.all([
    prisma.interviewExperience.findMany({ where, select: card, skip: p.skip, take: p.take, orderBy: top ? [{ likes: { _count: 'desc' } }, { createdAt: 'desc' }] : { createdAt: 'desc' } }),
    prisma.interviewExperience.count({ where }),
  ]);
  const liked = await likedSet(req.user?.id, rows.map((x) => x.id));
  send(res, pageOf(rows.map((x) => out(x, liked.has(x.id))), total, p));
});

r.get('/interviews/:id', optionalAuth, async (req: Request, res: Response) => {
  const x = await prisma.interviewExperience.findFirst({
    where: { isPublished: true, OR: [{ id: req.params.id }, { slug: req.params.id }] },
    select: { ...card, background: true, verdict: true, rounds: { orderBy: { roundNumber: 'asc' }, select: { title: true, description: true, questions: { orderBy: { order: 'asc' }, select: { question: true } } } } },
  });
  if (!x) throw E.notFound('Experience not found');
  const liked = await likedSet(req.user?.id, [x.id]);
  if (req.user) await logActivity(req.user.id, 'INTERVIEW_VIEWED', { refType: 'InterviewExperience', refId: x.id });
  send(res, {
    ...out(x, liked.has(x.id)), ...(x.background ? { background: x.background } : {}), ...(x.verdict ? { verdict: x.verdict } : {}),
    roundDetails: x.rounds.map((rd) => ({ title: rd.title, body: renderBody(rd.description) })),
    questions: x.rounds.flatMap((rd) => rd.questions.map((q) => q.question)),
  });
});

r.post('/interviews/:id/like', authenticate, async (req: Request, res: Response) => {
  const x = await prisma.interviewExperience.findFirst({ where: { id: req.params.id, isPublished: true }, select: { id: true } });
  if (!x) throw E.notFound('Experience not found');
  const key = { experienceId_userId: { experienceId: x.id, userId: req.user!.id } };
  const had = await prisma.interviewLike.findUnique({ where: key });
  if (had) await prisma.interviewLike.delete({ where: key });
  else { await prisma.interviewLike.create({ data: { experienceId: x.id, userId: req.user!.id } }); await logActivity(req.user!.id, 'LIKE', { refType: 'InterviewExperience', refId: x.id }); }
  send(res, { liked: !had, likes: await prisma.interviewLike.count({ where: { experienceId: x.id } }) });
});

const commentOut = (c: { id: string; body: string; createdAt: Date; userId: string; user: { name: string; username: string } }, me?: string) =>
  ({ id: c.id, author: c.user.name, body: c.body, createdAt: c.createdAt.toISOString(), mine: c.userId === me });

r.get('/interviews/:id/comments', optionalAuth, async (req: Request, res: Response) => {
  const x = await prisma.interviewExperience.findFirst({ where: { id: req.params.id, isPublished: true }, select: { id: true } });
  if (!x) throw E.notFound('Experience not found');
  const rows = await prisma.interviewComment.findMany({ where: { experienceId: x.id, isDeleted: false }, orderBy: { createdAt: 'asc' }, take: 200, include: { user: { select: { name: true, username: true } } } });
  send(res, rows.map((c) => commentOut(c, req.user?.id)));
});

r.post('/interviews/:id/comments', authenticate, async (req: Request, res: Response) => {
  const { body } = z.object({ body: safeText(1, 2000) }).parse(req.body ?? {});
  const x = await prisma.interviewExperience.findFirst({ where: { id: req.params.id, isPublished: true }, select: { id: true } });
  if (!x) throw E.notFound('Experience not found');
  const c = await prisma.interviewComment.create({ data: { experienceId: x.id, userId: req.user!.id, body }, include: { user: { select: { name: true, username: true } } } });
  await logActivity(req.user!.id, 'COMMENT', { refType: 'InterviewComment', refId: c.id });
  send(res, commentOut(c, req.user!.id), 201);
});

r.delete('/interviews/:id/comments/:cid', authenticate, async (req: Request, res: Response) => {
  const c = await prisma.interviewComment.findFirst({ where: { id: req.params.cid, experienceId: req.params.id } });
  if (!c || c.isDeleted) throw E.notFound('Comment not found');
  if (c.userId !== req.user!.id && req.user!.role !== 'ADMIN') throw E.forbidden('You can only delete your own comments');
  await prisma.$transaction(async (tx) => {
    await tx.interviewComment.update({ where: { id: c.id }, data: { isDeleted: true } });
    const where = { userId: c.userId, type: 'COMMENT' as const, refType: 'InterviewComment', refId: c.id };
    const events = await tx.activity.findMany({ where, select: { date: true } });
    await tx.activity.deleteMany({ where });
    for (const date of new Map(events.map((event) => [event.date.toISOString().slice(0, 10), event.date])).values()) {
      await rebuildDailyActivity(tx, c.userId, date);
    }
  });
  res.status(204).end();
});

// "Share your experience": stored unpublished until an admin approves it.
const submit = z.object({
  company: safeText(1, 120), role: safeText(1, 120), level: z.string().trim().max(60).optional().default(''),
  difficulty: z.string().default('Medium'), rounds: z.coerce.number().int().min(1).max(12).default(1), status: z.string().default('Pending'),
  title: safeText(5, 200), background: z.string().trim().max(10000).optional().default(''), body: safeText(20, 10000),
});
r.post('/interviews', authenticate, async (req: Request, res: Response) => {
  const d = submit.parse(req.body ?? {});
  const x = await prisma.interviewExperience.create({
    data: {
      title: d.title, slug: await uniqueSlug('interviewExperience', `${d.company}-${d.title}`), company: d.company, role: d.role, experienceLevel: d.level || null,
      difficulty: diffIn(d.difficulty) ?? 'MEDIUM', status: stIn(d.status) ?? 'PENDING', roundCount: d.rounds, background: d.background || null,
      summary: d.body.slice(0, 280), tags: [d.company], isAnonymous: true, isPublished: false, createdBy: req.user!.id,
      rounds: { create: [{ roundNumber: 1, title: 'Experience', description: d.body }] },
    },
  });
  send(res, { id: x.id, pendingReview: true }, 201);
});

export default r;
