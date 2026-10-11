import { Request } from 'express';
import { prisma } from '../config/db';
import { logger } from '../config/logger';

export async function audit(req: Request, action: string, entity?: string, entityId?: string, meta?: Record<string, unknown>) {
  logger.info({ actorId: req.user?.id, action, entity, entityId }, 'admin action');
  await prisma.auditLog
    .create({ data: { actorId: req.user?.id, action, entity, entityId, meta: meta as any, ip: req.ip } })
    .catch((err) => logger.error({ err }, 'audit write failed'));
}
