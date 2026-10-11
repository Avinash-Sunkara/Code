import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok } from '../utils/http';
import { hub, unreadFor } from '../services/notification';

export async function unread(req: Request, res: Response) {
  const items = await unreadFor(req.user!);
  ok(res, { count: items.length, items });
}

export async function markRead(req: Request, res: Response) {
  const d = z.object({ ids: z.array(z.string()).max(100).optional(), all: z.boolean().optional() }).parse(req.body ?? {});
  const ids = d.all ? (await unreadFor(req.user!)).map((n) => n.id) : d.ids ?? [];
  const userId = req.user!.id;
  await prisma.$transaction(ids.map((notificationId) =>
    prisma.notificationRecipient.upsert({ where: { notificationId_userId: { notificationId, userId } }, create: { notificationId, userId, readAt: new Date() }, update: { readAt: new Date() } })));
  ok(res, { marked: ids.length });
}

/** Server-Sent Events: the frontend shows each event as a ~5s popup. */
export function stream(req: Request, res: Response) {
  const user = req.user!;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const onNote = ({ notification, userIds }: { notification: any; userIds: string[] | null }) => {
    if (userIds === null || userIds.includes(user.id)) res.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
  };
  hub.on('notification', onNote);
  const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(beat); hub.off('notification', onNote); });
}
