import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { E, ok } from '../utils/http';
import { protectedType } from '../validators/common';
import * as svc from '../services/payment';

export async function create(req: Request, res: Response) {
  const d = z.object({ contentType: protectedType, contentId: z.string().min(1) }).parse(req.body);
  const { payment, checkout } = await svc.createPayment(req.user!, d.contentType, d.contentId);
  ok(res, { paymentId: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency, checkout }, 'Payment created', 201);
}

export async function submitProof(req: Request, res: Response) {
  const { reference } = z.object({ reference: z.string().trim().min(6).max(64).regex(/^[A-Za-z0-9\-_]+$/) }).parse(req.body);
  const p = await svc.submitProof(req.user!, req.params.id, reference);
  ok(res, { paymentId: p.id, status: p.status }, 'Submitted for review');
}

export async function verifyCheckout(req: Request, res: Response) {
  const d = z.object({ razorpay_payment_id: z.string(), razorpay_signature: z.string() }).parse(req.body);
  const p = await svc.verifyRazorpayCheckout(req.user!, req.params.id, d.razorpay_payment_id, d.razorpay_signature);
  ok(res, { paymentId: p.id, status: p.status }, 'Payment verified');
}

export async function status(req: Request, res: Response) {
  const p = await prisma.payment.findFirst({ where: { id: req.params.id, userId: req.user!.id }, select: { id: true, status: true, amount: true, contentType: true, contentId: true, verifiedAt: true } });
  if (!p) throw E.notFound('Payment not found');
  ok(res, p);
}

/** Raw-body route (mounted before express.json). Always 200 for verified events so the gateway stops retrying. */
export async function webhook(req: Request, res: Response) {
  await svc.handleRazorpayWebhook(req.body as Buffer, req.headers['x-razorpay-signature'] as string | undefined);
  res.json({ success: true, data: {}, message: 'ok' });
}
