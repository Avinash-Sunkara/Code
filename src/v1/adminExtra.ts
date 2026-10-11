import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ApiError, E } from '../utils/http';
import { uniqueSlug } from '../utils/slug';
import { audit } from '../services/audit';
import { CONTRIBUTION_TYPES, getHeatmap, getStreak, localDate } from '../services/activity';
import { fulfil, grantEntitlement, rejectPayment } from '../services/payment';
import { hub } from '../services/notification';
import { Spec, arr, b, crud, filesOf, imageData, n, need, s, sn, urlOrNull } from './adminKit';
import { diffIn, diffOut, pageOf, pq, send } from './util';
import { studyMinutes, titleOf, upload } from './me';
import { getSettings, saveSettings } from './settings';

const r = Router();
const fail = (m: string, code = 'INVALID') => new ApiError(422, code, m);

// ───── Overview / analytics ─────
r.get('/overview', async (_req: Request, res: Response) => {
  const day = 86_400_000, now = Date.now();
  const [total, active, fresh, problems, notes, roadmaps, cheat, interviews, purchases, revenue, recent] = await Promise.all([
    prisma.user.count(), prisma.user.count({ where: { lastActiveAt: { gte: new Date(now - 7 * day) }, status: 'ACTIVE' } }), prisma.user.count({ where: { createdAt: { gte: new Date(now - 7 * day) } } }),
    prisma.problem.count(), prisma.note.count(), prisma.roadmap.count(), prisma.cheatSheet.count(), prisma.interviewExperience.count({ where: { isPublished: true } }),
    prisma.payment.count({ where: { status: 'SUCCESS' } }), prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amount: true } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);
  send(res, {
    totalUsers: total, activeUsers: active, newUsers: fresh, problems, notes, roadmaps, cheatSheets: cheat, interviews, purchases, revenue: Number(revenue._sum.amount ?? 0),
    recent: recent.map((a) => ({ id: a.id, text: `${a.action.replace(/[._]/g, ' ')}${a.entity ? ` · ${a.entity}` : ''}`, at: a.createdAt.toISOString() })),
  });
});

r.get('/analytics', async (req: Request, res: Response) => {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[String(req.query.range)] ?? 30;
  const today = localDate();
  const from = new Date(today.getTime() - (days - 1) * 86_400_000);
  const keys = Array.from({ length: days }, (_, i) => new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  const [users, activity, pays, solves, views, totalUsers, payers] = await Promise.all([
    prisma.user.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true } }),
    prisma.activity.groupBy({ by: ['date', 'userId'], where: { type: { in: CONTRIBUTION_TYPES }, NOT: { type: 'PRACTICE', refType: 'Puzzle' }, date: { gte: from, lte: today } }, _count: { _all: true } }),
    prisma.payment.findMany({ where: { status: 'SUCCESS', verifiedAt: { gte: from } }, select: { amount: true, verifiedAt: true } }),
    prisma.activity.groupBy({ by: ['refId'], where: { type: 'PROBLEM_SOLVED', createdAt: { gte: from }, refId: { not: null } }, _count: { _all: true }, orderBy: { _count: { refId: 'desc' } }, take: 5 }),
    prisma.activity.groupBy({ by: ['refType', 'refId'], where: { type: { in: ['NOTE_VIEWED', 'CHEATSHEET_VIEWED'] }, refType: { in: ['NOTE', 'CHEATSHEET'] }, createdAt: { gte: from }, refId: { not: null } }, _count: { _all: true }, orderBy: { _count: { refId: 'desc' } }, take: 5 }),
    prisma.user.count(), prisma.payment.groupBy({ by: ['userId'], where: { status: 'SUCCESS' } }),
  ]);
  const series = (get: (k: string) => number) => keys.map((k) => ({ label: k.slice(5), value: get(k) }));
  const bucket = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
  const activeByDate = new Map<string, number>();
  for (const item of activity) {
    const key = bucket(item.date);
    activeByDate.set(key, (activeByDate.get(key) ?? 0) + 1);
  }
  const pids = solves.map((x) => x.refId!);
  const titles = new Map((await prisma.problem.findMany({ where: { id: { in: pids } }, select: { id: true, title: true } })).map((x) => [x.id, x.title]));
  const content = await Promise.all(views.map(async (v) => ({ title: (await titleOf(v.refType === 'CHEATSHEET' ? 'CHEATSHEET' : 'NOTE', v.refId!)).title, views: v._count._all })));
  send(res, {
    signups: series((k) => users.filter((u) => bucket(u.createdAt) === k).length),
    activeUsers: series((k) => activeByDate.get(k) ?? 0),
    revenue: series((k) => pays.filter((p) => bucket(p.verifiedAt) === k).reduce((t, p) => t + Number(p.amount), 0)),
    topProblems: solves.map((x) => ({ title: titles.get(x.refId!) ?? 'Removed problem', solves: x._count._all })),
    topContent: content,
    totals: { revenue: pays.reduce((t, p) => t + Number(p.amount), 0), conversion: totalUsers ? Math.round((payers.length / totalUsers) * 1000) / 10 : 0 },
  });
});

