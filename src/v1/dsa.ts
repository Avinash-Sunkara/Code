import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/db';
import { E } from '../utils/http';
import { stripHtml } from '../utils/serializers';
import { authenticate, optionalAuth } from '../middleware/auth';
import { entitledIds } from '../services/access';
import { clearProblemSolveActivity, localDate, logActivity, recordActivity } from '../services/activity';
import { diffIn, diffOut, pageOf, pq, send, toBool } from './util';

const r = Router();

const pSelect = {
  id: true, title: true, slug: true, difficulty: true, leetcodeUrl: true, gfgUrl: true, youtubeUrl: true, pattern: true,
  isPremium: true, order: true, topicId: true, subtopicId: true, imageUrl: true, tags: true, hints: true, images: true,
  topic: { select: { name: true } }, subtopic: { select: { name: true } },
  companies: { select: { company: { select: { id: true, name: true, logoUrl: true } } } },
} satisfies Prisma.ProblemSelect;
type PRow = Prisma.ProblemGetPayload<{ select: typeof pSelect }>;

export interface StateRow { status: string; usedHint: boolean; flaggedForRevision: boolean; personalNote: string | null }

export function problemOut(p: PRow, o: { number?: number; locked: boolean; st?: StateRow; bookmarked: boolean }) {
  return {
    id: p.id, number: o.number ?? p.order + 1, title: p.title, slug: p.slug, difficulty: diffOut(p.difficulty),
    topic: p.topic.name, ...(p.subtopic ? { subtopic: p.subtopic.name } : {}), ...(p.pattern ? { pattern: p.pattern } : {}),
    companies: p.companies.map((c) => ({ id: c.company.id, name: c.company.name, ...(c.company.logoUrl ? { logoUrl: c.company.logoUrl } : {}) })),
    ...(o.locked ? {} : { leetcodeUrl: p.leetcodeUrl ?? undefined, gfgUrl: p.gfgUrl ?? undefined, youtubeUrl: p.youtubeUrl ?? undefined }),
    access: p.isPremium ? 'PREMIUM' : 'FREE', locked: o.locked,
    state: { solved: o.st?.status === 'SOLVED', bookmarked: o.bookmarked, revision: !!o.st?.flaggedForRevision, hintUsed: !!o.st?.usedHint, ...(o.st?.personalNote ? { note: o.st.personalNote } : {}) },
  };
}

/** Attach per-user state to a list of problem rows. */
export async function hydrate(req: Request, rows: PRow[], startNumber = 1) {
  const ids = rows.map((p) => p.id);
  const uid = req.user?.id;
  const [states, marks, owned] = await Promise.all([
    uid ? prisma.userProblemProgress.findMany({ where: { userId: uid, problemId: { in: ids } } }) : [],
    uid ? prisma.bookmark.findMany({ where: { userId: uid, targetType: 'PROBLEM', targetId: { in: ids } }, select: { targetId: true } }) : [],
    entitledIds(uid, 'PROBLEM'),
  ]);
  const st = new Map(states.map((s) => [s.problemId, s]));
  const bm = new Set(marks.map((m) => m.targetId));
  const admin = req.user?.role === 'ADMIN';
  return rows.map((p, i) => problemOut(p, { number: startNumber + i, locked: p.isPremium && !admin && !owned.has(p.id), st: st.get(p.id), bookmarked: bm.has(p.id) }));
}

async function sheetOf(key: string) {
  const s = await prisma.dSASheet.findFirst({ where: { isPublished: true, OR: [{ id: key }, { slug: key }] } });
  if (!s) throw E.notFound('Sheet not found');
  return s;
}

