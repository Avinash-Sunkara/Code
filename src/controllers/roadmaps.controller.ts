import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { E, ok } from '../utils/http';
import { entitledIds } from '../services/access';
import { logActivity } from '../services/activity';

export async function listRoadmaps(req: Request, res: Response) {
  const rows = await prisma.roadmap.findMany({
    where: { isPublished: true }, orderBy: { order: 'asc' },
    select: { id: true, title: true, slug: true, description: true, imageUrl: true, isPremium: true, price: true },
  });
  const [owned, counts, done] = await Promise.all([
    entitledIds(req.user?.id, 'ROADMAP'),
    prisma.roadmapResource.findMany({ where: { topic: { section: { roadmap: { isPublished: true } } } }, select: { topic: { select: { section: { select: { roadmapId: true } } } } } }).then((r) => {
      const m = new Map<string, number>();
      for (const x of r) m.set(x.topic.section.roadmapId, (m.get(x.topic.section.roadmapId) ?? 0) + 1);
      return m;
    }),
    req.user ? prisma.userRoadmapProgress.groupBy({ by: ['roadmapId'], where: { userId: req.user.id, completed: true }, _count: { _all: true } }) : [],
  ]);
  const doneMap = new Map(done.map((d) => [d.roadmapId, d._count._all]));
  ok(res, rows.map((r) => ({ ...r, locked: r.isPremium && req.user?.role !== 'ADMIN' && !owned.has(r.id), resourceCount: counts.get(r.id) ?? 0, completed: doneMap.get(r.id) ?? 0 })));
}

export async function getRoadmap(req: Request, res: Response) {
  const key = req.params.id;
  const rm = await prisma.roadmap.findFirst({
    where: { isPublished: true, OR: [{ id: key }, { slug: key }] },
    include: { sections: { orderBy: { order: 'asc' }, include: { topics: { orderBy: { order: 'asc' }, include: { resources: { orderBy: { order: 'asc' } } } } } } },
  });
  if (!rm) throw E.notFound('Roadmap not found');
  const admin = req.user?.role === 'ADMIN';
  const [owned, ownedRes, progress] = await Promise.all([
    entitledIds(req.user?.id, 'ROADMAP'), entitledIds(req.user?.id, 'ROADMAP_RESOURCE'),
    req.user ? prisma.userRoadmapProgress.findMany({ where: { userId: req.user.id, roadmapId: rm.id, completed: true }, select: { resourceId: true } }) : [],
  ]);
  const doneSet = new Set(progress.map((p) => p.resourceId));
  const roadmapLocked = rm.isPremium && !admin && !owned.has(rm.id);
  if (req.user) await logActivity(req.user.id, 'ROADMAP_VIEWED', { refType: 'Roadmap', refId: rm.id });
  ok(res, {
    id: rm.id, title: rm.title, slug: rm.slug, description: rm.description, imageUrl: rm.imageUrl, isPremium: rm.isPremium, price: rm.price, locked: roadmapLocked,
    sections: rm.sections.map((s) => ({
      id: s.id, title: s.title, description: s.description,
      topics: s.topics.map((t) => ({
        id: t.id, title: t.title, description: t.description,
        resources: t.resources.map((r) => {
          const locked = (rm.isPremium || r.isPremium) && !admin && !owned.has(rm.id) && !ownedRes.has(r.id);
          // Content / file / links are never part of the roadmap tree: fetch via POST /api/resources/:id/access after the access check
          return { id: r.id, type: r.type, title: r.title, description: r.description, imageUrl: r.imageUrl, isPremium: r.isPremium, price: r.price, locked, completed: doneSet.has(r.id) };
        }),
      })),
    })),
  });
}

async function resolveRoadmap(key: string) {
  const rm = await prisma.roadmap.findFirst({ where: { isPublished: true, OR: [{ id: key }, { slug: key }] }, select: { id: true } });
  if (!rm) throw E.notFound('Roadmap not found');
  return rm.id;
}

export async function roadmapProgress(req: Request, res: Response) {
  const id = await resolveRoadmap(req.params.id);
  const [total, done] = await Promise.all([
    prisma.roadmapResource.count({ where: { topic: { section: { roadmapId: id } } } }),
    prisma.userRoadmapProgress.findMany({ where: { userId: req.user!.id, roadmapId: id, completed: true }, select: { resourceId: true, completedAt: true } }),
  ]);
  ok(res, { roadmapId: id, total, completed: done.length, percent: total ? Math.round((done.length / total) * 100) : 0, completedResources: done });
}

export async function completeResource(req: Request, res: Response) {
  const id = await resolveRoadmap(req.params.id);
  const resource = await prisma.roadmapResource.findFirst({ where: { id: req.params.resourceId, topic: { section: { roadmapId: id } } }, select: { id: true } });
  if (!resource) throw E.notFound('Resource not found in this roadmap');
  const userId = req.user!.id;
  const prev = await prisma.userRoadmapProgress.findUnique({ where: { userId_resourceId: { userId, resourceId: resource.id } } });
  const completed = req.body?.completed === false ? false : true;
  await prisma.userRoadmapProgress.upsert({
    where: { userId_resourceId: { userId, resourceId: resource.id } },
    create: { userId, roadmapId: id, resourceId: resource.id, completed, completedAt: completed ? new Date() : null },
    update: { completed, completedAt: completed ? new Date() : null },
  });
  if (completed && !prev?.completed) await logActivity(userId, 'ROADMAP_RESOURCE_COMPLETED', { refType: 'RoadmapResource', refId: resource.id });
  ok(res, { resourceId: resource.id, completed });
}
