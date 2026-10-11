import bcrypt from 'bcryptjs';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { logger } from '../config/logger';

/** Creates the first admin from env vars only if no admin exists. Password change is forced on first login. */
export async function ensureAdmin() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_INITIAL_PASSWORD) return;
  if (await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } })) return;
  if (env.ADMIN_INITIAL_PASSWORD.length < 12) { logger.error('ADMIN_INITIAL_PASSWORD must be at least 12 characters; admin not created'); return; }
  const email = env.ADMIN_EMAIL.toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) { logger.error('ADMIN_EMAIL belongs to a non-admin user; refusing to auto-promote'); return; }
  await prisma.user.create({
    data: {
      name: env.ADMIN_NAME, username: 'admin', email, role: 'ADMIN', emailVerified: true, mustChangePassword: true,
      passwordHash: await bcrypt.hash(env.ADMIN_INITIAL_PASSWORD, 12),
    },
  });
  logger.info({ email }, 'initial admin created; remove ADMIN_INITIAL_PASSWORD from the environment');
}
