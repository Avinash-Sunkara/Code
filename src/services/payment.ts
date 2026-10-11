import { createHmac } from 'crypto';
import { Payment, ProtectedType, User } from '@prisma/client';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { E } from '../utils/http';
import { safeEqual } from '../utils/crypto';
import { hasEntitlement } from './access';
import { logActivity } from './activity';

const PURCHASABLE: ProtectedType[] = ['NOTE', 'CHEATSHEET', 'ROADMAP', 'ROADMAP_RESOURCE'];

async function loadPriced(type: ProtectedType, id: string) {
  switch (type) {
    case 'NOTE': { const n = await prisma.note.findUnique({ where: { id } }); return n && { title: n.title, price: n.price, free: n.accessType === 'FREE', published: n.isPublished, selectedOnly: n.accessType === 'SELECTED_USERS' }; }
    case 'CHEATSHEET': { const n = await prisma.cheatSheet.findUnique({ where: { id } }); return n && { title: n.title, price: n.price, free: n.accessType === 'FREE', published: n.isPublished, selectedOnly: n.accessType === 'SELECTED_USERS' }; }
    case 'ROADMAP': { const n = await prisma.roadmap.findUnique({ where: { id } }); return n && { title: n.title, price: n.price, free: !n.isPremium, published: n.isPublished, selectedOnly: false }; }
    case 'ROADMAP_RESOURCE': { const n = await prisma.roadmapResource.findUnique({ where: { id }, include: { topic: { include: { section: { include: { roadmap: true } } } } } }); const rm = n?.topic.section.roadmap; return n && rm && { title: n.title, price: n.price, free: !n.isPremium && !rm.isPremium, published: rm.isPublished, selectedOnly: false, buyParent: rm.isPremium && !n.isPremium ? rm.id : null }; }
    default: return null;
  }
}

export async function grantEntitlement(userId: string, type: ProtectedType, id: string, source: 'PAYMENT' | 'ADMIN_GRANT', grantedBy?: string, expiresAt?: Date | null) {
  await prisma.contentEntitlement.upsert({
    where: { userId_contentType_contentId: { userId, contentType: type, contentId: id } },
    create: { userId, contentType: type, contentId: id, accessType: source === 'PAYMENT' ? 'PREMIUM' : 'SELECTED_USERS', source, grantedBy, expiresAt: expiresAt ?? undefined },
    update: { source, grantedBy, expiresAt: expiresAt ?? null },
  });
  await logActivity(userId, 'CONTENT_UNLOCKED', { refType: type, refId: id });
}

/** Mark a payment successful exactly once and grant access. Idempotent. */
export async function fulfil(paymentId: string, opts: { reviewedBy?: string; reference?: string; note?: string } = {}) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) throw E.notFound('Payment not found');
  if (p.status === 'SUCCESS') return p;
  const updated = await prisma.payment.update({
    where: { id: p.id },
    data: { status: 'SUCCESS', verifiedAt: new Date(), reviewedBy: opts.reviewedBy, reviewNote: opts.note, proofReference: opts.reference ?? p.proofReference },
  });
  await grantEntitlement(p.userId, p.contentType, p.contentId, 'PAYMENT');
  await logActivity(p.userId, 'PAYMENT', { refType: p.contentType, refId: p.contentId });
  logger.info({ paymentId: p.id, provider: p.provider, userId: p.userId }, 'payment verified');
  return updated;
}

