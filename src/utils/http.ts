import { Response } from 'express';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const E = {
  badRequest: (m = 'Bad request', c = 'BAD_REQUEST', d?: unknown) => new ApiError(400, c, m, d),
  unauthorized: (m = 'Authentication required', c = 'UNAUTHORIZED') => new ApiError(401, c, m),
  forbidden: (m = 'Forbidden', c = 'FORBIDDEN', d?: unknown) => new ApiError(403, c, m, d),
  notFound: (m = 'Not found', c = 'NOT_FOUND') => new ApiError(404, c, m),
  conflict: (m = 'Conflict', c = 'CONFLICT') => new ApiError(409, c, m),
  unavailable: (m = 'Service unavailable', c = 'UNAVAILABLE') => new ApiError(503, c, m),
};

export const ok = (res: Response, data: unknown = {}, message = 'OK', status = 200) =>
  res.status(status).json({ success: true, data, message });

export const page = (res: Response, items: unknown[], total: number, p: number, limit: number, message = 'OK') =>
  res.json({
    success: true,
    data: { items, pagination: { page: p, limit, total, totalPages: Math.ceil(total / limit) } },
    message,
  });
