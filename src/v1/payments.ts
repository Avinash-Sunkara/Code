import { Request, Response, Router } from 'express';
import { ProtectedType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/db';
import { E } from '../utils/http';
import { authenticate } from '../middleware/auth';
import * as svc from '../services/payment';
import { send } from './util';

const r = Router();
const KIND: Record<string, ProtectedType> = { note: 'NOTE', 'cheat-sheet': 'CHEATSHEET', roadmap: 'ROADMAP', problem: 'PROBLEM', resource: 'ROADMAP_RESOURCE' };

r.post('/payments/checkout', authenticate, async (req: Request, res: Response) => {
  const { kind, id } = z.object({ kind: z.string(), id: z.string().min(1) }).parse(req.body ?? {});
  const type = KIND[kind];
  if (!type) throw E.badRequest('This content cannot be purchased');
  const { payment, checkout } = await svc.createPayment(req.user!, type, id);
  const c = checkout as Record<string, unknown>;
  // UPI_MANUAL returns a UPI link; Razorpay needs its hosted/JS checkout, so the frontend gets the order data instead.
  send(res, { orderId: payment.id, paymentUrl: String(c.paymentUrl ?? ''), provider: payment.provider, ...(c.reference ? { reference: c.reference } : {}), ...(c.provider === 'RAZORPAY' ? { checkout: c } : {}) }, 201);
});

r.get('/payments/orders/:id', authenticate, async (req: Request, res: Response) => {
  const p = await prisma.payment.findFirst({ where: { id: req.params.id, userId: req.user!.id }, select: { id: true, status: true, provider: true } });
  if (!p) throw E.notFound('Order not found');
  const status = p.status === 'SUCCESS' ? 'PAID' : p.status === 'FAILED' || p.status === 'CANCELLED' ? 'FAILED' : 'PENDING';
  send(res, { status, needsProof: p.provider === 'UPI_MANUAL' && p.status === 'PENDING', inReview: p.status === 'MANUAL_REVIEW' });
});

r.post('/payments/orders/:id/proof', authenticate, async (req: Request, res: Response) => {
  const { reference } = z.object({ reference: z.string().trim().min(6).max(64).regex(/^[A-Za-z0-9\-_]+$/, 'Use only letters, numbers, - and _') }).parse(req.body ?? {});
  const p = await svc.submitProof(req.user!, req.params.id, reference);
  send(res, { status: p.status });
});

export default r;
