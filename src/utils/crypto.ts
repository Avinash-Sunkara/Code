import { createHash, randomBytes, timingSafeEqual } from 'crypto';
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 48) => randomBytes(bytes).toString('base64url');
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
