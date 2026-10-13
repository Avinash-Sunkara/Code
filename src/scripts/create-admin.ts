import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || !z.string().email().safeParse(email).success) {
    throw new Error('Set ADMIN_EMAIL to the new admin email address.');
  }
  const parsedPassword = z.string().min(12).max(128)
    .regex(/[a-z]/, 'Must contain a lowercase letter')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/\d/, 'Must contain a number')
    .safeParse(process.env.ADMIN_INITIAL_PASSWORD);
  if (!parsedPassword.success) {
    throw new Error('Set ADMIN_INITIAL_PASSWORD to a 12-128 character password with lowercase, uppercase, and a number.');
  }
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new Error('An account with ADMIN_EMAIL already exists; no account was changed.');
  }

  const base = email.split('@')[0].replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'admin';
  let username = base;
  for (let suffix = 2; await prisma.user.findUnique({ where: { username }, select: { id: true } }); suffix++) {
    username = `${base.slice(0, 28)}${suffix}`;
  }
  await prisma.user.create({
    data: {
      name: process.env.ADMIN_NAME?.trim() || 'Admin', username, email,
      role: 'ADMIN', emailVerified: true, mustChangePassword: true,
      passwordHash: await bcrypt.hash(parsedPassword.data, 12),
    },
  });
  console.log('Admin account created. Sign in and choose a new password.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Admin account creation failed.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
