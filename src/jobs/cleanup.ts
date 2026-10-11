import { prisma } from '../config/db';
import { logger } from '../config/logger';

export async function cleanup() {
  const now = new Date();
  const [s, t, a] = await Promise.all([
    prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } }] } }),
    prisma.authToken.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] } }),
    prisma.notification.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } }),
  ]);
  logger.info({ sessions: s.count, tokens: t.count, notifications: a.count }, 'cleanup job done');
}
export const startJobs = () => { setInterval(() => cleanup().catch((err) => logger.error({ err }, 'cleanup failed')), 6 * 3600_000).unref(); };
