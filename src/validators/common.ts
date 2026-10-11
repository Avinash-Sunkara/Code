import { z } from 'zod';
import { stripHtml } from '../utils/serializers';

export const safeText = (min = 1, max = 5000) => z.string().trim().min(min).max(max).transform(stripHtml);
export const url = z.string().trim().url().max(2048);
export const optUrl = url.nullish().or(z.literal('').transform(() => null));
export const slug = z.string().regex(/^[a-z0-9-]+$/).max(100).optional();
export const id = z.string().min(1).max(40);
export const price = z.coerce.number().min(0).max(1_000_000);
export const difficulty = z.enum(['EASY', 'MEDIUM', 'HARD']);
export const accessType = z.enum(['FREE', 'PREMIUM', 'SELECTED_USERS']);
export const protectedType = z.enum(['NOTE', 'CHEATSHEET', 'ROADMAP', 'ROADMAP_RESOURCE', 'PROBLEM']);
