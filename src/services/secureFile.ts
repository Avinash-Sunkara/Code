import jwt from 'jsonwebtoken';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { env } from '../config/env';

export type FileKind = 'note' | 'cheatsheet' | 'resource';

export function signFileToken(userId: string, kind: FileKind, id: string, ttlSeconds = 300) {
  return jwt.sign({ kind, id }, env.JWT_SECRET, { subject: userId, audience: 'file', expiresIn: ttlSeconds });
}
export function verifyFileToken(token: string) {
  const p = jwt.verify(token, env.JWT_SECRET, { audience: 'file' }) as jwt.JwtPayload;
  return { userId: String(p.sub), kind: p.kind as FileKind, id: String(p.id) };
}

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

/** Tiles a diagonal watermark with the viewer's email on every page. Fails closed (throws) if the PDF can't be processed. */
export async function watermarkPdf(buf: Buffer, email: string): Promise<Buffer> {
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const label = `${email} · ${new Date().toISOString().slice(0, 10)}`;
  for (const pg of pdf.getPages()) {
    const { width, height } = pg.getSize();
    const size = Math.max(14, Math.min(width, height) / 22);
    for (let y = height * 0.15; y < height; y += height * 0.3) {
      pg.drawText(label, { x: width * 0.08, y, size, font, color: rgb(0.5, 0.5, 0.5), opacity: 0.16, rotate: degrees(35) });
    }
    pg.drawText(`Licensed to ${email}`, { x: 20, y: 12, size: 8, font, color: rgb(0.4, 0.4, 0.4), opacity: 0.7 });
  }
  return Buffer.from(await pdf.save());
}

export async function watermarkImage(buf: Buffer, email: string): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 800, h = meta.height ?? 600;
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="50%" text-anchor="middle" font-family="Arial" font-size="${Math.round(w / 20)}" fill="rgba(128,128,128,0.28)" transform="rotate(-30 ${w / 2} ${h / 2})">${esc(email)}</text></svg>`;
  return sharp(buf).composite([{ input: Buffer.from(svg) }]).toBuffer();
}