/** Shared filter set used by topic counts and problem lists. */
async function filterWhere(req: Request, base: Prisma.ProblemWhereInput): Promise<Prisma.ProblemWhereInput> {
  const where: Prisma.ProblemWhereInput = { isPublished: true, ...base };
  const and: Prisma.ProblemWhereInput[] = [];
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  if (q) and.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }, { pattern: { contains: q, mode: 'insensitive' } }] });
  const d = diffIn(req.query.difficulty);
  if (d) where.difficulty = d;
  const company = String(req.query.company ?? '');
  if (company) where.companies = { some: { companyId: company } };
  if (toBool(req.query.bookmarked)) {
    if (!req.user) and.push({ id: { in: [] } });
    else {
      const b = await prisma.bookmark.findMany({ where: { userId: req.user.id, targetType: 'PROBLEM' }, select: { targetId: true } });
      and.push({ id: { in: b.map((x) => x.targetId) } });
    }
  }
  if (and.length) where.AND = and;
  return where;
}

const solvedIdsOf = async (uid?: string) => new Set(uid ? (await prisma.userProblemProgress.findMany({ where: { userId: uid, status: 'SOLVED' }, select: { problemId: true } })).map((x) => x.problemId) : []);

r.get('/sheets/overview', optionalAuth, async (req: Request, res: Response) => {
  const sheets = await prisma.dSASheet.findMany({ where: { isPublished: true }, orderBy: { order: 'asc' }, include: { _count: { select: { topics: true } } } });
  const problems = await prisma.problem.findMany({ where: { isPublished: true, topic: { sheet: { isPublished: true } } }, select: { id: true, difficulty: true, topic: { select: { sheetId: true } } } });
  const solved = await solvedIdsOf(req.user?.id);
  const perSheet = new Map<string, { total: number; solved: number }>();
  const diff = { Easy: { solved: 0, total: 0 }, Medium: { solved: 0, total: 0 }, Hard: { solved: 0, total: 0 } };
  for (const p of problems) {
    const s = perSheet.get(p.topic.sheetId) ?? { total: 0, solved: 0 };
    s.total++; const isSolved = solved.has(p.id); if (isSolved) s.solved++;
    perSheet.set(p.topic.sheetId, s);
    const d = diff[diffOut(p.difficulty)]; d.total++; if (isSolved) d.solved++;
  }
  send(res, {
    sheets: sheets.map((s) => ({ id: s.id, title: s.name, slug: s.slug, description: s.description ?? undefined, topicCount: s._count.topics, problemCount: perSheet.get(s.id)?.total ?? 0, solvedCount: perSheet.get(s.id)?.solved ?? 0 })),
    totals: { sheets: sheets.length, topics: sheets.reduce((n, s) => n + s._count.topics, 0), problems: problems.length, solved: problems.filter((p) => solved.has(p.id)).length },
    difficulty: diff,
  });
});

r.get('/sheets/:sheetId/topics', optionalAuth, async (req: Request, res: Response) => {
  const sheet = await sheetOf(req.params.sheetId);
  const topics = await prisma.dSATopic.findMany({ where: { sheetId: sheet.id }, orderBy: { order: 'asc' }, include: { subtopics: { orderBy: { order: 'asc' } } } });
  const where = await filterWhere(req, { topic: { sheetId: sheet.id } });
  const rows = await prisma.problem.findMany({ where, select: { id: true, topicId: true, subtopicId: true } });
  const solved = await solvedIdsOf(req.user?.id);
  const filtered = !!(req.query.q || req.query.difficulty || req.query.company || toBool(req.query.bookmarked));
  const out = topics.map((t) => {
    const mine = rows.filter((x) => x.topicId === t.id);
    return {
      id: t.id, title: t.name, description: t.description ?? undefined,
      problemCount: mine.length, solvedCount: mine.filter((x) => solved.has(x.id)).length,
      subtopics: t.subtopics.map((s) => {
        const sm = mine.filter((x) => x.subtopicId === s.id);
        return { id: s.id, title: s.name, ...(s.description ? { description: s.description } : {}), ...(s.tip ? { tip: s.tip } : {}), problemCount: sm.length, solvedCount: sm.filter((x) => solved.has(x.id)).length };
      }),
    };
  });
  send(res, filtered ? out.filter((t) => t.problemCount > 0) : out);
});

