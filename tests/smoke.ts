import { createHmac } from 'crypto';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/x';
process.env.FRONTEND_URL = 'https://app.example.com';
process.env.JWT_SECRET = 'x'.repeat(40); process.env.SESSION_SECRET = 'y'.repeat(20);
process.env.PAYMENT_WEBHOOK_SECRET = 'whsec_test'; process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = ''; process.env.GOOGLE_CLIENT_SECRET = '';
process.env.GITHUB_CLIENT_ID = ''; process.env.GITHUB_CLIENT_SECRET = '';
process.env.APP_TIMEZONE = 'America/Los_Angeles';

import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + JSON.stringify(extra)}`); };

(async () => {
  const { createApp } = await import('../src/app');
  const { calculateStreak, CONTRIBUTION_TYPES, isCountedActivity, localDate } = await import('../src/services/activity');
  const streak = calculateStreak(['2025-02-27', '2025-02-28', '2025-03-01', '2025-03-04'], '2025-03-01');
  t('streak counts consecutive learning days and ignores future days', streak.current === 3 && streak.longest === 3, streak);
  const missedToday = calculateStreak(['2025-02-28', '2025-03-01'], '2025-03-02');
  t('yesterday keeps the current streak active', missedToday.current === 2 && missedToday.longest === 2, missedToday);
  const broken = calculateStreak(['2025-02-28', '2025-03-02'], '2025-03-04');
  t('a missed day ends the current streak without losing longest', broken.current === 0 && broken.longest === 1, broken);
  t('non-learning actions are excluded from contribution categories', !CONTRIBUTION_TYPES.includes('LOGIN') && !CONTRIBUTION_TYPES.includes('NOTE_VIEWED'), CONTRIBUTION_TYPES);
  t('opening a puzzle does not count as practice activity', !isCountedActivity('PRACTICE', 'Puzzle') && isCountedActivity('PRACTICE', 'AptitudeQuestion'));
  const localDay = localDate(new Date('2025-03-01T02:30:00.000Z')).toISOString();
  t('activity date follows app timezone across UTC midnight', localDay === '2025-02-28T00:00:00.000Z', localDay);
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (path: string, init: RequestInit = {}) => { const r = await fetch(base + path, init); let j: any = null; try { j = await r.json(); } catch {} return { r, j }; };
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  let x = await call('/health'); t('GET /health -> {status:ok}', x.j?.status === 'ok', x.j);
  x = await call('/api/nope'); t('unknown route -> 404 envelope', x.r.status === 404 && x.j?.success === false && x.j?.error?.code === 'NOT_FOUND', x.j);
  x = await call('/api/auth/me'); t('/auth/me unauthenticated -> 401', x.r.status === 401 && x.j?.error?.code === 'UNAUTHORIZED', x.j);
  x = await call('/api/v1/auth/providers'); t('GET /v1/auth/providers -> both false when unconfigured', x.r.status === 200 && x.j?.google === false && x.j?.github === false, x.j);
  x = await call('/api/v1/auth/oauth/google', { redirect: 'manual' }); t('OAuth start without credentials -> redirect to app error page', x.r.status === 302 && String(x.r.headers.get('location')).endsWith('/auth/callback?error=not_configured'), x.r.headers.get('location'));
  x = await call('/api/auth/google/callback?error=access_denied', { redirect: 'manual' }); t('OAuth callback cancelled by user -> access_denied', x.r.status === 302 && String(x.r.headers.get('location')).endsWith('/auth/callback?error=access_denied'), x.r.headers.get('location'));
  x = await call('/api/auth/github/callback?code=abc&state=forged', { redirect: 'manual' }); t('OAuth callback with forged state -> invalid_state', x.r.status === 302 && String(x.r.headers.get('location')).endsWith('/auth/callback?error=invalid_state'), x.r.headers.get('location'));
  x = await call('/api/admin/dashboard'); t('/admin/dashboard unauthenticated -> 401', x.r.status === 401, x.j);
  x = await call('/api/users/me/activity'); t('/users/me/activity unauthenticated -> 401', x.r.status === 401, x.j);
  x = await call('/api/admin/users', { headers: { Authorization: 'Bearer forged.jwt.token' } }); t('forged bearer token -> 401', x.r.status === 401, x.j);
  x = await call('/api/auth/register', json({ name: 'A', username: 'x', email: 'bad', password: '1' })); t('register invalid input -> 400 VALIDATION_ERROR', x.r.status === 400 && x.j?.error?.code === 'VALIDATION_ERROR', x.j);
  x = await call('/api/auth/register', json({ name: 'Admin Guy', username: 'Admin', email: 'a@b.co', password: 'Passw0rdOK' })); t('register reserved username -> 400', x.r.status === 400 && JSON.stringify(x.j).includes('reserved'), x.j);
  x = await call('/api/auth/login', json({ email: 'a@b.co', password: 'x' }, { Cookie: 'access_token=abc', Origin: 'https://evil.example' })); t('cookie + wrong Origin -> 403 CSRF_REJECTED', x.r.status === 403 && x.j?.error?.code === 'CSRF_REJECTED', x.j);
  x = await call('/api/auth/login', json({}, { Cookie: 'access_token=abc', Origin: 'https://app.example.com' })); t('cookie + allowed Origin passes guard (then validation 400)', x.r.status === 400, x.j);
  x = await call('/api/files/note/abc?token=garbage'); t('file stream bad token -> 401 LINK_EXPIRED', x.r.status === 401 && x.j?.error?.code === 'LINK_EXPIRED', x.j);
  x = await call('/api/files/evil/abc?token=garbage'); t('file stream bad kind -> 404', x.r.status === 404, x.j);
  const body = JSON.stringify({ event: 'ping' });
  x = await call('/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' }, body }); t('webhook bad signature -> 400', x.r.status === 400 && x.j?.error?.code === 'INVALID_SIGNATURE', x.j);
  x = await call('/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); t('webhook missing signature -> 400', x.r.status === 400, x.j);
  const sig = createHmac('sha256', 'whsec_test').update(body).digest('hex');
  x = await call('/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }); t('webhook valid HMAC over raw body -> 200', x.r.status === 200 && x.j?.success === true, x.j);
  const bad = 'not json'; const sig2 = createHmac('sha256', 'whsec_test').update(bad).digest('hex');
  x = await call('/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig2 }, body: bad }); t('webhook signed-but-malformed JSON -> 400 (not 500)', x.r.status === 400, x.j);
  let r = await fetch(base + '/api/sheets', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'GET' } });
  t('CORS allows frontend origin with credentials', r.headers.get('access-control-allow-origin') === 'https://app.example.com' && r.headers.get('access-control-allow-credentials') === 'true');
  r = await fetch(base + '/api/sheets', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  t('CORS blocks other origins', !r.headers.get('access-control-allow-origin'));
  r = await fetch(base + '/health'); t('Helmet headers present', r.headers.get('x-content-type-options') === 'nosniff' && !r.headers.get('x-powered-by'));
  x = await call('/api/search?q=a'); t('search rejects 1-char query -> 400', x.r.status === 400, x.j);

  // Secure file token + watermarking
  const { signFileToken, verifyFileToken, watermarkPdf, watermarkImage } = await import('../src/services/secureFile');
  const tok = signFileToken('user1', 'note', 'n1'); const v = verifyFileToken(tok);
  t('file token round-trips (user, kind, id)', v.userId === 'user1' && v.kind === 'note' && v.id === 'n1', v);
  let expired = false; try { verifyFileToken(signFileToken('u', 'note', 'n', -5)); } catch { expired = true; } t('expired file token rejected', expired);
  let wrongAud = false; try { const jwt = require('jsonwebtoken'); verifyFileToken(jwt.sign({ kind: 'note', id: 'n' }, process.env.JWT_SECRET!, { subject: 'u', audience: 'access' })); } catch { wrongAud = true; } t('access-token cannot be used as file token', wrongAud);

  const pdf = await PDFDocument.create(); pdf.addPage([400, 600]); pdf.addPage([400, 600]);
  const src = Buffer.from(await pdf.save()); const out = await watermarkPdf(src, 'student@example.com');
  const reread = await PDFDocument.load(out);
  t('PDF watermark keeps all pages and changes bytes', reread.getPageCount() === 2 && out.length > src.length);
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const wm = await watermarkImage(png, 'student@example.com'); const meta = await sharp(wm).metadata();
  t('image watermark preserves size/format', meta.width === 300 && meta.height === 200 && meta.format === 'png' && !wm.equals(png));

  // Validators
  const A = await import('../src/validators/admin');
  t('PREMIUM note needs a price', !A.noteS.safeParse({ title: 'SQL Notes', contentType: 'PDF', accessType: 'PREMIUM', price: 0 }).success);
  t('PREMIUM note with price ok', A.noteS.safeParse({ title: 'SQL Notes', contentType: 'PDF', accessType: 'PREMIUM', price: 99 }).success);
  t('MCQ correctIndex out of range rejected', !A.aptQuestionS.safeParse({ topicId: 't', question: 'What?', options: ['a', 'b'], correctIndex: 5 }).success);
  t('HTML stripped from user text', (await import('../src/validators/common')).safeText().parse('<script>alert(1)</script>hello') === 'alert(1)hello');
  const { pageParams } = await import('../src/utils/pagination');
  t('pagination clamps limit and rejects unknown sort', (() => { const p = pageParams({ page: '-3', limit: '99999', sort: 'passwordHash' }, { sortable: ['name'] }); return p.page === 1 && p.limit === 100 && 'createdAt' in p.orderBy; })());

  // Streak/date helper
  t('localDate returns UTC-midnight', localDate().getUTCHours() === 0);

  // crud factory: sortable fields come from the real model
  const { Prisma } = await import('@prisma/client');
  const company = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Company')!.fields.map((f) => f.name);
  t('dmmf available: Company has no createdAt', !company.includes('createdAt'));

  server.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH', e); process.exit(2); });
