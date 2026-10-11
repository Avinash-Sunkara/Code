import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { E, ok } from '../utils/http';
import { stripHtml } from '../utils/serializers';
import { entitledIds } from '../services/access';
import { clearProblemSolveActivity, logActivity, recordActivity } from '../services/activity';

const problemSelectUser = {
  id: true, title: true, slug: true, difficulty: true, leetcodeUrl: true, gfgUrl: true, youtubeUrl: true,
  pattern: true, isPremium: true, order: true, topicId: true, subtopicId: true, imageUrl: true,
  companies: { select: { company: { select: { id: true, name: true, slug: true, logoUrl: true } } } },
} satisfies Prisma.ProblemSelect;

function shape(p: any, locked: boolean, st?: any, bookmarked = false) {
  const { companies, ...rest } = p;
  return {
    ...rest,
    ...(locked ? { leetcodeUrl: null, gfgUrl: null, youtubeUrl: null, imageUrl: null } : {}),
    locked,
    companies: companies.map((c: any) => c.company),
    status: st?.status ?? 'NOT_STARTED', usedHint: !!st?.usedHint, flaggedForRevision: !!st?.flaggedForRevision,
    hasNote: !!st?.personalNote, bookmarked,
  };
}

export async function listSheets(req: Request, res: Response) {
  const sheets = await prisma.dSASheet.findMany({
    where: { isPublished: true }, orderBy: { order: 'asc' },
    include: { _count: { select: { topics: true } } },
  });
  const solved: Record<string, number> = {};
  if (req.user) {
    const rows = await prisma.userProblemProgress.findMany({
      where: { userId: req.user.id, status: 'SOLVED', problem: { isPublished: true } },
      select: { problem: { select: { topic: { select: { sheetId: true } } } } },
    });
    for (const r of rows) solved[r.problem.topic.sheetId] = (solved[r.problem.topic.sheetId] ?? 0) + 1;
  }
  ok(res, sheets.map((s) => ({ id: s.id, name: s.name, slug: s.slug, description: s.description, totalProblems: s.totalProblems, topicCount: s._count.topics, solved: solved[s.id] ?? 0 })));
}

export async function getSheet(req: Request, res: Response) {
  const q = z.object({
    q: z.string().max(100).optional(), difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
    bookmarked: z.enum(['true', 'false']).optional(), topicId: z.string().optional(),
    status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'SOLVED']).optional(),
  }).parse(req.query);
  const key = req.params.slug;
  const sheet = await prisma.dSASheet.findFirst({ where: { isPublished: true, OR: [{ slug: key }, { id: key }] } });
  if (!sheet) throw E.notFound('Sheet not found');
  const userId = req.user?.id;

  const where: Prisma.ProblemWhereInput = { isPublished: true };
  if (q.difficulty) where.difficulty = q.difficulty;
  if (q.q) where.OR = [{ title: { contains: q.q, mode: 'insensitive' } }, { pattern: { contains: q.q, mode: 'insensitive' } }];
  if (userId && q.bookmarked === 'true') {
    const b = await prisma.bookmark.findMany({ where: { userId, targetType: 'PROBLEM' }, select: { targetId: true } });
    where.id = { in: b.map((x) => x.targetId) };
  }
  if (userId && q.status) {
    const st = await prisma.userProblemProgress.findMany({ where: { userId, status: q.status }, select: { problemId: true } });
    where.id = { in: st.map((x) => x.problemId) };
  }
  const filtered = !!(q.q || q.difficulty || q.bookmarked === 'true' || q.status);

  const topics = await prisma.dSATopic.findMany({
    where: { sheetId: sheet.id, ...(q.topicId ? { id: q.topicId } : {}) }, orderBy: { order: 'asc' },
    include: { subtopics: { orderBy: { order: 'asc' } }, problems: { where, orderBy: { order: 'asc' }, select: problemSelectUser } },
  });
  const ids = topics.flatMap((t) => t.problems.map((p) => p.id));
  const [states, marks, owned] = await Promise.all([
    userId ? prisma.userProblemProgress.findMany({ where: { userId, problemId: { in: ids } } }) : [],
    userId ? prisma.bookmark.findMany({ where: { userId, targetType: 'PROBLEM', targetId: { in: ids } }, select: { targetId: true } }) : [],
    entitledIds(userId, 'PROBLEM'),
  ]);
  const stMap = new Map(states.map((s) => [s.problemId, s]));
  const bm = new Set(marks.map((m) => m.targetId));
  const isAdmin = req.user?.role === 'ADMIN';

  ok(res, {
    sheet: { id: sheet.id, name: sheet.name, slug: sheet.slug, description: sheet.description, totalProblems: sheet.totalProblems },
    topics: topics
      .filter((t) => !filtered || t.problems.length)
      .map((t) => {
        const problems = t.problems.map((p) => shape(p, p.isPremium && !isAdmin && !owned.has(p.id), stMap.get(p.id), bm.has(p.id)));
        return {
          id: t.id, name: t.name, slug: t.slug, description: t.description, hint: t.hint, tip: t.tip, order: t.order,
          subtopics: t.subtopics.map((s) => ({ id: s.id, name: s.name, slug: s.slug })),
          solved: problems.filter((p) => p.status === 'SOLVED').length, total: problems.length, problems,
        };
      }),
  });
}

