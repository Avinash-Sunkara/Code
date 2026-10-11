import { EventEmitter } from 'events';
import { Notification, NotificationTarget, NotificationType } from '@prisma/client';
import { prisma } from '../config/db';

/** In-process fan-out for SSE. For multiple instances, swap for Redis pub/sub; polling endpoint works regardless. */
export const hub = new EventEmitter();
hub.setMaxListeners(0);

export async function createNotification(o: {
  title: string; message: string; type?: NotificationType; targetType?: NotificationTarget;
  userIds?: string[]; createdBy?: string; expiresAt?: Date | null; linkUrl?: string | null;
}): Promise<Notification> {
  const targetType = o.targetType ?? 'ALL_USERS';
  const n = await prisma.notification.create({
    data: {
      title: o.title, message: o.message, type: o.type ?? 'INFO', targetType,
      createdBy: o.createdBy, expiresAt: o.expiresAt ?? undefined, linkUrl: o.linkUrl ?? undefined,
      recipients: targetType === 'SELECTED_USERS' ? { create: (o.userIds ?? []).map((userId) => ({ userId })) } : undefined,
    },
  });
  hub.emit('notification', { notification: n, userIds: targetType === 'SELECTED_USERS' ? o.userIds ?? [] : null });
  return n;
}

export async function unreadFor(user: { id: string; createdAt: Date }) {
  const now = new Date();
  return prisma.notification.findMany({
    where: {
      AND: [
        { publishedAt: { not: null } },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        {
          OR: [
            { targetType: 'ALL_USERS', createdAt: { gte: user.createdAt }, recipients: { none: { userId: user.id } } },
            { targetType: 'SELECTED_USERS', recipients: { some: { userId: user.id, readAt: null } } },
          ],
        },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
