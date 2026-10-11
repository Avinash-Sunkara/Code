import { Request, Response, Router } from 'express';
import { prisma } from '../config/db';
import { apiUrl } from '../config/env';
import { E } from '../utils/http';
import { authenticate, optionalAuth } from '../middleware/auth';
import { entitledIds } from '../services/access';
import { logActivity, rebuildDailyActivity, recordActivity } from '../services/activity';
import { signFileToken } from '../services/secureFile';
import { send } from './util';

const r = Router();
const TYPE: Record<string, string> = { VIDEO: 'video', LINK: 'link', PDF: 'pdf', IMAGE: 'image', TEXT: 'text' };

async function findRoadmap(key: string) {
  const rm = await prisma.roadmap.findFirst({
    where: { isPublished: true, OR: [{ id: key }, { slug: key }] },
    include: { sections: { orderBy: { order: 'asc' }, include: { topics: { orderBy: { order: 'asc' }, include: { resources: { orderBy: { order: 'asc' } } } } } } },
  });
  if (!rm) throw E.notFound('Roadmap not found');
  return rm;
}

/** Leaf nodes are topics; a roadmap's completion is the share of completed topics. */
const leafIds = (rm: Awaited<ReturnType<typeof findRoadmap>>) => rm.sections.flatMap((s) => s.topics.map((t) => t.id));

r.get('/roadmaps', optionalAuth, async (req: Request, res: Response) => {
  const rows = await prisma.roadmap.findMany({
    where: { isPublished: true }, orderBy: { order: 'asc' },
    include: { sections: { select: { id: true, topics: { select: { id: true } } } } },
  });
  const [owned, done] = await Promise.all([
    entitledIds(req.user?.id, 'ROADMAP'),
    req.user ? prisma.userRoadmapNode.findMany({ where: { userId: req.user.id, completed: true }, select: { nodeId: true, roadmapId: true } }) : [],
  ]);
  const doneIds = new Set(done.map((d) => d.nodeId));
  send(res, rows.map((x) => {
    const leaves = x.sections.flatMap((s) => s.topics.map((t) => t.id));
    const completed = leaves.filter((id) => doneIds.has(id)).length;
    return {
      id: x.id, title: x.title, ...(x.description ? { description: x.description } : {}), sectionCount: x.sections.length,
      completion: leaves.length ? Math.round((completed / leaves.length) * 100) : 0,
      access: x.isPremium ? 'PREMIUM' : 'FREE', locked: x.isPremium && req.user?.role !== 'ADMIN' && !owned.has(x.id), ...(x.isPremium ? { price: Number(x.price) } : {}),
    };
  }));
});

r.get('/roadmaps/:id', optionalAuth, async (req: Request, res: Response) => {
  const rm = await findRoadmap(req.params.id);
  const admin = req.user?.role === 'ADMIN';
  const [owned, ownedRes, nodes] = await Promise.all([
    entitledIds(req.user?.id, 'ROADMAP'), entitledIds(req.user?.id, 'ROADMAP_RESOURCE'),
    req.user ? prisma.userRoadmapNode.findMany({ where: { userId: req.user.id, roadmapId: rm.id, completed: true }, select: { nodeId: true } }) : [],
  ]);
  const doneIds = new Set(nodes.map((n) => n.nodeId));
  const leaves = leafIds(rm);
  const completion = leaves.length ? Math.round((leaves.filter((id) => doneIds.has(id)).length / leaves.length) * 100) : 0;
  const locked = rm.isPremium && !admin && !owned.has(rm.id);
  const head = {
    id: rm.id, title: rm.title, ...(rm.description ? { description: rm.description } : {}), sectionCount: rm.sections.length, completion,
    access: rm.isPremium ? 'PREMIUM' : 'FREE', locked, ...(rm.isPremium ? { price: Number(rm.price) } : {}),
  };
  if (locked) return void send(res, head); // locked content never includes its body
  if (req.user) await logActivity(req.user.id, 'ROADMAP_VIEWED', { refType: 'Roadmap', refId: rm.id });

  const resource = (x: (typeof rm.sections)[number]['topics'][number]['resources'][number]) => {
    const allowed = admin || !(rm.isPremium || x.isPremium) || owned.has(rm.id) || ownedRes.has(x.id);
    const base = { id: x.id, type: TYPE[x.type] ?? 'link', title: x.title };
    if (!allowed) return base;
    if (x.type === 'VIDEO') return { ...base, ...(x.youtubeUrl ? { url: x.youtubeUrl } : {}) };
    if (x.type === 'LINK') return { ...base, ...(x.externalUrl ? { url: x.externalUrl } : {}) };
    if (x.type === 'TEXT') return { ...base, ...(x.content ? { content: x.content } : {}) };
    if (req.user && x.fileKey) return { ...base, url: `${apiUrl}/api/files/resource/${x.id}?token=${signFileToken(req.user.id, 'resource', x.id, 3600)}` };
    return base;
  };

  send(res, {
    ...head,
    sections: rm.sections.map((s) => {
      const children = s.topics.map((t) => ({
        id: t.id, title: t.title, ...(t.description ? { description: t.description } : {}), completed: doneIds.has(t.id),
        resources: t.resources.map(resource),
      }));
      return { id: s.id, title: s.title, ...(s.description ? { description: s.description } : {}), completed: children.length > 0 && children.every((c) => c.completed), children };
    }),
  });
});

