import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { E, ok, page } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { logActivity } from '../services/activity';

const TYPES = ['PROBLEM', 'NOTE', 'ROADMAP', 'CHEATSHEET', 'INTERVIEW'] as const;
const typeMap = z.enum(TYPES);

// ───── Bookmarks (generic: any bookmarkable content type) ─────
export async function listBookmarks(req: Request, res: Response) {
  const type = req.query.type ? typeMap.parse(req.query.type) : undefined;
  const p = pageParams(req.query, { defaultLimit: 50 });
  const where = { userId: req.user!.id, ...(type && { targetType: type }) };
  const [rows, total] = await Promise.all([
    prisma.bookmark.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    prisma.bookmark.count({ where }),
  ]);
  const ids = (t: string) => rows.filter((r) => r.targetType === t).map((r) => r.targetId);
  const [problems, notes, roadmaps, sheets, interviews] = await Promise.all([
    prisma.problem.findMany({ where: { id: { in: ids('PROBLEM') }, isPublished: true }, select: { id: true, title: true, slug: true, difficulty: true } }),
    prisma.note.findMany({ where: { id: { in: ids('NOTE') }, isPublished: true }, select: { id: true, title: true, slug: true } }),
    prisma.roadmap.findMany({ where: { id: { in: ids('ROADMAP') }, isPublished: true }, select: { id: true, title: true, slug: true } }),
    prisma.cheatSheet.findMany({ where: { id: { in: ids('CHEATSHEET') }, isPublished: true }, select: { id: true, title: true, slug: true } }),
    prisma.interviewExperience.findMany({ where: { id: { in: ids('INTERVIEW') }, isPublished: true }, select: { id: true, title: true, slug: true, company: true } }),
  ]);
  const lookup = new Map<string, any>([...problems, ...notes, ...roadmaps, ...sheets, ...interviews].map((x) => [x.id, x]));
  page(res, rows.filter((r) => lookup.has(r.targetId)).map((r) => ({ id: r.id, type: r.targetType, createdAt: r.createdAt, item: lookup.get(r.targetId) })), total, p.page, p.limit);
}

export async function toggleBookmark(req: Request, res: Response) {
  const { type, id } = z.object({ type: typeMap, id: z.string().min(1) }).parse(req.body);
  const exists = await ({
    PROBLEM: () => prisma.problem.findFirst({ where: { id, isPublished: true }, select: { id: true } }),
    NOTE: () => prisma.note.findFirst({ where: { id, isPublished: true }, select: { id: true } }),
    ROADMAP: () => prisma.roadmap.findFirst({ where: { id, isPublished: true }, select: { id: true } }),
    CHEATSHEET: () => prisma.cheatSheet.findFirst({ where: { id, isPublished: true }, select: { id: true } }),
    INTERVIEW: () => prisma.interviewExperience.findFirst({ where: { id, isPublished: true }, select: { id: true } }),
  }[type])();
  if (!exists) throw E.notFound('Content not found');
  const key = { userId_targetType_targetId: { userId: req.user!.id, targetType: type, targetId: id } };
  if (await prisma.bookmark.findUnique({ where: key })) { await prisma.bookmark.delete({ where: key }); return ok(res, { bookmarked: false }); }
  await prisma.bookmark.create({ data: { userId: req.user!.id, targetType: type, targetId: id } });
  if (type === 'PROBLEM') await logActivity(req.user!.id, 'PROBLEM_BOOKMARKED', { refType: 'Problem', refId: id });
  ok(res, { bookmarked: true });
}

// ───── Revision ─────
export async function revisionList(req: Request, res: Response) {
  const p = pageParams(req.query, { sortable: ['updatedAt'], defaultSort: 'updatedAt', defaultLimit: 50 });
  const where = { userId: req.user!.id, problem: { isPublished: true }, OR: [{ flaggedForRevision: true }, { usedHint: true, status: 'SOLVED' as const }, { wrongAttempts: { gt: 0 } }, { personalNote: { not: null } }] };
  const [rows, total] = await Promise.all([
    prisma.userProblemProgress.findMany({
      where, orderBy: p.orderBy, skip: p.skip, take: p.take,
      include: { problem: { select: { id: true, title: true, slug: true, difficulty: true, pattern: true, quickRevision: true, leetcodeUrl: true, gfgUrl: true, companies: { select: { company: { select: { name: true, logoUrl: true } } } } } } },
    }),
    prisma.userProblemProgress.count({ where }),
  ]);
  page(res, rows.map((r) => ({
    problemId: r.problemId, problem: { ...r.problem, companies: r.problem.companies.map((c) => c.company) },
    reasons: { flagged: r.flaggedForRevision, solvedWithHint: r.usedHint && r.status === 'SOLVED', wrongAttempts: r.wrongAttempts, hasNote: !!r.personalNote },
    personalNote: r.personalNote, revisedAt: r.revisedAt, status: r.status,
  })), total, p.page, p.limit);
}

export async function revisionComplete(req: Request, res: Response) {
  const row = await prisma.userProblemProgress.findUnique({ where: { userId_problemId: { userId: req.user!.id, problemId: req.params.problemId } } });
  if (!row) throw E.notFound('No progress for this problem');
  await prisma.userProblemProgress.update({ where: { id: row.id }, data: { flaggedForRevision: false, revisedAt: new Date(), usedHint: false, wrongAttempts: 0 } });
  await logActivity(req.user!.id, 'PROBLEM_REVISED', { refType: 'Problem', refId: row.problemId });
  ok(res, { problemId: row.problemId, revisedAt: new Date() }, 'Marked as revised');
}
