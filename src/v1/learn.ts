import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { E } from '../utils/http';
import { authenticate, optionalAuth } from '../middleware/auth';
import { logActivity, recordActivity } from '../services/activity';
import { diffOut, send } from './util';

const r = Router();
type Kind = 'core' | 'aptitude';

const slugify = (s: string) => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/&amp;/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section';

/** Ensure every h2/h3 has an id and return the heading list for the "On this page" rail. */
export function withHeadings(html: string) {
  const headings: { id: string; text: string; level: number }[] = [];
  const used = new Set<string>();
  const out = html.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, attrs: string, inner: string) => {
    const text = inner.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
    let id = /\sid=["']([^"']+)["']/.exec(attrs)?.[1] ?? slugify(text);
    while (used.has(id)) id += '-x';
    used.add(id);
    headings.push({ id, text, level: +lvl });
    return /\sid=/.test(attrs) ? `<h${lvl}${attrs}>${inner}</h${lvl}>` : `<h${lvl}${attrs} id="${id}">${inner}</h${lvl}>`;
  });
  return { html: out, headings };
}

const doneSet = async (uid: string | undefined, kind: Kind) =>
  new Set(uid ? (await prisma.topicCompletion.findMany({ where: { userId: uid, kind }, select: { topicId: true } })).map((x) => x.topicId) : []);

// ───── Core CS (/core-cs) ─────
r.get('/core-cs/categories', async (_req: Request, res: Response) => {
  const cats = await prisma.coreCategory.findMany({ orderBy: { order: 'asc' }, include: { _count: { select: { topics: { where: { isPublished: true } } } } } });
  send(res, cats.map((c) => ({ id: c.id, slug: c.slug, title: c.name, topicCount: c._count.topics })));
});

r.get('/core-cs/categories/:slug/patterns', optionalAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const cat = await prisma.coreCategory.findFirst({ where: { OR: [{ slug: req.params.slug }, { id: req.params.slug }] } });
  if (!cat) throw E.notFound('Category not found');
  const [topics, patterns, done] = await Promise.all([
    prisma.coreTopic.findMany({ where: { categoryId: cat.id, isPublished: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) }, orderBy: { order: 'asc' }, select: { id: true, name: true, slug: true, patternId: true } }),
    prisma.corePattern.findMany({ where: { categoryId: cat.id }, orderBy: { order: 'asc' } }),
    doneSet(req.user?.id, 'core'),
  ]);
  const t = (x: (typeof topics)[number]) => ({ id: x.id, title: x.name, slug: x.slug, completed: done.has(x.id) });
  const groups = patterns.map((p) => ({ id: p.id, title: p.name.toUpperCase(), topics: topics.filter((x) => x.patternId === p.id).map(t) }));
  const loose = topics.filter((x) => !x.patternId).map(t);
  if (loose.length) groups.push({ id: `${cat.id}-other`, title: cat.name.toUpperCase(), topics: loose });
  send(res, groups.filter((g) => g.topics.length));
});

r.get('/core-cs/topics/:slug', optionalAuth, async (req: Request, res: Response) => {
  const t = await prisma.coreTopic.findFirst({
    where: { isPublished: true, OR: [{ slug: req.params.slug }, { id: req.params.slug }] },
    include: { pattern: { select: { name: true } }, contents: { where: { isPublished: true }, orderBy: { order: 'asc' } } },
  });
  if (!t) throw E.notFound('Topic not found');
  if (req.user) await logActivity(req.user.id, 'NOTE_VIEWED', { refType: 'CoreTopic', refId: t.id });
  const raw = t.contents.map((c) => (c.title ? `<h2>${c.title}</h2>\n${c.body}` : c.body)).join('\n');
  const { html, headings } = withHeadings(raw);
  const done = await doneSet(req.user?.id, 'core');
  send(res, { id: t.id, title: t.name, slug: t.slug, ...(t.pattern ? { patternTitle: t.pattern.name.toUpperCase() } : {}), ...(t.summary ? { summary: t.summary } : {}), html, headings, practiceCount: 0, completed: done.has(t.id), locked: false, access: 'FREE' });
});

r.get('/core-cs/topics/:slug/questions', async (_req: Request, res: Response) => { send(res, []); });

// ───── Aptitude (/aptitude) ─────
r.get('/aptitude/categories', async (_req: Request, res: Response) => {
  const cats = await prisma.aptitudeCategory.findMany({ orderBy: { order: 'asc' }, include: { _count: { select: { topics: { where: { isPublished: true } } } } } });
  send(res, cats.map((c) => ({ id: c.id, slug: c.slug, title: c.name, topicCount: c._count.topics })));
});