r.put('/roadmaps/:id/nodes/:nodeId', authenticate, async (req: Request, res: Response) => {
  const rm = await findRoadmap(req.params.id);
  const admin = req.user!.role === 'ADMIN';
  if (rm.isPremium && !admin && !(await entitledIds(req.user!.id, 'ROADMAP')).has(rm.id)) throw E.forbidden('Unlock this roadmap to track progress', 'CONTENT_LOCKED');
  const completed = req.body?.completed !== false;
  const nodeId = req.params.nodeId;
  const section = rm.sections.find((s) => s.id === nodeId);
  const topicIds = section ? section.topics.map((t) => t.id) : leafIds(rm).filter((id) => id === nodeId);
  if (!topicIds.length) throw E.notFound('Roadmap item not found');
  const userId = req.user!.id;
  await prisma.$transaction(async (tx) => {
    if (completed) {
      const changed = await tx.userRoadmapNode.updateMany({
        where: { userId, nodeId: { in: topicIds }, completed: false },
        data: { completed: true, completedAt: new Date() },
      });
      const existing = await tx.userRoadmapNode.findMany({ where: { userId, nodeId: { in: topicIds } }, select: { nodeId: true } });
      const existingIds = new Set(existing.map((row) => row.nodeId));
      const missing = topicIds.filter((id) => !existingIds.has(id));
      const inserted = missing.length ? await tx.userRoadmapNode.createMany({
        data: missing.map((id) => ({ userId, roadmapId: rm.id, nodeId: id, completed: true })),
        skipDuplicates: true,
      }) : { count: 0 };
      if (changed.count || inserted.count) await recordActivity(tx, userId, 'ROADMAP_RESOURCE_COMPLETED', { refType: 'RoadmapNode', refId: nodeId });
      return;
    }

    const removed = await tx.userRoadmapNode.deleteMany({ where: { userId, nodeId: { in: topicIds }, completed: true } });
    if (!removed.count) return;
    const events = await tx.activity.findMany({
      where: { userId, type: 'ROADMAP_RESOURCE_COMPLETED', refType: 'RoadmapNode', refId: { in: [nodeId, ...topicIds] } },
      select: { date: true },
    });
    await tx.activity.deleteMany({
      where: { userId, type: 'ROADMAP_RESOURCE_COMPLETED', refType: 'RoadmapNode', refId: { in: [nodeId, ...topicIds] } },
    });
    const dates = new Map(events.map((event) => [event.date.toISOString().slice(0, 10), event.date]));
    for (const date of dates.values()) await rebuildDailyActivity(tx, userId, date);
  });
  send(res, { nodeId, completed });
});

export default r;
