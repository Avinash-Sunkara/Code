import { Request, Response } from 'express';
import { Difficulty, User } from '@prisma/client';

/** v1 responses are raw JSON (no {success,data} envelope) to match the frontend contract. */
export const send = (res: Response, body: unknown = {}, status = 200) => res.status(status).json(body);

export interface PageQ { page: number; pageSize: number; skip: number; take: number; q: string }
export function pq(req: Request, def = 20, max = 100): PageQ {
  const page = Math.max(1, parseInt(String(req.query.page)) || 1);
  const pageSize = Math.min(max, Math.max(1, parseInt(String(req.query.pageSize)) || def));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, q: String(req.query.q ?? '').trim().slice(0, 100) };
}
export const pageOf = <T>(items: T[], total: number, p: Pick<PageQ, 'page' | 'pageSize'>) => ({
  items, total, page: p.page, pageSize: p.pageSize, nextPage: p.page * p.pageSize < total ? p.page + 1 : null,
});

const D_OUT: Record<Difficulty, 'Easy' | 'Medium' | 'Hard'> = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' };
export const diffOut = (d: Difficulty) => D_OUT[d];
export const diffIn = (s?: unknown): Difficulty | undefined => {
  const v = String(s ?? '').toUpperCase();
  return v === 'EASY' || v === 'MEDIUM' || v === 'HARD' ? (v as Difficulty) : undefined;
};

export const toBool = (v: unknown) => v === true || v === 'true' || v === '1';

export const userOut = (u: User, streak?: number) => ({
  id: u.id, fullName: u.name, username: u.username, email: u.email,
  ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
  role: u.role, blocked: u.status !== 'ACTIVE', createdAt: u.createdAt.toISOString(), lastActiveAt: u.lastActiveAt.toISOString(),
  ...(streak !== undefined ? { streak } : {}),
  mustChangePassword: u.mustChangePassword,
});
