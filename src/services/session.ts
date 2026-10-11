import { CookieOptions, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '@prisma/client';
import { prisma } from '../config/db';
import { env, isProd } from '../config/env';
import { randomToken, sha256 } from '../utils/crypto';

const ACCESS_TTL_MS = 15 * 60_000;
const DAY = 86_400_000;

const base = (): CookieOptions => ({
  httpOnly: true,
  secure: isProd || env.COOKIE_SAMESITE === 'none',
  sameSite: env.COOKIE_SAMESITE ?? (isProd ? 'none' : 'lax'),
  domain: env.COOKIE_DOMAIN,
});

export function setAuthCookies(res: Response, access: string, refresh: string, persistent: boolean) {
  res.cookie('access_token', access, { ...base(), path: '/', maxAge: ACCESS_TTL_MS });
  res.cookie('refresh_token', refresh, { ...base(), path: '/api', ...(persistent ? { maxAge: 30 * DAY } : {}) });
}
export function clearAuthCookies(res: Response) {
  res.clearCookie('access_token', { ...base(), path: '/' });
  res.clearCookie('refresh_token', { ...base(), path: '/api' });
  res.clearCookie('refresh_token', { ...base(), path: '/api/auth' }); // legacy path from earlier deployments
}

export async function startSession(req: Request, res: Response, user: Pick<User, 'id' | 'role'>, persistent = true) {
  const raw = randomToken();
  await prisma.session.create({
    data: {
      userId: user.id, tokenHash: sha256(raw), persistent,
      userAgent: req.headers['user-agent']?.slice(0, 250), ip: req.ip,
      expiresAt: new Date(Date.now() + (persistent ? 30 : 1) * DAY),
    },
  });
  const access = jwt.sign({ role: user.role }, env.JWT_SECRET, { subject: user.id, audience: 'access', expiresIn: Math.floor(ACCESS_TTL_MS / 1000) });
  setAuthCookies(res, access, raw, persistent);
}
