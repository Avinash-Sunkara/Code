import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { E, ok, page } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { uniqueSlug } from '../utils/slug';
import { interviewInput } from '../validators/admin';
import { safeText } from '../validators/common';
import { logActivity } from '../services/activity';

export const buildRounds = (rounds: z.infer<typeof interviewInput>['rounds']) =>
  rounds.map((r, i) => ({ roundNumber: i + 1, title: r.title, description: r.description ?? null, questions: { create: r.questions.map((q, j) => ({ question: q, order: j })) } }));

const card = {
  id: true, title: true, slug: true, company: true, role: true, experienceLevel: true, difficulty: true, status: true,
  roundCount: true, summary: true, tags: true, createdAt: true, isAnonymous: true,
  companyRef: { select: { logoUrl: true } }, _count: { select: { comments: { where: { isDeleted: false } }, likes: true } },
} satisfies Prisma.InterviewExperienceSelect;

export async function list(req: Request, res: Response) {
  const f = z.object({
    status: z.enum(['SELECTED', 'REJECTED', 'PENDING']).optional(), difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
    company: z.string().max(120).optional(), q: z.string().max(100).optional(), sort: z.enum(['newest', 'top']).default('newest'),
  }).parse(req.query);
  const p = pageParams(req.query, { defaultLimit: 12, maxLimit: 50 });
  const where: Prisma.InterviewExperienceWhereInput = {
    isPublished: true, ...(f.status && { status: f.status }), ...(f.difficulty && { difficulty: f.difficulty }),
    ...(f.company && { company: { equals: f.company, mode: 'insensitive' } }),
    ...(f.q && { OR: [{ title: { contains: f.q, mode: 'insensitive' } }, { company: { contains: f.q, mode: 'insensitive' } }, { role: { contains: f.q, mode: 'insensitive' } }, { tags: { has: f.q } }] }),
  };
  const [rows, total, stats] = await Promise.all([
    prisma.interviewExperience.findMany({ where, select: card, skip: p.skip, take: p.take, orderBy: f.sort === 'top' ? [{ likes: { _count: 'desc' } }, { createdAt: 'desc' }] : { createdAt: 'desc' } }),
    prisma.interviewExperience.count({ where }),
    Promise.all([
      prisma.interviewExperience.count({ where: { isPublished: true } }),
      prisma.interviewExperience.groupBy({ by: ['company'], where: { isPublished: true } }).then((x) => x.length),
      prisma.interviewExperience.count({ where: { isPublished: true, status: 'SELECTED' } }),
    ]),
  ]);
  const liked = req.user ? new Set((await prisma.interviewLike.findMany({ where: { userId: req.user.id, experienceId: { in: rows.map((r) => r.id) } }, select: { experienceId: true } })).map((l) => l.experienceId)) : new Set<string>();
  res.json({
    success: true, message: 'OK',
    data: {
      items: rows.map(({ _count, companyRef, ...r }) => ({ ...r, logoUrl: companyRef?.logoUrl ?? null, commentCount: _count.comments, likeCount: _count.likes, liked: liked.has(r.id) })),
      stats: { experiences: stats[0], companies: stats[1], selected: stats[2] },
      pagination: { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) },
    },
  });
}

export async function get(req: Request, res: Response) {
  const x = await prisma.interviewExperience.findFirst({
    where: { isPublished: true, OR: [{ id: req.params.id }, { slug: req.params.id }] },
    include: {
      companyRef: { select: { logoUrl: true } }, author: { select: { name: true, username: true } },
      rounds: { orderBy: { roundNumber: 'asc' }, include: { questions: { orderBy: { order: 'asc' } } } },
      _count: { select: { likes: true, comments: { where: { isDeleted: false } } } },
    },
  });
  if (!x) throw E.notFound('Experience not found');
  const [liked, comments] = await Promise.all([
    req.user ? prisma.interviewLike.findUnique({ where: { experienceId_userId: { experienceId: x.id, userId: req.user.id } } }) : null,
    prisma.interviewComment.findMany({ where: { experienceId: x.id, isDeleted: false }, orderBy: { createdAt: 'asc' }, take: 200, include: { user: { select: { name: true, username: true, avatarUrl: true } } } }),
  ]);
  if (req.user) await logActivity(req.user.id, 'INTERVIEW_VIEWED', { refType: 'InterviewExperience', refId: x.id });
  const { author, companyRef, _count, ...rest } = x;
  ok(res, {
    ...rest, logoUrl: companyRef?.logoUrl ?? null, likeCount: _count.likes, commentCount: _count.comments, liked: !!liked,
    author: rest.isAnonymous ? { name: 'Anonymous' } : author,
    comments: comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, mine: c.userId === req.user?.id, user: c.user })),
  });
}

export async function like(req: Request, res: Response) {
  const x = await prisma.interviewExperience.findFirst({ where: { id: req.params.id, isPublished: true }, select: { id: true } });
  if (!x) throw E.notFound();
  const key = { experienceId_userId: { experienceId: x.id, userId: req.user!.id } };
  const had = await prisma.interviewLike.findUnique({ where: key });
  if (had) await prisma.interviewLike.delete({ where: key });
  else { await prisma.interviewLike.create({ data: { experienceId: x.id, userId: req.user!.id } }); await logActivity(req.user!.id, 'LIKE', { refType: 'InterviewExperience', refId: x.id }); }
  ok(res, { liked: !had, likeCount: await prisma.interviewLike.count({ where: { experienceId: x.id } }) });
}

export async function comment(req: Request, res: Response) {
  const { body } = z.object({ body: safeText(1, 2000) }).parse(req.body);
  const x = await prisma.interviewExperience.findFirst({ where: { id: req.params.id, isPublished: true }, select: { id: true } });
  if (!x) throw E.notFound();
  const c = await prisma.interviewComment.create({ data: { experienceId: x.id, userId: req.user!.id, body }, include: { user: { select: { name: true, username: true, avatarUrl: true } } } });
  await logActivity(req.user!.id, 'COMMENT', { refType: 'InterviewExperience', refId: x.id });
  ok(res, { id: c.id, body: c.body, createdAt: c.createdAt, mine: true, user: c.user }, 'Comment posted', 201);
}

export async function deleteOwnComment(req: Request, res: Response) {
  const c = await prisma.interviewComment.findUnique({ where: { id: req.params.commentId } });
  if (!c || c.isDeleted) throw E.notFound();
  if (c.userId !== req.user!.id && req.user!.role !== 'ADMIN') throw E.forbidden();
  await prisma.interviewComment.update({ where: { id: c.id }, data: { isDeleted: true } });
  ok(res, {}, 'Comment deleted');
}

/** "Share your experience": created unpublished; an admin approves it from the CMS. */
export async function submit(req: Request, res: Response) {
  const d = interviewInput.parse(req.body);
  const { rounds, ...rest } = d;
  const x = await prisma.interviewExperience.create({
    data: { ...rest, slug: await uniqueSlug('interviewExperience', `${d.company}-${d.title}`), roundCount: rounds.length, isPublished: false, createdBy: req.user!.id, rounds: { create: buildRounds(rounds) } },
  });
  ok(res, { id: x.id, status: 'pending_review' }, 'Thanks! Your experience will appear once reviewed.', 201);
}