// ───── Users ─────
r.get('/users', async (req: Request, res: Response) => {
  const p = pq(req, 25, 100); const f = String(req.query.status ?? '');
  const where: Prisma.UserWhereInput = {
    ...(f === 'active' ? { status: 'ACTIVE' } : f === 'blocked' ? { status: { not: 'ACTIVE' } } : f === 'admin' ? { role: 'ADMIN' } : f === 'premium' ? { OR: [{ payments: { some: { status: 'SUCCESS' } } }, { entitlements: { some: {} } }] } : {}),
    ...(p.q ? { AND: [{ OR: [{ name: { contains: p.q, mode: 'insensitive' } }, { email: { contains: p.q, mode: 'insensitive' } }, { username: { contains: p.q, mode: 'insensitive' } }] }] } : {}),
  };
  const [users, total] = await Promise.all([prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.user.count({ where })]);
  const ids = users.map((u) => u.id);
  const [solved, paid, ent] = await Promise.all([
    prisma.userProblemProgress.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: 'SOLVED' }, _count: { _all: true } }),
    prisma.payment.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: 'SUCCESS' } }),
    prisma.contentEntitlement.groupBy({ by: ['userId'], where: { userId: { in: ids } } }),
  ]);
  const sm = new Map(solved.map((x) => [x.userId, x._count._all])); const prem = new Set([...paid.map((x) => x.userId), ...ent.map((x) => x.userId)]);
  const streaks = await Promise.all(users.map((u) => getStreak(u.id)));
  send(res, pageOf(users.map((u, i) => ({
    id: u.id, fullName: u.name, username: u.username, email: u.email, role: u.role, blocked: u.status !== 'ACTIVE', premium: prem.has(u.id),
    solved: sm.get(u.id) ?? 0, streak: streaks[i].current, createdAt: u.createdAt.toISOString(), lastActiveAt: u.lastActiveAt.toISOString(),
  })), total, p));
});

const KIND: Record<string, 'NOTE' | 'CHEATSHEET' | 'ROADMAP' | 'PROBLEM'> = { note: 'NOTE', 'cheat-sheet': 'CHEATSHEET', roadmap: 'ROADMAP', problem: 'PROBLEM' };

