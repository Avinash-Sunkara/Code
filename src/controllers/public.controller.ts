import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { safeText } from '../validators/common';

export async function stats(_req: Request, res: Response) {
  const [problems, topics, learners, sheets, interviews, companies] = await Promise.all([
    prisma.problem.count({ where: { isPublished: true } }),
    prisma.dSATopic.count({ where: { sheet: { isPublished: true } } }),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.dSASheet.count({ where: { isPublished: true } }),
    prisma.interviewExperience.count({ where: { isPublished: true } }),
    prisma.company.count(),
  ]);
  ok(res, { problems, patterns: topics, topics, learners, sheets, interviews, companies });
}

export async function testimonials(_req: Request, res: Response) {
  ok(res, await prisma.testimonial.findMany({ where: { isPublished: true }, orderBy: { order: 'asc' }, take: 30 }));
}

export async function companies(req: Request, res: Response) {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
  ok(res, await prisma.company.findMany({ where: q ? { name: { contains: q, mode: 'insensitive' } } : {}, orderBy: { name: 'asc' }, take: 100 }));
}

export async function feedback(req: Request, res: Response) {
  const d = z.object({ message: safeText(3, 3000), page: z.string().max(200).optional() }).parse(req.body);
  await prisma.feedback.create({ data: { userId: req.user?.id, message: d.message, page: d.page } });
  ok(res, {}, 'Thanks for the feedback!', 201);
}

export async function search(req: Request, res: Response) {
  const f = z.object({
    q: z.string().trim().min(2).max(100),
    type: z.enum(['problems', 'topics', 'companies', 'notes', 'roadmaps', 'cheatsheets', 'interviews']).optional(),
  }).parse(req.query);
  const p = pageParams(req.query, { defaultLimit: 10, maxLimit: 30 });
  const c = { contains: f.q, mode: 'insensitive' as const };
  const pg = { skip: p.skip, take: p.take };
  const run = async <T>(name: string, find: () => Promise<T[]>, count: () => Promise<number>) =>
    !f.type || f.type === name ? [name, { items: await find(), total: await count() }] as const : null;

  const entries = await Promise.all([
    run('problems', () => prisma.problem.findMany({ where: { isPublished: true, OR: [{ title: c }, { pattern: c }] }, select: { id: true, title: true, slug: true, difficulty: true, pattern: true }, orderBy: { title: 'asc' }, ...pg }),
      () => prisma.problem.count({ where: { isPublished: true, OR: [{ title: c }, { pattern: c }] } })),
    run('topics', async () => {
      const [d, core, apt] = await Promise.all([
        prisma.dSATopic.findMany({ where: { name: c, sheet: { isPublished: true } }, select: { id: true, name: true, slug: true, sheet: { select: { slug: true } } }, ...pg }),
        prisma.coreTopic.findMany({ where: { name: c, isPublished: true }, select: { id: true, name: true, slug: true, category: { select: { slug: true } } }, ...pg }),
        prisma.aptitudeTopic.findMany({ where: { name: c, isPublished: true }, select: { id: true, name: true, slug: true }, ...pg }),
      ]);
      return [...d.map((x) => ({ ...x, kind: 'dsa' })), ...core.map((x) => ({ ...x, kind: 'core' })), ...apt.map((x) => ({ ...x, kind: 'aptitude' }))] as any[];
    }, async () => (await Promise.all([prisma.dSATopic.count({ where: { name: c, sheet: { isPublished: true } } }), prisma.coreTopic.count({ where: { name: c, isPublished: true } }), prisma.aptitudeTopic.count({ where: { name: c, isPublished: true } })])).reduce((a, b) => a + b, 0)),
    run('companies', () => prisma.company.findMany({ where: { name: c }, select: { id: true, name: true, slug: true, logoUrl: true }, orderBy: { name: 'asc' }, ...pg }), () => prisma.company.count({ where: { name: c } })),
    run('notes', () => prisma.note.findMany({ where: { isPublished: true, OR: [{ title: c }, { description: c }] }, select: { id: true, title: true, slug: true, category: true, accessType: true, price: true }, ...pg }), () => prisma.note.count({ where: { isPublished: true, OR: [{ title: c }, { description: c }] } })),
    run('roadmaps', () => prisma.roadmap.findMany({ where: { isPublished: true, OR: [{ title: c }, { description: c }] }, select: { id: true, title: true, slug: true, isPremium: true }, ...pg }), () => prisma.roadmap.count({ where: { isPublished: true, OR: [{ title: c }, { description: c }] } })),
    run('cheatsheets', () => prisma.cheatSheet.findMany({ where: { isPublished: true, OR: [{ title: c }, { description: c }] }, select: { id: true, title: true, slug: true, category: true, accessType: true, price: true }, ...pg }), () => prisma.cheatSheet.count({ where: { isPublished: true, OR: [{ title: c }, { description: c }] } })),
    run('interviews', () => prisma.interviewExperience.findMany({ where: { isPublished: true, OR: [{ title: c }, { company: c }, { role: c }] }, select: { id: true, title: true, slug: true, company: true, role: true, status: true }, orderBy: { createdAt: 'desc' }, ...pg }), () => prisma.interviewExperience.count({ where: { isPublished: true, OR: [{ title: c }, { company: c }, { role: c }] } })),
  ]);
  ok(res, { query: f.q, page: p.page, limit: p.limit, results: Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => !!e)) });
}
