import { Request, Response, Router } from 'express';
import { prisma } from '../config/db';
import { authenticate, optionalAuth } from '../middleware/auth';
import { entitledIds, isLocked } from '../services/access';
import { getStreak, localDate } from '../services/activity';
import { send, diffOut } from './util';
import { contributionsFor, studyMinutes } from './me';
import { hydrate } from './dsa';

const r = Router();
const pSelect = {
  id: true, title: true, slug: true, difficulty: true, leetcodeUrl: true, gfgUrl: true, youtubeUrl: true, pattern: true, isPremium: true, order: true,
  topicId: true, subtopicId: true, imageUrl: true, tags: true, hints: true, images: true, topic: { select: { name: true } }, subtopic: { select: { name: true } },
  companies: { select: { company: { select: { id: true, name: true, logoUrl: true } } } },
} as const;
const CS_LABEL: Record<string, string> = { DSA: 'DSA', JAVA: 'Java', SQL: 'SQL', DBMS: 'DBMS', OS: 'OS', CN: 'CN', APTITUDE: 'Aptitude', GIT_GITHUB: 'Git & GitHub' };
const acc = (a: string) => (a === 'SELECTED_USERS' ? 'PRIVATE' : a === 'PREMIUM' ? 'PREMIUM' : 'FREE');