r.get('/sheets/:sheetId/topics/:topicId/problems', optionalAuth, async (req: Request, res: Response) => {
  const sheet = await sheetOf(req.params.sheetId);
  const topic = await prisma.dSATopic.findFirst({ where: { id: req.params.topicId, sheetId: sheet.id }, select: { id: true } });
  if (!topic) throw E.notFound('Topic not found');
  const p = pq(req, 25, 200);
  const where = await filterWhere(req, { topicId: topic.id });
  const [rows, total] = await Promise.all([
    prisma.problem.findMany({ where, orderBy: [{ subtopic: { order: 'asc' } }, { order: 'asc' }], skip: p.skip, take: p.take, select: pSelect }),
    prisma.problem.count({ where }),
  ]);
  send(res, pageOf(await hydrate(req, rows, p.skip + 1), total, p));
});

r.get('/companies', async (req: Request, res: Response) => {
  const sheetId = String(req.query.sheetId ?? '');
  const sheet = sheetId ? await sheetOf(sheetId) : null;
  const rows = await prisma.company.findMany({
    where: { problems: { some: { problem: { isPublished: true, ...(sheet ? { topic: { sheetId: sheet.id } } : {}) } } } },
    orderBy: { name: 'asc' }, select: { id: true, name: true, logoUrl: true },
  });
  send(res, rows.map((c) => ({ id: c.id, name: c.name, ...(c.logoUrl ? { logoUrl: c.logoUrl } : {}) })));
});

async function loadProblem(key: string) {
  const p = await prisma.problem.findFirst({ where: { isPublished: true, OR: [{ id: key }, { slug: key }] }, select: { ...pSelect, description: true, quickRevision: true } });
  if (!p) throw E.notFound('Problem not found');
  return p;
}

r.get('/problems/:id', optionalAuth, async (req: Request, res: Response) => {
  const p = await loadProblem(req.params.id);
  const [out] = await hydrate(req, [p]);
  const { description, quickRevision, ...row } = p;
  void row;
  send(res, out.locked ? out : { ...out, ...(description ? { description } : {}), ...(quickRevision ? { quickNotes: quickRevision } : {}), ...(p.hints.length ? { hints: p.hints } : {}), ...(p.tags.length ? { tags: p.tags } : {}), ...((p.images.length || p.imageUrl) ? { images: [...(p.imageUrl ? [p.imageUrl] : []), ...p.images] } : {}) });
});

const valueBody = z.object({ value: z.boolean().default(true) });
const progressKey = (uid: string, pid: string) => ({ userId_problemId: { userId: uid, problemId: pid } });

