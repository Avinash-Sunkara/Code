import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { E, ok, page } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { publicUser } from '../utils/serializers';
import { adminUserPatch, entitlementS, notificationS } from '../validators/admin';
import { audit } from '../services/audit';
import { CONTRIBUTION_TYPES, getHeatmap, getStreak, localDate } from '../services/activity';
import { createNotification } from '../services/notification';
import { fulfil, grantEntitlement, rejectPayment } from '../services/payment';
import * as storage from '../services/storage';

// ───── Dashboard ─────
export async function dashboard(_req: Request, res: Response) {
  const now = Date.now(), day = 86_400_000;
  const today = localDate();
  const [total, active, blocked, new7, new30, problems, solves, notes, roadmaps, cheats, interviews, pendingInterviews, purchases, revenue, activity, manual] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastActiveAt: { gte: new Date(now - 30 * day) }, status: 'ACTIVE' } }),
    prisma.user.count({ where: { status: { in: ['BLOCKED', 'SUSPENDED'] } } }),
    prisma.user.count({ where: { createdAt: { gte: new Date(now - 7 * day) } } }),
    prisma.user.count({ where: { createdAt: { gte: new Date(now - 30 * day) } } }),
    prisma.problem.count(),
    prisma.userProblemProgress.count({ where: { status: 'SOLVED' } }),
    prisma.note.count(), prisma.roadmap.count(), prisma.cheatSheet.count(),
    prisma.interviewExperience.count({ where: { isPublished: true } }),
    prisma.interviewExperience.count({ where: { isPublished: false } }),
    prisma.payment.count({ where: { status: 'SUCCESS' } }),
    prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amount: true } }),
    prisma.activity.groupBy({ by: ['date', 'userId'], where: { type: { in: CONTRIBUTION_TYPES }, NOT: { type: 'PRACTICE', refType: 'Puzzle' }, date: { gte: new Date(today.getTime() - 29 * day), lte: today } } }),
    prisma.payment.count({ where: { status: 'MANUAL_REVIEW' } }),
  ]);
  const activeByDate = new Map<string, number>();
  for (const item of activity) {
    const key = item.date.toISOString().slice(0, 10);
    activeByDate.set(key, (activeByDate.get(key) ?? 0) + 1);
  }
  const dau = activity.filter((item) => item.date.getTime() === today.getTime()).length;
  ok(res, {
    users: { total, active30d: active, blocked, new7d: new7, new30d: new30 },
    content: { problems, notes, roadmaps, cheatSheets: cheats, interviewExperiences: interviews, interviewsAwaitingReview: pendingInterviews },
    learning: { problemsSolved: solves, dailyActiveUsers: dau },
    payments: { premiumPurchases: purchases, revenue: revenue._sum.amount ?? 0, currency: 'INR', awaitingManualReview: manual },
    dailyActiveUsersLast30Days: [...activeByDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, users]) => ({ date, users })),
  });
}

// ───── Users ─────
export async function listUsers(req: Request, res: Response) {
  const f = z.object({ q: z.string().max(100).optional(), status: z.enum(['ACTIVE', 'BLOCKED', 'SUSPENDED']).optional(), role: z.enum(['USER', 'ADMIN']).optional() }).parse(req.query);
  const p = pageParams(req.query, { sortable: ['createdAt', 'lastActiveAt', 'name', 'email'], defaultSort: 'createdAt' });
  const where: Prisma.UserWhereInput = { ...(f.status && { status: f.status }), ...(f.role && { role: f.role }),
    ...(f.q && { OR: [{ name: { contains: f.q, mode: 'insensitive' } }, { email: { contains: f.q, mode: 'insensitive' } }, { username: { contains: f.q, mode: 'insensitive' } }] }) };
  const [users, total] = await Promise.all([prisma.user.findMany({ where, orderBy: p.orderBy, skip: p.skip, take: p.take }), prisma.user.count({ where })]);
  const solved = await prisma.userProblemProgress.groupBy({ by: ['userId'], where: { userId: { in: users.map((u) => u.id) }, status: 'SOLVED' }, _count: { _all: true } });
  const sm = new Map(solved.map((s) => [s.userId, s._count._all]));
  page(res, users.map((u) => ({ ...publicUser(u), problemsSolved: sm.get(u.id) ?? 0 })), total, p.page, p.limit);
}

