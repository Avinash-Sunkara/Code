import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { TokenType } from '@prisma/client';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { E, ok } from '../utils/http';
import { randomToken, sha256 } from '../utils/crypto';
import { publicUser } from '../utils/serializers';
import { changePasswordSchema, forgotSchema, loginSchema, registerSchema, resetSchema, verifySchema } from '../validators/auth';
import { clearAuthCookies, startSession } from '../services/session';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/mailer';
import { claimPendingEntitlements } from '../services/access';
import { getStreak, logActivity } from '../services/activity';
import * as oauth from '../services/oauth';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12); // keeps login timing uniform for unknown emails

async function issueToken(userId: string, type: TokenType, ttlMs: number) {
  const raw = randomToken(32);
  await prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.authToken.create({ data: { userId, type, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + ttlMs) } });
  return raw;
}
async function consumeToken(raw: string, type: TokenType) {
  const t = await prisma.authToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!t || t.type !== type || t.usedAt || t.expiresAt < new Date()) throw E.badRequest('Link is invalid or has expired', 'INVALID_TOKEN');
  await prisma.authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  return t;
}

export async function register(req: Request, res: Response) {
  const d = registerSchema.parse(req.body);
  const clash = await prisma.user.findFirst({ where: { OR: [{ email: d.email }, { username: d.username }] }, select: { email: true } });
  if (clash) throw E.conflict(clash.email === d.email ? 'Email already registered' : 'Username is taken', 'ALREADY_EXISTS');
  const user = await prisma.user.create({ data: { name: d.name, username: d.username, email: d.email, passwordHash: await bcrypt.hash(d.password, 12) } });
  sendVerificationEmail(user.email, await issueToken(user.id, 'EMAIL_VERIFY', 24 * 3600_000)).catch((err) => logger.error({ err }, 'verification email failed'));
  await startSession(req, res, user, true);
  await logActivity(user.id, 'LOGIN', { refType: 'register' });
  ok(res, { user: publicUser(user) }, 'Registered', 201);
}

export async function login(req: Request, res: Response) {
  const d = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: d.email } });
  const valid = await bcrypt.compare(d.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !valid) {
    logger.warn({ ip: req.ip }, 'failed login');
    throw E.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'ACTIVE') throw E.forbidden(`Account is ${user.status.toLowerCase()}`, `ACCOUNT_${user.status}`);
  await startSession(req, res, user, d.remember);
  await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
  await logActivity(user.id, 'LOGIN');
  ok(res, { user: publicUser(user), mustChangePassword: user.mustChangePassword }, 'Logged in');
}

export async function logout(req: Request, res: Response) {
  const raw = req.cookies?.refresh_token;
  if (raw) {
    const s = await prisma.session.findUnique({ where: { tokenHash: sha256(raw) } });
    if (s) { await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } }); await logActivity(s.userId, 'LOGOUT'); }
  }
  clearAuthCookies(res);
  ok(res, {}, 'Logged out');
}

export async function refresh(req: Request, res: Response) {
  const raw = req.cookies?.refresh_token;
  if (!raw) throw E.unauthorized('No refresh token');
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  if (!s) { clearAuthCookies(res); throw E.unauthorized('Invalid session'); }
  if (s.revokedAt) {
    // A rotated token was replayed: assume theft and kill every session of this user.
    await prisma.session.updateMany({ where: { userId: s.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    logger.warn({ userId: s.userId }, 'refresh token reuse detected');
    clearAuthCookies(res);
    throw E.unauthorized('Session revoked');
  }
  if (s.expiresAt < new Date() || s.user.status !== 'ACTIVE') { clearAuthCookies(res); throw E.unauthorized('Session expired'); }
  await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  await startSession(req, res, s.user, s.persistent);
  ok(res, { user: publicUser(s.user) }, 'Refreshed');
}

export async function forgotPassword(req: Request, res: Response) {
  const { email } = forgotSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.status === 'ACTIVE') {
    sendPasswordResetEmail(email, await issueToken(user.id, 'PASSWORD_RESET', 3600_000)).catch((err) => logger.error({ err }, 'reset email failed'));
  }
  ok(res, {}, 'If that email exists, a reset link has been sent'); // same response either way
}

export async function resetPassword(req: Request, res: Response) {
  const d = resetSchema.parse(req.body);
  const t = await consumeToken(d.token, 'PASSWORD_RESET');
  await prisma.user.update({ where: { id: t.userId }, data: { passwordHash: await bcrypt.hash(d.password, 12), mustChangePassword: false } });
  await prisma.session.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  ok(res, {}, 'Password updated. Please log in.');
}

export async function changePassword(req: Request, res: Response) {
  const d = changePasswordSchema.parse(req.body);
  const u = req.user!;
  if (!u.passwordHash || !(await bcrypt.compare(d.currentPassword, u.passwordHash))) throw E.unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(d.newPassword, 12), mustChangePassword: false } });
  await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await startSession(req, res, u, true); // keep this device signed in
  ok(res, {}, 'Password changed');
}

export async function verifyEmail(req: Request, res: Response) {
  const { token } = verifySchema.parse(req.method === 'GET' ? req.query : req.body);
  const t = await consumeToken(token, 'EMAIL_VERIFY');
  const user = await prisma.user.update({ where: { id: t.userId }, data: { emailVerified: true } });
  await claimPendingEntitlements(user);
  ok(res, {}, 'Email verified');
}

export async function resendVerification(req: Request, res: Response) {
  if (!req.user!.emailVerified) await sendVerificationEmail(req.user!.email, await issueToken(req.user!.id, 'EMAIL_VERIFY', 24 * 3600_000));
  ok(res, {}, 'Verification email sent');
}

export async function me(req: Request, res: Response) {
  const [streak, solved, linked] = await Promise.all([
    getStreak(req.user!.id),
    prisma.userProblemProgress.count({ where: { userId: req.user!.id, status: 'SOLVED' } }),
    prisma.oAuthAccount.findMany({ where: { userId: req.user!.id }, select: { provider: true } }),
  ]);
  ok(res, { user: publicUser(req.user!), streak, problemsSolved: solved, hasPassword: !!req.user!.passwordHash, linkedProviders: linked.map((l) => l.provider) });
}

export const googleStart = (_req: Request, res: Response) => oauth.begin('google', res);
export const googleCallback = (req: Request, res: Response) => oauth.complete('google', req, res);
export const githubStart = (_req: Request, res: Response) => oauth.begin('github', res);
export const githubCallback = (req: Request, res: Response) => oauth.complete('github', req, res);