r.get('/dashboard', authenticate, async (req: Request, res: Response) => {
  const uid = req.user!.id;
  const published = { isPublished: true, topic: { sheet: { isPublished: true } } };
  const [allProblems, solvedRows, streak, minutes, contributions, bookmarks, flagged, personal] = await Promise.all([
    prisma.problem.findMany({ where: published, select: { id: true, difficulty: true, topic: { select: { sheetId: true } } } }),
    prisma.userProblemProgress.findMany({ where: { userId: uid, status: 'SOLVED', problem: published }, orderBy: { solvedAt: 'desc' }, select: { problemId: true, solvedAt: true } }),
    getStreak(uid), studyMinutes(uid), contributionsFor(uid, 365),
    prisma.bookmark.count({ where: { userId: uid, targetType: 'PROBLEM' } }),
    prisma.userProblemProgress.count({ where: { userId: uid, flaggedForRevision: true, problem: { isPublished: true } } }),
    prisma.userProblemProgress.count({ where: { userId: uid, personalNote: { not: null } } }),
  ]);
  const solved = new Set(solvedRows.map((s) => s.problemId));
  const rec = () => ({ solved: 0, total: 0 });
  const prog = { easy: rec(), medium: rec(), hard: rec() };
  const perSheet = new Map<string, { total: number; solved: number }>();
  for (const p of allProblems) {
    const bucket = prog[diffOut(p.difficulty).toLowerCase() as 'easy' | 'medium' | 'hard'];
    bucket.total++; if (solved.has(p.id)) bucket.solved++;
    const s = perSheet.get(p.topic.sheetId) ?? { total: 0, solved: 0 }; s.total++; if (solved.has(p.id)) s.solved++; perSheet.set(p.topic.sheetId, s);
  }

  const [sheets, roadmaps, nodes, notes, newRoadmaps, interviews, unsolved, flaggedRows] = await Promise.all([
    prisma.dSASheet.findMany({ where: { isPublished: true }, orderBy: { order: 'asc' }, select: { id: true, name: true } }),
    prisma.roadmap.findMany({ where: { isPublished: true }, select: { id: true, title: true, sections: { select: { topics: { select: { id: true } } } } } }),
    prisma.userRoadmapNode.findMany({ where: { userId: uid, completed: true }, select: { nodeId: true } }),
    prisma.note.findMany({ where: { isPublished: true, accessType: { not: 'SELECTED_USERS' } }, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, title: true, slug: true, description: true, category: true, previewImageUrl: true, price: true, accessType: true, updatedAt: true } }),
    prisma.roadmap.findMany({ where: { isPublished: true }, orderBy: { createdAt: 'desc' }, take: 3, include: { sections: { select: { topics: { select: { id: true } } } } } }),
    prisma.interviewExperience.findMany({ where: { isPublished: true }, orderBy: { createdAt: 'desc' }, take: 3, include: { _count: { select: { comments: { where: { isDeleted: false } }, likes: true } }, author: { select: { name: true } } } }),
    prisma.problem.findMany({ where: { ...published, isPremium: false, id: { notIn: [...solved] } }, orderBy: [{ topic: { sheet: { order: 'asc' } } }, { topic: { order: 'asc' } }, { order: 'asc' }], take: 3, select: pSelect }),
    prisma.userProblemProgress.findMany({ where: { userId: uid, flaggedForRevision: true, problem: { isPublished: true } }, orderBy: { updatedAt: 'desc' }, take: 3, select: { problem: { select: pSelect } } }),
  ]);
  const doneNodes = new Set(nodes.map((n) => n.nodeId));
  const ownedNotes = await entitledIds(uid, 'NOTE');
  const roadmapPct = (rm: { sections: { topics: { id: string }[] }[] }) => { const l = rm.sections.flatMap((s) => s.topics.map((t) => t.id)); return l.length ? Math.round((l.filter((i) => doneNodes.has(i)).length / l.length) * 100) : 0; };

  const continueLearning = [
    ...sheets.map((s) => ({ s, v: perSheet.get(s.id) })).filter((x) => x.v && x.v.solved > 0 && x.v.solved < x.v.total)
      .map((x) => ({ title: x.s.name, href: '/sheets', progress: Math.round((x.v!.solved / x.v!.total) * 100), kind: 'DSA' })),
    ...roadmaps.map((rm) => ({ title: rm.title, href: `/roadmaps/${rm.id}`, progress: roadmapPct(rm), kind: 'Roadmap' })).filter((x) => x.progress > 0 && x.progress < 100),
  ].slice(0, 4);

  const today = localDate().getTime();
  const solvedToday = solvedRows.some((s) => s.solvedAt && localDate(s.solvedAt).getTime() === today);
  const todaysPlan = [
    { id: 'solve', title: 'Solve a problem today', href: '/sheets', done: solvedToday },
    ...(flagged > 0 ? [{ id: 'revise', title: `Revise ${Math.min(flagged, 3)} flagged problem${Math.min(flagged, 3) > 1 ? 's' : ''}`, href: '/revision', done: false }] : []),
  ];

  const recentIds = solvedRows.slice(0, 3).map((s) => s.problemId);
  const recentRows = recentIds.length ? await prisma.problem.findMany({ where: { id: { in: recentIds } }, select: pSelect }) : [];
  const byId = new Map(recentRows.map((x) => [x.id, x]));
  const recentlySolved = await hydrate(req, recentIds.map((i) => byId.get(i)).filter((x): x is NonNullable<typeof x> => !!x));

  send(res, {
    progress: { solved: solved.size, total: allProblems.length, ...prog },
    streak, studyMinutes: minutes, counts: { bookmarks, revision: flagged, notes: personal },
    contributions, contributionTotal: contributions.reduce((n, c) => n + c.count, 0), today: localDate().toISOString().slice(0, 10),
    continueLearning, todaysPlan, recentlySolved, recommended: await hydrate(req, unsolved), revisionDue: await hydrate(req, flaggedRows.map((x) => x.problem)),
    latestNotes: notes.map((n) => ({ id: n.id, title: n.title, ...(n.description ? { description: n.description } : {}), category: n.category ?? 'General', ...(n.previewImageUrl ? { previewUrl: n.previewImageUrl } : {}), access: acc(n.accessType), ...(n.accessType === 'PREMIUM' ? { price: Number(n.price) } : {}), locked: isLocked(req.user, n, ownedNotes), updatedAt: n.updatedAt.toISOString() })),
    newRoadmaps: newRoadmaps.map((x) => ({ id: x.id, title: x.title, ...(x.description ? { description: x.description } : {}), sectionCount: x.sections.length, completion: roadmapPct(x), access: x.isPremium ? 'PREMIUM' : 'FREE', locked: x.isPremium && req.user?.role !== 'ADMIN', ...(x.isPremium ? { price: Number(x.price) } : {}) })),
    latestInterviews: interviews.map((x) => ({
      id: x.id, company: x.company, role: x.role, ...(x.experienceLevel ? { level: x.experienceLevel } : {}), difficulty: diffOut(x.difficulty), rounds: x.roundCount,
      status: x.status === 'SELECTED' ? 'Selected' : x.status === 'REJECTED' ? 'Rejected' : 'Pending', title: x.title, ...(x.summary ? { summary: x.summary } : {}), tags: x.tags,
      likes: x._count.likes, comments: x._count.comments, createdAt: x.createdAt.toISOString(),
    })),
  });
});

