import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { E } from '../utils/http';
import { optionalAuth } from '../middleware/auth';
import { diffIn, diffOut, pageOf, pq, send } from './util';

/** Public puzzles (docs/API_CONTRACT.md). Puzzles are never sold, so premium-flagged rows (only creatable via the legacy API) stay hidden here. */
const r = Router();
const visible: Prisma.PuzzleWhereInput = { isPublished: true, isPremium: false };

r.get('/puzzles', async (req: Request, res: Response) => {
  const p = pq(req, 20, 100);
  const pattern = String(req.query.pattern ?? '').trim().slice(0, 120);
  const difficulty = diffIn(req.query.difficulty);
  const where: Prisma.PuzzleWhereInput = {
    ...visible,
    ...(pattern ? { pattern } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(p.q ? { OR: [{ title: { contains: p.q, mode: 'insensitive' } }, { pattern: { contains: p.q, mode: 'insensitive' } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.puzzle.findMany({ where, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }], skip: p.skip, take: p.take, select: { id: true, title: true, slug: true, pattern: true, difficulty: true, imageUrl: true } }),
    prisma.puzzle.count({ where }),
  ]);
  send(res, pageOf(rows.map((x) => ({ id: x.id, title: x.title, slug: x.slug, difficulty: diffOut(x.difficulty), ...(x.pattern ? { pattern: x.pattern } : {}), ...(x.imageUrl ? { imageUrl: x.imageUrl } : {}) })), total, p));
});

// Declared before /puzzles/:slug so "patterns" is not treated as a slug.
r.get('/puzzles/patterns', async (_req: Request, res: Response) => {
  const rows = await prisma.puzzle.groupBy({ by: ['pattern'], where: visible, _count: { _all: true } });
  send(res, rows.filter((x): x is typeof x & { pattern: string } => !!x.pattern).sort((a, b) => a.pattern.localeCompare(b.pattern)).map((x) => ({ pattern: x.pattern, count: x._count._all })));
});

r.get('/puzzles/:slug', optionalAuth, async (req: Request, res: Response) => {
  const x = await prisma.puzzle.findFirst({ where: { ...visible, OR: [{ slug: req.params.slug }, { id: req.params.slug }] } });
  if (!x) throw E.notFound('Puzzle not found');
  send(res, {
    id: x.id, title: x.title, slug: x.slug, description: x.description, difficulty: diffOut(x.difficulty),
    ...(x.pattern ? { pattern: x.pattern } : {}), ...(x.imageUrl ? { imageUrl: x.imageUrl } : {}), ...(x.solution ? { solution: x.solution } : {}),
    hints: Array.isArray(x.hints) ? (x.hints as unknown[]).map(String) : [],
  });
});

export default r;