r.get('/aptitude/categories/:slug/patterns', optionalAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const cat = await prisma.aptitudeCategory.findFirst({ where: { OR: [{ slug: req.params.slug }, { id: req.params.slug }] } });
  if (!cat) throw E.notFound('Category not found');
  const [topics, done] = await Promise.all([
    prisma.aptitudeTopic.findMany({ where: { categoryId: cat.id, isPublished: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) }, orderBy: { order: 'asc' }, select: { id: true, name: true, slug: true } }),
    doneSet(req.user?.id, 'aptitude'),
  ]);
  send(res, topics.length ? [{ id: cat.id, title: cat.name.toUpperCase(), topics: topics.map((x) => ({ id: x.id, title: x.name, slug: x.slug, completed: done.has(x.id) })) }] : []);
});

async function aptTopic(slug: string) {
  const t = await prisma.aptitudeTopic.findFirst({ where: { isPublished: true, OR: [{ slug }, { id: slug }] }, include: { category: { select: { name: true } }, _count: { select: { questions: true } } } });
  if (!t) throw E.notFound('Topic not found');
  return t;
}

r.get('/aptitude/topics/:slug', optionalAuth, async (req: Request, res: Response) => {
  const t = await aptTopic(req.params.slug);
  if (req.user) await logActivity(req.user.id, 'NOTE_VIEWED', { refType: 'AptitudeTopic', refId: t.id });
  const { html, headings } = withHeadings(t.notes ?? '<p>Notes for this topic are coming from the admin soon.</p>');
  const done = await doneSet(req.user?.id, 'aptitude');
  send(res, { id: t.id, title: t.name, slug: t.slug, patternTitle: t.category.name.toUpperCase(), html, headings, practiceCount: t._count.questions, completed: done.has(t.id), locked: false, access: 'FREE' });
});

r.get('/aptitude/topics/:slug/questions', optionalAuth, async (req: Request, res: Response) => {
  const t = await aptTopic(req.params.slug);
  const qs = await prisma.aptitudeQuestion.findMany({ where: { topicId: t.id }, orderBy: { order: 'asc' } });
  const attempts = req.user ? await prisma.aptitudeAttempt.findMany({ where: { userId: req.user.id, questionId: { in: qs.map((x) => x.id) } } }) : [];
  const at = new Map(attempts.map((a) => [a.questionId, a]));
  send(res, qs.map((x) => ({ id: x.id, prompt: x.question, options: Array.isArray(x.options) ? (x.options as unknown[]).map(String) : [], difficulty: diffOut(x.difficulty), solved: !!at.get(x.id)?.correct })));
});

r.post('/aptitude/questions/:id/answer', authenticate, async (req: Request, res: Response) => {
  const { choice } = z.object({ choice: z.number().int().min(0).max(20) }).parse(req.body ?? {});
  const q = await prisma.aptitudeQuestion.findUnique({ where: { id: req.params.id } });
  if (!q) throw E.notFound('Question not found');
  const options = Array.isArray(q.options) ? q.options : [];
  if (choice >= options.length) throw E.badRequest('Invalid option');
  const correct = choice === q.correctIndex;
  const userId = req.user!.id;
  await prisma.$transaction(async (tx) => {
    let prev = await tx.aptitudeAttempt.findUnique({ where: { userId_questionId: { userId, questionId: q.id } } });
    if (!prev) {
      const created = await tx.aptitudeAttempt.createMany({ data: [{ userId, questionId: q.id, correct }], skipDuplicates: true });
      if (created.count) {
        await recordActivity(tx, userId, 'PRACTICE', { refType: 'AptitudeQuestion', refId: q.id });
        return;
      }
      // Another concurrent request created this user's first attempt. Re-read it and update
      // the answer without emitting a second contribution event.
      prev = await tx.aptitudeAttempt.findUnique({ where: { userId_questionId: { userId, questionId: q.id } } });
    }
    if (prev && !prev.correct && correct) {
      await tx.aptitudeAttempt.update({ where: { userId_questionId: { userId, questionId: q.id } }, data: { correct: true } });
    }
  });
  send(res, { correct, answerIndex: q.correctIndex, ...(q.explanation ? { explanation: q.explanation } : {}) });
});

// Mark a topic complete (both content sections share the same endpoint shape)
for (const [base, kind] of [['core-cs', 'core'], ['aptitude', 'aptitude']] as const) {
  r.post(`/${base}/topics/:slug/complete`, authenticate, async (req: Request, res: Response) => {
    const slug = req.params.slug;
    const topic = kind === 'core'
      ? await prisma.coreTopic.findFirst({ where: { isPublished: true, OR: [{ slug }, { id: slug }] }, select: { id: true } })
      : await prisma.aptitudeTopic.findFirst({ where: { isPublished: true, OR: [{ slug }, { id: slug }] }, select: { id: true } });
    if (!topic) throw E.notFound('Topic not found');
    await prisma.topicCompletion.upsert({ where: { userId_kind_topicId: { userId: req.user!.id, kind, topicId: topic.id } }, create: { userId: req.user!.id, kind, topicId: topic.id }, update: {} });
    send(res, { completed: true });
  });
}

export default r;
