import { Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { E } from '../utils/http';
import { randomToken, sha256 } from '../utils/crypto';
import { loginSchema, registerSchema, forgotSchema, resetSchema, password } from '../validators/auth';
import { safeText } from '../validators/common';
import { clearAuthCookies, startSession } from '../services/session';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/mailer';
import { claimPendingEntitlements } from '../services/access';
import { getStreak, logActivity } from '../services/activity';
import * as oauth from '../services/oauth';
import { authenticate } from '../middleware/auth';
import { send, userOut } from './util';
import { getSettings } from './settings';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
const r = Router();

async function issueToken(userId: string, type: 'EMAIL_VERIFY' | 'PASSWORD_RESET', ttlMs: number) {
  const raw = randomToken(32);
  await prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.authToken.create({ data: { userId, type, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + ttlMs) } });
  return raw;
}

r.post('/register', async (req: Request, res: Response) => {
  if (!(await getSettings()).signupsOpen) throw E.forbidden('Sign-ups are currently closed', 'SIGNUPS_CLOSED');
  // frontend sends fullName; backend schema calls it name
  const body = { ...req.body, name: req.body?.fullName ?? req.body?.name };
  const d = registerSchema.parse(body);
  const clash = await prisma.user.findFirst({ where: { OR: [{ email: d.email }, { username: d.username }] }, select: { email: true } });
  if (clash) throw E.conflict(clash.email === d.email ? 'Email already registered' : 'Username is taken', 'ALREADY_EXISTS');
  const user = await prisma.user.create({ data: { name: d.name, username: d.username, email: d.email, passwordHash: await bcrypt.hash(d.password, 12) } });
  issueToken(user.id, 'EMAIL_VERIFY', 24 * 3600_000).then((t) => sendVerificationEmail(user.email, t)).catch((err) => logger.error({ err }, 'verification email failed'));
  await startSession(req, res, user, true);
  await logActivity(user.id, 'LOGIN', { refType: 'register' });
  send(res, userOut(user, 0), 201);
});

async function doLogin(req: Request, res: Response, adminOnly: boolean) {
  const d = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: d.email } });
  const valid = await bcrypt.compare(d.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !valid || (adminOnly && user.role !== 'ADMIN')) {
    logger.warn({ ip: req.ip, adminOnly }, 'failed login');
    throw E.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'ACTIVE') throw E.forbidden(`Your account is ${user.status.toLowerCase()}. Contact support.`, `ACCOUNT_${user.status}`);
  await startSession(req, res, user, adminOnly ? false : d.remember);
  await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
  await logActivity(user.id, 'LOGIN');
  send(res, userOut(user, (await getStreak(user.id)).current));
}
r.post('/login', (req, res) => doLogin(req, res, false));

r.post('/logout', async (req: Request, res: Response) => {
  const raw = req.cookies?.refresh_token;
  if (raw) {
    const s = await prisma.session.findUnique({ where: { tokenHash: sha256(raw) } });
    if (s) { await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } }); await logActivity(s.userId, 'LOGOUT'); }
  }
  clearAuthCookies(res);
  res.status(204).end();
});

r.post('/refresh', async (req: Request, res: Response) => {
  const raw = req.cookies?.refresh_token;
  if (!raw) throw E.unauthorized('No refresh token');
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  if (!s) { clearAuthCookies(res); throw E.unauthorized('Invalid session'); }
  if (s.revokedAt) {
    // Two tabs (or two parallel requests) refreshing at the same moment is normal: the loser presents a token the winner just rotated.
    // The browser's cookie jar already holds the winner's new cookies, so answer OK without touching them instead of treating it as theft.
    if (Date.now() - s.revokedAt.getTime() < 15_000 && s.user.status === 'ACTIVE' && s.expiresAt > new Date()) return void send(res, userOut(s.user));
    await prisma.session.updateMany({ where: { userId: s.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    logger.warn({ userId: s.userId }, 'refresh token reuse detected');
    clearAuthCookies(res); throw E.unauthorized('Session revoked');
  }
  if (s.expiresAt < new Date() || s.user.status !== 'ACTIVE') { clearAuthCookies(res); throw E.unauthorized('Session expired'); }
  await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  await startSession(req, res, s.user, s.persistent);
  send(res, userOut(s.user));
});

r.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = forgotSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.status === 'ACTIVE') {
    issueToken(user.id, 'PASSWORD_RESET', 3600_000).then((t) => sendPasswordResetEmail(email, t)).catch((err) => logger.error({ err }, 'reset email failed'));
  }
  send(res, { ok: true }); // identical response whether or not the email exists
});