r.get('/users/:id', async (req: Request, res: Response) => {
  const u = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!u) throw E.notFound('User not found');
  const [solved, streak, minutes, heat, bookmarks, revision, notes, views, pays, ents] = await Promise.all([
    prisma.userProblemProgress.count({ where: { userId: u.id, status: 'SOLVED' } }), getStreak(u.id), studyMinutes(u.id), getHeatmap(u.id, localDate().getUTCFullYear()),
    prisma.bookmark.count({ where: { userId: u.id } }), prisma.userProblemProgress.count({ where: { userId: u.id, flaggedForRevision: true } }),
    prisma.userProblemProgress.count({ where: { userId: u.id, personalNote: { not: null } } }),
    prisma.activity.findMany({ where: { userId: u.id, type: { in: ['NOTE_VIEWED', 'CHEATSHEET_VIEWED', 'INTERVIEW_VIEWED'] }, refId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.payment.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.contentEntitlement.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  const STATUS: Record<string, string> = { SUCCESS: 'PAID', PENDING: 'PENDING', MANUAL_REVIEW: 'PENDING', FAILED: 'FAILED', CANCELLED: 'FAILED' };
  const viewTitle = async (a: (typeof views)[number]) => {
    if (a.type === 'INTERVIEW_VIEWED') return { title: (await prisma.interviewExperience.findUnique({ where: { id: a.refId! }, select: { title: true } }))?.title ?? 'Interview', kind: 'interview' };
    if (a.refType === 'CoreTopic') return { title: (await prisma.coreTopic.findUnique({ where: { id: a.refId! }, select: { name: true } }))?.name ?? 'Core CS topic', kind: 'core cs' };
    if (a.refType === 'AptitudeTopic') return { title: (await prisma.aptitudeTopic.findUnique({ where: { id: a.refId! }, select: { name: true } }))?.name ?? 'Aptitude topic', kind: 'aptitude' };
    return titleOf(a.type === 'CHEATSHEET_VIEWED' ? 'CHEATSHEET' : 'NOTE', a.refId!);
  };
  send(res, {
    id: u.id, fullName: u.name, username: u.username, email: u.email, blocked: u.status !== 'ACTIVE', role: u.role, lastActiveAt: u.lastActiveAt.toISOString(),
    solved, streak: streak.current, notesWritten: notes, bookmarks, revision, studyMinutes: minutes, contributions: heat.days,
    contentViewed: await Promise.all(views.map(async (a) => ({ ...(await viewTitle(a)), at: a.createdAt.toISOString() }))),
    purchases: await Promise.all(pays.map(async (p) => ({ id: p.id, ...(await titleOf(p.contentType, p.contentId)), amount: Number(p.amount), status: STATUS[p.status] ?? p.status, at: p.createdAt.toISOString() }))),
    entitlements: await Promise.all(ents.map(async (e) => ({ id: e.id, ...(await titleOf(e.contentType, e.contentId)), type: e.source === 'PAYMENT' ? 'PREMIUM' : 'FREE' }))),
  });
});

const setBlocked = (blocked: boolean) => async (req: Request, res: Response) => {
  if (blocked && req.params.id === req.user!.id) throw E.badRequest('You cannot block yourself');
  const u = await prisma.user.update({ where: { id: req.params.id }, data: { status: blocked ? 'BLOCKED' : 'ACTIVE' } });
  if (blocked) await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, blocked ? 'user.block' : 'user.unblock', 'User', u.id);
  send(res, { blocked });
};
r.patch('/users/:id/block', setBlocked(true));
r.patch('/users/:id/unblock', setBlocked(false));
r.delete('/users/:id', async (req: Request, res: Response) => {
  const t = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!t) throw E.notFound('User not found');
  if (t.id === req.user!.id) throw E.badRequest('You cannot delete yourself');
  if (t.role === 'ADMIN' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1) throw E.badRequest('Cannot delete the last admin');
  await prisma.user.delete({ where: { id: t.id } });
  await audit(req, 'user.delete', 'User', t.id, { email: t.email });
  res.status(204).end();
});
r.post('/users/:id/entitlements', async (req: Request, res: Response) => {
  const d = z.object({ kind: z.string(), contentId: z.string().min(1), type: z.enum(['FREE', 'PREMIUM']).default('FREE') }).parse(req.body ?? {});
  const type = KIND[d.kind];
  if (!type) throw fail('That content type cannot be assigned (Core CS topics are free for everyone)');
  const exists = type === 'NOTE' ? await prisma.note.findUnique({ where: { id: d.contentId }, select: { id: true } }) : type === 'CHEATSHEET' ? await prisma.cheatSheet.findUnique({ where: { id: d.contentId }, select: { id: true } })
    : type === 'ROADMAP' ? await prisma.roadmap.findUnique({ where: { id: d.contentId }, select: { id: true } }) : await prisma.problem.findUnique({ where: { id: d.contentId }, select: { id: true } });
  if (!exists) throw E.notFound('Content not found');
  if (!(await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } }))) throw E.notFound('User not found');
  await grantEntitlement(req.params.id, type, d.contentId, d.type === 'PREMIUM' ? 'PAYMENT' : 'ADMIN_GRANT', req.user!.id);
  await audit(req, 'entitlement.grant', type, d.contentId, { userId: req.params.id });
  send(res, { granted: true }, 201);
});
r.delete('/users/:id/entitlements/:eid', async (req: Request, res: Response) => {
  const e = await prisma.contentEntitlement.findFirst({ where: { id: req.params.eid, userId: req.params.id } });
  if (!e) throw E.notFound('Access record not found');
  await prisma.contentEntitlement.delete({ where: { id: e.id } });
  await audit(req, 'entitlement.revoke', e.contentType, e.contentId, { userId: e.userId });
  res.status(204).end();
});

