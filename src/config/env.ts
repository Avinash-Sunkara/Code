import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  FRONTEND_URL: z.string().min(1),
  API_URL: z.string().url().optional(),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'none', 'strict']).optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  SESSION_SECRET: z.string().min(16),
  JWT_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CALLBACK_URL: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('CodeWithAws <no-reply@localhost>'),
  STORAGE_PROVIDER: z.string().default('s3'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_ENDPOINT: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(['UPI_MANUAL', 'RAZORPAY']).default('UPI_MANUAL'),
  PAYMENT_KEY_ID: z.string().optional(),
  PAYMENT_SECRET: z.string().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  UPI_PAYMENT_URL: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_NAME: z.string().default('Admin'),
  ADMIN_INITIAL_PASSWORD: z.string().optional(),
});

// Treat empty strings (from a copied .env.example) as unset
const cleaned = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''));
const parsed = schema.safeParse(cleaned);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
const configured = env.FRONTEND_URL.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
// In development, http://localhost:3000 and http://127.0.0.1:3000 are the same app; accept both so CORS and the CSRF origin check don't reject one of them.
export const frontendOrigins = isProd ? configured : [...new Set(configured.flatMap((o) => [o, o.replace('//localhost', '//127.0.0.1'), o.replace('//127.0.0.1', '//localhost')]))];
export const primaryFrontend = frontendOrigins[0];
export const apiUrl = (env.API_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, '');
