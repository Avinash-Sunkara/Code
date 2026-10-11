import { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError } from '../utils/http';
import { logger } from '../config/logger';
import { isProd } from '../config/env';

/** Frontend error contract: { message, field? } with a meaningful HTTP status. */
export const v1NotFound: RequestHandler = (_req, res) => { res.status(404).json({ message: 'Route not found' }); };

export const v1Errors: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500, message = 'Something went wrong', field: string | undefined;
  if (err instanceof ApiError) {
    status = err.status; message = err.message;
    if (err.code === 'ALREADY_EXISTS') field = /username/i.test(err.message) ? 'username' : 'email';
  } else if (err instanceof ZodError) {
    status = 422; const first = err.issues[0];
    message = first ? `${first.path.join('.') ? first.path.join('.') + ': ' : ''}${first.message}` : 'Invalid input';
    field = first?.path[0] === 'name' ? 'fullName' : (first?.path[0] as string | undefined);
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') { status = 409; message = 'A record with these values already exists'; field = (err.meta?.target as string[] | undefined)?.[0]; }
    else if (err.code === 'P2025') { status = 404; message = 'Record not found'; }
    else if (err.code === 'P2003') { status = 400; message = 'Referenced record does not exist'; }
  } else if ((err as any)?.type === 'entity.parse.failed') { status = 400; message = 'Malformed JSON body'; }
  else if ((err as any)?.code === 'LIMIT_FILE_SIZE') { status = 422; message = 'File is too large'; }

  if (status >= 500) logger.error({ err, path: req.path, userId: req.user?.id }, 'server error');
  res.status(status).json({ message: status >= 500 && isProd ? 'Something went wrong' : message, ...(field ? { field } : {}) });
};
