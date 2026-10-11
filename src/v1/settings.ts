import { prisma } from '../config/db';
import { env } from '../config/env';

export interface Settings {
  siteName: string; supportEmail: string; maintenanceMode: boolean; signupsOpen: boolean; defaultPopupSeconds: number;
  /** read-only here: payments are configured through environment variables */
  paymentProvider: string; paymentMode: 'GATEWAY' | 'MANUAL'; upiDeepLinkTemplate: string;
}
const defaults = (): Settings => ({
  siteName: 'CodeWithAws', supportEmail: '', maintenanceMode: false, signupsOpen: true, defaultPopupSeconds: 5,
  paymentProvider: env.PAYMENT_PROVIDER === 'RAZORPAY' ? 'Razorpay' : 'UPI (manual verification)', paymentMode: env.PAYMENT_PROVIDER === 'RAZORPAY' ? 'GATEWAY' : 'MANUAL', upiDeepLinkTemplate: env.UPI_PAYMENT_URL ?? '',
});

let cache: { at: number; value: Settings } | null = null;
export async function getSettings(fresh = false): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.value;
  const row = await prisma.siteSetting.findUnique({ where: { key: 'settings' } });
  const stored = (row?.value ?? {}) as Partial<Settings>;
  const value = { ...defaults(), ...stored, ...{ paymentProvider: defaults().paymentProvider, paymentMode: defaults().paymentMode, upiDeepLinkTemplate: defaults().upiDeepLinkTemplate } };
  cache = { at: Date.now(), value };
  return value;
}
export async function saveSettings(patch: Partial<Settings>) {
  const { paymentProvider: _a, paymentMode: _b, upiDeepLinkTemplate: _c, ...editable } = { ...(await getSettings(true)), ...patch };
  void _a; void _b; void _c;
  await prisma.siteSetting.upsert({ where: { key: 'settings' }, create: { key: 'settings', value: editable }, update: { value: editable } });
  cache = null;
  return getSettings(true);
}
