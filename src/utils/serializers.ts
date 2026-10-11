import { User } from '@prisma/client';

export const publicUser = (u: User) => ({
  id: u.id, name: u.name, username: u.username, email: u.email, avatarUrl: u.avatarUrl,
  role: u.role, status: u.status, emailVerified: u.emailVerified,
  mustChangePassword: u.mustChangePassword, createdAt: u.createdAt, lastActiveAt: u.lastActiveAt,
});

export const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