r.get('/search', optionalAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit)) || 5));
  const empty = { problems: [], topics: [], companies: [], notes: [], roadmaps: [], cheatSheets: [], interviews: [] };
  if (q.length < 2) return void send(res, empty);
  const c = { contains: q, mode: 'insensitive' as const };
  const [problems, dsaTopics, coreTopics, aptTopics, companies, notes, roadmaps, sheets, interviews] = await Promise.all([
    prisma.problem.findMany({ where: { isPublished: true, topic: { sheet: { isPublished: true } }, OR: [{ title: c }, { pattern: c }] }, take: limit, orderBy: { title: 'asc' }, select: pSelect }),
    prisma.dSATopic.findMany({ where: { name: c, sheet: { isPublished: true } }, take: limit, select: { id: true, name: true, sheetId: true } }),
    prisma.coreTopic.findMany({ where: { name: c, isPublished: true }, take: limit, select: { id: true, name: true, slug: true, category: { select: { slug: true } } } }),
    prisma.aptitudeTopic.findMany({ where: { name: c, isPublished: true }, take: limit, select: { id: true, name: true, slug: true, category: { select: { slug: true } } } }),
    prisma.company.findMany({ where: { name: c }, take: limit, orderBy: { name: 'asc' }, select: { id: true, name: true, logoUrl: true } }),
    prisma.note.findMany({ where: { isPublished: true, accessType: { not: 'SELECTED_USERS' }, OR: [{ title: c }, { description: c }] }, take: limit, select: { id: true, title: true, description: true, category: true, previewImageUrl: true, price: true, accessType: true, updatedAt: true } }),
    prisma.roadmap.findMany({ where: { isPublished: true, OR: [{ title: c }, { description: c }] }, take: limit, include: { sections: { select: { id: true } } } }),
    prisma.cheatSheet.findMany({ where: { isPublished: true, accessType: { not: 'SELECTED_USERS' }, OR: [{ title: c }, { description: c }] }, take: limit, select: { id: true, title: true, category: true, description: true, previewImageUrl: true, price: true, accessType: true } }),
    prisma.interviewExperience.findMany({ where: { isPublished: true, OR: [{ title: c }, { company: c }, { role: c }] }, take: limit, include: { _count: { select: { comments: { where: { isDeleted: false } }, likes: true } } } }),
  ]);
  const ownedN = await entitledIds(req.user?.id, 'NOTE'), ownedC = await entitledIds(req.user?.id, 'CHEATSHEET');
  send(res, {
    problems: await hydrate(req, problems),
    topics: [
      ...dsaTopics.map((t) => ({ id: t.id, title: t.name, href: `/sheets/${t.sheetId}#topic-${t.id}` })),
      ...coreTopics.map((t) => ({ id: t.id, title: t.name, href: `/core-cs?c=${t.category.slug}&t=${t.slug}` })),
      ...aptTopics.map((t) => ({ id: t.id, title: t.name, href: `/aptitude?c=${t.category.slug}&t=${t.slug}` })),
    ].slice(0, limit),
    companies: companies.map((x) => ({ id: x.id, name: x.name, ...(x.logoUrl ? { logoUrl: x.logoUrl } : {}) })),
    notes: notes.map((n) => ({ id: n.id, title: n.title, ...(n.description ? { description: n.description } : {}), category: n.category ?? 'General', access: acc(n.accessType), ...(n.accessType === 'PREMIUM' ? { price: Number(n.price) } : {}), locked: isLocked(req.user, n, ownedN), updatedAt: n.updatedAt.toISOString() })),
    roadmaps: roadmaps.map((x) => ({ id: x.id, title: x.title, sectionCount: x.sections.length, completion: 0, access: x.isPremium ? 'PREMIUM' : 'FREE', locked: x.isPremium && req.user?.role !== 'ADMIN' })),
    cheatSheets: sheets.map((n) => ({ id: n.id, title: n.title, category: CS_LABEL[n.category], access: acc(n.accessType), ...(n.accessType === 'PREMIUM' ? { price: Number(n.price) } : {}), locked: isLocked(req.user, n, ownedC) })),
    interviews: interviews.map((x) => ({ id: x.id, company: x.company, role: x.role, difficulty: diffOut(x.difficulty), rounds: x.roundCount, status: x.status === 'SELECTED' ? 'Selected' : x.status === 'REJECTED' ? 'Rejected' : 'Pending', title: x.title, tags: x.tags, likes: x._count.likes, comments: x._count.comments, createdAt: x.createdAt.toISOString() })),
  });
});

export default r;