r.post('/reset-password', async (req: Request, res: Response) => {
  const d = resetSchema.parse(req.body);
  const t = await prisma.authToken.findUnique({ where: { tokenHash: sha256(d.token) } });
  if (!t || t.type !== 'PASSWORD_RESET' || t.usedAt || t.expiresAt < new Date()) throw E.badRequest('This reset link is invalid or has expired', 'INVALID_TOKEN');
  await prisma.authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  await prisma.user.update({ where: { id: t.userId }, data: { passwordHash: await bcrypt.hash(d.password, 12), mustChangePassword: false } });
  await prisma.session.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  send(res, { ok: true });
});

r.post('/verify-email', async (req: Request, res: Response) => {
  const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body ?? {});
  const t = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!t || t.type !== 'EMAIL_VERIFY' || t.usedAt || t.expiresAt < new Date()) throw E.badRequest('This verification link is invalid or has expired', 'INVALID_TOKEN');
  await prisma.authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  const user = await prisma.user.update({ where: { id: t.userId }, data: { emailVerified: true } });
  await claimPendingEntitlements(user); // access an admin granted to this address before it was verified
  send(res, { ok: true });
});

r.post('/resend-verification', authenticate, async (req: Request, res: Response) => {
  if (!req.user!.emailVerified) sendVerificationEmail(req.user!.email, await issueToken(req.user!.id, 'EMAIL_VERIFY', 24 * 3600_000)).catch((err) => logger.error({ err }, 'verification email failed'));
  send(res, { ok: true });
});

r.get('/me', authenticate, async (req: Request, res: Response) => {
  send(res, userOut(req.user!, (await getStreak(req.user!.id)).current));
});

// Which social providers are configured, so the UI only offers working buttons.
r.get('/providers', (_req: Request, res: Response) => { send(res, { google: oauth.isConfigured('google'), github: oauth.isConfigured('github') }); });

// Browser redirect flow: GET /auth/oauth/google|github
r.get('/oauth/:provider', (req: Request, res: Response) => {
  const p = req.params.provider;
  if (p !== 'google' && p !== 'github') throw E.notFound('Unknown provider');
  oauth.begin(p, res);
});

export const adminAuth = Router();
adminAuth.post('/login', (req, res) => doLogin(req, res, true));

// Account-level actions used by the profile page
export const me = Router();
me.use(authenticate);
const profile = z.object({ fullName: safeText(2, 80).optional(), username: z.string().trim().regex(/^[a-zA-Z0-9_]{3,30}$/, '3-30 letters, numbers or underscores').transform((s) => s.toLowerCase()).optional() });
me.patch('/', async (req: Request, res: Response) => {
  const d = profile.parse(req.body);
  if (d.username && (await prisma.user.findFirst({ where: { username: d.username, NOT: { id: req.user!.id } }, select: { id: true } }))) throw E.conflict('Username is taken', 'ALREADY_EXISTS');
  const u = await prisma.user.update({ where: { id: req.user!.id }, data: { ...(d.fullName ? { name: d.fullName } : {}), ...(d.username ? { username: d.username } : {}) } });
  send(res, userOut(u));
});
me.post('/password', async (req: Request, res: Response) => {
  const d = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).parse({ currentPassword: req.body?.currentPassword ?? req.body?.current, newPassword: req.body?.newPassword ?? req.body?.password });
  const u = req.user!;
  if (!u.passwordHash || !(await bcrypt.compare(d.currentPassword, u.passwordHash))) throw E.unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(d.newPassword, 12), mustChangePassword: false } });
  await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await startSession(req, res, u, true);
  send(res, { ok: true });
});
export default r;
