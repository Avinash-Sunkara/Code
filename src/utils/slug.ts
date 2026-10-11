import { randomBytes } from 'crypto';
import { prisma } from '../config/db';

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'item';

export async function uniqueSlug(model: string, base: string, scope: Record<string, unknown> = {}): Promise<string> {
  const delegate = (prisma as any)[model];
  let slug = slugify(base);
  while (await delegate.findFirst({ where: { slug, ...scope }, select: { id: true } })) {
    slug = `${slugify(base).slice(0, 70)}-${randomBytes(2).toString('hex')}`;
  }
  return slug;
}