export async function getUser(req: Request, res: Response) {
  const u = await prisma.user.findUnique({ where: { id: req.params.id }, include: { oauthAccounts: { select: { provider: true, createdAt: true } } } });
  if (!u) throw E.notFound('User not found');
  const year = localDate().getUTCFullYear();
  const [solved, streak, heat, bookmarks, revision, notes, roadmapProg, payments, entitlements, recent] = await Promise.all([
    prisma.userProblemProgress.count({ where: { userId: u.id, status: 'SOLVED' } }),
    getStreak(u.id), getHeatmap(u.id, year),
    prisma.bookmark.groupBy({ by: ['targetType'], where: { userId: u.id }, _count: { _all: true } }),
    prisma.userProblemProgress.count({ where: { userId: u.id, flaggedForRevision: true } }),
    prisma.userProblemProgress.findMany({ where: { userId: u.id, personalNote: { not: null } }, take: 50, orderBy: { updatedAt: 'desc' }, select: { problemId: true, personalNote: true, updatedAt: true, problem: { select: { title: true } } } }),
    prisma.userRoadmapProgress.groupBy({ by: ['roadmapId'], where: { userId: u.id, completed: true }, _count: { _all: true } }),
    prisma.payment.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.contentEntitlement.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.activity.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  ok(res, {
    user: { ...publicUser(u), linkedProviders: u.oauthAccounts.map((o) => o.provider) },
    stats: { problemsSolved: solved, streak, flaggedForRevision: revision, bookmarks: Object.fromEntries(bookmarks.map((b) => [b.targetType, b._count._all])) },
    activity: heat, recentActivity: recent, personalNotes: notes, roadmapProgress: roadmapProg.map((r) => ({ roadmapId: r.roadmapId, completed: r._count._all })), payments, entitlements,
  });
}

export async function patchUser(req: Request, res: Response) {
  const d = adminUserPatch.parse(req.body);
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw E.notFound('User not found');
  if (target.id === req.user!.id && (d.role === 'USER' || (d.status && d.status !== 'ACTIVE'))) throw E.badRequest('You cannot demote or block yourself');
  if (target.role === 'ADMIN' && d.role === 'USER' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1) throw E.badRequest('Cannot remove the last admin');
  const u = await prisma.user.update({ where: { id: target.id }, data: d });
  if (d.status && d.status !== 'ACTIVE') await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, 'user.update', 'User', u.id, { fields: Object.keys(d) });
  ok(res, { user: publicUser(u) }, 'User updated');
}

const setStatus = (status: 'ACTIVE' | 'BLOCKED') => async (req: Request, res: Response) => {
  if (status === 'BLOCKED' && req.params.id === req.user!.id) throw E.badRequest('You cannot block yourself');
  const u = await prisma.user.update({ where: { id: req.params.id }, data: { status } });
  if (status === 'BLOCKED') await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, status === 'BLOCKED' ? 'user.block' : 'user.unblock', 'User', u.id);
  ok(res, { user: publicUser(u) }, status === 'BLOCKED' ? 'User blocked' : 'User unblocked');
};
export const blockUser = setStatus('BLOCKED');
export const unblockUser = setStatus('ACTIVE');

export async function deleteUser(req: Request, res: Response) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw E.notFound('User not found');
  if (target.id === req.user!.id) throw E.badRequest('You cannot delete yourself');
  if (target.role === 'ADMIN' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1) throw E.badRequest('Cannot delete the last admin');
  await prisma.user.delete({ where: { id: target.id } });
  await audit(req, 'user.delete', 'User', target.id, { email: target.email });
  ok(res, { id: target.id }, 'User deleted');
}