async function findProblem(idOrSlug: string) {
  const p = await prisma.problem.findFirst({ where: { isPublished: true, OR: [{ id: idOrSlug }, { slug: idOrSlug }] }, select: { id: true } });
  if (!p) throw E.notFound('Problem not found');
  return p.id;
}

export async function getProblem(req: Request, res: Response) {
  const id = await findProblem(req.params.id);
  const p = await prisma.problem.findUniqueOrThrow({ where: { id }, select: { ...problemSelectUser, description: true, quickRevision: true, topic: { select: { name: true, sheetId: true } } } });
  const owned = await entitledIds(req.user?.id, 'PROBLEM');
  const locked = p.isPremium && req.user?.role !== 'ADMIN' && !owned.has(p.id);
  const [st, bm] = req.user
    ? await Promise.all([
        prisma.userProblemProgress.findUnique({ where: { userId_problemId: { userId: req.user.id, problemId: id } } }),
        prisma.bookmark.findUnique({ where: { userId_targetType_targetId: { userId: req.user.id, targetType: 'PROBLEM', targetId: id } } }),
      ])
    : [null, null];
  const { description, quickRevision, ...rest } = p as any;
  ok(res, { ...shape(rest, locked, st, !!bm), ...(locked ? {} : { description, quickRevision }), personalNote: st?.personalNote ?? null });
}

export async function solve(req: Request, res: Response) {
  const id = await findProblem(req.params.id);
  const d = z.object({ solved: z.boolean().default(true), usedHint: z.boolean().optional(), wrong: z.boolean().optional() }).parse(req.body ?? {});
  const userId = req.user!.id;
  const row = await prisma.$transaction(async (tx) => {
    const key = { userId_problemId: { userId, problemId: id } };
    const prev = await tx.userProblemProgress.findUnique({ where: key });
    const newlySolved = d.solved && prev?.status !== 'SOLVED';
    const unsolved = !d.solved && prev?.status === 'SOLVED';
    const status = d.solved ? 'SOLVED' : unsolved ? 'IN_PROGRESS' : prev?.status ?? 'IN_PROGRESS';
    const updated = await tx.userProblemProgress.upsert({
      where: key,
      create: { userId, problemId: id, status, solvedAt: d.solved ? new Date() : null, attempts: 1, usedHint: !!d.usedHint, wrongAttempts: d.wrong ? 1 : 0 },
      update: {
        status,
        ...(newlySolved ? { solvedAt: new Date() } : {}),
        ...(unsolved ? { solvedAt: null } : {}),
        attempts: { increment: 1 },
        ...(d.usedHint ? { usedHint: true } : {}),
        ...(d.wrong ? { wrongAttempts: { increment: 1 } } : {}),
      },
    });
    if (newlySolved || unsolved) await clearProblemSolveActivity(tx, userId, id);
    if (newlySolved) await recordActivity(tx, userId, 'PROBLEM_SOLVED', { refType: 'Problem', refId: id });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  ok(res, { status: row.status, solvedAt: row.solvedAt, usedHint: row.usedHint, attempts: row.attempts }, d.solved ? 'Marked solved' : 'Marked unsolved');
}

export async function toggleBookmark(req: Request, res: Response) {
  const id = await findProblem(req.params.id);
  const key = { userId_targetType_targetId: { userId: req.user!.id, targetType: 'PROBLEM' as const, targetId: id } };
  const existing = await prisma.bookmark.findUnique({ where: key });
  if (existing) { await prisma.bookmark.delete({ where: key }); return ok(res, { bookmarked: false }); }
  await prisma.bookmark.create({ data: { userId: req.user!.id, targetType: 'PROBLEM', targetId: id } });
  await logActivity(req.user!.id, 'PROBLEM_BOOKMARKED', { refType: 'Problem', refId: id });
  ok(res, { bookmarked: true });
}

export async function toggleRevision(req: Request, res: Response) {
  const id = await findProblem(req.params.id);
  const userId = req.user!.id;
  const prev = await prisma.userProblemProgress.findUnique({ where: { userId_problemId: { userId, problemId: id } } });
  const flag = z.object({ flagged: z.boolean().optional() }).parse(req.body ?? {}).flagged ?? !prev?.flaggedForRevision;
  await prisma.userProblemProgress.upsert({
    where: { userId_problemId: { userId, problemId: id } },
    create: { userId, problemId: id, status: 'NOT_STARTED', flaggedForRevision: flag },
    update: { flaggedForRevision: flag },
  });
  if (flag) await logActivity(userId, 'PROBLEM_FLAGGED', { refType: 'Problem', refId: id });
  ok(res, { flaggedForRevision: flag });
}

export async function saveNote(req: Request, res: Response) {
  const id = await findProblem(req.params.id);
  const { note } = z.object({ note: z.string().max(10000) }).parse(req.body);
  const userId = req.user!.id;
  const text = stripHtml(note).trim() || null;
  const prev = await prisma.userProblemProgress.findUnique({ where: { userId_problemId: { userId, problemId: id } } });
  await prisma.userProblemProgress.upsert({
    where: { userId_problemId: { userId, problemId: id } },
    create: { userId, problemId: id, status: 'NOT_STARTED', personalNote: text },
    update: { personalNote: text },
  });
  if (text && !prev?.personalNote) await logActivity(userId, 'PERSONAL_NOTE_CREATED', { refType: 'Problem', refId: id });
  ok(res, { personalNote: text }, 'Note saved');
}
