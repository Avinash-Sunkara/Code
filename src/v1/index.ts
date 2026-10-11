import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import auth, { adminAuth, me as account } from './auth';
import dsa from './dsa';
import learn from './learn';
import puzzles from './puzzles';
import content from './content';
import roadmaps from './roadmaps';
import interviews from './interviews';
import payments from './payments';
import home from './home';
import meRoutes from './me';
import admin from './admin';
import { v1Errors, v1NotFound } from './error';
import { getSettings } from './settings';

const limiter = (limit: number, windowMs = 15 * 60_000) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => { res.status(429).json({ message: 'Too many attempts. Please wait a few minutes and try again.' }); } });
// Only failed attempts count (skipSuccessfulRequests): a whole college sharing one IP can all sign in or register without locking each other out.
const failedOnly = (limit: number, windowMs = 15 * 60_000) => rateLimit({ windowMs, limit, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => { res.status(429).json({ message: 'Too many attempts. Please wait a few minutes and try again.' }); } });
const strict = failedOnly(20), signup = limiter(100, 60 * 60_000), moderate = limiter(60, 60_000);

/**
 * Frontend-facing API (docs/API_CONTRACT.md): mounted at /api/v1. Plain JSON, { message, field? } errors,
 * paged lists as { items, total, page, pageSize, nextPage }. Business logic and models are shared with the legacy /api routes.
 */
const v1 = Router();
// Maintenance mode: everything except sign-in and the admin area returns 503 for visitors.
v1.use(async (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/admin') || req.path.startsWith('/public')) return next();
  if ((await getSettings()).maintenanceMode) return void res.status(503).json({ message: 'We are performing maintenance. Please try again shortly.' });
  next();
});
for (const p of ['/auth/login', '/auth/reset-password', '/admin/auth/login']) v1.use(p, strict);
v1.use('/auth/register', signup);
v1.use('/auth/forgot-password', limiter(20, 60 * 60_000)); // every request counts: each one can send an email
v1.use('/auth/refresh', moderate);
v1.use('/auth', auth);
v1.use('/admin/auth', adminAuth);
v1.use('/me', account);
v1.use(meRoutes);
v1.use(dsa);
v1.use(learn);
v1.use(puzzles);
v1.use(content);
v1.use(roadmaps);
v1.use(interviews);
v1.use(payments);
v1.use(home);
v1.use('/admin', admin);
v1.use(v1NotFound);
v1.use(v1Errors);
export default v1;