// ───── Entitlements (selected-user access) ─────
async function contentExists(type: string, id: string) {
  const m: Record<string, () => Promise<unknown>> = {
    NOTE: () => prisma.note.findUnique({ where: { id }, select: { id: true } }),
    CHEATSHEET: () => prisma.cheatSheet.findUnique({ where: { id }, select: { id: true } }),
    ROADMAP: () => prisma.roadmap.findUnique({ where: { id }, select: { id: true } }),
    ROADMAP_RESOURCE: () => prisma.roadmapResource.findUnique({ where: { id }, select: { id: true } }),
    PROBLEM: () => prisma.problem.findUnique({ where: { id }, select: { id: true } }),
  };
  return !!(await m[type]());
}

export async function grant(req: Request, res: Response) {
  const d = entitlementS.parse(req.body);
  if (!(await contentExists(d.contentType, d.contentId))) throw E.notFound('Content not found');
  const users = await prisma.user.findMany({ where: { email: { in: d.emails } } });
  const found = new Map(users.map((u) => [u.email, u]));
  const granted: string[] = [], pending: string[] = [];
  for (const email of d.emails) {
    const u = found.get(email);
    if (u && u.emailVerified) { await grantEntitlement(u.id, d.contentType, d.contentId, 'ADMIN_GRANT', req.user!.id, d.expiresAt); granted.push(email); }
    else {
      // no account, or email not verified yet: hold the grant until the address is verified (prevents grabbing access by registering someone else's email)
      await prisma.pendingEntitlement.upsert({
        where: { email_contentType_contentId: { email, contentType: d.contentType, contentId: d.contentId } },
        create: { email, contentType: d.contentType, contentId: d.contentId, grantedBy: req.user!.id, expiresAt: d.expiresAt ?? undefined }, update: { expiresAt: d.expiresAt ?? null },
      });
      pending.push(email);
    }
  }
  if (granted.length) await createNotification({ title: 'You have new access', message: 'An admin unlocked premium content for you.', type: 'NEW_CONTENT', targetType: 'SELECTED_USERS', userIds: users.filter((u) => granted.includes(u.email)).map((u) => u.id), createdBy: req.user!.id });
  await audit(req, 'entitlement.grant', d.contentType, d.contentId, { granted: granted.length, pending: pending.length });
  ok(res, { granted, pending }, 'Access updated', 201);
}

export async function listEntitlements(req: Request, res: Response) {
  const f = z.object({ contentType: z.string().optional(), contentId: z.string().optional(), userId: z.string().optional() }).parse(req.query);
  const p = pageParams(req.query, { defaultLimit: 50 });
  const where: any = { ...(f.contentType && { contentType: f.contentType }), ...(f.contentId && { contentId: f.contentId }), ...(f.userId && { userId: f.userId }) };
  const [items, total, pending] = await Promise.all([
    prisma.contentEntitlement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { user: { select: { email: true, name: true } } } }),
    prisma.contentEntitlement.count({ where }),
    prisma.pendingEntitlement.findMany({ where: { ...(f.contentType && { contentType: f.contentType as any }), ...(f.contentId && { contentId: f.contentId }) }, take: 100 }),
  ]);
  res.json({ success: true, message: 'OK', data: { items, pendingByEmail: pending, pagination: { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) } } });
}

export async function revoke(req: Request, res: Response) {
  const e = await prisma.contentEntitlement.delete({ where: { id: req.params.id } });
  await audit(req, 'entitlement.revoke', e.contentType, e.contentId, { userId: e.userId });
  ok(res, {}, 'Access revoked');
}

