import nodemailer from 'nodemailer';
import { env, isProd, primaryFrontend } from '../config/env';
import { logger } from '../config/logger';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    })
  : null;

async function send(to: string, subject: string, html: string, devLink: string) {
  if (!transport) {
    // Never log tokens in production.
    logger.warn(isProd ? { to, subject } : { to, subject, link: devLink }, 'SMTP not configured; email not sent');
    return;
  }
  await transport.sendMail({ from: env.EMAIL_FROM, to, subject, html });
}

export const sendVerificationEmail = (to: string, token: string) => {
  const link = `${primaryFrontend}/verify-email?token=${token}`;
  return send(to, 'Verify your CodeWithAws email', `<p>Confirm your email to unlock everything.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`, link);
};

export const sendPasswordResetEmail = (to: string, token: string) => {
  const link = `${primaryFrontend}/reset-password?token=${token}`;
  return send(to, 'Reset your CodeWithAws password', `<p>Use the link below to choose a new password.</p><p><a href="${link}">Reset password</a></p><p>It expires in 1 hour. If you didn't ask for this, ignore this email.</p>`, link);
};
