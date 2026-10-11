import { z } from 'zod';
import { safeText } from './common';

export const RESERVED = ['admin', 'administrator', 'root', 'support', 'risingbrain', 'system', 'moderator', 'staff'];
export const password = z.string().min(8).max(128)
  .regex(/[a-z]/, 'Must contain a lowercase letter').regex(/[A-Z]/, 'Must contain an uppercase letter').regex(/\d/, 'Must contain a number');

export const registerSchema = z.object({
  name: safeText(2, 80),
  username: z.string().trim().regex(/^[a-zA-Z0-9_]{3,30}$/, '3-30 letters, numbers or underscores').transform((s) => s.toLowerCase())
    .refine((s) => !RESERVED.includes(s), 'This username is reserved'),
  email: z.string().trim().toLowerCase().email().max(254),
  password,
});
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
  remember: z.boolean().default(true),
});
export const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetSchema = z.object({ token: z.string().min(10).max(200), password });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const verifySchema = z.object({ token: z.string().min(10).max(200) });
export const profileSchema = z.object({
  name: safeText(2, 80).optional(),
  username: z.string().trim().regex(/^[a-zA-Z0-9_]{3,30}$/).transform((s) => s.toLowerCase()).optional(),
  avatarUrl: z.string().url().max(2048).nullish(),
});