// ───── Payments ─────
export async function listPayments(req: Request, res: Response) {
  const f = z.object({ status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'MANUAL_REVIEW']).optional(), userId: z.string().optional() }).parse(req.query);
  const p = pageParams(req.query, { sortable: ['createdAt', 'amount'] });
  const where = { ...(f.status && { status: f.status }), ...(f.userId && { userId: f.userId }) };
  const [items, total, sums] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: p.orderBy, skip: p.skip, take: p.take, include: { user: { select: { id: true, name: true, email: true } } } }),
    prisma.payment.count({ where }),
    prisma.payment.groupBy({ by: ['status'], _sum: { amount: true }, _count: { _all: true } }),
  ]);
  res.json({ success: true, message: 'OK', data: { items, summary: sums.map((s) => ({ status: s.status, count: s._count._all, amount: s._sum.amount })), pagination: { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) } } });
}

export async function approvePayment(req: Request, res: Response) {
  const note = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {}).note;
  const p = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!p) throw E.notFound('Payment not found');
  if (p.status !== 'MANUAL_REVIEW') throw E.badRequest('Only payments in MANUAL_REVIEW can be approved', 'INVALID_STATE');
  const out = await fulfil(p.id, { reviewedBy: req.user!.id, note });
  await audit(req, 'payment.approve', 'Payment', p.id, { amount: String(p.amount) });
  ok(res, out, 'Payment approved and access granted');
}

export async function rejectPaymentH(req: Request, res: Response) {
  const note = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {}).note;
  const out = await rejectPayment(req.params.id, req.user!.id, note);
  await audit(req, 'payment.reject', 'Payment', out.id);
  ok(res, out, 'Payment rejected');
}

// ───── Uploads, notifications, moderation ─────
export async function presign(req: Request, res: Response) {
  const d = z.object({ contentType: z.string(), folder: z.enum(['notes', 'cheatsheets', 'roadmaps']).default('notes'), size: z.number().int().max(storage.MAX_FILE_BYTES).optional() }).parse(req.body);
  const key = storage.newKey(d.folder, d.contentType);
  const uploadUrl = await storage.presignUpload(key, d.contentType);
  await audit(req, 'upload.presign', 'File', key);
  ok(res, { key, uploadUrl, method: 'PUT', headers: { 'Content-Type': d.contentType }, expiresIn: 600 }, 'Upload the file with a PUT, then save `key` as fileKey on the content');
}

export async function createNotificationH(req: Request, res: Response) {
  const d = notificationS.parse(req.body);
  const userIds = d.targetType === 'SELECTED_USERS' ? (await prisma.user.findMany({ where: { email: { in: d.emails!.map((e) => e.toLowerCase()) } }, select: { id: true } })).map((u) => u.id) : undefined;
  const n = await createNotification({ ...d, userIds, createdBy: req.user!.id });
  await audit(req, 'notification.create', 'Notification', n.id);
  ok(res, n, 'Notification sent', 201);
}

export async function listComments(req: Request, res: Response) {
  const p = pageParams(req.query, { defaultLimit: 50 });
  const where = { ...(req.query.experienceId ? { experienceId: String(req.query.experienceId) } : {}), ...(req.query.deleted === 'true' ? {} : { isDeleted: false }) };
  const [items, total] = await Promise.all([
    prisma.interviewComment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { user: { select: { id: true, name: true, email: true } }, experience: { select: { title: true } } } }),
    prisma.interviewComment.count({ where }),
  ]);
  page(res, items, total, p.page, p.limit);
}

export async function deleteComment(req: Request, res: Response) {
  const c = await prisma.interviewComment.update({ where: { id: req.params.id }, data: { isDeleted: true } });
  await audit(req, 'comment.moderate', 'InterviewComment', c.id);
  ok(res, {}, 'Comment removed');
}

export async function listFeedback(req: Request, res: Response) {
  const p = pageParams(req.query);
  const [items, total] = await Promise.all([prisma.feedback.findMany({ orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.feedback.count()]);
  page(res, items, total, p.page, p.limit);
}

export async function listAudit(req: Request, res: Response) {
  const p = pageParams(req.query, { defaultLimit: 50 });
  const [items, total] = await Promise.all([prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.auditLog.count()]);
  page(res, items, total, p.page, p.limit);
}
