import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { E, ok, page } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { publicUser } from '../utils/serializers';
import { profileSchema } from '../validators/auth';
import { getHeatmap, getStreak, localDate, logActivity } from '../services/activity';

export async function activity(req: Request, res: Response) {
  const year = z.coerce.number().int().min(2020).max(2100).default(localDate().getUTCFullYear()).parse(req.query.year);
  const [heat, streak] = await Promise.all([getHeatmap(req.user!.id, year), getStreak(req.user!.id)]);
  ok(res, { ...heat, streak });
}

export async function progress(req: Request, res: Response) {
  const userId = req.user!.id;
  const [sheets, totals, solvedRows] = await Promise.all([
    prisma.dSASheet.findMany({ where: { isPublished: true }, orderBy: { order: 'asc' }, select: { id: true, name: true, slug: true, totalProblems: true } }),
    prisma.problem.groupBy({ by: ['difficulty'], where: { isPublished: true, topic: { sheet: { isPublished: true } } }, _count: { _all: true } }),
    prisma.userProblemProgress.findMany({
      where: { userId, status: 'SOLVED', problem: { isPublished: true } },
      select: { problem: { select: { difficulty: true, topic: { select: { sheetId: true } } } } },
    }),
  ]);
  const byDifficulty: Record<string, { solved: number; total: number }> = { EASY: { solved: 0, total: 0 }, MEDIUM: { solved: 0, total: 0 }, HARD: { solved: 0, total: 0 } };
  for (const t of totals) byDifficulty[t.difficulty].total = t._count._all;
  const solvedBySheet: Record<string, number> = {};
  for (const r of solvedRows) {
    byDifficulty[r.problem.difficulty].solved++;
    solvedBySheet[r.problem.topic.sheetId] = (solvedBySheet[r.problem.topic.sheetId] ?? 0) + 1;
  }
  const total = sheets.reduce((s, x) => s + x.totalProblems, 0);

  const p = pageParams(req.query, { sortable: ['updatedAt', 'solvedAt'], defaultSort: 'updatedAt' });
  const where: any = { userId };
  if (typeof req.query.status === 'string') where.status = req.query.status;
  const [items, count] = await Promise.all([
    prisma.userProblemProgress.findMany({
      where, orderBy: p.orderBy, skip: p.skip, take: p.take,
      select: { problemId: true, status: true, solvedAt: true, attempts: true, usedHint: true, flaggedForRevision: true, revisedAt: true, personalNote: true, updatedAt: true, problem: { select: { title: true, slug: true, difficulty: true } } },
    }),
    prisma.userProblemProgress.count({ where }),
  ]);
  ok(res, {
    overall: { solved: solvedRows.length, total, percent: total ? Math.round((solvedRows.length / total) * 100) : 0 },
    byDifficulty,
    bySheet: sheets.map((s) => ({ ...s, solved: solvedBySheet[s.id] ?? 0 })),
    streak: await getStreak(userId),
    items, pagination: { page: p.page, limit: p.limit, total: count, totalPages: Math.ceil(count / p.limit) },
  });
}

export async function updateProfile(req: Request, res: Response) {
  const d = profileSchema.parse(req.body);
  if (d.username && (await prisma.user.findFirst({ where: { username: d.username, NOT: { id: req.user!.id } }, select: { id: true } }))) throw E.conflict('Username is taken', 'ALREADY_EXISTS');
  const u = await prisma.user.update({ where: { id: req.user!.id }, data: { ...d, avatarUrl: d.avatarUrl ?? undefined } });
  ok(res, { user: publicUser(u) }, 'Profile updated');
}

export async function studySession(req: Request, res: Response) {
  const d = z.object({ minutes: z.number().int().min(1).max(600), topic: z.string().max(100).optional() }).parse(req.body);
  await logActivity(req.user!.id, 'STUDY_SESSION', { refType: d.topic, refId: String(d.minutes) });
  ok(res, {}, 'Study session logged', 201);
}

export async function myPayments(req: Request, res: Response) {
  const p = pageParams(req.query, { sortable: ['createdAt'] });
  const where = { userId: req.user!.id };
  const [items, total] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: p.orderBy, skip: p.skip, take: p.take, select: { id: true, contentType: true, contentId: true, amount: true, currency: true, status: true, provider: true, createdAt: true, verifiedAt: true } }),
    prisma.payment.count({ where }),
  ]);
  page(res, items, total, p.page, p.limit);
}
