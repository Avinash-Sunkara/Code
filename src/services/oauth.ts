import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { prisma } from '../config/db';
import { apiUrl, env, isProd, primaryFrontend } from '../config/env';
import { logger } from '../config/logger';
import { E } from '../utils/http';
import { startSession } from './session';
import { claimPendingEntitlements } from './access';
import { logActivity } from './activity';
import { RESERVED } from '../validators/auth';

type Provider = 'google' | 'github';
const cfg = (p: Provider) =>
  p === 'google'
    ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, cb: env.GOOGLE_CALLBACK_URL ?? (isProd ? `${primaryFrontend}/api/auth/google/callback` : `${apiUrl}/api/auth/google/callback`), url: 'https://accounts.google.com/o/oauth2/v2/auth', scope: 'openid email profile' }
    : { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET, cb: env.GITHUB_CALLBACK_URL ?? (isProd ? `${primaryFrontend}/api/auth/github/callback` : `${apiUrl}/api/auth/github/callback`), url: 'https://github.com/login/oauth/authorize', scope: 'read:user user:email' };

const stateCookie = { httpOnly: true, signed: true, secure: isProd, sameSite: 'lax' as const, path: '/api/auth', maxAge: 10 * 60_000 };

export const isConfigured = (p: Provider) => !!(cfg(p).id && cfg(p).secret);

export function begin(provider: Provider, res: Response) {
  const c = cfg(provider);
  if (!c.id || !c.secret) return res.redirect(`${primaryFrontend}/auth/callback?error=not_configured`); // a browser navigation: show the app's error page, not raw JSON
  const state = randomBytes(24).toString('base64url');
  res.cookie('oauth_state', state, stateCookie);
  const q = new URLSearchParams({ client_id: c.id, redirect_uri: c.cb, response_type: 'code', scope: c.scope, state });
  if (provider === 'google') q.set('prompt', 'select_account');
  res.redirect(`${c.url}?${q}`);
}

interface Profile { id: string; email?: string; emailVerified: boolean; name: string; avatar?: string; login?: string }

async function fetchProfile(provider: Provider, code: string): Promise<Profile> {
  const c = cfg(provider);
  if (provider === 'google') {
    const t = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: c.id!, client_secret: c.secret!, redirect_uri: c.cb, grant_type: 'authorization_code' }),
    }).then((r) => r.json() as Promise<any>);
    if (!t.access_token) throw E.badRequest('Google sign-in failed', 'OAUTH_FAILED');
    const u = (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json())) as any;
    return { id: String(u.sub), email: u.email?.toLowerCase(), emailVerified: !!u.email_verified, name: u.name ?? u.email, avatar: u.picture };
  }
  const t = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: c.id, client_secret: c.secret, code, redirect_uri: c.cb }),
  }).then((r) => r.json() as Promise<any>);
  if (!t.access_token) throw E.badRequest('GitHub sign-in failed', 'OAUTH_FAILED');
  const h = { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'risingbrain-api', Accept: 'application/vnd.github+json' };
  const u = (await fetch('https://api.github.com/user', { headers: h }).then((r) => r.json())) as any;
  const emails = (await fetch('https://api.github.com/user/emails', { headers: h }).then((r) => r.json())) as any;
  const primary = Array.isArray(emails) ? emails.find((e: any) => e.primary && e.verified) ?? emails.find((e: any) => e.verified) : undefined;
  return { id: String(u.id), email: primary?.email?.toLowerCase(), emailVerified: !!primary, name: u.name ?? u.login, avatar: u.avatar_url, login: u.login };
}

async function freeUsername(seed: string) {
  let base = seed.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  if (base.length < 3 || RESERVED.includes(base)) base = `learner${base}`.slice(0, 20); // keeps names valid (3-30 chars) and never hands out "admin", "support", ...
  let name = base;
  while (await prisma.user.findUnique({ where: { username: name }, select: { id: true } })) name = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
  return name;
}

export async function complete(provider: Provider, req: Request, res: Response) {
  const fail = (code: string) => res.redirect(`${primaryFrontend}/auth/callback?error=${encodeURIComponent(code)}`);
  const expected = req.signedCookies?.oauth_state;
  res.clearCookie('oauth_state', { path: '/api/auth' });
  if (typeof req.query.error === 'string') return fail(req.query.error === 'access_denied' ? 'access_denied' : 'oauth_failed'); // user pressed "Cancel" at the provider
  if (!expected || req.query.state !== expected || typeof req.query.code !== 'string') return fail('invalid_state');
  try {
    return await finish(provider, req, res, req.query.code, fail);
  } catch (err) {
    logger.error({ err, provider }, 'oauth sign-in failed');
    return fail('oauth_failed');
  }
}

async function finish(provider: Provider, req: Request, res: Response, code: string, fail: (c: string) => void) {
  let profile: Profile;
  try { profile = await fetchProfile(provider, code); } catch (err) { logger.warn({ provider }, 'oauth profile fetch failed'); return fail('oauth_failed'); }

  const account = await prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId: profile.id } }, include: { user: true },
  });
  let user = account?.user ?? null;

  if (!user) {
    if (!profile.email || !profile.emailVerified) return fail('email_unverified'); // never link/create on an unverified email
    const existing = await prisma.user.findUnique({ where: { email: profile.email } });
    if (existing) {
      if (!existing.emailVerified) {
        // Someone may have pre-registered this address with a password they chose. The provider has now proven the real owner,
        // so drop that password and every session it opened before linking.
        await prisma.session.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
        await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: null } });
      }
      user = await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: true, avatarUrl: existing.avatarUrl ?? profile.avatar } });
    } else {
      user = await prisma.user.create({
        data: { name: (profile.name || profile.email).slice(0, 80), username: await freeUsername(profile.login ?? profile.email.split('@')[0]), email: profile.email, avatarUrl: profile.avatar, emailVerified: true },
      });
    }
    await prisma.oAuthAccount.create({ data: { userId: user.id, provider, providerAccountId: profile.id, email: profile.email } });
  }
  if (user.status !== 'ACTIVE') return fail(`account_${user.status.toLowerCase()}`);
  await claimPendingEntitlements(user);
  await startSession(req, res, user, true);
  await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
  await logActivity(user.id, 'LOGIN', { refType: provider });
  res.redirect(`${primaryFrontend}/auth/callback?status=success`);
}
