import { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../config/db';
import { E } from '../utils/http';

async function resolveUser(req: Request) {
  const header = req.headers.authorization;
  const token = req.cookies?.access_token ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!token) return null;
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { audience: 'access' }) as jwt.JwtPayload;
    // Role/status always come from the database, never from the token or the client.
    return await prisma.user.findUnique({ where: { id: String(p.sub) } });
  } catch {
    return null;
  }
}

function touch(user: { id: string; lastActiveAt: Date }) {
  if (Date.now() - user.lastActiveAt.getTime() > 5 * 60_000) {
    prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } }).catch(() => undefined);
  }
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const user = await resolveUser(req);
  if (!user) throw E.unauthorized();
  if (user.status !== 'ACTIVE') throw E.forbidden(`Account is ${user.status.toLowerCase()}`, `ACCOUNT_${user.status}`);
  touch(user);
  req.user = user;
  next();
};

export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const user = await resolveUser(req);
  if (user && user.status === 'ACTIVE') { touch(user); req.user = user; }
  next();
};

const adminCheck = (req: Request, _res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role !== 'ADMIN') throw E.forbidden('Admin access required', 'ADMIN_ONLY');
  if (u.mustChangePassword) throw E.forbidden('Password change required', 'PASSWORD_CHANGE_REQUIRED');
  next();
};
export const requireAdmin: RequestHandler[] = [authenticate, adminCheck];
