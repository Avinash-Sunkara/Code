import { RequestHandler } from 'express';
import { frontendOrigins } from '../config/env';
import { E } from '../utils/http';

// CSRF defence for cookie-authenticated requests: SameSite cookies + strict Origin check on unsafe methods.
export const originGuard: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/payments/webhook') return next();
  if (!req.headers.cookie) return next(); // no ambient credentials => nothing to forge
  const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
  if (!origin || !frontendOrigins.includes(origin.replace(/\/$/, ''))) throw E.forbidden('Invalid request origin', 'CSRF_REJECTED');
  next();
};