// ───── Payments (manual UPI review) ─────
r.get('/payments', async (req: Request, res: Response) => {
  const p = pq(req, 20, 100); const st = String(req.query.status ?? 'MANUAL_REVIEW');
  const where: Prisma.PaymentWhereInput = st === 'ALL' ? {} : { status: st as Prisma.EnumPaymentStatusFilter['equals'] };
  const [rows, total] = await Promise.all([prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { user: { select: { name: true, email: true } } } }), prisma.payment.count({ where })]);
  send(res, pageOf(await Promise.all(rows.map(async (x) => ({ id: x.id, user: x.user.name, email: x.user.email, ...(await titleOf(x.contentType, x.contentId)), amount: Number(x.amount), status: x.status, reference: x.proofReference ?? '', provider: x.provider, at: x.createdAt.toISOString() }))), total, p));
});
r.post('/payments/:id/approve', async (req: Request, res: Response) => {
  const p = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!p) throw E.notFound('Payment not found');
  if (p.status !== 'MANUAL_REVIEW') throw E.badRequest('Only payments with a submitted reference can be approved', 'INVALID_STATE');
  await fulfil(p.id, { reviewedBy: req.user!.id, note: s(req.body?.note) });
  await audit(req, 'payment.approve', 'Payment', p.id, { amount: String(p.amount) });
  send(res, { status: 'SUCCESS' });
});
r.post('/payments/:id/reject', async (req: Request, res: Response) => {
  const p = await rejectPayment(req.params.id, req.user!.id, s(req.body?.note));
  await audit(req, 'payment.reject', 'Payment', p.id);
  send(res, { status: p.status });
});

// ───── Settings & founder ─────
r.get('/settings', async (_q: Request, res: Response) => { send(res, await getSettings(true)); });
r.put('/settings', async (req: Request, res: Response) => {
  const d = z.object({
    siteName: z.string().trim().min(1).max(80), supportEmail: z.string().trim().max(160).refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Enter a valid email address'),
    defaultPopupSeconds: z.coerce.number().int().min(2).max(30), maintenanceMode: z.boolean(), signupsOpen: z.boolean(),
  }).parse(req.body ?? {});
  await audit(req, 'settings.update', 'Settings', 'settings', { maintenanceMode: d.maintenanceMode, signupsOpen: d.signupsOpen });
  send(res, await saveSettings(d));
});

