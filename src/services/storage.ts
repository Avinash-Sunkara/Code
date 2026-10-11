import { GetObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { E } from '../utils/http';

/**
 * Storage abstraction. Any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Supabase)
 * works via STORAGE_ENDPOINT. Add another provider by implementing the same four functions below.
 * The database only stores the object key; objects stay private and are only served through the API.
 */
let client: S3Client | null = null;
function s3() {
  if (env.STORAGE_PROVIDER !== 's3') throw E.unavailable(`Unsupported STORAGE_PROVIDER "${env.STORAGE_PROVIDER}"`, 'STORAGE_UNSUPPORTED');
  if (!env.STORAGE_BUCKET || !env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY) throw E.unavailable('Object storage is not configured', 'STORAGE_NOT_CONFIGURED');
  client ??= new S3Client({
    region: env.STORAGE_REGION, endpoint: env.STORAGE_ENDPOINT, forcePathStyle: !!env.STORAGE_ENDPOINT,
    credentials: { accessKeyId: env.STORAGE_ACCESS_KEY, secretAccessKey: env.STORAGE_SECRET_KEY },
  });
  return client;
}

export const ALLOWED_UPLOADS: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
};
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function newKey(folder: string, contentType: string) {
  const ext = ALLOWED_UPLOADS[contentType];
  if (!ext) throw E.badRequest('Unsupported file type', 'UNSUPPORTED_FILE_TYPE');
  return `private/${folder.replace(/[^a-z0-9-]/gi, '')}/${randomUUID()}.${ext}`;
}

export async function presignUpload(key: string, contentType: string, expiresIn = 600) {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: env.STORAGE_BUCKET!, Key: key, ContentType: contentType }), { expiresIn });
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  if (body.length > MAX_FILE_BYTES) throw E.badRequest('File too large (50 MB max)', 'FILE_TOO_LARGE');
  await s3().send(new PutObjectCommand({ Bucket: env.STORAGE_BUCKET!, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  const out = await s3().send(new GetObjectCommand({ Bucket: env.STORAGE_BUCKET!, Key: key }));
  if ((out.ContentLength ?? 0) > MAX_FILE_BYTES) throw E.badRequest('File too large to stream', 'FILE_TOO_LARGE');
  return Buffer.from(await out.Body!.transformToByteArray());
}

export async function deleteObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: env.STORAGE_BUCKET!, Key: key }));
}
