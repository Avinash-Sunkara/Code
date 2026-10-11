import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env, frontendOrigins } from './config/env';
import { logger } from './config/logger';
import { originGuard } from './middleware/security';
import { errorHandler, notFound } from './middleware/error';
import routes from './routes';
import v1 from './v1';
import { webhook } from './controllers/payments.controller';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY_HOPS); // Render sits behind 1 proxy; 2 when the Vercel same-origin rewrite sits in front of it (real client IPs for rate limits)
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || frontendOrigins.includes(origin.replace(/\/$/, ''))),
    credentials: true, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'], maxAge: 600,
  }));
  app.use(compression({ filter: (req, res) => req.path.endsWith('/notifications/stream') ? false : compression.filter(req, res) }));
  app.use(pinoHttp({
    logger, autoLogging: { ignore: (req) => req.url === '/health' },
    serializers: { req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0], remoteAddress: req.remoteAddress }), res: (res) => ({ statusCode: res.statusCode }) }, // no query strings: they can hold file tokens / OAuth codes
  }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Signature verification needs the exact raw bytes, so this is mounted before express.json()
  app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }), webhook);

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(env.SESSION_SECRET));
  app.use('/api', rateLimit({ windowMs: 15 * 60_000, limit: 1000, standardHeaders: true, legacyHeaders: false, skip: (req) => req.path.startsWith('/notifications/stream'),
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } } }));
  app.use('/api', originGuard);
  app.use('/api/v1', v1); // frontend contract; has its own 404 + error format
  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