r.get('/founder', async (_q: Request, res: Response) => {
  const row = await prisma.siteSetting.findUnique({ where: { key: 'founder' } });
  res.json(row?.value ?? null);
});
r.put('/founder', upload.any(), async (req: Request, res: Response) => {
  const d = req.body ?? {}; const name = s(d.name) ?? '';
  const prev = ((await prisma.siteSetting.findUnique({ where: { key: 'founder' } }))?.value ?? {}) as Record<string, unknown>;
  if (!name) { await prisma.siteSetting.deleteMany({ where: { key: 'founder' } }); return void send(res, { removed: true }); }
  const photo = filesOf(req, 'photo')[0];
  const cta = s(d.ctaUrl);
  if (cta && !/^https?:\/\//i.test(cta)) throw fail('Button URL must start with http:// or https://');
  const value = {
    name, title: s(d.title) ?? '', bio: String(d.bio ?? '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean),
    previously: arr(d.previously) ?? [],
    stats: String(d.stats ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [v, ...rest] = l.split('|'); return { value: v.trim(), label: rest.join('|').trim() }; }).filter((x) => x.value && x.label),
    ...(s(d.ctaLabel) ? { ctaLabel: s(d.ctaLabel) } : {}), ...(cta ? { ctaUrl: cta } : {}),
    ...(photo ? { photoUrl: await imageData(photo, 1000) } : prev.photoUrl ? { photoUrl: prev.photoUrl } : {}),
  };
  await prisma.siteSetting.upsert({ where: { key: 'founder' }, create: { key: 'founder', value }, update: { value } });
  await audit(req, 'founder.update', 'Settings', 'founder');
  send(res, value);
});

// ───── Testimonials ─────
const testimonials: Spec = {
  path: '/testimonials', model: 'testimonial', entity: 'Testimonial', search: ['name', 'message'], orderBy: { order: 'asc' }, publishField: 'isPublished', orderField: 'order',
  row: (x: any) => ({ id: x.id, name: x.name, handle: x.handle ?? '', quote: x.message, rating: x.rating, avatarUrl: x.avatarUrl ?? '', published: x.isPublished, order: x.order }),
  write: async (req, d, create) => {
    const rating = n(d.rating); if (rating !== undefined && (rating < 1 || rating > 5)) throw fail('Rating must be between 1 and 5');
    const av = filesOf(req, 'avatar')[0];
    return { name: create ? need(s(d.name), 'Name') : s(d.name), handle: sn(d.handle), message: create ? need(s(d.quote), 'Quote') : s(d.quote), rating, isPublished: b(d.published), avatarUrl: av ? await imageData(av, 200) : undefined, ...(create ? { order: await prisma.testimonial.count() } : {}) };
  },
};
r.use(testimonials.path, crud(testimonials));

// ───── Courses (landing page showcase) ─────
const lines = (v: unknown, max: number): string[] | undefined => (v === undefined || v === null ? undefined : (Array.isArray(v) ? v : String(v).split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, max));
const courses: Spec = {
  path: '/courses', model: 'course', entity: 'Course', search: ['title', 'description'], orderBy: [{ order: 'asc' }, { createdAt: 'asc' }], publishField: 'isPublished', orderField: 'order',
  row: (x: any) => ({
    id: x.id, title: x.title, description: x.description, level: x.level ?? '', duration: x.duration ?? '', priceLabel: x.priceLabel ?? '',
    highlights: Array.isArray(x.highlights) ? (x.highlights as unknown[]).map(String).join('\n') : '', ctaLabel: x.ctaLabel ?? '', ctaUrl: x.ctaUrl ?? '',
    thumbnailUrl: x.thumbnailUrl ?? '', published: x.isPublished, order: x.order,
  }),
  write: async (req, d, create) => {
    const img = filesOf(req, 'thumbnail')[0];
    return {
      title: create ? need(s(d.title), 'Title') : s(d.title), description: create ? need(s(d.description), 'Description') : s(d.description),
      level: sn(d.level), duration: sn(d.duration), priceLabel: sn(d.priceLabel), highlights: lines(d.highlights, 8),
      ctaLabel: sn(d.ctaLabel), ctaUrl: urlOrNull(d.ctaUrl), isPublished: b(d.published),
      thumbnailUrl: img ? await imageData(img, 800) : undefined,
      ...(create ? { order: await prisma.course.count() } : {}),
    };
  },
};
r.use(courses.path, crud(courses));

// ───── Puzzles (hidden from the public app until published; never sold: isPremium stays false) ─────
const puzzles: Spec = {
  path: '/puzzles', model: 'puzzle', entity: 'Puzzle', search: ['title', 'pattern'], orderBy: [{ order: 'asc' }, { createdAt: 'asc' }], publishField: 'isPublished', orderField: 'order',
  row: (x: any) => ({
    id: x.id, title: x.title, slug: x.slug, description: x.description, pattern: x.pattern ?? '', difficulty: diffOut(x.difficulty),
    hints: Array.isArray(x.hints) ? (x.hints as unknown[]).map(String).join('\n') : '', solution: x.solution ?? '', imageUrl: x.imageUrl ?? '', published: x.isPublished, order: x.order,
  }),
  write: async (req, d, create) => {
    const diff = d.difficulty === undefined ? (create ? 'MEDIUM' : undefined) : diffIn(d.difficulty);
    if (d.difficulty !== undefined && !diff) throw fail('Difficulty must be Easy, Medium or Hard');
    const title = create ? need(s(d.title), 'Title') : s(d.title);
    const img = filesOf(req, 'image')[0];
    return {
      title, description: create ? need(s(d.description), 'Description') : s(d.description), pattern: sn(d.pattern), difficulty: diff,
      hints: lines(d.hints, 10), solution: sn(d.solution), isPublished: b(d.published), isPremium: false,
      imageUrl: img ? await imageData(img, 1200) : undefined,
      ...(create ? { slug: await uniqueSlug('puzzle', title!), order: await prisma.puzzle.count() } : {}),
    };
  },
};
r.use(puzzles.path, crud(puzzles));

// ───── Interviews (moderation) ─────
const ST = { Selected: 'SELECTED', Rejected: 'REJECTED', Pending: 'PENDING' } as const;
const roundsBody = (rounds: { title: string; description: string | null }[]) => rounds.map((x) => `<h3>${x.title}</h3>\n${x.description ?? ''}`).join('\n');
const interviews: Spec = {
  path: '/interviews', model: 'interviewExperience', entity: 'InterviewExperience', search: ['title', 'company', 'role'], orderBy: [{ isPublished: 'asc' }, { createdAt: 'desc' }], publishField: 'isPublished',
  include: { rounds: { orderBy: { roundNumber: 'asc' } } },
  row: (x: any) => ({
    id: x.id, title: x.title, company: x.company, role: x.role, level: x.experienceLevel ?? '', rounds: x.roundCount, difficulty: diffOut(x.difficulty), status: x.status[0] + x.status.slice(1).toLowerCase(),
    summary: x.summary ?? '', background: x.background ?? '', body: roundsBody(x.rounds), verdict: x.verdict ?? '', tags: x.tags, published: x.isPublished,
  }),
  write: async (req, d, create, ex) => {
    const diff = d.difficulty === undefined ? undefined : diffIn(d.difficulty); if (d.difficulty !== undefined && !diff) throw fail('Difficulty must be Easy, Medium or Hard');
    const status = d.status === undefined ? undefined : ST[String(d.status) as keyof typeof ST]; if (d.status !== undefined && !status) throw fail('Outcome must be Selected, Rejected or Pending');
    const title = create ? need(s(d.title), 'Title') : s(d.title); const company = create ? need(s(d.company), 'Company') : s(d.company);
    const body = s(d.body);
    const bodyChanged = body !== undefined && (create || body !== roundsBody(ex.rounds));
    const rounds = n(d.rounds);
    return {
      title, company, role: create ? need(s(d.role), 'Role') : s(d.role), experienceLevel: sn(d.level), difficulty: diff ?? (create ? 'MEDIUM' : undefined), status: status ?? (create ? 'PENDING' : undefined),
      summary: sn(d.summary), background: sn(d.background), verdict: sn(d.verdict), tags: arr(d.tags), isPublished: b(d.published), isAnonymous: create ? true : undefined, createdBy: create ? req.user!.id : undefined,
      roundCount: rounds ?? (bodyChanged ? 1 : create ? 1 : undefined),
      ...(create ? { slug: await uniqueSlug('interviewExperience', `${company}-${title}`) } : {}),
      ...(bodyChanged ? { rounds: create ? { create: [{ roundNumber: 1, title: 'Experience', description: body }] } : { deleteMany: {}, create: [{ roundNumber: 1, title: 'Experience', description: body }] } } : {}),
    };
  },
};
r.use(interviews.path, crud(interviews));
r.patch('/interviews/:id/moderate', async (req: Request, res: Response) => {
  const approved = b(req.body?.approved);
  if (approved === undefined) throw fail('approved is required');
  await prisma.interviewExperience.update({ where: { id: req.params.id }, data: { isPublished: approved } });
  await audit(req, approved ? 'interview.approve' : 'interview.reject', 'InterviewExperience', req.params.id);
  send(res, { published: approved });
});

// ───── Popup notifications (draft → publish) ─────
const T_IN: Record<string, 'INFO' | 'NEW_CONTENT' | 'ANNOUNCEMENT'> = { info: 'INFO', success: 'NEW_CONTENT', warning: 'ANNOUNCEMENT' };
const T_OUT = { INFO: 'info', NEW_CONTENT: 'success', ANNOUNCEMENT: 'warning' } as const;
const notifications: Spec = {
  path: '/notifications', model: 'notification', entity: 'Notification', orderBy: { createdAt: 'desc' }, include: { recipients: { include: { user: { select: { id: true, email: true } } } } },
  row: (x: any) => ({
    id: x.id, title: x.title, message: x.message, type: T_OUT[x.type as keyof typeof T_OUT], durationSeconds: x.durationSeconds ?? '', target: x.targetType === 'ALL_USERS' ? 'ALL' : 'USERS',
    userIds: x.recipients.map((q: any) => q.userId), emails: x.recipients.map((q: any) => q.user.email), publishedAt: x.publishedAt?.toISOString() ?? null,
  }),
  write: async (req, d, create, ex) => {
    if (!create && ex.publishedAt) throw new ApiError(409, 'ALREADY_PUBLISHED', 'Published notifications cannot be edited');
    const type = d.type === undefined ? undefined : T_IN[String(d.type)]; if (d.type !== undefined && !type) throw fail('Unknown type');
    const target = s(d.target); if (create) need(target, 'Target');
    let ids: string[] | undefined;
    if (target === 'USERS') ids = arr(d.userIds) ?? [];
    else if (target === 'EMAILS') {
      const emails = (arr(d.emails) ?? []).map((e) => e.toLowerCase());
      const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } });
      const missing = emails.filter((e) => !users.some((u) => u.email === e));
      if (missing.length) throw fail(`No account for: ${missing.join(', ')}`);
      ids = users.map((u) => u.id);
    }
    if ((target === 'USERS' || target === 'EMAILS') && !ids?.length) throw fail('Choose at least one recipient');
    const duration = n(d.durationSeconds); if (duration !== undefined && (duration < 2 || duration > 30)) throw fail('Duration must be between 2 and 30 seconds');
    const recipients = ids
      ? { ...(create ? {} : { deleteMany: {} }), create: ids.map((userId) => ({ userId })) }
      : target === 'ALL' && !create ? { deleteMany: {} } : undefined;
    return {
      title: create ? need(s(d.title), 'Title') : s(d.title), message: create ? need(s(d.message), 'Message') : s(d.message), type, durationSeconds: duration,
      targetType: target === undefined ? undefined : target === 'ALL' ? 'ALL_USERS' : 'SELECTED_USERS', createdBy: create ? req.user!.id : undefined, publishedAt: create ? null : undefined,
      ...(recipients ? { recipients } : {}),
    };
  },
};
r.use(notifications.path, crud(notifications));
r.post('/notifications/:id/publish', async (req: Request, res: Response) => {
  const x = await prisma.notification.findUnique({ where: { id: req.params.id }, include: { recipients: true } });
  if (!x) throw E.notFound('Notification not found');
  if (x.publishedAt) throw new ApiError(409, 'ALREADY_PUBLISHED', 'Already published');
  const u = await prisma.notification.update({ where: { id: x.id }, data: { publishedAt: new Date() } });
  hub.emit('notification', { notification: u, userIds: u.targetType === 'SELECTED_USERS' ? x.recipients.map((q) => q.userId) : null });
  await audit(req, 'notification.publish', 'Notification', x.id);
  send(res, { published: true });
});

export default r;
