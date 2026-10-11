import { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError } from '../utils/http';
import { logger } from '../config/logger';
import { isProd } from '../config/env';

export const notFound: RequestHandler = (_req, res) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500, code = 'INTERNAL_ERROR', message = 'Something went wrong', details: unknown;
  if (err instanceof ApiError) { status = err.status; code = err.code; message = err.message; details = err.details; }
  else if (err instanceof ZodError) { status = 400; code = 'VALIDATION_ERROR'; message = 'Invalid input'; details = err.flatten().fieldErrors; }
  else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') { status = 409; code = 'DUPLICATE'; message = 'A record with these unique values already exists'; }
    else if (err.code === 'P2025') { status = 404; code = 'NOT_FOUND'; message = 'Record not found'; }
    else if (err.code === 'P2003') { status = 400; code = 'INVALID_REFERENCE'; message = 'Referenced record does not exist'; }
  } else if (err?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Malformed JSON body'; }

  if (status >= 500) logger.error({ err, path: req.path, userId: req.user?.id }, 'server error');
  else if (status === 401 || code === 'FORBIDDEN') logger.warn({ path: req.path, code, ip: req.ip }, 'auth failure');
  res.status(status).json({
    success: false,
    error: { code, message: status >= 500 && isProd ? 'Something went wrong' : message, ...(details ? { details } : {}) },
  });
};
