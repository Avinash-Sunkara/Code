import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { E, ok, page } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { logActivity } from '../services/activity';

// ───── Core CS ─────
export async function coreCategories(_req: Request, res: Response) {
  const cats = await prisma.coreCategory.findMany({ orderBy: { order: 'asc' }, include: { _count: { select: { topics: { where: { isPublished: true } } } } } });
  ok(res, cats.map((c) => ({ id: c.id, name: c.name, slug: c.slug, description: c.description, topicCount: c._count.topics })));
}

export async function coreCategory(req: Request, res: Response) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const cat = await prisma.coreCategory.findFirst({ where: { OR: [{ slug: req.params.slug }, { id: req.params.slug }] } });
  if (!cat) throw E.notFound('Category not found');
  const topics = await prisma.coreTopic.findMany({
    where: { categoryId: cat.id, isPublished: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
    orderBy: { order: 'asc' }, select: { id: true, name: true, slug: true, summary: true, order: true, patternId: true },
  });
  const patterns = await prisma.corePattern.findMany({ where: { categoryId: cat.id }, orderBy: { order: 'asc' } });
  ok(res, {
    category: { id: cat.id, name: cat.name, slug: cat.slug },
    patterns: patterns.map((p) => ({ id: p.id, name: p.name, slug: p.slug, topics: topics.filter((t) => t.patternId === p.id) })).filter((p) => !q || p.topics.length),
    ungrouped: topics.filter((t) => !t.patternId),
  });
}

export async function coreTopic(req: Request, res: Response) {
  const t = await prisma.coreTopic.findFirst({
    where: { isPublished: true, OR: [{ slug: req.params.slug }, { id: req.params.slug }] },
    include: { category: { select: { name: true, slug: true } }, pattern: { select: { name: true } }, contents: { where: { isPublished: true }, orderBy: { order: 'asc' } } },
  });
  if (!t) throw E.notFound('Topic not found');
  if (req.user) await logActivity(req.user.id, 'NOTE_VIEWED', { refType: 'CoreTopic', refId: t.id });
  ok(res, t);
}

// ───── Aptitude ─────
export async function aptitudeCategories(req: Request, res: Response) {
  const cats = await prisma.aptitudeCategory.findMany({
    orderBy: { order: 'asc' },
    include: { topics: { where: { isPublished: true }, orderBy: { order: 'asc' }, select: { id: true, name: true, slug: true, _count: { select: { questions: true } } } } },
  });
  const done = new Map<string, number>();
  if (req.user) {
    const rows = await prisma.aptitudeAttempt.findMany({ where: { userId: req.user.id, correct: true }, select: { question: { select: { topicId: true } } } });
    for (const r of rows) done.set(r.question.topicId, (done.get(r.question.topicId) ?? 0) + 1);
  }
  ok(res, cats.map((c) => {
    const topics = c.topics.map((t) => ({ id: t.id, name: t.name, slug: t.slug, questionCount: t._count.questions, correct: done.get(t.id) ?? 0 }));
    const total = topics.reduce((s, t) => s + t.questionCount, 0), correct = topics.reduce((s, t) => s + t.correct, 0);
    return { id: c.id, name: c.name, slug: c.slug, topicCount: topics.length, percent: total ? Math.round((correct / total) * 100) : 0, topics };
  }));
}

export async function aptitudeTopic(req: Request, res: Response) {
  const t = await prisma.aptitudeTopic.findFirst({
    where: { isPublished: true, OR: [{ slug: req.params.slug }, { id: req.params.slug }] },
    include: { category: { select: { name: true, slug: true } }, _count: { select: { questions: true } } },
  });
  if (!t) throw E.notFound('Topic not found');
  if (req.user) await logActivity(req.user.id, 'NOTE_VIEWED', { refType: 'AptitudeTopic', refId: t.id });
  ok(res, t);
}

export async function aptitudeQuestions(req: Request, res: Response) {
  const topic = await prisma.aptitudeTopic.findFirst({ where: { isPublished: true, OR: [{ slug: req.params.slug }, { id: req.params.slug }] }, select: { id: true } });
  if (!topic) throw E.notFound('Topic not found');
  const p = pageParams(req.query, { sortable: ['order'], defaultSort: 'order', defaultDir: 'asc', defaultLimit: 10, maxLimit: 50 });
  const where = { topicId: topic.id };
  const [items, total] = await Promise.all([
    prisma.aptitudeQuestion.findMany({ where, orderBy: p.orderBy, skip: p.skip, take: p.take, select: { id: true, question: true, options: true, difficulty: true, order: true } }), // correctIndex never sent
    prisma.aptitudeQuestion.count({ where }),
  ]);
  page(res, items, total, p.page, p.limit);
}

export async function answerQuestion(req: Request, res: Response) {
  const { choice } = z.object({ choice: z.number().int().min(0).max(7) }).parse(req.body);
  const q = await prisma.aptitudeQuestion.findUnique({ where: { id: req.params.id } });
  if (!q) throw E.notFound('Question not found');
  const correct = q.correctIndex === choice;
  const userId = req.user!.id;
  const prev = await prisma.aptitudeAttempt.findUnique({ where: { userId_questionId: { userId, questionId: q.id } } });
  await prisma.aptitudeAttempt.upsert({
    where: { userId_questionId: { userId, questionId: q.id } },
    create: { userId, questionId: q.id, correct },
    update: { correct: prev?.correct ? true : correct }, // a once-correct answer stays counted
  });
  if (!prev) await logActivity(userId, 'PRACTICE', { refType: 'AptitudeQuestion', refId: q.id });
  ok(res, { correct, correctIndex: q.correctIndex, explanation: q.explanation });
}

// ───── Puzzles ─────
export async function listPuzzles(req: Request, res: Response) {
  const f = z.object({ pattern: z.string().max(120).optional(), difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(), q: z.string().max(100).optional() }).parse(req.query);
  const p = pageParams(req.query, { sortable: ['order', 'title'], defaultSort: 'order', defaultDir: 'asc' });
  const where: any = { isPublished: true, ...(f.pattern && { pattern: f.pattern }), ...(f.difficulty && { difficulty: f.difficulty }), ...(f.q && { title: { contains: f.q, mode: 'insensitive' } }) };
  const [items, total, patterns] = await Promise.all([
    prisma.puzzle.findMany({ where, orderBy: p.orderBy, skip: p.skip, take: p.take, select: { id: true, title: true, slug: true, pattern: true, difficulty: true, isPremium: true, imageUrl: true } }),
    prisma.puzzle.count({ where }),
    prisma.puzzle.groupBy({ by: ['pattern'], where: { isPublished: true }, _count: { _all: true } }),
  ]);
  res.json({ success: true, data: { items, patterns: patterns.filter((x) => x.pattern).map((x) => ({ pattern: x.pattern, count: x._count._all })), pagination: { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) } }, message: 'OK' });
}

export async function getPuzzle(req: Request, res: Response) {
  const pz = await prisma.puzzle.findFirst({ where: { isPublished: true, OR: [{ slug: req.params.slug }, { id: req.params.slug }] } });
  if (!pz) throw E.notFound('Puzzle not found');
  if (pz.isPremium && req.user?.role !== 'ADMIN') {
    const e = req.user && (await prisma.contentEntitlement.findFirst({ where: { userId: req.user.id, contentType: 'PROBLEM', contentId: pz.id, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }));
    if (!e) return ok(res, { id: pz.id, title: pz.title, slug: pz.slug, pattern: pz.pattern, difficulty: pz.difficulty, locked: true });
  }
  ok(res, { ...pz, locked: false });
}