export async function createPayment(user: User, type: ProtectedType, contentId: string) {
  if (!PURCHASABLE.includes(type)) throw E.badRequest('This content type cannot be purchased', 'NOT_PURCHASABLE');
  const item = await loadPriced(type, contentId);
  if (!item || !item.published) throw E.notFound('Content not found');
  if ((item as any).buyParent) throw E.badRequest('This resource is part of a premium roadmap. Purchase the full roadmap instead.', 'BUY_PARENT', { contentType: 'ROADMAP', contentId: (item as any).buyParent });
  if (item.free) throw E.badRequest('This content is free', 'ALREADY_FREE');
  if (item.selectedOnly) throw E.badRequest('This content is available to selected users only', 'NOT_PURCHASABLE');
  if (Number(item.price) <= 0) throw E.badRequest('Price is not set for this content', 'PRICE_NOT_SET');
  if (await hasEntitlement(user.id, type, contentId)) throw E.conflict('You already have access', 'ALREADY_OWNED');

  const amount = item.price; // always the server-side price
  const provider = env.PAYMENT_PROVIDER;

  if (provider === 'RAZORPAY') {
    if (!env.PAYMENT_KEY_ID || !env.PAYMENT_SECRET) throw E.unavailable('Payment gateway is not configured', 'PAYMENT_NOT_CONFIGURED');
    const pending = await prisma.payment.create({ data: { userId: user.id, contentType: type, contentId, amount, provider } });
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${env.PAYMENT_KEY_ID}:${env.PAYMENT_SECRET}`).toString('base64') },
      body: JSON.stringify({ amount: Math.round(Number(amount) * 100), currency: 'INR', receipt: pending.id.slice(0, 40), notes: { paymentId: pending.id, userId: user.id } }),
    });
    if (!res.ok) {
      await prisma.payment.update({ where: { id: pending.id }, data: { status: 'FAILED' } });
      logger.error({ status: res.status }, 'razorpay order creation failed');
      throw E.unavailable('Could not start payment', 'PAYMENT_PROVIDER_ERROR');
    }
    const order = (await res.json()) as { id: string };
    const payment = await prisma.payment.update({ where: { id: pending.id }, data: { providerPaymentId: order.id } });
    return { payment, checkout: { provider, orderId: order.id, keyId: env.PAYMENT_KEY_ID, amount: Math.round(Number(amount) * 100), currency: 'INR', title: item.title } };
  }

  // UPI_MANUAL: opening a UPI link proves nothing. The user submits a UTR afterwards and an admin approves it.
  if (!env.UPI_PAYMENT_URL) throw E.unavailable('UPI payments are not configured', 'PAYMENT_NOT_CONFIGURED');
  const pending = await prisma.payment.create({ data: { userId: user.id, contentType: type, contentId, amount, provider } });
  const url = new URL(env.UPI_PAYMENT_URL);
  url.searchParams.set('am', Number(amount).toFixed(2));
  url.searchParams.set('cu', 'INR');
  url.searchParams.set('tn', `RB-${pending.id.slice(-8)}`);
  const payment = await prisma.payment.update({ where: { id: pending.id }, data: { paymentUrl: url.toString() } });
  return { payment, checkout: { provider, paymentUrl: payment.paymentUrl, reference: `RB-${pending.id.slice(-8)}`, note: 'After paying, submit your UTR/transaction id. Access is granted once an admin verifies it.' } };
}

export async function submitProof(user: User, paymentId: string, reference: string) {
  const p = await prisma.payment.findFirst({ where: { id: paymentId, userId: user.id } });
  if (!p) throw E.notFound('Payment not found');
  if (p.provider !== 'UPI_MANUAL') throw E.badRequest('Proof submission is only for manual UPI payments');
  if (!['PENDING', 'MANUAL_REVIEW'].includes(p.status)) throw E.conflict('Payment is already finalised');
  return prisma.payment.update({ where: { id: p.id }, data: { status: 'MANUAL_REVIEW', proofReference: reference } });
}

/** Client-side Razorpay checkout callback: verify signature(order_id|payment_id) server-side. */
export async function verifyRazorpayCheckout(user: User, paymentId: string, razorpayPaymentId: string, signature: string) {
  const p = await prisma.payment.findFirst({ where: { id: paymentId, userId: user.id, provider: 'RAZORPAY' } });
  if (!p || !p.providerPaymentId) throw E.notFound('Payment not found');
  const expected = createHmac('sha256', env.PAYMENT_SECRET ?? '').update(`${p.providerPaymentId}|${razorpayPaymentId}`).digest('hex');
  if (!safeEqual(expected, signature)) {
    logger.warn({ paymentId }, 'razorpay checkout signature mismatch');
    throw E.badRequest('Payment signature invalid', 'INVALID_SIGNATURE');
  }
  return fulfil(p.id, { reference: razorpayPaymentId });
}

/** Webhook: verify HMAC over the RAW body, match order, check amount, then fulfil. */
export async function handleRazorpayWebhook(raw: Buffer, signature: string | undefined) {
  if (!env.PAYMENT_WEBHOOK_SECRET) throw E.unavailable('Webhook not configured', 'WEBHOOK_NOT_CONFIGURED');
  const expected = createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET).update(raw).digest('hex');
  if (!signature || !safeEqual(expected, signature)) {
    logger.warn('payment webhook signature rejected');
    throw E.badRequest('Invalid signature', 'INVALID_SIGNATURE');
  }
  let body: any;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw E.badRequest('Malformed payload', 'INVALID_PAYLOAD'); }
  const pay = body?.payload?.payment?.entity;
  const orderId: string | undefined = pay?.order_id ?? body?.payload?.order?.entity?.id;
  if (!orderId) return;
  const p = await prisma.payment.findUnique({ where: { provider_providerPaymentId: { provider: 'RAZORPAY', providerPaymentId: orderId } } });
  if (!p) return;
  if (body.event === 'payment.captured' || body.event === 'order.paid') {
    if (pay?.amount !== undefined && pay.amount !== Math.round(Number(p.amount) * 100)) {
      await prisma.payment.update({ where: { id: p.id }, data: { status: 'MANUAL_REVIEW', reviewNote: 'Amount mismatch with gateway' } });
      logger.error({ paymentId: p.id }, 'payment amount mismatch');
      return;
    }
    await fulfil(p.id, { reference: pay?.id });
  } else if (body.event === 'payment.failed' && p.status !== 'SUCCESS') {
    await prisma.payment.update({ where: { id: p.id }, data: { status: 'FAILED' } });
    logger.info({ paymentId: p.id }, 'payment failed');
  }
}

export async function rejectPayment(id: string, adminId: string, note?: string): Promise<Payment> {
  const p = await prisma.payment.findUnique({ where: { id } });
  if (!p) throw E.notFound('Payment not found');
  if (p.status === 'SUCCESS') throw E.conflict('Payment already approved');
  return prisma.payment.update({ where: { id }, data: { status: 'FAILED', reviewedBy: adminId, reviewNote: note } });
}
