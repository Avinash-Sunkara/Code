import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || !z.string().email().safeParse(email).success) {
    throw new Error('Set ADMIN_EMAIL to the existing admin account to reset.');
  }
  const parsedPassword = z.string().min(12).max(128)
    .regex(/[a-z]/, 'Must contain a lowercase letter')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/\d/, 'Must contain a number')
    .safeParse(process.env.ADMIN_RESET_PASSWORD);
  if (!parsedPassword.success) {
    throw new Error('Set ADMIN_RESET_PASSWORD to a 12-128 character password with lowercase, uppercase, and a number.');
  }
  const admin = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (!admin || admin.role !== 'ADMIN') throw new Error('ADMIN_EMAIL must belong to an existing admin account.');
  const passwordHash = await bcrypt.hash(parsedPassword.data, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: admin.id }, data: { passwordHash, mustChangePassword: true } }),
    prisma.session.updateMany({ where: { userId: admin.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  console.log('Admin password reset. Sign in with the new password and choose a replacement.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Admin password reset failed.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
