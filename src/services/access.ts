import { AccessType, ProtectedType, User } from '@prisma/client';
import { prisma } from '../config/db';

type Gated = { id: string; accessType?: AccessType; isPremium?: boolean };
export const levelOf = (i: Gated): AccessType => i.accessType ?? (i.isPremium ? 'PREMIUM' : 'FREE');

const live = () => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });

export async function hasEntitlement(userId: string, type: ProtectedType, id: string) {
  const e = await prisma.contentEntitlement.findFirst({ where: { userId, contentType: type, contentId: id, ...live() }, select: { id: true } });
  return !!e;
}

/** All ids of a content type the user is currently entitled to (for list endpoints). */
export async function entitledIds(userId: string | undefined, type: ProtectedType): Promise<Set<string>> {
  if (!userId) return new Set();
  const rows = await prisma.contentEntitlement.findMany({ where: { userId, contentType: type, ...live() }, select: { contentId: true } });
  return new Set(rows.map((r) => r.contentId));
}

/**
 * Central access decision. Callers must already have checked authentication and `isPublished`.
 * FREE -> any active user; PREMIUM / SELECTED_USERS -> verified payment or admin grant (both are ContentEntitlement rows).
 */
export async function canAccess(user: Pick<User, 'id' | 'role' | 'status'> | undefined, type: ProtectedType, item: Gated, parent?: { type: ProtectedType; id: string }) {
  if (!user || user.status !== 'ACTIVE') return false;
  if (user.role === 'ADMIN') return true;
  if (levelOf(item) === 'FREE') return true;
  if (await hasEntitlement(user.id, type, item.id)) return true;
  return parent ? hasEntitlement(user.id, parent.type, parent.id) : false;
}

export const isLocked = (user: { role: string } | undefined, item: Gated, owned: Set<string>) =>
  user?.role !== 'ADMIN' && levelOf(item) !== 'FREE' && !owned.has(item.id);

/** Turn pending (email-only) grants into real entitlements once the email is verified. */
export async function claimPendingEntitlements(user: Pick<User, 'id' | 'email' | 'emailVerified'>) {
  if (!user.emailVerified) return;
  const pending = await prisma.pendingEntitlement.findMany({ where: { email: user.email } });
  for (const p of pending) {
    await prisma.contentEntitlement.upsert({
      where: { userId_contentType_contentId: { userId: user.id, contentType: p.contentType, contentId: p.contentId } },
      create: { userId: user.id, contentType: p.contentType, contentId: p.contentId, grantedBy: p.grantedBy, expiresAt: p.expiresAt },
      update: {},
    });
  }
  if (pending.length) await prisma.pendingEntitlement.deleteMany({ where: { email: user.email } });
}