r.put('/problems/:id/solved', authenticate, async (req: Request, res: Response) => {
  const { id } = await loadProblem(req.params.id);
  const { value } = valueBody.parse(req.body ?? {});
  const userId = req.user!.id;
  try {
    await prisma.$transaction(async (tx) => {
      const key = progressKey(userId, id);
      const prev = await tx.userProblemProgress.findUnique({ where: key });
      if (value) {
        if (prev?.status === 'SOLVED') return;
        if (prev) {
          const changed = await tx.userProblemProgress.updateMany({
            where: { userId, problemId: id, status: { not: 'SOLVED' } },
            data: { status: 'SOLVED', solvedAt: new Date(), attempts: { increment: 1 } },
          });
          if (!changed.count) return;
        } else {
          await tx.userProblemProgress.create({ data: { userId, problemId: id, status: 'SOLVED', solvedAt: new Date(), attempts: 1 } });
        }
        await clearProblemSolveActivity(tx, userId, id);
        await recordActivity(tx, userId, 'PROBLEM_SOLVED', { refType: 'Problem', refId: id });
        return;
      }

      if (prev?.status !== 'SOLVED') return;
      await tx.userProblemProgress.update({ where: key, data: { status: 'IN_PROGRESS', solvedAt: null } });
      await clearProblemSolveActivity(tx, userId, id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (value && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const current = await prisma.userProblemProgress.findUnique({ where: progressKey(userId, id), select: { status: true } });
      if (current?.status === 'SOLVED') return void send(res, { solved: true });
    }
    throw err;
  }
  send(res, { solved: value });
});

r.put('/problems/:id/bookmark', authenticate, async (req: Request, res: Response) => {
  const { id } = await loadProblem(req.params.id);
  const { value } = valueBody.parse(req.body ?? {});
  const key = { userId_targetType_targetId: { userId: req.user!.id, targetType: 'PROBLEM' as const, targetId: id } };
  const exists = await prisma.bookmark.findUnique({ where: key });
  if (value && !exists) { await prisma.bookmark.create({ data: { userId: req.user!.id, targetType: 'PROBLEM', targetId: id } }); await logActivity(req.user!.id, 'PROBLEM_BOOKMARKED', { refType: 'Problem', refId: id }); }
  if (!value && exists) await prisma.bookmark.delete({ where: key });
  send(res, { bookmarked: value });
});

r.put('/problems/:id/revision', authenticate, async (req: Request, res: Response) => {
  const { id } = await loadProblem(req.params.id);
  const { value } = valueBody.parse(req.body ?? {});
  const userId = req.user!.id;
  await prisma.userProblemProgress.upsert({ where: progressKey(userId, id), create: { userId, problemId: id, status: 'NOT_STARTED', flaggedForRevision: value }, update: { flaggedForRevision: value } });
  if (value) await logActivity(userId, 'PROBLEM_FLAGGED', { refType: 'Problem', refId: id });
  send(res, { revision: value });
});

r.put('/problems/:id/note', authenticate, async (req: Request, res: Response) => {
  const { id } = await loadProblem(req.params.id);
  const { note } = z.object({ note: z.string().max(10000) }).parse(req.body ?? {});
  const userId = req.user!.id;
  const text = stripHtml(note).trim() || null;
  const date = localDate();
  await prisma.$transaction(async (tx) => {
    const key = progressKey(userId, id);
    const prev = await tx.userProblemProgress.findUnique({ where: key });
    if (prev) {
      const changed = await tx.userProblemProgress.updateMany({
        where: { userId, problemId: id, ...(text ? { personalNote: null } : {}) },
        data: { personalNote: text },
      });
      if (text && changed.count) await recordActivity(tx, userId, 'PERSONAL_NOTE_CREATED', { refType: 'Problem', refId: id }, date);
      else if (text && !changed.count) await tx.userProblemProgress.update({ where: key, data: { personalNote: text } });
      return;
    }

    const created = await tx.userProblemProgress.createMany({
      data: [{ userId, problemId: id, status: 'NOT_STARTED', personalNote: text }],
      skipDuplicates: true,
    });
    if (created.count) {
      if (text) await recordActivity(tx, userId, 'PERSONAL_NOTE_CREATED', { refType: 'Problem', refId: id }, date);
      return;
    }

    // A concurrent request inserted the progress row. Count only the request that
    // changes its note from empty to non-empty, while still saving later edits.
    const changed = text ? await tx.userProblemProgress.updateMany({ where: { userId, problemId: id, personalNote: null }, data: { personalNote: text } }) : { count: 0 };
    if (text && changed.count) await recordActivity(tx, userId, 'PERSONAL_NOTE_CREATED', { refType: 'Problem', refId: id }, date);
    if (!changed.count) await tx.userProblemProgress.update({ where: key, data: { personalNote: text } });
  });
  send(res, { note: text });
});

r.post('/problems/:id/hint', authenticate, async (req: Request, res: Response) => {
  const { id } = await loadProblem(req.params.id);
  const userId = req.user!.id;
  await prisma.userProblemProgress.upsert({ where: progressKey(userId, id), create: { userId, problemId: id, status: 'IN_PROGRESS', usedHint: true }, update: { usedHint: true } });
  send(res, { hintUsed: true });
});

r.post('/problems/:id/revised', authenticate, async (req: Request, res: Response) => {
  const { id } = await loadProblem(req.params.id);
  const userId = req.user!.id;
  const row = await prisma.userProblemProgress.findUnique({ where: progressKey(userId, id) });
  if (!row) throw E.notFound('No progress for this problem');
  const date = localDate();
  await prisma.$transaction(async (tx) => {
    const changed = await tx.userProblemProgress.updateMany({
      where: { userId, problemId: id, OR: [{ revisedAt: null }, { revisedAt: { lt: date } }] },
      data: { flaggedForRevision: false, revisedAt: new Date(), usedHint: false, wrongAttempts: 0 },
    });
    if (changed.count) await recordActivity(tx, userId, 'PROBLEM_REVISED', { refType: 'Problem', refId: id }, date);
    else await tx.userProblemProgress.update({ where: progressKey(userId, id), data: { flaggedForRevision: false, revisedAt: new Date(), usedHint: false, wrongAttempts: 0 } });
  });
  // The endpoint is safe to retry; one problem can count as revised at most once per app-local day.
  send(res, { revised: true });
});

// ───── Revision ─────
type Tab = 'flagged' | 'hint' | 'notes' | 'wrong' | 'recent';
const tabWhere = (uid: string, t: Tab): Prisma.UserProblemProgressWhereInput => {
  const base = { userId: uid, problem: { isPublished: true } };
  switch (t) {
    case 'flagged': return { ...base, flaggedForRevision: true };
    case 'hint': return { ...base, usedHint: true, status: 'SOLVED' };
    case 'notes': return { ...base, personalNote: { not: null } };
    case 'wrong': return { ...base, wrongAttempts: { gt: 0 } };
    default: return { ...base, status: 'SOLVED', solvedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } };
  }
};
const TABS: Tab[] = ['flagged', 'hint', 'notes', 'wrong', 'recent'];

r.get('/revision/counts', authenticate, async (req: Request, res: Response) => {
  const c = await Promise.all(TABS.map((t) => prisma.userProblemProgress.count({ where: tabWhere(req.user!.id, t) })));
  send(res, Object.fromEntries(TABS.map((t, i) => [t, c[i]])));
});

r.get('/revision', authenticate, async (req: Request, res: Response) => {
  const type = (TABS as string[]).includes(String(req.query.type)) ? (req.query.type as Tab) : 'flagged';
  const uid = req.user!.id;
  const counts = await Promise.all(TABS.map((t) => prisma.userProblemProgress.count({ where: tabWhere(uid, t) })));
  const rows = await prisma.userProblemProgress.findMany({ where: tabWhere(uid, type), orderBy: { updatedAt: 'desc' }, take: 200, select: { revisedAt: true, problem: { select: pSelect } } });
  const items = await hydrate(req, rows.map((x) => x.problem));
  send(res, { counts: Object.fromEntries(TABS.map((t, i) => [t, counts[i]])), items: items.map((it, i) => ({ ...it, ...(rows[i].revisedAt ? { revisedAt: rows[i].revisedAt!.toISOString() } : {}) })) });
});

r.get('/bookmarks', authenticate, async (req: Request, res: Response) => {
  const p = pq(req, 20);
  const where: Prisma.BookmarkWhereInput = { userId: req.user!.id, targetType: 'PROBLEM' };
  const [marks, total] = await Promise.all([prisma.bookmark.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.bookmark.count({ where })]);
  const rows = await prisma.problem.findMany({ where: { id: { in: marks.map((m) => m.targetId) }, isPublished: true }, select: pSelect });
  const byId = new Map(rows.map((x) => [x.id, x]));
  const ordered = marks.map((m) => byId.get(m.targetId)).filter((x): x is PRow => !!x);
  send(res, pageOf(await hydrate(req, ordered, p.skip + 1), total, p));
});

export default r;
